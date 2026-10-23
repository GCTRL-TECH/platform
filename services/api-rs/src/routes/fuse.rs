use axum::{extract::{Extension, Path, State}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;
use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
    services::{redis::lpush, usage::record_usage},
};

#[derive(Deserialize, Default)]
pub(crate) struct MergeReq {
    pub(crate) name: String,
    /// Low-level form: the extraction jobs to merge.
    #[serde(rename = "sourceJobIds", default)] pub(crate) source_job_ids: Vec<Uuid>,
    /// Agent form: whole knowledge bases to merge - each contributes its source
    /// jobs. list_graphs / get_graph never expose job ids, so "merge graph A
    /// with graph B" needs this.
    #[serde(rename = "compilationIds", default)] pub(crate) compilation_ids: Vec<Uuid>,
    pub(crate) description: Option<String>,
    #[serde(rename = "ontologyId")] pub(crate) ontology_id: Option<Uuid>,
    /// Where to file the result (find-or-create, same as POST /kg/compilations).
    /// Without it the merge lands unfiled at the tree root.
    #[serde(rename = "folderPath", default)] pub(crate) folder_path: Vec<String>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/merge",           post(merge))
        .route("/jobs",            get(list_jobs))
        .route("/jobs/:id",        get(get_job).delete(delete_job))
        .route("/jobs/:id/cancel", post(cancel_job))
        .route("/config",          get(get_config).put(set_config))
}

/// Map a numeric classification rank onto the legacy `user_clearance` enum
/// (PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED) used by the compilations
/// table's `classification` column. The authoritative value is
/// `classification_level_id`; this keeps the legacy column coherent.
fn rank_to_enum(rank: i32) -> &'static str {
    match rank {
        r if r <= 0   => "PUBLIC",
        r if r <= 100 => "INTERNAL",
        r if r <= 200 => "CONFIDENTIAL",
        _             => "RESTRICTED",
    }
}

async fn merge(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<MergeReq>,
) -> Result<Json<Value>> {
    Ok(Json(start_merge(&state, &claims, req).await?))
}

/// Start a FUSE merge - the ONE path behind `POST /fuse/merge` and the agent
/// tool `fuse_graphs`, so both enforce the same rules:
///
/// - every source job belongs to the caller (IDOR guard), and for a KB-scoped
///   token lies inside a knowledge base of its scope: a colleague's agent may
///   merge what it can read, no more. It used to be refused outright on the
///   agent path while the REST path checked nothing beyond ownership.
/// - CODE sources need Codebase access (migration 078), like every other
///   read of a CODE knowledge base.
/// - the result is filed by `folderPath` and, for a scoped token, granted onto
///   that token - otherwise the merge it just started would be invisible to it.
pub(crate) async fn start_merge(
    state: &crate::models::AppState,
    claims: &JwtClaims,
    req: MergeReq,
) -> Result<Value> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let mut source_job_ids = req.source_job_ids.clone();
    if !req.compilation_ids.is_empty() {
        let rows: Vec<(Uuid, Vec<Uuid>)> = sqlx::query_as(
            "SELECT id, COALESCE(source_job_ids, '{}'::uuid[]) FROM compilations
             WHERE id = ANY($1) AND user_id = $2"
        ).bind(&req.compilation_ids).bind(claims.sub).fetch_all(&state.db).await?;
        if rows.len() != req.compilation_ids.len() {
            return Err(AppError::NotFound);
        }
        for (_, jobs) in rows { source_job_ids.extend(jobs); }
    }
    // Dedup first so repeated ids don't trip the count checks below.
    source_job_ids.sort();
    source_job_ids.dedup();
    if source_job_ids.is_empty() {
        return Err(AppError::BadRequest("sourceJobIds or compilationIds is required".into()));
    }

    // IDOR guard: refuse to merge any source job the caller doesn't own - a
    // merge would otherwise pull another user's graph data into this user's
    // compilation.
    let owned: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs WHERE id = ANY($1) AND user_id = $2"
    ).bind(&source_job_ids).bind(claims.sub).fetch_one(&state.db).await?;
    if (owned as usize) != source_job_ids.len() {
        return Err(AppError::Forbidden("one or more sourceJobIds are not yours".into()));
    }

    // KB-scoped token: every source job must come from a knowledge base inside
    // its scope (grants plus class scope; CODE graphs only with Codebase access,
    // which api_key_scope already encodes).
    let scope = crate::routes::kg::api_key_scope(&state.db, claims).await;
    if let Some(scope) = &scope {
        let scope_ids: Vec<Uuid> = scope.iter().copied().collect();
        let covered: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM unnest($1::uuid[]) AS s(job_id)
             WHERE EXISTS (SELECT 1 FROM compilations c
                           WHERE c.id = ANY($2) AND s.job_id = ANY(c.source_job_ids))"
        ).bind(&source_job_ids).bind(&scope_ids).fetch_one(&state.db).await?;
        if (covered as usize) != source_job_ids.len() {
            return Err(AppError::Forbidden(
                "this access token is scoped to specific knowledge bases; every source must belong to one of them".into(),
            ));
        }
    }

    // Codebase access off (078): a CODE knowledge base is invisible to this
    // token, so its jobs must not be merged into something the token can read.
    if !claims.code_access {
        let touches_code: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM compilations c
                            WHERE c.user_id = $2 AND c.type::text = 'CODE'
                              AND c.source_job_ids && $1::uuid[])"
        ).bind(&source_job_ids).bind(claims.sub).fetch_one(&state.db).await?;
        if touches_code {
            return Err(AppError::Forbidden(
                "Codebase access is off for this token; it cannot merge CODE knowledge bases".into(),
            ));
        }
    }

    // File the result (find-or-create), same rule as POST /kg/compilations.
    let segs: Vec<&str> = req.folder_path.iter()
        .map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let folder_id: Option<Uuid> = if segs.is_empty() { None } else {
        Some(crate::routes::kg::ensure_folder_path(&state.db, claims.sub, &segs).await?)
    };

    sqlx::query("UPDATE users SET tokens_balance = GREATEST(0, tokens_balance - 10) WHERE id = $1")
        .bind(claims.sub).execute(&state.db).await?;

    let comp_id = Uuid::new_v4();

    // The merged compilation inherits the MOST-PERMISSIVE (lowest rank) level of
    // its sources, so anyone who could see any source can discover the merge.
    // Per-element labels (written by the FUSE worker) do the real gating, so a
    // confidential element stays gated even inside a publicly-discoverable graph.
    let src_level = sqlx::query_as::<_, (Uuid, i32)>(
        "SELECT cl.id, cl.rank
         FROM jobs j JOIN classification_levels cl ON cl.id = j.classification_level_id
         WHERE j.id = ANY($1) AND j.user_id = $2
         ORDER BY cl.rank ASC LIMIT 1"
    ).bind(&source_job_ids).bind(claims.sub).fetch_optional(&state.db).await?;

    let (level_id, legacy): (Option<Uuid>, &str) = match src_level {
        Some((id, rank)) => (Some(id), rank_to_enum(rank)),
        None => (None, "PUBLIC"),
    };

    // The ontology's match rules travel with the job. The UI has offered an
    // ontology on this form since the beginning, and the worker has read
    // `match_rules` just as long - but nothing ever carried them from one to
    // the other, so every merge ran on the generic rule.
    let match_rules = match req.ontology_id {
        Some(oid) => load_match_rules(&state.db, oid, claims.sub).await?,
        None => vec![],
    };

    // source_job_ids column is UUID[] - bind Vec<Uuid> directly (NOT jsonb).
    sqlx::query(
        "INSERT INTO compilations (id, user_id, name, description, source_job_ids, classification, classification_level_id, version, ontology_id, folder_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)"
    )
    .bind(comp_id).bind(claims.sub).bind(&name).bind(&req.description)
    .bind(&source_job_ids).bind(legacy).bind(level_id).bind(req.ontology_id).bind(folder_id)
    .execute(&state.db).await?;

    // A scoped token sees only its grants - without this row the merge it just
    // started would be invisible to it (same as POST /kg/compilations).
    if scope.is_some() {
        if let Some(key_id) = claims.api_key_id {
            sqlx::query(
                "INSERT INTO api_key_grants (api_key_id, compilation_id, granted_rank)
                 VALUES ($1, $2, NULL) ON CONFLICT DO NOTHING"
            ).bind(key_id).bind(comp_id).execute(&state.db).await?;
        }
    }

    let job_id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs (id, user_id, type, status, input, api_key_id) VALUES ($1, $2, 'fuse_merge', 'pending', $3, $4)")
        .bind(job_id).bind(claims.sub)
        .bind(json!({ "compilationId": comp_id, "sourceJobIds": source_job_ids, "name": name }))
        .bind(claims.api_key_id)
        .execute(&state.db).await?;

    record_usage(&state.db, claims.sub, "fuse_merge", 10, Some(job_id)).await;

    lpush(&state.redis, "fuse:jobs", &json!({
        "job_id": job_id, "user_id": claims.sub,
        "compilation_id": comp_id, "source_job_ids": source_job_ids, "name": name,
        "classification": legacy,
        "match_rules": match_rules,
    }).to_string()).await.map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(json!({ "jobId": job_id, "compilationId": comp_id, "status": "pending", "folderId": folder_id }))
}

/// The match rules of one of the caller's ontologies, in the shape the fuse
/// worker reads (`match_rules` in the job payload). An ontology the caller
/// does not own yields no rules rather than an error: the ontology was never
/// more than a hint on this form.
pub(crate) async fn load_match_rules(db: &sqlx::PgPool, ontology_id: Uuid, user_id: Uuid) -> Result<Vec<Value>> {
    let rows = sqlx::query_as::<_, (String, String, bool, Option<String>, Option<f64>, Option<String>, Option<Vec<String>>)>(
        "SELECT r.entity_type_a, r.entity_type_b, coalesce(r.can_match, true),
                r.similarity_metric, r.threshold, r.blocking_strategy, r.properties_to_match
         FROM ontology_match_rules r
         JOIN ontologies o ON o.id = r.ontology_id
         WHERE r.ontology_id = $1 AND o.user_id = $2
         ORDER BY r.entity_type_a, r.entity_type_b"
    )
    .bind(ontology_id).bind(user_id)
    .fetch_all(db).await?;
    Ok(rows.into_iter().map(|(a, b, can_match, metric, threshold, blocking, props)| json!({
        "entity_type_a": a, "entity_type_b": b, "can_match": can_match,
        "similarity_metric": metric, "threshold": threshold,
        "blocking_strategy": blocking, "properties_to_match": props.unwrap_or_default(),
    })).collect())
}

async fn list_jobs(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows: Vec<FuseJobRow> = sqlx::query_as(&format!(
        "SELECT {FUSE_JOB_COLUMNS} {FUSE_JOB_JOINS}
         WHERE j.user_id=$1 AND j.type='fuse_merge' ORDER BY j.created_at DESC LIMIT 50"
    ))
    .bind(claims.sub).fetch_all(&state.db).await?;
    let jobs: Vec<Value> = rows.into_iter().map(fuse_job_json).collect();
    Ok(Json(json!({ "jobs": jobs })))
}

/// A fuse job plus the token that triggered it and the account it belongs to —
/// the same provenance the KEX job list shows.
type FuseJobRow = (
    Uuid, String, String, Value, Option<Value>, Option<String>,
    chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>,
    Option<Uuid>, Option<String>, Option<String>,
);

const FUSE_JOB_COLUMNS: &str =
    "j.id, j.type, j.status, j.input, j.result, j.error, j.created_at, j.completed_at,
     j.api_key_id, ak.name, u.email";

const FUSE_JOB_JOINS: &str =
    "FROM jobs j
     LEFT JOIN api_keys ak ON ak.id = j.api_key_id
     LEFT JOIN users u ON u.id = j.user_id";

fn fuse_job_json(row: FuseJobRow) -> Value {
    let (id, t, s, inp, r, e, c, cmp, api_key_id, token_name, user_email) = row;
    json!({
        "id": id, "type": t, "status": s, "input": inp, "result": r, "error": e,
        "createdAt": c, "completedAt": cmp,
        "apiKeyId": api_key_id, "tokenName": token_name, "userEmail": user_email,
    })
}

async fn get_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row: Option<FuseJobRow> = sqlx::query_as(&format!(
        "SELECT {FUSE_JOB_COLUMNS} {FUSE_JOB_JOINS} WHERE j.id=$1 AND j.user_id=$2"
    )).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    let row = row.ok_or(AppError::NotFound)?;
    // Frontend FuseJobDetail expects `{ job: ... }` wrapper.
    Ok(Json(json!({ "job": fuse_job_json(row) })))
}

async fn cancel_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("UPDATE jobs SET status='failed', error='Cancelled', updated_at=NOW() WHERE id=$1 AND user_id=$2")
        .bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM jobs WHERE id=$1 AND user_id=$2").bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn get_config() -> Json<Value> {
    Json(json!({ "similarityThreshold": 0.85, "measureFunction": "Jaccard", "maxCandidates": 10 }))
}

async fn set_config(Json(cfg): Json<Value>) -> Json<Value> {
    Json(json!({ "ok": true, "config": cfg }))
}

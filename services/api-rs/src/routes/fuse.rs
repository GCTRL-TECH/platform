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

#[derive(Deserialize)]
struct MergeReq {
    name: String,
    #[serde(rename = "sourceJobIds")] source_job_ids: Vec<Uuid>,
    description: Option<String>,
    #[serde(rename = "ontologyId")] ontology_id: Option<Uuid>,
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
    // IDOR guard: refuse to merge any source job the caller doesn't own — a
    // merge would otherwise pull another user's graph data into this user's
    // compilation. Dedup first so repeated ids don't trip the count check.
    let mut source_job_ids = req.source_job_ids.clone();
    source_job_ids.sort();
    source_job_ids.dedup();
    if source_job_ids.is_empty() {
        return Err(AppError::BadRequest("sourceJobIds is required".into()));
    }
    let owned: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs WHERE id = ANY($1) AND user_id = $2"
    ).bind(&source_job_ids).bind(claims.sub).fetch_one(&state.db).await?;
    if (owned as usize) != source_job_ids.len() {
        return Err(AppError::Forbidden("one or more sourceJobIds are not yours".into()));
    }

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

    // source_job_ids column is UUID[] — bind Vec<Uuid> directly (NOT jsonb).
    sqlx::query(
        "INSERT INTO compilations (id, user_id, name, description, source_job_ids, classification, classification_level_id, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)"
    )
    .bind(comp_id).bind(claims.sub).bind(&req.name).bind(&req.description)
    .bind(&source_job_ids).bind(legacy).bind(level_id)
    .execute(&state.db).await?;

    let job_id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs (id, user_id, type, status, input) VALUES ($1, $2, 'fuse_merge', 'pending', $3)")
        .bind(job_id).bind(claims.sub)
        .bind(json!({ "compilationId": comp_id, "sourceJobIds": source_job_ids, "name": req.name }))
        .execute(&state.db).await?;

    record_usage(&state.db, claims.sub, "fuse_merge", 10, Some(job_id)).await;

    lpush(&state.redis, "fuse:jobs", &json!({
        "job_id": job_id, "user_id": claims.sub,
        "compilation_id": comp_id, "source_job_ids": source_job_ids, "name": req.name,
        "classification": legacy,
    }).to_string()).await.map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "jobId": job_id, "compilationId": comp_id, "status": "pending" })))
}

async fn list_jobs(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, Value, Option<Value>, Option<String>, chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT id, type, status, input, result, error, created_at, completed_at FROM jobs
         WHERE user_id=$1 AND type='fuse_merge' ORDER BY created_at DESC LIMIT 50"
    )
    .bind(claims.sub).fetch_all(&state.db).await?;
    let jobs: Vec<Value> = rows.into_iter().map(|(id, t, s, inp, r, e, c, cmp)| json!({
        "id": id, "type": t, "status": s, "input": inp, "result": r, "error": e,
        "createdAt": c, "completedAt": cmp,
    })).collect();
    Ok(Json(json!({ "jobs": jobs })))
}

async fn get_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, (Uuid, String, String, Value, Option<Value>, Option<String>, chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT id, type, status, input, result, error, created_at, completed_at FROM jobs WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let (id, t, s, inp, r, e, c, cmp) = row;
    // Frontend FuseJobDetail expects `{ job: ... }` wrapper.
    Ok(Json(json!({ "job": {
        "id": id, "type": t, "status": s, "input": inp, "result": r, "error": e,
        "createdAt": c, "completedAt": cmp,
    } })))
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

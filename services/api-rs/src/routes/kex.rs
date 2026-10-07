use axum::{
    body::Bytes,
    extract::{Extension, Multipart, Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
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
struct ExtractReq {
    text: String,
    #[serde(rename = "ontologyId")]          ontology_id:            Option<Uuid>,
    #[serde(rename = "discoveryMode")]       discovery_mode:         Option<String>,
    #[serde(rename = "classificationLevelId")] classification_level_id: Option<Uuid>,
    /// Optional human-readable origin (e.g. "Obsidian (My Vault) / Projects/Note.md")
    /// so the extracted entities are traceable back to where the text came from,
    /// even if the original file later moves. Stored as the job's source.
    #[serde(rename = "sourceRef")]           source_ref:             Option<String>,
    /// Optional target compilation. When set, the new extraction job is linked
    /// into that compilation's `source_job_ids` so the document is part of the
    /// graph (and scoped RAG can find it) instead of being orphaned.
    #[serde(rename = "compilationId")]       compilation_id:         Option<Uuid>,
}

/// The status a caller is shown for a finished job.
///
/// A job whose relation extraction or embedding phase fell over still finished —
/// KEX keeps whatever it got instead of failing the customer's document — but the
/// graph it produced is INCOMPLETE (typically entities without a single edge, and
/// the isolated ones get pruned afterwards). Reporting that as a plain `completed`
/// is what made a broken install look healthy: the only trace was a line in the
/// KEX log.
///
/// KEX flags it in the result payload (`degraded` + `warning`, see
/// `services/kex/src/main.py`). The `jobs.status` COLUMN deliberately stays
/// `completed` — every filter, count and retry path keeps its meaning — while every
/// read surface (job list, job detail, result, agent `list_extractions`) reports the
/// distinguishable `completed_degraded` plus the reason. Terminal-success checks in
/// clients therefore test `status.startsWith("completed")`.
pub(crate) fn presented_status(status: &str, result: Option<&Value>) -> (String, Option<String>) {
    let degraded = status == "completed"
        && result
            .and_then(|r| r.get("degraded"))
            .and_then(|d| d.as_bool())
            .unwrap_or(false);
    if !degraded {
        return (status.to_string(), None);
    }
    let reason = result
        .and_then(|r| r.get("warning"))
        .and_then(|w| w.as_str())
        .map(|s| s.to_string());
    ("completed_degraded".to_string(), reason)
}

/// Link a freshly-created extraction job into a compilation's `source_job_ids`,
/// if the caller owns that compilation. Idempotent (`array_append` only when the
/// id isn't already present) and owner-scoped (the `user_id` guard means a caller
/// can never attach a job to someone else's compilation). Best-effort: a failure
/// here never fails the extraction — the job is still created and retrievable via
/// the owner-scoped corpus fallback; it just won't grow the compilation.
///
/// This implements the `appendJobToCompilation` behaviour that previously lived
/// only in the MCP layer (services/mcp), so direct `/api/kex/extract` + `/upload`
/// callers no longer produce orphaned documents.
pub(crate) async fn link_job_to_compilation(
    db: &sqlx::PgPool,
    user_id: Uuid,
    compilation_id: Uuid,
    job_id: Uuid,
) {
    let res = sqlx::query(
        "UPDATE compilations
            SET source_job_ids = array_append(source_job_ids, $3),
                updated_at = NOW()
          WHERE id = $1 AND user_id = $2
            AND NOT ($3 = ANY(source_job_ids))"
    )
    .bind(compilation_id).bind(user_id).bind(job_id)
    .execute(db).await;
    if let Err(e) = res {
        tracing::warn!("link_job_to_compilation({compilation_id}, {job_id}) failed: {e}");
    }
}

/// Resolve the user's default knowledge base — the oldest compilation that is
/// neither a system compilation (e.g. the seeded "Knowledge Wiki") nor a WIKI
/// (distilled view, holds no graph data of its own) nor a CODE compilation
/// (code graphs are explicit targets, never a landing spot for documents).
/// Every fresh registration seeds exactly one such compilation ("My First
/// Knowledge Base" —
/// `auth::seed_default_workspace`), so this gives every submission path
/// without an explicit `compilationId` a landing spot instead of orphaning the
/// job. Returns `None` only for the edge case of a user with no eligible
/// compilation at all (e.g. it was deleted) — callers then keep today's
/// behaviour of leaving the job unlinked.
pub(crate) async fn resolve_default_compilation(db: &sqlx::PgPool, user_id: Uuid) -> Option<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM compilations
          WHERE user_id = $1
            AND COALESCE(is_system, false) = false
            AND type::text NOT IN ('WIKI', 'CODE')
          ORDER BY created_at ASC LIMIT 1"
    )
    .bind(user_id)
    .fetch_optional(db).await.ok().flatten()
}

/// Link a job into its target compilation: the caller's explicit choice, or
/// (when none was given) the caller's default knowledge base, so a submission
/// never silently orphans. Best-effort/idempotent — see `link_job_to_compilation`.
///
/// SCOPE-AWARE (bug-hunt W7): KB-scoped access tokens run under the OWNER's
/// user_id, so the `user_id` guard alone would let them link into ANY of the
/// owner's compilations — including ones the token was never granted. This
/// helper therefore consults `api_key_scope`:
///   - explicit `compilationId` outside the grant set → never linked (warn);
///   - no `compilationId` + exactly one grant → that grant IS the default;
///   - no `compilationId` + zero/many grants → no safe default, left unlinked;
///   - unscoped caller (owner JWT / full-access key) → owner's default KB.
pub(crate) async fn link_job_to_target_or_default(
    db: &sqlx::PgPool,
    claims: &crate::middleware::auth::JwtClaims,
    compilation_id: Option<Uuid>,
    job_id: Uuid,
) {
    // WRITE scope (088): a read-only grant is neither a valid explicit target nor a
    // candidate for the single-grant default — otherwise a viewer's key would link
    // its extractions straight into the knowledge base it may only read.
    let scope = crate::routes::kg::api_key_write_scope(db, claims).await;
    let target = match compilation_id {
        Some(cid) => {
            if let Some(set) = &scope {
                if !set.contains(&cid) {
                    tracing::warn!(%job_id, %cid,
                        "scoped token tried to link a job outside its WRITABLE knowledge bases — job left unlinked");
                    return;
                }
            }
            Some(cid)
        }
        None => match &scope {
            Some(set) if set.len() == 1 => {
                let cid = set.iter().next().copied();
                tracing::debug!(%job_id, ?cid, "scoped token: linking job to its single writable knowledge base");
                cid
            }
            Some(_) => {
                tracing::debug!(%job_id,
                    "scoped token without explicit compilationId and no single writable grant — job left unlinked");
                None
            }
            None => resolve_default_compilation(db, claims.sub).await,
        },
    };
    if let Some(cid) = target {
        // Migration 078 — belt-and-braces for every ingest path that funnels
        // through here (upload, connector, agent store/create_extraction): a
        // token without Codebase access never links a job into a CODE knowledge
        // base, not even the resolved default one. The callers that CAN return
        // an error (POST /kex/extract) refuse earlier with 403.
        if !claims.code_access
            && crate::routes::kg::compilation_is_code(db, cid).await
        {
            tracing::warn!(%job_id, %cid,
                "token without Codebase access targeted a CODE knowledge base — job left unlinked");
            return;
        }
        link_job_to_compilation(db, claims.sub, cid, job_id).await;
    }
}

/// Link an OWNER-ingested job (connector / Obsidian-vault sync) into its target
/// compilation, or the owner's default KB when none was chosen. Connector syncs
/// run under the owner's `user_id` (no scoped colleague token), so the
/// owner-guarded linker is the correct scope. Without this the extracted entities
/// never enter `compilation.source_job_ids` — the ONLY entity→graph mapping — so
/// the job completes but its nodes never show up in the graph.
pub(crate) async fn link_owned_job(
    db: &sqlx::PgPool,
    user_id: Uuid,
    compilation_id: Option<Uuid>,
    job_id: Uuid,
) {
    let target = match compilation_id {
        Some(cid) => Some(cid),
        None => resolve_default_compilation(db, user_id).await,
    };
    if let Some(cid) = target {
        link_job_to_compilation(db, user_id, cid, job_id).await;
    }
}

/// A token may not ingest content classified above its own clearance ceiling.
/// (bug-hunt W7: this check existed on `ingest_repo` and the agent's
/// `create_extraction`, but was missing on the two most-used entry points —
/// `extract` and `upload` — an inconsistent-enforcement gap.)
pub(crate) async fn enforce_classification_ceiling(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
    classification_level_id: Option<Uuid>,
) -> Result<()> {
    if let (Some(key_rank), Some(c)) = (claims.api_key_rank, classification_level_id) {
        let lvl_rank: Option<i32> = sqlx::query_scalar(
            "SELECT rank FROM classification_levels WHERE id = $1"
        ).bind(c).fetch_optional(db).await.ok().flatten();
        if lvl_rank.map_or(false, |r| r > key_rank) {
            return Err(AppError::Forbidden("classification exceeds this access token's clearance".into()));
        }
    }
    Ok(())
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/extract",         post(extract))
        .route("/repo",            post(ingest_repo))
        .route("/code",            post(ingest_code))
        .route("/code/manifest",   get(code_manifest))
        .route("/code/files",      axum::routing::delete(delete_code_files))
        .route("/upload",          post(upload))
        .route("/jobs",            get(list_jobs))
        .route("/jobs/:id",        get(get_job).delete(delete_job))
        .route("/jobs/:id/result", get(get_result))
        .route("/jobs/:id/unlink", post(unlink_job))
        .route("/jobs/:id/cancel", post(cancel_job))
        .route("/jobs/:id/retry",  post(retry_job))
        .route("/jobs/retry-failed", post(retry_failed))
        .route("/chunks",          get(list_chunks))
        .route("/chunks/:id",      axum::routing::delete(delete_chunk))
        .route("/chunks/:id/supersede", post(supersede_chunk))
        .route("/queue",           get(queue_depth))
        .route("/model-status",    get(model_status))
        .route("/threads",         axum::routing::put(set_threads))
}

async fn extract(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<ExtractReq>,
) -> Result<Json<Value>> {
    if req.text.len() < 10 {
        return Err(AppError::BadRequest("Text too short (min 10 chars)".into()));
    }
    enforce_classification_ceiling(&state.db, &claims, req.classification_level_id).await?;
    // Migration 078 — ingesting INTO a CODE knowledge base is a code-KB mutation.
    // Refused before the token spend, so a no-code token can't pay for a write it
    // isn't allowed to make (the linker below would drop it anyway).
    if let Some(cid) = req.compilation_id {
        crate::routes::kg::enforce_code_capability(&state.db, &claims, cid).await?;
    }
    // GREATEST(0, ...) prevents negative balances if a prior bug or race left them stuck.
    sqlx::query("UPDATE users SET tokens_balance = GREATEST(0, tokens_balance - 5) WHERE id = $1")
        .bind(claims.sub).execute(&state.db).await?;

    let (ontology_id, entity_types) = resolve_ontology(&state.db, claims.sub, req.ontology_id).await;

    // P2b: resolve a stable document identity for (user, path). Re-ingesting
    // the SAME text just bumps last_ingested_at; CHANGED text creates a new
    // version in the chain. `path` falls back to a short text preview when
    // the caller gave no sourceRef (direct API text ingest has no path/mtime
    // to offer, so modified_at is left unknown — first_ingested_at stands in).
    let source_path = req.source_ref.clone().unwrap_or_else(|| {
        let preview: String = req.text.chars().take(60).collect();
        format!("text:{preview}")
    });
    let content_hash = crate::services::source_docs::hash_content(req.text.as_bytes());
    let source_doc = crate::services::source_docs::resolve_source_document(
        &state.db, claims.sub, None, &source_path, req.source_ref.as_deref(),
        &content_hash, None,
    ).await.ok();
    let source_document_id = source_doc.as_ref().map(|d| d.id);

    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id, source_document_id, api_key_id)
         VALUES ($1, $2, 'kex_extract', 'pending', $3, $4, $5, $6)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({
        "text": req.text,
        "ontologyId": ontology_id,
        "discoveryMode": req.discovery_mode.unwrap_or_else(|| "extract".into()),
        // Surfaced as the entity's source path (entity_detail reads input->>'fileName').
        "fileName": req.source_ref,
        "sourceRef": req.source_ref,
    }))
    .bind(req.classification_level_id)
    .bind(source_document_id)
    .bind(claims.api_key_id)
    .execute(&state.db).await?;

    // Record the spend locally so the heartbeat task can ship it upstream.
    record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;

    // Link into the target compilation: explicit choice, else the user's default
    // knowledge base, so the document is never orphaned.
    link_job_to_target_or_default(&state.db, &claims, req.compilation_id, job_id).await;

    // Look up classification name to forward to KEX worker for Neo4j tagging.
    let classification_name: Option<String> = if let Some(clf_id) = req.classification_level_id {
        sqlx::query_scalar("SELECT name FROM classification_levels WHERE id = $1")
            .bind(clf_id).fetch_optional(&state.db).await.ok().flatten()
    } else {
        None
    };

    let mut payload = json!({
        "job_id": job_id, "user_id": claims.sub, "type": "text",
        "input": req.text, "entity_types": entity_types,
        "ontology_id": ontology_id,
        "classification": classification_name,
        "classification_level_id": req.classification_level_id,
        "source_document_id": source_document_id,
        "source_path": source_path,
        // No source-side mtime for direct text ingest.
        "source_modified_at": Value::Null,
    });
    crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
}

#[derive(Deserialize)]
struct RepoReq {
    /// Repo files as a JSON array of {path, content}; forwarded as-is to KEX.
    files: Value,
    #[serde(rename = "classificationLevelId")] classification_level_id: Option<Uuid>,
    #[serde(rename = "repoName")]              repo_name:               Option<String>,
    #[serde(rename = "compilationId")]         compilation_id:          Option<Uuid>,
}

/// POST /api/kex/repo — ingest a (Python) code repository into the graph.
/// Authenticated proxy to the KEX `/repo` parser (deterministic, no LLM). The
/// caller's clearance ceiling + KB write-scope are enforced, and the resulting
/// job can be linked into a compilation. Synchronous (parsing is fast).
async fn ingest_repo(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<RepoReq>,
) -> Result<Json<Value>> {
    let file_count = req.files.as_array().map(|a| a.len()).unwrap_or(0);
    if file_count == 0 {
        return Err(AppError::BadRequest("files is required (array of {path, content})".into()));
    }
    // A token may not ingest content classified above its own clearance ceiling.
    if let (Some(key_rank), Some(c)) = (claims.api_key_rank, req.classification_level_id) {
        let lvl_rank: Option<i32> = sqlx::query_scalar(
            "SELECT rank FROM classification_levels WHERE id = $1"
        ).bind(c).fetch_optional(&state.db).await.ok().flatten();
        if lvl_rank.map_or(false, |r| r > key_rank) {
            return Err(AppError::Forbidden("classification exceeds this access token's clearance".into()));
        }
    }
    // KB write-scope when targeting a compilation.
    if let Some(cid) = req.compilation_id {
        crate::routes::kg::enforce_kb_write_scope(&state.db, &claims, cid).await?;
    }

    let job_id = Uuid::new_v4();
    let repo_name = req.repo_name.clone().unwrap_or_else(|| "repo".into());
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id, api_key_id)
         VALUES ($1, $2, 'kex_extract', 'processing', $3, $4, $5)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({ "source": "repo", "repoName": repo_name, "fileCount": file_count }))
    .bind(req.classification_level_id)
    .bind(claims.api_key_id)
    .execute(&state.db).await?;

    let url = format!("{}/repo", state.cfg.kex_worker_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&json!({
            "files": req.files,
            "job_id": job_id.to_string(),
            "user_id": claims.sub.to_string(),
            "classification_level_id": req.classification_level_id,
            "repo_name": repo_name,
        }))
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("KEX unreachable: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let _ = sqlx::query("UPDATE jobs SET status='failed', error=$2, completed_at=NOW() WHERE id=$1")
            .bind(job_id).bind(&body).execute(&state.db).await;
        return Err(AppError::Internal(format!("KEX repo ingest failed ({status}): {body}")));
    }
    let summary: Value = resp.json().await
        .map_err(|e| AppError::Internal(format!("KEX response parse error: {e}")))?;

    let _ = sqlx::query("UPDATE jobs SET status='completed', result=$2, completed_at=NOW() WHERE id=$1")
        .bind(job_id).bind(&summary).execute(&state.db).await;
    // Link into the target compilation: explicit choice, else the user's default
    // knowledge base, so the repo ingest is never orphaned.
    link_job_to_target_or_default(&state.db, &claims, req.compilation_id, job_id).await;
    record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;

    let mut out = summary;
    if let Value::Object(ref mut m) = out {
        m.insert("jobId".into(), json!(job_id));
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
struct CodeIngestReq {
    #[serde(rename = "compilationId")]         compilation_id:          Uuid,
    repo:                                      Value,
    #[serde(default)]                          files:                   Vec<Value>,
    #[serde(default)]                          removed:                 Vec<String>,
    #[serde(rename = "classificationLevelId")] classification_level_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct CodeDeleteReq {
    #[serde(rename = "compilationId")] compilation_id: Uuid,
    #[serde(rename = "repoName")]      repo_name:      String,
    paths:                             Vec<String>,
}

#[derive(Deserialize)]
struct ManifestQuery {
    #[serde(rename = "compilationId")] compilation_id: Uuid,
}

/// Pure builder for the kex:jobs payload of a code job (unit-tested).
fn code_job_payload(
    job_id: Uuid, user_id: Uuid, compilation_id: Uuid,
    repo: &Value, files: &Value, removed: &Value,
    classification_name: Option<String>, classification_level_id: Option<Uuid>,
) -> Value {
    json!({
        "job_id": job_id, "user_id": user_id, "type": "code",
        "compilation_id": compilation_id,
        "repo": repo, "files": files, "removed": removed,
        "classification": classification_name,
        "classification_level_id": classification_level_id,
    })
}

/// Pure Cypher for GET /kex/code/manifest: file hashes + the repo node, job-scoped.
fn code_manifest_cypher() -> String {
    format!(
        "MATCH (n:Entity {{type: 'file', coarse_type: 'code'}}) WHERE {scope} \
         RETURN n.name AS path, n.sha256 AS sha256, n._repo AS repo",
        scope = crate::services::neo4j::job_scope("n", "jobs"),
    )
}

fn code_repo_cypher() -> String {
    format!(
        "MATCH (n:Entity {{type: 'repo', coarse_type: 'code'}}) WHERE {scope} \
         RETURN n.name AS repo, n.commit AS commit ORDER BY n.indexed_at DESC LIMIT 1",
        scope = crate::services::neo4j::job_scope("n", "jobs"),
    )
}

/// Shared by POST /code and DELETE /code/files: validates the target CODE
/// compilation, inserts a pending `kex_code` job linked to it, enqueues it.
///
/// Owner or kb-scoped grant required; foreign ids return 404. A caller who is
/// neither the compilation's owner nor holds an explicit grant for it (via a
/// KB-scoped access token) gets `NotFound` — never `Forbidden` — so a foreign
/// UUID cannot be distinguished from one that simply doesn't exist.
async fn enqueue_code_job(
    claims: &JwtClaims,
    state: &Arc<crate::models::AppState>,
    compilation_id: Uuid,
    repo: Value,
    files: Vec<Value>,
    removed: Vec<String>,
    classification_level_id: Option<Uuid>,
) -> Result<Json<Value>> {
    // Migration 078 — per-token "Codebase access": writing code knowledge is a
    // code capability, so a token with it switched off is refused before any
    // work (or usage accounting) happens.
    if !claims.code_access {
        return Err(AppError::Forbidden(
            "Codebase access is disabled for this access token".into(),
        ));
    }
    if files.is_empty() && removed.is_empty() {
        return Err(AppError::BadRequest("files or removed is required".into()));
    }
    enforce_classification_ceiling(&state.db, claims, classification_level_id).await?;
    crate::routes::kg::enforce_kb_write_scope(&state.db, claims, compilation_id).await?;
    let comp: Option<(String, Uuid)> = sqlx::query_as(
        "SELECT type::text, user_id FROM compilations WHERE id = $1"
    ).bind(compilation_id).fetch_optional(&state.db).await?;
    let Some((ctype, owner_id)) = comp else { return Err(AppError::NotFound); };
    if owner_id != claims.sub {
        match crate::routes::kg::api_key_scope(&state.db, claims).await {
            Some(ref s) if s.contains(&compilation_id) => {}
            _ => return Err(AppError::NotFound),
        }
    }
    match ctype.as_str() {
        "CODE" => {}
        other => return Err(AppError::BadRequest(format!(
            "compilation {compilation_id} is {other}, not CODE - create a CODE compilation for code graphs"))),
    }
    let repo_name = repo["name"].as_str().unwrap_or("repo").to_string();

    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id, api_key_id)
         VALUES ($1, $2, 'kex_code', 'pending', $3, $4, $5)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({ "source": "code", "repoName": repo_name, "fileCount": files.len(),
                  "removedCount": removed.len(), "commit": repo["commit"] }))
    .bind(classification_level_id)
    .bind(claims.api_key_id)
    .execute(&state.db).await?;
    record_usage(&state.db, claims.sub, "kex_code", 5, Some(job_id)).await;
    link_job_to_compilation(&state.db, claims.sub, compilation_id, job_id).await;

    let classification_name: Option<String> = if let Some(clf_id) = classification_level_id {
        sqlx::query_scalar("SELECT name FROM classification_levels WHERE id = $1")
            .bind(clf_id).fetch_optional(&state.db).await.ok().flatten()
    } else { None };

    let mut payload = code_job_payload(
        job_id, claims.sub, compilation_id, &repo, &Value::Array(files), &json!(removed),
        classification_name, classification_level_id,
    );
    crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
}

/// POST /api/kex/code - async ingest of an IndexBatch (see spec §10).
async fn ingest_code(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CodeIngestReq>,
) -> Result<Json<Value>> {
    enqueue_code_job(&claims, &state, req.compilation_id, req.repo, req.files, req.removed,
                     req.classification_level_id).await
}

/// DELETE /api/kex/code/files - drop symbols + chunks of the given paths.
///
/// Deviation from the original brief: the request carries a required `repoName`
/// (instead of a null placeholder). `enqueue_code_job` falls back to repo name
/// "repo" when `repo["name"]` is absent, which would purge whatever the WORKER
/// happens to default to instead of the caller's actual repo — a required field
/// keeps the delete scoped to the repo the caller means.
async fn delete_code_files(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CodeDeleteReq>,
) -> Result<Json<Value>> {
    enqueue_code_job(&claims, &state, req.compilation_id, json!({"name": req.repo_name}), vec![], req.paths, None).await
}

/// GET /api/kex/code/manifest?compilationId= - {repo, commit, files:{path:sha256}}
async fn code_manifest(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<ManifestQuery>,
) -> Result<Json<Value>> {
    let eff = crate::routes::kg::effective_rank_for_compilation(&state.db, &claims, q.compilation_id).await;
    if eff == i32::MIN { return Err(AppError::Forbidden("compilation not granted to this token".into())); }
    let jobs: Option<(Vec<Uuid>, Uuid)> = sqlx::query_as(
        "SELECT COALESCE(source_job_ids,'{}'::uuid[]), user_id FROM compilations WHERE id = $1"
    ).bind(q.compilation_id).fetch_optional(&state.db).await?;
    let Some((job_ids, owner_id)) = jobs else { return Err(AppError::NotFound); };
    // Owner or kb-scoped grant required; foreign ids return 404 (never Forbidden)
    // so a foreign compilation UUID can't be distinguished from a nonexistent one.
    if owner_id != claims.sub {
        match crate::routes::kg::api_key_scope(&state.db, &claims).await {
            Some(ref s) if s.contains(&q.compilation_id) => {}
            _ => return Err(AppError::NotFound),
        }
    }
    let job_strs: Vec<String> = job_ids.iter().map(|u| u.to_string()).collect();

    let mut files = serde_json::Map::new();
    if let Ok(mut stream) = state.neo.execute(neo4rs::query(&code_manifest_cypher()).param("jobs", job_strs.clone())).await {
        while let Ok(Some(row)) = stream.next().await {
            let path = row.get::<String>("path").unwrap_or_default();
            let sha = row.get::<String>("sha256").unwrap_or_default();
            if !path.is_empty() { files.insert(path, json!(sha)); }
        }
    }
    let (mut repo, mut commit) = (Value::Null, Value::Null);
    if let Ok(mut stream) = state.neo.execute(neo4rs::query(&code_repo_cypher()).param("jobs", job_strs)).await {
        if let Ok(Some(row)) = stream.next().await {
            repo = row.get::<String>("repo").map(Value::String).unwrap_or(Value::Null);
            commit = row.get::<String>("commit").map(Value::String).unwrap_or(Value::Null);
        }
    }
    Ok(Json(json!({ "repo": repo, "commit": commit, "files": Value::Object(files) })))
}

/// Resolves the ontology to use for an extraction job, returning
/// `(ontology_id, gliner_labels)`:
///   - **Explicit selection** (`requested` set): constrain extraction to that
///     ontology's entity types (the user curated it — respect its schema).
///   - **No selection**: fall back to the user's `default_ontology_id` (the shared
///     "General Knowledge" ontology) but use OPEN discovery (`None` labels → KEX's
///     built-in default label set). The worker then writes back any newly-seen
///     types, so the default ontology grows in place instead of staying static.
///
/// In both cases the returned `ontology_id` is the write-back target.
pub(crate) async fn resolve_ontology(
    db: &sqlx::PgPool,
    user_id: Uuid,
    requested: Option<Uuid>,
) -> (Option<Uuid>, Option<Vec<String>>) {
    match requested {
        Some(id) => {
            let entity_types = sqlx::query_scalar::<_, String>(
                "SELECT name FROM ontology_entity_types WHERE ontology_id = $1 ORDER BY name")
                .bind(id).fetch_all(db).await.ok().filter(|v: &Vec<String>| !v.is_empty());
            (Some(id), entity_types)
        }
        None => {
            let default_id = sqlx::query_scalar::<_, Option<Uuid>>(
                "SELECT default_ontology_id FROM users WHERE id = $1")
                .bind(user_id).fetch_optional(db).await.ok().flatten().flatten();
            // Open discovery so the shared default can grow toward newly-seen types.
            (default_id, None)
        }
    }
}

async fn upload(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut file_bytes: Option<Bytes> = None;
    let mut file_name  = "upload".to_string();
    let mut ontology_id: Option<Uuid> = None;
    let mut classification_level_id: Option<Uuid> = None;
    let mut compilation_id: Option<Uuid> = None;
    // CLI and SDK send the file's real location here; the browser does not.
    let mut source_ref: Option<String> = None;

    while let Some(field) = multipart.next_field().await
        .map_err(|e| AppError::BadRequest(e.to_string()))? {
        match field.name() {
            Some("file") => {
                file_name = field.file_name().unwrap_or("upload").to_string();
                file_bytes = Some(field.bytes().await.map_err(|e| AppError::BadRequest(e.to_string()))?);
            }
            Some("ontologyId") => {
                let s = field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?;
                ontology_id = s.parse().ok();
            }
            Some("classificationLevelId") => {
                let s = field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?;
                classification_level_id = s.parse().ok();
            }
            Some("compilationId") => {
                let s = field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?;
                compilation_id = s.parse().ok();
            }
            Some("sourceRef") => {
                let s = field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?;
                let s = s.trim();
                if !s.is_empty() { source_ref = Some(s.to_string()); }
            }
            _ => {}
        }
    }

    let bytes = file_bytes.ok_or(AppError::BadRequest("No file field".into()))?;
    let job_id = submit_upload(
        &state, &claims, &bytes, &file_name, ontology_id, classification_level_id, compilation_id,
        source_ref.as_deref(),
    ).await?;

    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
}

/// MIME type KEX should route a file by, from its extension. KEX's
/// `file_handler.extract_text` routes first by extension and then by MIME; a type
/// it does not recognise ends in "Unsupported mimetype". Until v0.9.7 every
/// extension not listed here was enqueued as `application/octet-stream`, so an
/// image, a PPTX or an .eml uploaded through the API or an agent's `ingest_file`
/// failed even though KEX can read them (OCR/vision for images, python-pptx, ...).
/// Keep the strings in sync with `services/kex/src/sources/file_handler.py`.
pub(crate) fn mime_for_filename(file_name: &str) -> &'static str {
    let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "pdf"  => "application/pdf",
        "txt" | "text" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "csv"  => "text/csv",
        "json" => "application/json",
        "xml"  => "application/xml",
        "yaml" | "yml" => "application/x-yaml",
        "toml" => "application/toml",
        "rtf"  => "application/rtf",
        "epub" => "application/epub+zip",
        "eml"  => "message/rfc822",
        "msg"  => "application/vnd.ms-outlook",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsm" => "application/vnd.ms-excel.sheet.macroEnabled.12",
        "odt"  => "application/vnd.oasis.opendocument.text",
        "odp"  => "application/vnd.oasis.opendocument.presentation",
        "ods"  => "application/vnd.oasis.opendocument.spreadsheet",
        // Images: KEX transcribes them with the vision model when the runtime
        // can see, and falls back to Tesseract OCR otherwise.
        "png"  => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "tif" | "tiff" => "image/tiff",
        "bmp"  => "image/bmp",
        "gif"  => "image/gif",
        _      => "application/octet-stream",
    }
}

/// Core of file ingestion: given raw bytes + a filename, resolves the mimetype
/// from the extension, spends tokens, creates the `kex_upload` job, links it
/// into a compilation (explicit choice, else the user's default so nothing is
/// orphaned), and enqueues the KEX worker payload. Shared by the multipart HTTP
/// handler (`upload`, above) and the `ingest_file` agent tool (`routes::agent`)
/// so both entry points behave identically. Preserves the exact behaviour the
/// multipart handler had before this refactor.
pub(crate) async fn submit_upload(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    bytes: &[u8],
    file_name: &str,
    ontology_id: Option<Uuid>,
    classification_level_id: Option<Uuid>,
    compilation_id: Option<Uuid>,
    // `source_ref`: where the file actually came from — an absolute path, a URL, a
    // vault location. `None` falls back to the bare file name, which is what every
    // caller effectively sent before. The distinction matters: two different
    // `notes.md` are ONE document under the bare name and two under their paths,
    // and a reader who only sees "notes.md" cannot tell which one made a claim.
    source_ref: Option<&str>,
) -> Result<Uuid> {
    enforce_classification_ceiling(&state.db, claims, classification_level_id).await?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    let mimetype = mime_for_filename(file_name);

    let job_id = Uuid::new_v4();
    sqlx::query("UPDATE users SET tokens_balance = GREATEST(0, tokens_balance - 5) WHERE id = $1")
        .bind(claims.sub).execute(&state.db).await?;

    let (resolved_ontology_id, entity_types) = resolve_ontology(&state.db, claims.sub, ontology_id).await;

    // P2b: identity keyed on (user, path). The caller's `sourceRef` IS that path
    // when it sent one (CLI sends the absolute path, the SDK the connector
    // location, an agent the original URL); otherwise the bare file name stands
    // in, as it always did. No source-side mtime either way — neither browser nor
    // agent sends one — so modified_at stays unknown.
    let source_path = source_ref
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(file_name);
    let content_hash = crate::services::source_docs::hash_content(bytes);
    let source_doc = crate::services::source_docs::resolve_source_document(
        &state.db, claims.sub, None, source_path, Some(file_name),
        &content_hash, None,
    ).await.ok();
    let source_document_id = source_doc.as_ref().map(|d| d.id);

    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id, source_document_id, api_key_id)
         VALUES ($1, $2, 'kex_upload', 'pending', $3, $4, $5, $6)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({
        "fileName": file_name,
        // Kept alongside fileName so the readable-provenance chain
        // (COALESCE(fileName, sourceRef, …)) can show the full location.
        "sourceRef": source_ref,
        "ontologyId": resolved_ontology_id,
    }))
    .bind(classification_level_id)
    .bind(source_document_id)
    .bind(claims.api_key_id)
    .execute(&state.db).await?;

    record_usage(&state.db, claims.sub, "kex_upload", 5, Some(job_id)).await;

    // Link into the target compilation: explicit choice, else the user's default
    // knowledge base, so the upload is never orphaned.
    link_job_to_target_or_default(&state.db, claims, compilation_id, job_id).await;

    let classification_name: Option<String> = if let Some(clf_id) = classification_level_id {
        sqlx::query_scalar("SELECT name FROM classification_levels WHERE id = $1")
            .bind(clf_id).fetch_optional(&state.db).await.ok().flatten()
    } else {
        None
    };

    // KEX worker parses `input` as a JSON string with fileBase64, mimetype, originalFilename
    let kex_input = json!({
        "fileBase64": encoded,
        "mimetype": mimetype,
        "originalFilename": file_name,
    }).to_string();

    let mut payload = json!({
        "job_id": job_id, "user_id": claims.sub, "type": "file",
        "input": kex_input, "file_name": file_name, "entity_types": entity_types,
        "ontology_id": resolved_ontology_id,
        "classification": classification_name,
        "classification_level_id": classification_level_id,
        "source_document_id": source_document_id,
        "source_path": source_path,
        "source_modified_at": Value::Null,
    });
    crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(job_id)
}

/// Re-push a FAILED text extraction. The full text is retained in `jobs.input`,
/// so we reset the SAME row to pending and re-push the worker payload — the
/// compilation link + source-document identity already stand, and no credit is
/// re-charged (the original attempt already recorded the spend).
async fn repush_text_job(
    state: &Arc<crate::models::AppState>,
    user_id: Uuid,
    job_id: Uuid,
    input: &Value,
    text: &str,
    classification_level_id: Option<Uuid>,
    source_document_id: Option<Uuid>,
) -> Result<()> {
    let requested = input["ontologyId"].as_str().and_then(|s| Uuid::parse_str(s).ok());
    let (ontology_id, entity_types) = resolve_ontology(&state.db, user_id, requested).await;
    let source_path = input["sourceRef"].as_str().map(String::from).unwrap_or_else(|| {
        let preview: String = text.chars().take(60).collect();
        format!("text:{preview}")
    });
    let classification_name: Option<String> = if let Some(c) = classification_level_id {
        sqlx::query_scalar("SELECT name FROM classification_levels WHERE id = $1")
            .bind(c).fetch_optional(&state.db).await.ok().flatten()
    } else {
        None
    };

    sqlx::query(
        "UPDATE jobs SET status = 'pending', error = NULL, completed_at = NULL, updated_at = NOW() \
         WHERE id = $1 AND user_id = $2"
    )
    .bind(job_id).bind(user_id).execute(&state.db).await?;

    let mut payload = json!({
        "job_id": job_id, "user_id": user_id, "type": "text",
        "input": text, "entity_types": entity_types,
        "ontology_id": ontology_id,
        "classification": classification_name,
        "classification_level_id": classification_level_id,
        "source_document_id": source_document_id,
        "source_path": source_path,
        "source_modified_at": Value::Null,
    });
    crate::services::llm::inject_ollama_overrides(&state.db, user_id, &mut payload).await;
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

/// POST /api/kex/jobs/:id/retry — re-run ONE failed job without re-uploading.
/// Text extracts reset in place; connector jobs (Drive/SharePoint) re-fetch from
/// their retained source reference. Free (no re-charge). Non-retryable types
/// (direct upload, repo) return a clear error. Preflight balance check so a retry
/// with no credits surfaces "insufficient credits" instead of silently re-failing.
async fn retry_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(job_id): Path<Uuid>,
) -> Result<Json<Value>> {
    let (jtype, status, input, clf, source_doc_id, result) = sqlx::query_as::<_, (String, String, Value, Option<Uuid>, Option<Uuid>, Option<Value>)>(
        "SELECT type, status, input, classification_level_id, source_document_id, result \
         FROM jobs WHERE id = $1 AND user_id = $2"
    )
    .bind(job_id).bind(claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;

    // A `completed_degraded` job (entities written, relations/embeddings skipped
    // because the LLM or embedder was unreachable) is retryable too: once the
    // runtime is fixed, re-running it in place adds the missing edges and vectors.
    // Without this the user was stuck with a graph of isolated nodes (2026-09-25,
    // Bifroest demo: 577 nodes, 0 relations) and could only delete and re-upload.
    let (presented, _) = presented_status(&status, result.as_ref());
    if status != "failed" && presented != "completed_degraded" {
        return Err(AppError::BadRequest(format!("only failed or incomplete jobs can be retried (current status: {presented})")));
    }
    // Unlimited tiers (business/enterprise + transitional starter/pro aliases)
    // never block on the local balance — tokens_balance keeps tracking spend,
    // it just can't gate work.
    let (balance, tier): (i32, String) = sqlx::query_as(
        "SELECT tokens_balance, tier FROM users WHERE id = $1"
    ).bind(claims.sub).fetch_one(&state.db).await?;
    if balance <= 0 && !crate::routes::billing::is_unlimited_tier(&tier) {
        return Err(AppError::BadRequest("Insufficient credits — top up before retrying".into()));
    }

    match jtype.as_str() {
        "kex_extract" => {
            let text = input["text"].as_str()
                .ok_or_else(|| AppError::BadRequest("this extraction retains no text (repo/upload) — re-ingest required".into()))?;
            repush_text_job(&state, claims.sub, job_id, &input, text, clf, source_doc_id).await?;
            Ok(Json(json!({ "ok": true, "jobId": job_id, "status": "pending" })))
        }
        "kex_connector" | "kex_sharepoint" => {
            let new_id = crate::routes::connectors::retry_connector_job(&state, claims.sub, &jtype, &input, clf).await?;
            // Replace the failed row with the fresh pending job (keeps history clean).
            sqlx::query("DELETE FROM jobs WHERE id = $1 AND user_id = $2")
                .bind(job_id).bind(claims.sub).execute(&state.db).await?;
            Ok(Json(json!({ "ok": true, "jobId": new_id, "status": "pending" })))
        }
        other => Err(AppError::BadRequest(format!("job type '{other}' is not retryable — re-upload required"))),
    }
}

/// POST /api/kex/jobs/retry-failed — re-run ALL retryable failed jobs for the
/// user. Runs in the background (a large connector batch means many synchronous
/// re-downloads), so it returns immediately with the count queued; watch the jobs
/// list for progress. Per-job failures are logged, not fatal.
async fn retry_failed(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // Same unlimited-tier bypass as retry_job: never block a business/enterprise
    // user on the local tracking balance.
    let (balance, tier): (i32, String) = sqlx::query_as(
        "SELECT tokens_balance, tier FROM users WHERE id = $1"
    ).bind(claims.sub).fetch_one(&state.db).await?;
    if balance <= 0 && !crate::routes::billing::is_unlimited_tier(&tier) {
        return Err(AppError::BadRequest("Insufficient credits — top up before retrying".into()));
    }

    let rows = sqlx::query_as::<_, (Uuid, String, Value, Option<Uuid>, Option<Uuid>)>(
        "SELECT id, type, input, classification_level_id, source_document_id \
         FROM jobs WHERE user_id = $1 AND status = 'failed' \
           AND type IN ('kex_extract','kex_connector','kex_sharepoint') \
         ORDER BY created_at DESC LIMIT 1000"
    )
    .bind(claims.sub)
    .fetch_all(&state.db).await?;

    let count = rows.len();
    let st = state.clone();
    let uid = claims.sub;
    tokio::spawn(async move {
        for (id, jtype, input, clf, sdoc) in rows {
            let r: Result<()> = match jtype.as_str() {
                "kex_extract" => match input["text"].as_str() {
                    Some(text) => repush_text_job(&st, uid, id, &input, text, clf, sdoc).await,
                    None => continue,
                },
                "kex_connector" | "kex_sharepoint" => {
                    match crate::routes::connectors::retry_connector_job(&st, uid, &jtype, &input, clf).await {
                        Ok(_) => {
                            let _ = sqlx::query("DELETE FROM jobs WHERE id = $1 AND user_id = $2")
                                .bind(id).bind(uid).execute(&st.db).await;
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }
                _ => continue,
            };
            if let Err(e) = r {
                tracing::warn!("retry_failed: job {id} re-enqueue failed: {e}");
            }
        }
    });

    Ok(Json(json!({ "retrying": count })))
}

async fn list_jobs(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<JobsQuery>,
) -> Result<Json<Value>> {
    let limit  = q.limit.unwrap_or(20).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let scope = job_read_scope(&state.db, &claims, truthy(q.all.as_deref())).await;
    let (token_id, token_web) = match q.token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None        => (None, false),
        Some("web") => (None, true),
        Some(s)     => (
            Some(s.parse::<Uuid>().map_err(|_| AppError::BadRequest(
                "token must be an access-token id or 'web'".into()))?),
            false,
        ),
    };
    let pattern = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(like_pattern);

    let rows: Vec<JobRow> = sqlx::query_as(&format!(
        "SELECT {JOB_COLUMNS} {JOB_JOINS} WHERE {JOB_LIST_WHERE}
         ORDER BY j.created_at DESC LIMIT $7 OFFSET $8"
    ))
    .bind(scope.user_id).bind(scope.api_key_id)
    .bind(token_id).bind(token_web).bind(q.kb).bind(&pattern)
    .bind(limit).bind(offset)
    .fetch_all(&state.db).await?;

    // Real totals over the SAME filter, not the page: the dashboard used to count
    // the returned page (capped at the default limit of 20) and showed "20
    // extractions" forever.
    let (total, completed_total): (i64, i64) = sqlx::query_as(&format!(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE j.status = 'completed')
         {JOB_JOINS} WHERE {JOB_LIST_WHERE}"
    ))
    .bind(scope.user_id).bind(scope.api_key_id)
    .bind(token_id).bind(token_web).bind(q.kb).bind(&pattern)
    .fetch_one(&state.db).await?;

    let ids: Vec<Uuid> = rows.iter().map(|r| r.0).collect();
    let mut comps = compilations_of_jobs(&state.db, &claims, &ids).await;
    let jobs: Vec<Value> = rows.into_iter().map(|r| {
        let c = comps.remove(&r.0).unwrap_or_default();
        job_json(r, c)
    }).collect();
    let has_more = (offset + jobs.len() as i64) < total;

    Ok(Json(json!({ "jobs": jobs, "total": total, "completed": completed_total, "hasMore": has_more })))
}

#[derive(Deserialize)]
struct JobsQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    /// ILIKE over token name, user e-mail and the input's file name / source ref.
    search: Option<String>,
    /// An access-token id, or the literal `web` for jobs triggered from a
    /// signed-in session (`api_key_id IS NULL`).
    token: Option<String>,
    /// Only jobs that are part of this compilation's `source_job_ids`.
    kb: Option<Uuid>,
    /// `1` / `true`: every user's jobs. Honoured for an admin SESSION only; a
    /// delegated token never crosses the account boundary, whatever it asks for.
    all: Option<String>,
}

/// An admin signed in with a session (not a delegated token) may look at and
/// remove any user's jobs.
pub(crate) fn is_admin_session(claims: &JwtClaims) -> bool {
    claims.role == "admin" && claims.api_key_id.is_none()
}

fn truthy(v: Option<&str>) -> bool {
    matches!(v.map(str::trim), Some("1") | Some("true") | Some("yes"))
}

/// `%term%` with the LIKE wildcards of the term itself escaped, so a search for
/// `report_2026` does not match `reportX2026`. Postgres' default escape is `\`.
pub(crate) fn like_pattern(term: &str) -> String {
    let mut s = String::with_capacity(term.len() + 2);
    s.push('%');
    for ch in term.chars() {
        if matches!(ch, '\\' | '%' | '_') { s.push('\\'); }
        s.push(ch);
    }
    s.push('%');
    s
}

/// Who the job list / job detail shows. `user_id = None` only for an admin
/// session that asked for `all`; `api_key_id = Some` confines a KB-scoped token
/// to the jobs it triggered itself (a full-owner token sees the whole account,
/// like the owner's session).
struct JobReadScope { user_id: Option<Uuid>, api_key_id: Option<Uuid> }

async fn job_read_scope(db: &sqlx::PgPool, claims: &JwtClaims, want_all: bool) -> JobReadScope {
    if want_all && is_admin_session(claims) {
        return JobReadScope { user_id: None, api_key_id: None };
    }
    let key = if crate::routes::kg::api_key_scope(db, claims).await.is_some() {
        claims.api_key_id
    } else {
        None
    };
    JobReadScope { user_id: Some(claims.sub), api_key_id: key }
}

/// Row shape shared by the job list and the job detail: the job, plus the
/// token that triggered it and the account it belongs to.
type JobRow = (
    Uuid, String, String, Value, Option<Value>, Option<String>,
    chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>,
    Option<Uuid>, Option<String>, Option<String>, Uuid,
);

const JOB_COLUMNS: &str =
    "j.id, j.type, j.status, j.input, j.result, j.error, j.created_at, j.completed_at,
     j.api_key_id, ak.name, u.email, j.user_id";

const JOB_JOINS: &str =
    "FROM jobs j
     LEFT JOIN api_keys ak ON ak.id = j.api_key_id
     LEFT JOIN users u ON u.id = j.user_id";

/// Filter of the job list; bound as $1 user (NULL = every user), $2 own token
/// (NULL = unrestricted), $3 token filter, $4 "web only", $5 compilation,
/// $6 ILIKE pattern. The list query and its count query share it so the totals
/// can never drift from the page.
const JOB_LIST_WHERE: &str =
    "j.type IN ('kex_extract','kex_upload','kex_connector')
     AND ($1::uuid IS NULL OR j.user_id = $1)
     AND ($2::uuid IS NULL OR j.api_key_id = $2)
     AND ($3::uuid IS NULL OR j.api_key_id = $3)
     AND (NOT $4::bool OR j.api_key_id IS NULL)
     AND ($5::uuid IS NULL OR EXISTS (
           SELECT 1 FROM compilations c WHERE c.id = $5 AND j.id = ANY(c.source_job_ids)))
     AND ($6::text IS NULL
          OR ak.name ILIKE $6 OR u.email ILIKE $6
          OR j.input->>'fileName' ILIKE $6 OR j.input->>'originalFilename' ILIKE $6
          OR j.input->>'sourceRef' ILIKE $6 OR j.input->>'source' ILIKE $6)";

/// Best-effort display name of what a job ingested, from the keys the ingest
/// paths write: `fileName` (upload / extract / agent store), `originalFilename`
/// (KEX payload), `sourceRef` (where it came from). `source` is a kind
/// ("agent_store", "repo"), not a name, so it is not a candidate.
pub(crate) fn job_file_name(input: &Value) -> Option<String> {
    ["fileName", "originalFilename", "sourceRef"].iter()
        .filter_map(|k| input.get(*k).and_then(|v| v.as_str()))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

/// `{id, name}` of every compilation whose `source_job_ids` carries each of the
/// jobs — one query for a whole page.
pub(crate) async fn compilations_of_jobs(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
    job_ids: &[Uuid],
) -> std::collections::HashMap<Uuid, Vec<Value>> {
    // Only knowledge bases the CALLER may see: an admin session sees every owner's,
    // everyone else only the account's own, and a KB-scoped token only its granted
    // ones. Without this a scoped token learned the names of every knowledge base
    // its owner had filed one of its jobs into.
    let mut out: std::collections::HashMap<Uuid, Vec<Value>> = Default::default();
    if job_ids.is_empty() { return out; }
    let owner: Option<Uuid> = if is_admin_session(claims) { None } else { Some(claims.sub) };
    let scope = crate::routes::kg::api_key_scope(db, claims).await;
    let rows: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT x.job_id, c.id, c.name
           FROM compilations c, unnest(c.source_job_ids) AS x(job_id)
          WHERE x.job_id = ANY($1)
            AND ($2::uuid IS NULL OR c.user_id = $2)
          ORDER BY c.name"
    ).bind(job_ids).bind(owner).fetch_all(db).await.unwrap_or_default();
    for (job, cid, name) in rows {
        if let Some(set) = &scope {
            if !set.contains(&cid) { continue; }
        }
        out.entry(job).or_default().push(json!({ "id": cid, "name": name }));
    }
    out
}

fn job_json(row: JobRow, compilations: Vec<Value>) -> Value {
    let (id, t, status, input, result, error, created, completed,
         api_key_id, token_name, user_email, _owner) = row;
    let (status, degraded_reason) = presented_status(&status, result.as_ref());
    let file_name = job_file_name(&input);
    json!({
        "id": id, "type": t, "status": status,
        "degradedReason": degraded_reason,
        "input": input, "result": result, "error": error,
        "createdAt": created, "completedAt": completed,
        "apiKeyId": api_key_id,
        "tokenName": token_name,
        "userEmail": user_email,
        "fileName": file_name,
        "compilationIds": compilations,
    })
}

// Frontend KexJobDetail expects `{ job: ... }` wrapper.
async fn get_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // An admin session may open any user's job; everyone else is confined like
    // the list (own account; a KB-scoped token to its own jobs).
    let scope = job_read_scope(&state.db, &claims, true).await;
    let row: Option<JobRow> = sqlx::query_as(&format!(
        "SELECT {JOB_COLUMNS} {JOB_JOINS}
         WHERE j.id = $1
           AND ($2::uuid IS NULL OR j.user_id = $2)
           AND ($3::uuid IS NULL OR j.api_key_id = $3)"
    ))
    .bind(id).bind(scope.user_id).bind(scope.api_key_id)
    .fetch_optional(&state.db).await?;
    let row = row.ok_or(AppError::NotFound)?;

    let comps = compilations_of_jobs(&state.db, &claims, &[id]).await.remove(&id).unwrap_or_default();
    let mut job = job_json(row, comps);

    let chunk_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM text_chunks WHERE job_id = $1")
        .bind(id).fetch_one(&state.db).await.unwrap_or(0);
    let sample: Vec<(Uuid, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, left(content, 160), source_document_id FROM text_chunks
          WHERE job_id = $1
          ORDER BY chunk_sequence NULLS LAST, created_at
          LIMIT 50"
    ).bind(id).fetch_all(&state.db).await.unwrap_or_default();
    job["chunks"] = json!({
        "count": chunk_count,
        "sample": sample.into_iter().map(|(cid, preview, doc)| json!({
            "id": cid, "preview": preview, "sourceDocumentId": doc,
        })).collect::<Vec<_>>(),
    });
    job["graphFootprint"] = graph_footprint(&state.neo, id).await;

    Ok(Json(json!({ "job": job })))
}

/// How much of the graph a job accounts for: elements it is a member of, and
/// those it is the ONLY member of (what a removal would actually delete).
pub(crate) fn footprint_cypher(pattern: &str, alias: &str) -> String {
    format!(
        "MATCH {pattern} WHERE {scope} \
         RETURN count({alias}) AS total, \
                count(CASE WHEN size({expr}) = 1 THEN 1 END) AS exclusive",
        scope = crate::services::neo4j::job_scope(alias, "jobs"),
        expr = crate::services::neo4j::source_jobs_expr(alias),
    )
}

async fn footprint_counts(neo: &neo4rs::Graph, cypher: &str, jobs: &[String]) -> (i64, i64) {
    match neo.execute(neo4rs::query(cypher).param("jobs", jobs.to_vec())).await {
        Ok(mut stream) => match stream.next().await {
            Ok(Some(row)) => (
                row.get::<i64>("total").unwrap_or(0),
                row.get::<i64>("exclusive").unwrap_or(0),
            ),
            _ => (0, 0),
        },
        Err(e) => {
            tracing::warn!("graph footprint query failed: {e}");
            (0, 0)
        }
    }
}

async fn graph_footprint(neo: &neo4rs::Graph, job_id: Uuid) -> Value {
    let jobs = vec![job_id.to_string()];
    let (nodes, nodes_exclusive) = footprint_counts(neo, &footprint_cypher("(n)", "n"), &jobs).await;
    let (rels, rels_exclusive)   = footprint_counts(neo, &footprint_cypher("()-[r]->()", "r"), &jobs).await;
    json!({
        "nodes": nodes, "nodesExclusive": nodes_exclusive,
        "rels": rels, "relsExclusive": rels_exclusive,
    })
}

// Frontend KexJobDetail expects shape `{ jobId, status, completedAt, result }`.
async fn get_result(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, (String, Option<Value>, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT status, result, completed_at FROM jobs WHERE id = $1 AND user_id = $2"
    )
    .bind(id).bind(claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;
    let (status, result, completed_at) = row;
    let (status, degraded_reason) = presented_status(&status, result.as_ref());
    Ok(Json(json!({
        "jobId": id,
        "status": status,
        "degradedReason": degraded_reason,
        "completedAt": completed_at,
        "result": result,
    })))
}

async fn cancel_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("UPDATE jobs SET status='failed', error='Cancelled by user', updated_at=NOW() WHERE id=$1 AND user_id=$2")
        .bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/kex/jobs/:id — remove the extraction and everything it put into
/// the stores. See `remove_job_everywhere`.
async fn delete_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(Json(remove_job_everywhere(&state, &claims, id).await?))
}

#[derive(Deserialize)]
struct UnlinkReq {
    #[serde(rename = "compilationId")] compilation_id: Uuid,
}

/// POST /api/kex/jobs/:id/unlink { compilationId } — take the extraction out of
/// ONE knowledge base. See `unlink_job_from_compilation`.
async fn unlink_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UnlinkReq>,
) -> Result<Json<Value>> {
    Ok(Json(unlink_job_from_compilation(&state, &claims, id, req.compilation_id).await?))
}

/// What a mutation needs to know about a job once the caller is allowed to touch it.
struct JobRef {
    user_id: Uuid,
    api_key_id: Option<Uuid>,
    file_name: Option<String>,
    source_document_id: Option<Uuid>,
}

/// Load a job for a mutation and settle who may touch it:
///   * an admin session: any user's job;
///   * otherwise the caller's own job (a foreign id reads as not found, so the
///     id's existence is never confirmed);
///   * a KB-scoped token: only the jobs it triggered itself.
/// Then every compilation that still references the job must be writable for
/// the caller — `enforce_kb_write_scope` (grant set + read-only grants) and the
/// Codebase-access capability for CODE knowledge bases.
async fn load_job_for_mutation(db: &sqlx::PgPool, claims: &JwtClaims, job_id: Uuid) -> Result<JobRef> {
    let row: Option<(Uuid, Option<Uuid>, Value, Option<Uuid>)> = sqlx::query_as(
        "SELECT user_id, api_key_id, input, source_document_id FROM jobs WHERE id = $1"
    ).bind(job_id).fetch_optional(db).await?;
    let Some((user_id, api_key_id, input, source_document_id)) = row else {
        return Err(AppError::NotFound);
    };
    if !is_admin_session(claims) {
        if user_id != claims.sub { return Err(AppError::NotFound); }
        if crate::routes::kg::api_key_scope(db, claims).await.is_some()
            && api_key_id != claims.api_key_id
        {
            return Err(AppError::Forbidden(
                "This access token may only remove extractions it triggered itself".into()));
        }
    }
    let cids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM compilations WHERE $1 = ANY(source_job_ids)"
    ).bind(job_id).fetch_all(db).await?;
    for cid in cids {
        crate::routes::kg::enforce_kb_write_scope(db, claims, cid).await?;
        crate::routes::kg::enforce_code_capability(db, claims, cid).await?;
    }
    Ok(JobRef { user_id, api_key_id, file_name: job_file_name(&input), source_document_id })
}

/// Names of the nodes ONLY this job produced. Read before the purge — afterwards
/// nothing maps them back to the job. Capped; a dossier that slips through the
/// cap is still caught by the `origin_files` match on the file name.
async fn exclusive_node_names(neo: &neo4rs::Graph, job_id: Uuid) -> Vec<String> {
    let cypher = format!(
        "MATCH (n) WHERE {scope} AND size({expr}) = 1 AND n.name IS NOT NULL \
         RETURN DISTINCT n.name AS name LIMIT 5000",
        scope = crate::services::neo4j::job_scope("n", "jobs"),
        expr = crate::services::neo4j::source_jobs_expr("n"),
    );
    let mut names = Vec::new();
    match neo.execute(neo4rs::query(&cypher).param("jobs", vec![job_id.to_string()])).await {
        Ok(mut stream) => {
            while let Ok(Some(row)) = stream.next().await {
                if let Ok(name) = row.get::<String>("name") { names.push(name); }
            }
        }
        Err(e) => tracing::warn!("job {job_id}: exclusive node names query failed: {e}"),
    }
    names
}

/// Best-effort Qdrant cleanup for a whole job: the explicit point ids (the chunk
/// rows we just deleted) AND a filter delete on the payload's `job_id`, which
/// also catches points whose row was already gone. Returns how many explicit
/// points were acknowledged.
async fn delete_job_vectors(state: &Arc<crate::models::AppState>, job_id: Uuid, point_ids: &[String]) -> usize {
    let collection = qdrant_collection(state).await;
    let url = format!(
        "{}/collections/{}/points/delete?wait=true",
        state.cfg.qdrant_url.trim_end_matches('/'),
        collection
    );
    let client = reqwest::Client::new();
    let mut deleted = 0usize;
    if !point_ids.is_empty() {
        match client.post(&url).json(&json!({ "points": point_ids })).send().await {
            Ok(r) if r.status().is_success() => deleted = point_ids.len(),
            Ok(r) => tracing::warn!("job {job_id}: qdrant points/delete returned {}", r.status()),
            Err(e) => tracing::warn!("job {job_id}: qdrant points/delete failed: {e}"),
        }
    }
    let by_job = json!({ "filter": { "must": [
        { "key": "job_id", "match": { "value": job_id.to_string() } }
    ]}});
    match client.post(&url).json(&by_job).send().await {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => tracing::warn!("job {job_id}: qdrant delete-by-job_id returned {}", r.status()),
        Err(e) => tracing::warn!("job {job_id}: qdrant delete-by-job_id failed: {e}"),
    }
    deleted
}

/// Remove an extraction job AND its cross-store footprint. Shared by
/// `DELETE /kex/jobs/:id`, by `unlink` when the last knowledge base lets go of
/// the job, and by the agent's `delete_extraction`.
///
/// In order:
///   1. names of the nodes only this job produced (before the purge);
///   2. its chunks — Postgres rows, point ids collected first;
///   3. its membership in every compilation's `source_job_ids`;
///   4. the graph: every element drops this job from `_source_jobs`, and
///      whatever ends up with an empty list is deleted (`neo4j::purge_jobs`) —
///      nodes are URI-merged across jobs, so what other jobs also produced
///      survives, minus one contributor;
///   5. dossiers compiled from those nodes (by name, or by the file in
///      `origin_files`) are marked `stale`, not deleted;
///   6. a `knowledge_corrections` row remembers the removal;
///   7. the job row, then the source document if nothing references it any more;
///   8. Qdrant, best-effort, after the authoritative Postgres deletes.
/// token_usage / sync-history rows survive via ON DELETE SET NULL (migration
/// 070) — they are billing/audit history, not job data.
pub async fn remove_job_everywhere(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    job_id: Uuid,
) -> Result<Value> {
    let job = load_job_for_mutation(&state.db, claims, job_id).await?;
    let owner = job.user_id;

    let exclusive_names = exclusive_node_names(&state.neo, job_id).await;

    let chunk_rows: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT id, qdrant_point_id FROM text_chunks WHERE job_id = $1 AND user_id = $2"
    ).bind(job_id).bind(owner).fetch_all(&state.db).await.unwrap_or_default();
    let point_ids: Vec<String> = chunk_rows.into_iter()
        .map(|(cid, point)| chunk_point_id(point, cid))
        .collect();
    let chunks_deleted = sqlx::query("DELETE FROM text_chunks WHERE job_id = $1 AND user_id = $2")
        .bind(job_id).bind(owner).execute(&state.db).await?.rows_affected();

    let compilations_unlinked = sqlx::query(
        "UPDATE compilations SET source_job_ids = array_remove(source_job_ids, $1), updated_at = NOW()
         WHERE $1 = ANY(source_job_ids)"
    ).bind(job_id).execute(&state.db).await?.rows_affected();

    // Graph footprint before the row: after the DELETE nothing maps a node back
    // to this job.
    let purged = crate::services::neo4j::purge_jobs(&state.neo, &[job_id]).await;

    let names_lower: Vec<String> = exclusive_names.iter().map(|n| n.to_lowercase()).collect();
    let dossiers_staled = sqlx::query(
        "UPDATE entity_dossiers SET stale = true
          WHERE user_id = $1 AND stale = false
            AND (lower(entity_name) = ANY($2)
                 OR ($3::text IS NOT NULL AND $3 = ANY(origin_files)))"
    ).bind(owner).bind(&names_lower).bind(&job.file_name)
     .execute(&state.db).await
     .map(|r| r.rows_affected())
     .unwrap_or_else(|e| { tracing::warn!("job {job_id}: dossiers not marked stale: {e}"); 0 });

    let reason = format!(
        "removed by {}{}",
        claims.email,
        job.file_name.as_deref().map(|f| format!("; file {f}")).unwrap_or_default(),
    );
    let _ = sqlx::query(
        "INSERT INTO knowledge_corrections
            (user_id, compilation_id, element_kind, head, rel_type, tail, action, reason)
         VALUES ($1, NULL, 'job', $2, NULL, $3, 'job_removed', $4)"
    ).bind(owner).bind(job_id.to_string()).bind(job.api_key_id.map(|k| k.to_string())).bind(&reason)
     .execute(&state.db).await
     .map_err(|e| tracing::warn!("job {job_id}: removal not remembered: {e}"));

    sqlx::query("DELETE FROM jobs WHERE id = $1").bind(job_id).execute(&state.db).await?;

    // The document identity goes with its last job; a version another job or
    // chunk still points at stays.
    let mut source_documents_deleted = 0u64;
    if let Some(doc) = job.source_document_id {
        source_documents_deleted = sqlx::query(
            "DELETE FROM source_documents sd
              WHERE sd.id = $1
                AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.source_document_id = sd.id)
                AND NOT EXISTS (SELECT 1 FROM text_chunks tc WHERE tc.source_document_id = sd.id)"
        ).bind(doc).execute(&state.db).await
         .map(|r| r.rows_affected())
         .unwrap_or_else(|e| { tracing::warn!("job {job_id}: source document not deleted: {e}"); 0 });
    }

    let vectors_deleted = delete_job_vectors(state, job_id, &point_ids).await;

    let eff = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
    crate::services::audit::log_access(&state.db, claims, "job.delete",
        "job", &job_id.to_string(), eff, None, true, None).await;

    Ok(json!({
        "ok": true,
        "chunksDeleted": chunks_deleted,
        "vectorsDeleted": vectors_deleted,
        "nodesDeleted": purged.nodes_deleted,
        "relationshipsDeleted": purged.rels_deleted,
        "sourceDocumentsDeleted": source_documents_deleted,
        "dossiersStaled": dossiers_staled,
        "compilationsUnlinked": compilations_unlinked,
    }))
}

/// Does the compilation hold FUSE-merged entities? Then a membership change
/// leaves the merged layer behind until FUSE runs again.
async fn has_merged_nodes(neo: &neo4rs::Graph, compilation_id: Uuid) -> bool {
    let q = neo4rs::query(
        "MATCH (e:Entity:Merged {_compilation: $cid}) RETURN count(e) > 0 AS has"
    ).param("cid", compilation_id.to_string());
    match neo.execute(q).await {
        Ok(mut stream) => match stream.next().await {
            Ok(Some(row)) => row.get::<bool>("has").unwrap_or(false),
            _ => false,
        },
        Err(e) => { tracing::warn!("compilation {compilation_id}: merged-node check failed: {e}"); false }
    }
}

/// Queue a FUSE re-run for a compilation over its CURRENT source jobs (the
/// refresh path). Used by `POST /kg/compilations/:id/refresh`, by the agent's
/// `refresh_compilation`, by the unlink path, by a "not the same" merge-review
/// answer and by the decision memory when it replays such an answer.
/// `NotFound` when the compilation is not the user's. Returns the fuse job id.
pub(crate) async fn enqueue_fuse_refresh(
    state: &crate::models::AppState,
    user_id: Uuid,
    api_key_id: Option<Uuid>,
    compilation_id: Uuid,
) -> Result<Uuid> {
    let (source_ids, classification, name): (Vec<Uuid>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT COALESCE(source_job_ids,'{}'::uuid[]), classification::text, name FROM compilations WHERE id=$1 AND user_id=$2",
    )
        .bind(compilation_id).bind(user_id).fetch_optional(&state.db).await?
        .ok_or(AppError::NotFound)?;
    let job_id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs (id,user_id,type,status,input,api_key_id) VALUES ($1,$2,'fuse_merge','pending',$3,$4)")
        .bind(job_id).bind(user_id)
        .bind(json!({ "compilationId": compilation_id, "sourceJobIds": source_ids, "name": name }))
        .bind(api_key_id)
        .execute(&state.db).await?;
    // The worker needs the same payload a fresh merge gets (routes::fuse):
    // user, classification and name — a refresh used to send none of them.
    lpush(&state.redis, "fuse:jobs", &json!({
        "job_id": job_id, "compilation_id": compilation_id, "source_job_ids": source_ids,
        "user_id": user_id, "classification": classification, "name": name,
    }).to_string())
        .await.map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(job_id)
}

/// Take a job out of ONE knowledge base. Shared by `POST /kex/jobs/:id/unlink`,
/// by `PUT /kg/compilations/:id` (a shrunken `sourceJobIds`) and by the agent's
/// `delete_extraction` with a `compilationId`.
///
/// If no other compilation references the job afterwards, the job is removed
/// everywhere (`remove_job_everywhere`) — an extraction nobody can reach is
/// garbage, not an archive. Otherwise only the membership changes; the raw nodes
/// stay for the other knowledge bases, and a compilation that holds FUSE-merged
/// entities gets a fusion re-run queued so its merged layer follows.
pub(crate) async fn unlink_job_from_compilation(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    job_id: Uuid,
    compilation_id: Uuid,
) -> Result<Value> {
    let job = load_job_for_mutation(&state.db, claims, job_id).await?;
    crate::routes::kg::enforce_kb_write_scope(&state.db, claims, compilation_id).await?;
    crate::routes::kg::enforce_code_capability(&state.db, claims, compilation_id).await?;

    let removed = sqlx::query(
        "UPDATE compilations SET source_job_ids = array_remove(source_job_ids, $1), updated_at = NOW()
         WHERE id = $2 AND user_id = $3 AND $1 = ANY(source_job_ids)"
    ).bind(job_id).bind(compilation_id).bind(job.user_id)
     .execute(&state.db).await?.rows_affected();
    if removed == 0 { return Err(AppError::NotFound); }

    let still_referenced: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM compilations WHERE $1 = ANY(source_job_ids))"
    ).bind(job_id).fetch_one(&state.db).await?;

    if !still_referenced {
        let mut out = remove_job_everywhere(state, claims, job_id).await?;
        out["purged"] = json!(true);
        out["refreshQueued"] = json!(false);
        out["compilationsUnlinked"] = json!(1);
        return Ok(out);
    }

    let refresh_queued = has_merged_nodes(&state.neo, compilation_id).await
        && enqueue_fuse_refresh(state, job.user_id, claims.api_key_id, compilation_id).await.is_ok();

    let eff = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
    crate::services::audit::log_access(&state.db, claims, "job.unlink",
        "job", &job_id.to_string(), eff, Some("compilation"), true, None).await;

    Ok(json!({
        "ok": true,
        "purged": false,
        "refreshQueued": refresh_queued,
        "nodesDeleted": 0,
        "relationshipsDeleted": 0,
        "chunksDeleted": 0,
        "vectorsDeleted": 0,
    }))
}

/// Redis key the KEX worker's config-watcher polls to scale its thread pool.
const KEX_THREADS_KEY: &str = "kex:config:threads";

async fn queue_depth(State(state): State<Arc<crate::models::AppState>>) -> Result<Json<Value>> {
    let depth = crate::services::redis::llen(&state.redis, "kex:jobs").await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    // Current desired worker-thread count (what the KEX pool scales to). Defaults
    // to 1 when unset. The frontend's "N threads" selector reads this back, so it
    // must survive a poll — that's why the PUT below persists it in Redis.
    let threads = crate::services::redis::get(&state.redis, KEX_THREADS_KEY).await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(1)
        .clamp(1, 10);
    Ok(Json(json!({ "depth": depth, "threads": threads })))
}

/// GET /api/kex/model-status — proxy the KEX worker's NER-model warmup status so
/// the dashboard can show a first-run "extraction engine is initialising" notice
/// with progress. Never errors: if KEX isn't serving yet (still booting), report
/// a "starting" state so the UI still shows the notice.
async fn model_status(State(state): State<Arc<crate::models::AppState>>) -> Json<Value> {
    let url = format!("{}/model-status", state.cfg.kex_worker_url.trim_end_matches('/'));
    let fallback = json!({ "state": "starting", "progress": 0, "attempt": 0, "detail": "" });
    let body = match reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or(fallback),
        _ => fallback,
    };
    Json(body)
}

#[derive(Deserialize)]
struct ThreadsReq { threads: i64 }

/// PUT /api/kex/threads — set how many KEX extraction worker threads run in
/// parallel. Persisted in Redis (`kex:config:threads`); the worker's config-
/// watcher picks the change up within ~1s and scales its pool up/down. Clamped
/// to 1..=10 to match the worker's own bound.
async fn set_threads(
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<ThreadsReq>,
) -> Result<Json<Value>> {
    let threads = req.threads.clamp(1, 10);
    crate::services::redis::set(&state.redis, KEX_THREADS_KEY, &threads.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "ok": true, "threads": threads })))
}

// ── Chunks lookup (powers the Node Detail drawer's "Chunks" tab) ──────────────

#[derive(Deserialize)]
struct ChunksQuery {
    entity:         String,
    #[serde(rename = "compilationId")]
    compilation_id: Option<Uuid>,
    limit:          Option<i64>,
    offset:         Option<i64>,
}

/// GET /api/kex/chunks?entity=Berlin[&compilationId=...&limit=20&offset=0]
///
/// List text chunks that mention a given entity name, scoped to the
/// authenticated user. Matches either the structured `entity_mentions`
/// JSONB array (preferred — exact name match via `@>`) or a raw ILIKE
/// fallback against the chunk content (catches mentions the extractor
/// missed in the structured field). A single round-trip via a window
/// function returns the total row count alongside the page.
async fn list_chunks(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<ChunksQuery>,
) -> Result<Json<Value>> {
    if q.entity.trim().is_empty() {
        return Err(AppError::BadRequest("entity is required".into()));
    }
    let limit  = q.limit.unwrap_or(20).min(100);
    let offset = q.offset.unwrap_or(0);

    // Per-chunk clearance: hide chunks whose ingest classification exceeds the
    // caller's effective rank (raised by a per-graph grant when scoped to one).
    let eff_rank: i32 = match q.compilation_id {
        Some(cid) => crate::routes::kg::effective_rank_for_compilation(&state.db, &claims, cid).await,
        None      => crate::routes::kg::get_user_clearance_rank(&state.db, &claims).await,
    };

    let rows = sqlx::query_as::<_, (
        Uuid, Option<Uuid>, Option<Uuid>, String,
        Option<i32>, Option<i32>, Option<i32>,
        Option<Value>, chrono::DateTime<chrono::Utc>, i64,
    )>(
        // Chunk→compilation links are best-effort: KEX writes chunks with a NULL
        // compilation_id (it's set later, if ever), so a chunk mentioning the
        // entity but not yet linked must still surface for its owner. Match the
        // requested compilation OR any of the user's unlinked chunks.
        //
        // Migration 078 — Codebase access off ($7 false): CODE-origin chunks are
        // excluded IN SQL, not post-filtered, so the window-function `total` and
        // the page stay consistent. A chunk is code when its own compilation is a
        // CODE graph, or — for the NULL-compilation majority — when the job that
        // produced it feeds one (same origin rule as agent::drop_code_chunks).
        "SELECT id, job_id, compilation_id, content, start_char, end_char,
                chunk_sequence, entity_mentions, created_at,
                COUNT(*) OVER () AS total
           FROM text_chunks tc
          WHERE user_id = $1
            AND ($2::uuid IS NULL OR compilation_id = $2 OR compilation_id IS NULL)
            AND COALESCE(min_rank, 0) <= $6
            AND ($7::bool OR NOT EXISTS (
                  SELECT 1 FROM compilations c
                   WHERE c.type::text = 'CODE' AND c.user_id = tc.user_id
                     AND (c.id = tc.compilation_id
                          OR tc.job_id = ANY(COALESCE(c.source_job_ids, '{}'::uuid[])))))
            AND (
                 entity_mentions @> jsonb_build_array(jsonb_build_object('name', $3))
              OR content ILIKE '%' || $3 || '%'
            )
          ORDER BY created_at DESC
          LIMIT $4 OFFSET $5"
    )
    .bind(claims.sub)
    .bind(q.compilation_id)
    .bind(&q.entity)
    .bind(limit)
    .bind(offset)
    .bind(eff_rank)
    .bind(claims.code_access)
    .fetch_all(&state.db).await?;

    let total: i64 = rows.first().map(|r| r.9).unwrap_or(0);

    crate::services::audit::log_access(&state.db, &claims, "chunks.read",
        "entity", &q.entity, eff_rank,
        q.compilation_id.map(|_| "compilation").as_deref(), true, None).await;

    let chunks: Vec<Value> = rows.into_iter().map(|(
        id, job_id, compilation_id, content,
        start_char, end_char, chunk_sequence,
        entity_mentions, created_at, _total,
    )| {
        json!({
            "id":             id,
            "jobId":          job_id,
            "compilationId":  compilation_id,
            "content":        content,
            "startChar":      start_char,
            "endChar":        end_char,
            "chunkSequence":  chunk_sequence,
            "entityMentions": entity_mentions,
            "createdAt":      created_at,
        })
    }).collect();

    Ok(Json(json!({ "chunks": chunks, "total": total })))
}

/// DELETE /api/kex/chunks/:id
///
/// Permanently delete a text chunk from BOTH stores: the Postgres `text_chunks`
/// row and its Qdrant vector point (so RAG search can never surface it again).
/// Owner-scoped. The Qdrant point id is the `qdrant_point_id` recorded at ingest;
/// if the chunk had no vector (worker degraded), only Postgres is touched. Qdrant
/// failure is logged but not fatal — the authoritative Postgres row is removed.
async fn delete_chunk(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let vector_deleted = delete_chunk_core(&state, &claims, id).await?;
    Ok(Json(json!({ "ok": true, "vectorDeleted": vector_deleted })))
}

/// Migration 078 — mutating a chunk that belongs to a CODE knowledge base is a
/// code-KB mutation. The chunk carries no compilationId of its own in the
/// request, so the origin is resolved here (own compilation, or the job that
/// produced it) — one query, only when the capability is off.
async fn ensure_chunk_mutable(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
) -> Result<()> {
    // 088 — read-only grants: a chunk belongs to the knowledge base(s) whose
    // `compilation_id` or `source_job_ids` carry it; if this key may only READ one
    // of them, the chunk is not its to delete or supersede. Same join shape as the
    // code gate below, one query, only when the key holds read-only grants at all.
    let ro = crate::routes::kg::api_key_read_only_grants(&state.db, claims).await;
    if !ro.is_empty() {
        let ro_ids: Vec<Uuid> = ro.into_iter().collect();
        let in_ro: bool = sqlx::query_scalar(
            "SELECT EXISTS (
               SELECT 1 FROM text_chunks tc JOIN compilations c
                 ON c.user_id = tc.user_id AND c.id = ANY($3)
                AND (c.id = tc.compilation_id
                     OR tc.job_id = ANY(COALESCE(c.source_job_ids, '{}'::uuid[])))
                WHERE tc.id = $1 AND tc.user_id = $2)"
        ).bind(id).bind(claims.sub).bind(&ro_ids).fetch_one(&state.db).await.unwrap_or(false);
        if in_ro {
            return Err(AppError::Forbidden(crate::routes::kg::READ_ONLY_GRANT_DENIED.into()));
        }
    }
    if !claims.code_access {
        let is_code: bool = sqlx::query_scalar(
            "SELECT EXISTS (
               SELECT 1 FROM text_chunks tc JOIN compilations c
                 ON c.type::text = 'CODE' AND c.user_id = tc.user_id
                AND (c.id = tc.compilation_id
                     OR tc.job_id = ANY(COALESCE(c.source_job_ids, '{}'::uuid[])))
                WHERE tc.id = $1 AND tc.user_id = $2)"
        ).bind(id).bind(claims.sub).fetch_one(&state.db).await.unwrap_or(false);
        if is_code {
            return Err(AppError::Forbidden(
                "This access token has Codebase access disabled - code knowledge bases cannot be modified".into(),
            ));
        }
    }
    Ok(())
}

/// The Qdrant point that carries a chunk's vector. KEX inserts the Postgres row
/// and the Qdrant point under the SAME fresh UUID (vector_store.py `point_ids`),
/// and on the `store`/text path it never fills `qdrant_point_id`. Deleting only
/// when the column was set left ghost points behind: the row was gone, but the
/// vector search still returned the chunk (its text lives in the payload) —
/// found on Asgard 2026-09-08, three "deleted" chunks still cited. The chunk id
/// is therefore the fallback point id.
pub(crate) fn chunk_point_id(qdrant_point_id: Option<String>, chunk_id: Uuid) -> String {
    qdrant_point_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| chunk_id.to_string())
}

const QDRANT_DEFAULT_COLLECTION: &str = "GCTRL_chunks";

/// Pick the collection the vectors actually live in. The env value wins when Qdrant has it;
/// otherwise the one existing collection whose name matches case-insensitively (Qdrant names
/// ARE case-sensitive — "gctrl_chunks" vs "GCTRL_chunks" are two collections, one of them
/// empty); otherwise the default. Pure, so the decision is unit-tested.
pub(crate) fn pick_qdrant_collection(env: Option<&str>, existing: &[String]) -> String {
    let wanted = env.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(QDRANT_DEFAULT_COLLECTION);
    if existing.iter().any(|c| c == wanted) { return wanted.to_string(); }
    if let Some(c) = existing.iter().find(|c| c.eq_ignore_ascii_case(wanted)) { return c.clone(); }
    wanted.to_string()
}

static QDRANT_COLLECTION_CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// The Qdrant collection that holds the chunk vectors, resolved once against the live server.
///
/// KEX owns the collection and reads QDRANT_COLLECTION from ITS container; the API used to
/// guess the default whenever the variable was not set on its own container. On installs where
/// KEX had been configured with "gctrl_chunks" every API-side vector delete (delete_chunk,
/// supersede_chunk, delete_job) posted to a collection that does not exist and silently 404ed —
/// the row was gone, the vector kept answering searches (Asgard, 2026-09-08). Listing the
/// collections once and matching case-insensitively removes the guess.
pub(crate) async fn qdrant_collection(state: &Arc<crate::models::AppState>) -> String {
    if let Some(c) = QDRANT_COLLECTION_CACHE.get() { return c.clone(); }
    let env = std::env::var("QDRANT_COLLECTION").ok();
    let url = format!("{}/collections", state.cfg.qdrant_url.trim_end_matches('/'));
    let existing: Vec<String> = match reqwest::Client::new().get(&url).send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok()
            .and_then(|v| v["result"]["collections"].as_array().map(|a| {
                a.iter().filter_map(|c| c["name"].as_str().map(str::to_string)).collect()
            }))
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let picked = pick_qdrant_collection(env.as_deref(), &existing);
    if env.as_deref().map_or(true, |e| e != picked) {
        tracing::info!("qdrant: using collection {picked:?} (env {env:?}, existing {existing:?})");
    }
    // Only remember a verified answer: with Qdrant unreachable the next call tries again.
    if existing.iter().any(|c| *c == picked) { let _ = QDRANT_COLLECTION_CACHE.set(picked.clone()); }
    picked
}

/// Best-effort removal of one Qdrant point. Failure is logged, never fatal — the
/// Postgres row is authoritative.
async fn delete_qdrant_point(state: &Arc<crate::models::AppState>, chunk_id: Uuid, point_id: &str) -> bool {
    let collection = qdrant_collection(state).await;
    let url = format!(
        "{}/collections/{}/points/delete?wait=true",
        state.cfg.qdrant_url.trim_end_matches('/'),
        collection
    );
    let res = reqwest::Client::new()
        .post(&url)
        .json(&json!({ "points": [point_id] }))
        .send().await;
    match res {
        Ok(r) if r.status().is_success() => true,
        Ok(r)  => { tracing::warn!("chunk {chunk_id}: Qdrant delete returned {}", r.status()); false }
        Err(e) => { tracing::warn!("chunk {chunk_id}: Qdrant delete failed: {e}"); false }
    }
}

/// Core: delete a chunk from Postgres + Qdrant (owner-scoped). Shared by the HTTP
/// handler and the Pi agent tool. Returns whether the Qdrant point was removed.
pub(crate) async fn delete_chunk_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
) -> Result<bool> {
    ensure_chunk_mutable(state, claims, id).await?;
    // Fetch the chunk (owner-scoped) and its Qdrant point id before deleting.
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT qdrant_point_id FROM text_chunks WHERE id = $1 AND user_id = $2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    let Some((qdrant_point_id,)) = row else { return Err(AppError::NotFound); };

    // Remove from Postgres (authoritative).
    sqlx::query("DELETE FROM text_chunks WHERE id = $1 AND user_id = $2")
        .bind(id).bind(claims.sub).execute(&state.db).await?;

    let vector_deleted = delete_qdrant_point(state, id, &chunk_point_id(qdrant_point_id, id)).await;

    let eff = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
    crate::services::audit::log_access(&state.db, claims, "chunk.delete",
        "chunk", &id.to_string(), eff, None, true, None).await;
    Ok(vector_deleted)
}

#[derive(Deserialize, Default)]
pub(crate) struct SupersedeReq {
    #[serde(default)]
    pub reason: Option<String>,
}

/// POST /api/kex/chunks/:id/supersede  { reason?: string }
///
/// A user corrected a fact and this chunk carries the old, wrong statement — but
/// it comes from a reviewed document, so it must not be deleted. Superseding
/// keeps the Postgres row (and the source document) and takes the chunk out of
/// every retrieval path: `archived = true, archived_reason = 'superseded'`
/// (lexical + Hebb neighbour paths filter on `archived`), and its Qdrant point
/// is removed (the vector path has no `archived` payload field to filter on —
/// same reasoning as A5 dedup). Reversible by un-archiving + re-embedding.
async fn supersede_chunk(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    body: Option<Json<SupersedeReq>>,
) -> Result<Json<Value>> {
    let reason = body.and_then(|Json(b)| b.reason);
    let vector_deleted = supersede_chunk_core(&state, &claims, id, reason.as_deref()).await?;
    Ok(Json(json!({ "ok": true, "vectorDeleted": vector_deleted })))
}

/// Core: mark a chunk superseded (owner-scoped) and drop its vector. Shared by the
/// HTTP handler and the Pi agent tool. The supersession is remembered in
/// `knowledge_corrections` (element_kind 'chunk', action 'flag') for the audit
/// trail. Returns whether the Qdrant point was removed.
pub(crate) async fn supersede_chunk_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
    reason: Option<&str>,
) -> Result<bool> {
    ensure_chunk_mutable(state, claims, id).await?;
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "UPDATE text_chunks
            SET archived = true, archived_reason = 'superseded', heat = 0
          WHERE id = $1 AND user_id = $2
          RETURNING qdrant_point_id"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    let Some((qdrant_point_id,)) = row else { return Err(AppError::NotFound); };

    let vector_deleted = delete_qdrant_point(state, id, &chunk_point_id(qdrant_point_id, id)).await;

    let _ = sqlx::query(
        "INSERT INTO knowledge_corrections
            (user_id, compilation_id, element_kind, head, rel_type, tail, action, reason)
         VALUES ($1, NULL, 'chunk', $2, NULL, NULL, 'flag', $3)"
    ).bind(claims.sub).bind(id.to_string()).bind(reason)
     .execute(&state.db).await
     .map_err(|e| tracing::warn!("chunk {id}: supersede not remembered: {e}"));

    let eff = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
    crate::services::audit::log_access(&state.db, claims, "chunk.supersede",
        "chunk", &id.to_string(), eff, None, true, None).await;
    Ok(vector_deleted)
}

#[cfg(test)]
mod qdrant_collection_tests {
    use super::pick_qdrant_collection;

    fn ex(names: &[&str]) -> Vec<String> { names.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn env_value_wins_when_qdrant_has_it() {
        assert_eq!(pick_qdrant_collection(Some("gctrl_chunks"), &ex(&["gctrl_chunks", "other"])), "gctrl_chunks");
    }

    #[test]
    fn case_insensitive_match_beats_the_guess() {
        // The Asgard case: API container without QDRANT_COLLECTION, KEX created "gctrl_chunks".
        assert_eq!(pick_qdrant_collection(None, &ex(&["gctrl_chunks"])), "gctrl_chunks");
        // Env set to the default spelling while the server has the lowercase one.
        assert_eq!(pick_qdrant_collection(Some("GCTRL_chunks"), &ex(&["gctrl_chunks"])), "gctrl_chunks");
    }

    #[test]
    fn falls_back_to_the_requested_name_when_nothing_matches() {
        assert_eq!(pick_qdrant_collection(None, &[]), "GCTRL_chunks");
        assert_eq!(pick_qdrant_collection(Some("custom"), &ex(&["gctrl_chunks"])), "custom");
        assert_eq!(pick_qdrant_collection(Some("  "), &ex(&["gctrl_chunks"])), "gctrl_chunks");
    }
}

#[cfg(test)]
mod chunk_point_id_tests {
    use super::chunk_point_id;
    use uuid::Uuid;

    #[test]
    fn recorded_point_id_wins() {
        let id = Uuid::new_v4();
        assert_eq!(chunk_point_id(Some("abc".into()), id), "abc");
    }

    #[test]
    fn missing_or_blank_point_id_falls_back_to_the_chunk_id() {
        // KEX writes row and point under the same UUID; the column stays NULL on the
        // text/store path — the Asgard ghost-chunk case.
        let id = Uuid::new_v4();
        assert_eq!(chunk_point_id(None, id), id.to_string());
        assert_eq!(chunk_point_id(Some("  ".into()), id), id.to_string());
    }
}

#[cfg(test)]
mod degraded_status_tests {
    use super::presented_status;
    use serde_json::json;

    #[test]
    fn plain_completion_is_unchanged() {
        let r = json!({ "entities": [], "relations": [] });
        assert_eq!(presented_status("completed", Some(&r)), ("completed".into(), None));
        assert_eq!(presented_status("completed", None), ("completed".into(), None));
    }

    #[test]
    fn a_skipped_phase_is_reported_as_degraded_with_its_reason() {
        let r = json!({
            "degraded": true,
            "warning": "Extracted 4 entities; Relation extraction skipped — LLM unavailable."
        });
        let (status, reason) = presented_status("completed", Some(&r));
        assert_eq!(status, "completed_degraded");
        assert!(reason.unwrap().contains("Relation extraction skipped"));
    }

    #[test]
    fn only_a_completed_job_can_be_degraded() {
        // A failed/pending job keeps its own status — `degraded` in a stale result
        // payload must never rewrite it.
        let r = json!({ "degraded": true, "warning": "…" });
        assert_eq!(presented_status("failed", Some(&r)).0, "failed");
        assert_eq!(presented_status("processing", Some(&r)).0, "processing");
    }
}

#[cfg(test)]
mod code_ingest_tests {
    use super::*;

    #[test]
    fn code_job_payload_has_type_code_and_required_keys() {
        let p = code_job_payload(
            Uuid::nil(), Uuid::nil(), Uuid::nil(),
            &json!({"name":"r","root":"/r","commit":null}),
            &json!([{"path":"a.py","sha256":"x","lang":"python","symbols":[],"edges":[],"chunks":[]}]),
            &json!(["gone.py"]),
            Some("INTERNAL".into()), None,
        );
        assert_eq!(p["type"], "code");
        assert_eq!(p["files"].as_array().unwrap().len(), 1);
        assert_eq!(p["removed"][0], "gone.py");
        assert_eq!(p["classification"], "INTERNAL");
        assert!(p["compilation_id"].is_string());
    }

    #[test]
    fn manifest_cypher_is_job_scoped_and_reads_file_hashes() {
        let c = code_manifest_cypher();
        assert!(c.contains("type: 'file'"));
        assert!(c.contains("coarse_type: 'code'"));
        assert!(c.contains(&crate::services::neo4j::job_scope("n", "jobs")));
        assert!(c.contains("n.sha256"));
    }
}

#[cfg(test)]
mod mime_tests {
    use super::mime_for_filename;

    #[test]
    fn images_and_office_types_are_routed_by_extension() {
        assert_eq!(mime_for_filename("board.png"), "image/png");
        assert_eq!(mime_for_filename("PHOTO.JPG"), "image/jpeg");
        assert_eq!(mime_for_filename("scan.tif"), "image/tiff");
        assert_eq!(mime_for_filename("deck.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        assert_eq!(mime_for_filename("mail.eml"), "message/rfc822");
        assert_eq!(mime_for_filename("notes.markdown"), "text/markdown");
    }

    #[test]
    fn unknown_or_missing_extension_stays_octet_stream() {
        assert_eq!(mime_for_filename("blob.dwg"), "application/octet-stream");
        assert_eq!(mime_for_filename("noext"), "application/octet-stream");
        assert_eq!(mime_for_filename("report.pdf"), "application/pdf");
    }
}

#[cfg(test)]
mod job_overview_tests {
    use super::*;

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("report_2026"), "%report\\_2026%");
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("plain"), "%plain%");
    }

    #[test]
    fn file_name_prefers_the_upload_name_and_ignores_the_source_kind() {
        assert_eq!(job_file_name(&json!({"fileName": "deck.pptx", "sourceRef": "/x/deck.pptx"})).as_deref(), Some("deck.pptx"));
        assert_eq!(job_file_name(&json!({"fileName": null, "sourceRef": "vault/Note.md"})).as_deref(), Some("vault/Note.md"));
        assert_eq!(job_file_name(&json!({"originalFilename": " a.pdf "})).as_deref(), Some("a.pdf"));
        // "source" is a kind (agent_store, repo), never a name.
        assert_eq!(job_file_name(&json!({"source": "agent_store", "text": "..."})), None);
    }

    #[test]
    fn footprint_counts_membership_and_exclusive_membership() {
        let c = footprint_cypher("(n)", "n");
        assert!(c.contains(&crate::services::neo4j::job_scope("n", "jobs")));
        assert!(c.contains(") = 1 THEN 1 END) AS exclusive"));
        let r = footprint_cypher("()-[r]->()", "r");
        assert!(r.contains("r._source_jobs"));
    }

    #[test]
    fn only_an_admin_session_crosses_the_account_boundary() {
        let mut c = JwtClaims {
            sub: Uuid::nil(), email: "a@b".into(), role: "admin".into(), clearance: None, exp: 0,
            api_key_rank: None, api_key_id: None, read_only: false, code_access: true,
            agent_override_rank: None,
        };
        assert!(is_admin_session(&c));
        c.api_key_id = Some(Uuid::nil());
        assert!(!is_admin_session(&c), "a delegated admin token is not a session");
        c.api_key_id = None;
        c.role = "editor".into();
        assert!(!is_admin_session(&c));
        assert!(truthy(Some("1")) && truthy(Some("true")));
        assert!(!truthy(Some("0")) && !truthy(None));
    }

    #[test]
    fn list_filter_binds_every_parameter_in_both_queries() {
        // The page query and the count query share the WHERE; a parameter that
        // one of them stops binding would be a runtime error, not a compile error.
        for n in 1..=6 {
            assert!(JOB_LIST_WHERE.contains(&format!("${n}")), "missing ${n}");
        }
        assert!(!JOB_LIST_WHERE.contains("$7"));
    }

    /// The removal surfaces share one implementation: HTTP delete, unlink's
    /// last-reference purge, the compilation update and the agent's
    /// delete_extraction all go through it.
    #[test]
    fn every_removal_surface_shares_the_core() {
        let kex = include_str!("kex.rs");
        let agent = include_str!("agent.rs");
        let kg = include_str!("kg.rs");
        let delete_body = &kex[kex.find("async fn delete_job(").unwrap()..];
        let delete_body = &delete_body[..delete_body.find("\n}\n").unwrap()];
        assert!(delete_body.contains("remove_job_everywhere("));
        assert!(agent.contains("remove_job_everywhere(") && agent.contains("unlink_job_from_compilation("),
            "agent delete_extraction must use the shared removal functions");
        assert!(kg.contains("unlink_job_from_compilation("),
            "PUT /kg/compilations/:id must unlink removed sourceJobIds through the shared path");
    }
}

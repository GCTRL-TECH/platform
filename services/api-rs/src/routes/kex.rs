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
/// (distilled view, holds no graph data of its own). Every fresh registration
/// seeds exactly one such compilation ("My First Knowledge Base" —
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
            AND type::text NOT IN ('WIKI')
          ORDER BY created_at ASC LIMIT 1"
    )
    .bind(user_id)
    .fetch_optional(db).await.ok().flatten()
}

/// Link a job into its target compilation: the caller's explicit choice, or
/// (when none was given) the user's default knowledge base, so a submission
/// never silently orphans. Best-effort/idempotent — see `link_job_to_compilation`.
pub(crate) async fn link_job_to_target_or_default(
    db: &sqlx::PgPool,
    user_id: Uuid,
    compilation_id: Option<Uuid>,
    job_id: Uuid,
) {
    match compilation_id {
        Some(cid) => link_job_to_compilation(db, user_id, cid, job_id).await,
        None => {
            if let Some(cid) = resolve_default_compilation(db, user_id).await {
                tracing::debug!(%job_id, %cid, "linking job to default compilation (no compilationId given)");
                link_job_to_compilation(db, user_id, cid, job_id).await;
            }
        }
    }
}

#[derive(Deserialize)]
struct Pagination { limit: Option<i64>, offset: Option<i64> }

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/extract",         post(extract))
        .route("/repo",            post(ingest_repo))
        .route("/upload",          post(upload))
        .route("/jobs",            get(list_jobs))
        .route("/jobs/:id",        get(get_job).delete(delete_job))
        .route("/jobs/:id/result", get(get_result))
        .route("/jobs/:id/cancel", post(cancel_job))
        .route("/chunks",          get(list_chunks))
        .route("/chunks/:id",      axum::routing::delete(delete_chunk))
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
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id, source_document_id)
         VALUES ($1, $2, 'kex_extract', 'pending', $3, $4, $5)"
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
    .execute(&state.db).await?;

    // Record the spend locally so the heartbeat task can ship it upstream.
    record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;

    // Link into the target compilation: explicit choice, else the user's default
    // knowledge base, so the document is never orphaned.
    link_job_to_target_or_default(&state.db, claims.sub, req.compilation_id, job_id).await;

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
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id)
         VALUES ($1, $2, 'kex_extract', 'processing', $3, $4)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({ "source": "repo", "repoName": repo_name, "fileCount": file_count }))
    .bind(req.classification_level_id)
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
    link_job_to_target_or_default(&state.db, claims.sub, req.compilation_id, job_id).await;
    record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;

    let mut out = summary;
    if let Value::Object(ref mut m) = out {
        m.insert("jobId".into(), json!(job_id));
    }
    Ok(Json(out))
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
            _ => {}
        }
    }

    let bytes = file_bytes.ok_or(AppError::BadRequest("No file field".into()))?;
    let job_id = submit_upload(
        &state, &claims, &bytes, &file_name, ontology_id, classification_level_id, compilation_id,
    ).await?;

    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
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
) -> Result<Uuid> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    let mimetype = match file_name.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "pdf"  => "application/pdf",
        "txt"  => "text/plain",
        "md"   => "text/markdown",
        "html" | "htm" => "text/html",
        "csv"  => "text/csv",
        "json" => "application/json",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _      => "application/octet-stream",
    };

    let job_id = Uuid::new_v4();
    sqlx::query("UPDATE users SET tokens_balance = GREATEST(0, tokens_balance - 5) WHERE id = $1")
        .bind(claims.sub).execute(&state.db).await?;

    let (resolved_ontology_id, entity_types) = resolve_ontology(&state.db, claims.sub, ontology_id).await;

    // P2b: identity keyed on (user, path). Direct upload has no folder path —
    // `path` is the file name, and there is no source-side mtime (neither the
    // browser nor an agent sends one), so modified_at is left unknown.
    let content_hash = crate::services::source_docs::hash_content(bytes);
    let source_doc = crate::services::source_docs::resolve_source_document(
        &state.db, claims.sub, None, file_name, Some(file_name),
        &content_hash, None,
    ).await.ok();
    let source_document_id = source_doc.as_ref().map(|d| d.id);

    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id, source_document_id)
         VALUES ($1, $2, 'kex_upload', 'pending', $3, $4, $5)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({ "fileName": file_name, "ontologyId": resolved_ontology_id }))
    .bind(classification_level_id)
    .bind(source_document_id)
    .execute(&state.db).await?;

    record_usage(&state.db, claims.sub, "kex_upload", 5, Some(job_id)).await;

    // Link into the target compilation: explicit choice, else the user's default
    // knowledge base, so the upload is never orphaned.
    link_job_to_target_or_default(&state.db, claims.sub, compilation_id, job_id).await;

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
        "source_path": file_name,
        "source_modified_at": Value::Null,
    });
    crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(job_id)
}

async fn list_jobs(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<Pagination>,
) -> Result<Json<Value>> {
    let limit  = q.limit.unwrap_or(20).min(100);
    let offset = q.offset.unwrap_or(0);
    let rows = sqlx::query_as::<_, (Uuid, String, String, Value, Option<Value>, Option<String>, chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT id, type, status, input, result, error, created_at, completed_at FROM jobs
         WHERE user_id = $1 AND type IN ('kex_extract','kex_upload','kex_connector')
         ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    )
    .bind(claims.sub).bind(limit).bind(offset)
    .fetch_all(&state.db).await?;

    let jobs: Vec<Value> = rows.into_iter().map(|(id, t, status, input, result, error, created, completed)| {
        json!({
            "id": id, "type": t, "status": status,
            "input": input, "result": result, "error": error,
            "createdAt": created, "completedAt": completed,
        })
    }).collect();

    // Real totals across ALL of the user's jobs — the dashboard was counting the
    // returned page (jobs.length, capped at the default limit of 20) and showed
    // "20 extractions" forever. Same WHERE clause as the page query above.
    let (total, completed_total): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'completed') FROM jobs
         WHERE user_id = $1 AND type IN ('kex_extract','kex_upload','kex_connector')"
    )
    .bind(claims.sub)
    .fetch_one(&state.db).await?;

    Ok(Json(json!({ "jobs": jobs, "total": total, "completed": completed_total })))
}

// Frontend KexJobDetail expects `{ job: ... }` wrapper.
async fn get_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, (Uuid, String, String, Value, Option<Value>, Option<String>, chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT id, type, status, input, result, error, created_at, completed_at FROM jobs WHERE id = $1 AND user_id = $2"
    )
    .bind(id).bind(claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;
    let (id, t, status, input, result, error, created, completed) = row;
    Ok(Json(json!({ "job": {
        "id": id, "type": t, "status": status,
        "input": input, "result": result, "error": error,
        "createdAt": created, "completedAt": completed,
    } })))
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
    Ok(Json(json!({
        "jobId": id,
        "status": status,
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

async fn delete_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM jobs WHERE id=$1 AND user_id=$2")
        .bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
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
        "SELECT id, job_id, compilation_id, content, start_char, end_char,
                chunk_sequence, entity_mentions, created_at,
                COUNT(*) OVER () AS total
           FROM text_chunks
          WHERE user_id = $1
            AND ($2::uuid IS NULL OR compilation_id = $2 OR compilation_id IS NULL)
            AND COALESCE(min_rank, 0) <= $6
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

/// Core: delete a chunk from Postgres + Qdrant (owner-scoped). Shared by the HTTP
/// handler and the Pi agent tool. Returns whether the Qdrant point was removed.
pub(crate) async fn delete_chunk_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
) -> Result<bool> {
    // Fetch the chunk (owner-scoped) and its Qdrant point id before deleting.
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT qdrant_point_id FROM text_chunks WHERE id = $1 AND user_id = $2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    let Some((qdrant_point_id,)) = row else { return Err(AppError::NotFound); };

    // Remove from Postgres (authoritative).
    sqlx::query("DELETE FROM text_chunks WHERE id = $1 AND user_id = $2")
        .bind(id).bind(claims.sub).execute(&state.db).await?;

    // Best-effort remove from Qdrant by point id.
    let mut vector_deleted = false;
    if let Some(point_id) = qdrant_point_id {
        let collection = std::env::var("QDRANT_COLLECTION").unwrap_or_else(|_| "GCTRL_chunks".into());
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
            Ok(r) if r.status().is_success() => vector_deleted = true,
            Ok(r)  => tracing::warn!("chunk {id}: Qdrant delete returned {}", r.status()),
            Err(e) => tracing::warn!("chunk {id}: Qdrant delete failed: {e}"),
        }
    }

    let eff = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
    crate::services::audit::log_access(&state.db, claims, "chunk.delete",
        "chunk", &id.to_string(), eff, None, true, None).await;
    Ok(vector_deleted)
}

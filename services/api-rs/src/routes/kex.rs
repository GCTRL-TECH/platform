use axum::{
    body::Bytes,
    extract::{Extension, Multipart, Path, Query, State},
    routing::{delete, get, post},
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
    #[serde(rename = "ontologyId")]    ontology_id:    Option<Uuid>,
    #[serde(rename = "discoveryMode")] discovery_mode: Option<String>,
}

#[derive(Deserialize)]
struct Pagination { limit: Option<i64>, offset: Option<i64> }

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/extract",         post(extract))
        .route("/upload",          post(upload))
        .route("/jobs",            get(list_jobs))
        .route("/jobs/:id",        get(get_job).delete(delete_job))
        .route("/jobs/:id/result", get(get_result))
        .route("/jobs/:id/cancel", post(cancel_job))
        .route("/chunks",          get(list_chunks))
        .route("/queue",           get(queue_depth))
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

    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input) VALUES ($1, $2, 'kex_extract', 'pending', $3)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({
        "text": req.text,
        "ontologyId": ontology_id,
        "discoveryMode": req.discovery_mode.unwrap_or_else(|| "extract".into()),
    }))
    .execute(&state.db).await?;

    // Record the spend locally so the heartbeat task can ship it upstream.
    record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;

    let payload = json!({
        "job_id": job_id, "user_id": claims.sub, "type": "text",
        "input": req.text, "entity_types": entity_types,
    });
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
}

/// Resolves the ontology to use for an extraction job:
///   1. If caller passed `ontology_id`, use it.
///   2. Else fall back to the user's `default_ontology_id` (seeded on registration).
///   3. Returns the resolved id + the entity type names (used by KEX as GLiNER labels).
///      Returns `None` for entity_types if no ontology resolved → KEX uses its 87 defaults.
async fn resolve_ontology(
    db: &sqlx::PgPool,
    user_id: Uuid,
    requested: Option<Uuid>,
) -> (Option<Uuid>, Option<Vec<String>>) {
    let ontology_id: Option<Uuid> = match requested {
        Some(id) => Some(id),
        None => sqlx::query_scalar::<_, Option<Uuid>>("SELECT default_ontology_id FROM users WHERE id = $1")
            .bind(user_id).fetch_optional(db).await.ok().flatten().flatten(),
    };

    let entity_types = if let Some(oid) = ontology_id {
        sqlx::query_scalar::<_, String>("SELECT name FROM ontology_entity_types WHERE ontology_id = $1 ORDER BY name")
            .bind(oid).fetch_all(db).await.ok().filter(|v: &Vec<String>| !v.is_empty())
    } else {
        None
    };

    (ontology_id, entity_types)
}

async fn upload(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut file_bytes: Option<Bytes> = None;
    let mut file_name  = "upload".to_string();
    let mut ontology_id: Option<Uuid> = None;

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
            _ => {}
        }
    }

    let bytes = file_bytes.ok_or(AppError::BadRequest("No file field".into()))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);

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

    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input) VALUES ($1, $2, 'kex_upload', 'pending', $3)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({ "fileName": file_name, "ontologyId": resolved_ontology_id }))
    .execute(&state.db).await?;

    record_usage(&state.db, claims.sub, "kex_upload", 5, Some(job_id)).await;

    // KEX worker parses `input` as a JSON string with fileBase64, mimetype, originalFilename
    let kex_input = json!({
        "fileBase64": encoded,
        "mimetype": mimetype,
        "originalFilename": file_name,
    }).to_string();

    let payload = json!({
        "job_id": job_id, "user_id": claims.sub, "type": "file",
        "input": kex_input, "file_name": file_name, "entity_types": entity_types,
    });
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
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
         WHERE user_id = $1 AND type IN ('kex_extract','kex_upload')
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
    Ok(Json(json!({ "jobs": jobs })))
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

async fn queue_depth(State(state): State<Arc<crate::models::AppState>>) -> Result<Json<Value>> {
    let depth = crate::services::redis::llen(&state.redis, "kex:jobs").await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "depth": depth })))
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

    let rows = sqlx::query_as::<_, (
        Uuid, Option<Uuid>, Option<Uuid>, String,
        Option<i32>, Option<i32>, Option<i32>,
        Option<Value>, chrono::DateTime<chrono::Utc>, i64,
    )>(
        "SELECT id, job_id, compilation_id, content, start_char, end_char,
                chunk_sequence, entity_mentions, created_at,
                COUNT(*) OVER () AS total
           FROM text_chunks
          WHERE user_id = $1
            AND ($2::uuid IS NULL OR compilation_id = $2)
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
    .fetch_all(&state.db).await?;

    let total: i64 = rows.first().map(|r| r.9).unwrap_or(0);

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

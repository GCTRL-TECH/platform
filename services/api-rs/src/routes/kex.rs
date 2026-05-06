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

use crate::{error::{AppError, Result}, middleware::auth::JwtClaims, services::redis::lpush};

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
    sqlx::query("UPDATE users SET tokens_balance = tokens_balance - 5 WHERE id = $1")
        .bind(claims.sub).execute(&state.db).await?;

    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input) VALUES ($1, $2, 'kex_extract', 'pending', $3)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({
        "text": req.text,
        "ontologyId": req.ontology_id,
        "discoveryMode": req.discovery_mode.unwrap_or_else(|| "extract".into()),
    }))
    .execute(&state.db).await?;

    let payload = json!({
        "job_id": job_id, "user_id": claims.sub, "type": "text",
        "input": req.text, "entity_types": null,
    });
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
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

    let job_id = Uuid::new_v4();
    sqlx::query("UPDATE users SET tokens_balance = tokens_balance - 5 WHERE id = $1")
        .bind(claims.sub).execute(&state.db).await?;
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input) VALUES ($1, $2, 'kex_upload', 'pending', $3)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({ "fileName": file_name, "ontologyId": ontology_id }))
    .execute(&state.db).await?;

    let payload = json!({
        "job_id": job_id, "user_id": claims.sub, "type": "file",
        "input": encoded, "file_name": file_name,
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
    let rows = sqlx::query_as::<_, (Uuid, String, String, Option<Value>, Option<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, type, status, result, error, created_at FROM jobs
         WHERE user_id = $1 AND type IN ('kex_extract','kex_upload')
         ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    )
    .bind(claims.sub).bind(limit).bind(offset)
    .fetch_all(&state.db).await?;

    let jobs: Vec<Value> = rows.into_iter().map(|(id, t, status, result, error, created)| {
        json!({ "id": id, "type": t, "status": status, "result": result, "error": error, "createdAt": created })
    }).collect();
    Ok(Json(json!({ "jobs": jobs })))
}

async fn get_job(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, (Uuid, String, String, Option<Value>, Option<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, type, status, result, error, created_at FROM jobs WHERE id = $1 AND user_id = $2"
    )
    .bind(id).bind(claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;
    let (id, t, status, result, error, created) = row;
    Ok(Json(json!({ "id": id, "type": t, "status": status, "result": result, "error": error, "createdAt": created })))
}

async fn get_result(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let result: Option<Value> = sqlx::query_scalar("SELECT result FROM jobs WHERE id = $1 AND user_id = $2")
        .bind(id).bind(claims.sub)
        .fetch_optional(&state.db).await?
        .flatten();
    Ok(Json(result.unwrap_or(json!(null))))
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

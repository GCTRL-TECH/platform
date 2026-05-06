use axum::{extract::{Extension, Path, Query, State}, routing::{delete, get, post, put}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;
use crate::{error::{AppError, Result}, middleware::auth::JwtClaims};

#[derive(Deserialize)]
struct CreateComp {
    name: String,
    description: Option<String>,
    classification: Option<String>,
    #[serde(rename = "sourceJobIds")] source_job_ids: Option<Vec<Uuid>>,
}

#[derive(Deserialize)]
struct ListQuery { limit: Option<i64>, offset: Option<i64> }

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/compilations",             get(list).post(create))
        .route("/compilations/:id",         get(get_one).put(update).delete(delete_one))
        .route("/compilations/:id/refresh", post(refresh))
        .route("/compilations/:id/acl",     get(get_acl).put(set_acl))
}

async fn list(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit  = q.limit.unwrap_or(20).min(100);
    let offset = q.offset.unwrap_or(0);
    let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<i32>, Option<i32>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, name, description, classification, node_count, edge_count, created_at
         FROM compilations WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    ).bind(claims.sub).bind(limit).bind(offset).fetch_all(&state.db).await?;
    let comps: Vec<Value> = rows.into_iter().map(|(id,n,d,cls,nc,ec,c)| {
        json!({ "id":id,"name":n,"description":d,"classification":cls,"nodeCount":nc,"edgeCount":ec,"createdAt":c })
    }).collect();
    Ok(Json(json!({ "compilations": comps })))
}

async fn create(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateComp>,
) -> Result<Json<Value>> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO compilations (id, user_id, name, description, classification, source_job_ids, version) VALUES ($1,$2,$3,$4,$5,$6,1)")
        .bind(id).bind(claims.sub).bind(&req.name).bind(&req.description)
        .bind(req.classification.unwrap_or_else(|| "INTERNAL".into()))
        .bind(serde_json::to_value(req.source_job_ids.unwrap_or_default()).unwrap())
        .execute(&state.db).await?;
    Ok(Json(json!({ "id": id, "name": req.name })))
}

async fn get_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<i32>, Option<i32>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, name, description, classification, node_count, edge_count, created_at FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let (id,n,d,cls,nc,ec,c) = row;
    Ok(Json(json!({ "id":id,"name":n,"description":d,"classification":cls,"nodeCount":nc,"edgeCount":ec,"createdAt":c })))
}

async fn update(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
    if let Some(name) = req.get("name").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE compilations SET name=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3")
            .bind(name).bind(id).bind(claims.sub).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM compilations WHERE id=$1 AND user_id=$2").bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn refresh(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("UPDATE users SET tokens_balance=tokens_balance-3 WHERE id=$1").bind(claims.sub).execute(&state.db).await?;
    let source_ids: Vec<uuid::Uuid> = sqlx::query_scalar("SELECT unnest(source_job_ids) FROM compilations WHERE id=$1").bind(id).fetch_all(&state.db).await?;
    let job_id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs (id,user_id,type,status,input) VALUES ($1,$2,'fuse_merge','pending',$3)")
        .bind(job_id).bind(claims.sub).bind(json!({ "compilationId": id, "sourceJobIds": source_ids }))
        .execute(&state.db).await?;
    crate::services::redis::lpush(&state.redis, "fuse:jobs", &json!({ "job_id": job_id, "compilation_id": id, "source_job_ids": source_ids }).to_string())
        .await.map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "jobId": job_id })))
}

async fn get_acl(
    Extension(_claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, Uuid, String)>(
        "SELECT id, user_id, permission FROM compilation_acl WHERE compilation_id=$1"
    ).bind(id).fetch_all(&state.db).await?;
    let entries: Vec<Value> = rows.into_iter().map(|(id,uid,perm)| json!({ "id":id,"userId":uid,"permission":perm })).collect();
    Ok(Json(json!({ "entries": entries })))
}

async fn set_acl(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM compilation_acl WHERE compilation_id=$1").bind(id).execute(&state.db).await?;
    if let Some(entries) = req.get("entries").and_then(|v| v.as_array()) {
        for e in entries {
            let uid: Uuid = serde_json::from_value(e["userId"].clone()).map_err(|_| AppError::BadRequest("Invalid userId".into()))?;
            let perm = e["permission"].as_str().unwrap_or("read");
            sqlx::query("INSERT INTO compilation_acl (id,compilation_id,user_id,permission,granted_by) VALUES (gen_random_uuid(),$1,$2,$3,$4)")
                .bind(id).bind(uid).bind(perm).bind(claims.sub).execute(&state.db).await?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

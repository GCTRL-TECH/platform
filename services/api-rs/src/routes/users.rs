use axum::{
    extract::{Extension, Path, State},
    routing::{get, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
use crate::{error::{AppError, Result}, middleware::auth::{require_role, JwtClaims}};

#[derive(Serialize, sqlx::FromRow)]
struct SafeUser {
    id: Uuid,
    email: String,
    name: Option<String>,
    role: String,
    clearance: Option<String>,
    tier: Option<String>,
    tokens_balance: Option<i32>,
    #[serde(rename = "defaultOntologyId")]
    default_ontology_id: Option<Uuid>,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize)]
struct UpdateRole { role: String }

#[derive(Deserialize)]
struct UpdateSettings {
    #[serde(rename = "defaultOntologyId")]
    default_ontology_id: Option<Uuid>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/me",       get(me).put(update_settings_handler))
        .route("/:id/role", put(update_role))
        .route("/",         get(list_users))
}

async fn me(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<SafeUser>> {
    let user = sqlx::query_as::<_, SafeUser>(
        "SELECT id, email, name, role, clearance, tier, tokens_balance, default_ontology_id, created_at
         FROM users WHERE id = $1"
    )
    .bind(claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(user))
}

async fn list_users(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Vec<SafeUser>>> {
    require_role(&claims, "admin")?;
    let users = sqlx::query_as::<_, SafeUser>(
        "SELECT id, email, name, role, clearance, tier, tokens_balance, default_ontology_id, created_at
         FROM users ORDER BY created_at DESC"
    )
    .fetch_all(&state.db).await?;
    Ok(Json(users))
}

async fn update_role(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateRole>,
) -> Result<Json<serde_json::Value>> {
    require_role(&claims, "admin")?;
    sqlx::query("UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2")
        .bind(&req.role).bind(id)
        .execute(&state.db).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn update_settings_handler(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<UpdateSettings>,
) -> Result<Json<serde_json::Value>> {
    sqlx::query("UPDATE users SET default_ontology_id = $1, updated_at = NOW() WHERE id = $2")
        .bind(req.default_ontology_id).bind(claims.sub)
        .execute(&state.db).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

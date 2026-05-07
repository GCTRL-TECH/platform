use axum::{extract::{Extension, Query, State}, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use crate::{error::Result, middleware::auth::{require_role, JwtClaims}};

#[derive(Deserialize)]
struct LimitQuery { limit: Option<i64> }

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/stats", get(stats))
        .route("/users", get(list_users))
        .route("/audit", get(audit_log))
}

#[derive(serde::Serialize)]
struct Stats { users: i64, jobs: i64, compilations: i64 }

async fn stats(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Stats>> {
    require_role(&claims, "admin")?;
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&state.db).await?;
    let jobs:  i64 = sqlx::query_scalar("SELECT COUNT(*) FROM jobs").fetch_one(&state.db).await?;
    let comps: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM compilations").fetch_one(&state.db).await?;
    Ok(Json(Stats { users, jobs, compilations: comps }))
}

async fn list_users(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Vec<Value>>> {
    require_role(&claims, "admin")?;
    let rows = sqlx::query_as::<_, (uuid::Uuid, String, Option<String>, String, Option<String>, Option<i32>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, email, name, role::TEXT AS role, tier, tokens_balance, created_at FROM users ORDER BY created_at DESC"
    )
    .fetch_all(&state.db).await?;
    let users = rows.into_iter().map(|(id, email, name, role, tier, bal, created)| {
        json!({ "id": id, "email": email, "name": name, "role": role, "tier": tier,
                "tokensBalance": bal, "createdAt": created })
    }).collect();
    Ok(Json(users))
}

async fn audit_log(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<LimitQuery>,
) -> Result<Json<Vec<Value>>> {
    require_role(&claims, "admin")?;
    let limit = q.limit.unwrap_or(100).min(500);
    let rows = sqlx::query_as::<_, (uuid::Uuid, Option<uuid::Uuid>, String, Option<String>, Option<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, user_id, action, resource_type, resource_id, created_at
         FROM audit_log ORDER BY created_at DESC LIMIT $1"
    )
    .bind(limit)
    .fetch_all(&state.db).await?;
    let entries = rows.into_iter().map(|(id, uid, action, rt, rid, created)| {
        json!({ "id": id, "userId": uid, "action": action, "resourceType": rt,
                "resourceId": rid, "createdAt": created })
    }).collect();
    Ok(Json(entries))
}

use axum::{extract::{Extension, Query, State}, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use crate::{error::Result, middleware::auth::JwtClaims};

#[derive(Deserialize)]
struct DaysQuery { days: Option<i64> }

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/balance",       get(balance))
        .route("/usage",         get(usage))
        .route("/usage/summary", get(usage_summary))
}

async fn balance(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let row: (Option<i32>, Option<String>) = sqlx::query_as("SELECT tokens_balance, tier FROM users WHERE id=$1")
        .bind(claims.sub).fetch_one(&state.db).await?;
    let (balance, tier) = row;
    Ok(Json(json!({ "balance": balance.unwrap_or(0), "tier": tier.unwrap_or_else(|| "free".into()) })))
}

async fn usage(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<DaysQuery>,
) -> Result<Json<Value>> {
    let days = q.days.unwrap_or(30).min(90);
    let rows = sqlx::query_as::<_, (String, i32, chrono::DateTime<chrono::Utc>)>(
        "SELECT action, tokens_spent, created_at FROM token_usage WHERE user_id=$1 AND created_at > NOW() - $2 * INTERVAL '1 day' ORDER BY created_at DESC LIMIT 500"
    ).bind(claims.sub).bind(days).fetch_all(&state.db).await?;
    let entries: Vec<Value> = rows.into_iter().map(|(a,t,c)| json!({ "action":a,"tokensSpent":t,"createdAt":c })).collect();
    Ok(Json(json!({ "usage": entries })))
}

async fn usage_summary(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<DaysQuery>,
) -> Result<Json<Value>> {
    let days = q.days.unwrap_or(30).min(90);
    let by_action = sqlx::query_as::<_, (String, i64)>(
        "SELECT action, SUM(tokens_spent) FROM token_usage WHERE user_id=$1 AND created_at > NOW() - $2 * INTERVAL '1 day' GROUP BY action"
    ).bind(claims.sub).bind(days).fetch_all(&state.db).await?;
    let by_day = sqlx::query_as::<_, (chrono::NaiveDate, i64)>(
        "SELECT DATE(created_at), SUM(tokens_spent) FROM token_usage WHERE user_id=$1 AND created_at > NOW() - $2 * INTERVAL '1 day' GROUP BY DATE(created_at) ORDER BY 1"
    ).bind(claims.sub).bind(days).fetch_all(&state.db).await?;
    Ok(Json(json!({
        "byAction": by_action.into_iter().map(|(a,t)| json!({ "action":a,"total":t })).collect::<Vec<_>>(),
        "byDay": by_day.into_iter().map(|(d,t)| json!({ "day":d.to_string(),"total":t })).collect::<Vec<_>>(),
    })))
}

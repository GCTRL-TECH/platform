use axum::{extract::{Extension, Query, State}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use crate::{error::Result, middleware::auth::JwtClaims};

#[derive(Deserialize)]
struct DaysQuery { days: Option<i64> }

#[derive(Deserialize)]
struct RegisterLicenseBody {
    license_key: String,
    tier: Option<String>,
    credits_allocated: Option<i32>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/balance",       get(balance))
        .route("/license",       post(register_license))
        .route("/usage",         get(usage))
        .route("/usage/summary", get(usage_summary))
}

/// Default token allocation per tier. Must stay in sync with the license server
/// (services/license-api/src/db/schema.ts → users.creditsBalance default = 3000).
fn tier_limit(tier: &str) -> i32 {
    match tier {
        "starter"    => 10_000,
        "pro"        => 50_000,
        "enterprise" => 1_000_000,
        _            => 3_000, // free — matches license-api default
    }
}

async fn balance(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // Prefer active license if one exists for this user
    let license = sqlx::query_as::<_, (i32, i32, String)>(
        "SELECT credits_allocated, credits_used, tier FROM licenses
         WHERE user_id = $1 AND status = 'active'
         ORDER BY activated_at DESC LIMIT 1"
    ).bind(claims.sub).fetch_optional(&state.db).await?;

    if let Some((allocated, used, tier)) = license {
        return Ok(Json(json!({
            "balance": allocated - used,
            "tier": tier,
            "tierLimit": allocated,
        })));
    }

    // Fallback: users.tokens_balance
    let row: (Option<i32>, Option<String>) = sqlx::query_as(
        "SELECT tokens_balance, tier FROM users WHERE id = $1"
    ).bind(claims.sub).fetch_one(&state.db).await?;
    let (bal, tier) = row;
    let tier = tier.unwrap_or_else(|| "free".into());
    let limit = tier_limit(&tier);
    Ok(Json(json!({
        "balance": bal.unwrap_or(0),
        "tier": tier,
        "tierLimit": limit,
    })))
}

async fn register_license(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(body): Json<RegisterLicenseBody>,
) -> Result<Json<Value>> {
    let tier = body.tier.clone().unwrap_or_else(|| "free".into());
    let credits = body.credits_allocated.unwrap_or_else(|| tier_limit(&tier));

    sqlx::query(
        "INSERT INTO licenses (user_id, license_key, tier, credits_allocated)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (license_key) DO UPDATE
           SET tier = EXCLUDED.tier, credits_allocated = EXCLUDED.credits_allocated, updated_at = NOW()"
    )
    .bind(claims.sub)
    .bind(&body.license_key)
    .bind(&tier)
    .bind(credits)
    .execute(&state.db).await?;

    Ok(Json(json!({ "ok": true })))
}

async fn usage(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<DaysQuery>,
) -> Result<Json<Value>> {
    let days = q.days.unwrap_or(30).min(90);
    let rows = sqlx::query_as::<_, (uuid::Uuid, String, i32, Option<uuid::Uuid>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, action, tokens_spent, job_id, created_at FROM token_usage
         WHERE user_id = $1 AND created_at > NOW() - $2 * INTERVAL '1 day'
         ORDER BY created_at DESC LIMIT 500"
    ).bind(claims.sub).bind(days).fetch_all(&state.db).await?;

    let entries: Vec<Value> = rows.into_iter().map(|(id, action, spent, job_id, created)| {
        json!({ "id": id, "action": action, "tokensSpent": spent, "jobId": job_id, "createdAt": created })
    }).collect();
    Ok(Json(json!({ "usage": entries })))
}

async fn usage_summary(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<DaysQuery>,
) -> Result<Json<Value>> {
    let days = q.days.unwrap_or(30).min(90);

    let by_action = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT action, SUM(tokens_spent), COUNT(*) FROM token_usage
         WHERE user_id = $1 AND created_at > NOW() - $2 * INTERVAL '1 day'
         GROUP BY action ORDER BY 2 DESC"
    ).bind(claims.sub).bind(days).fetch_all(&state.db).await?;

    let by_day = sqlx::query_as::<_, (chrono::NaiveDate, i64, i64)>(
        "SELECT DATE(created_at), SUM(tokens_spent), COUNT(*) FROM token_usage
         WHERE user_id = $1 AND created_at > NOW() - $2 * INTERVAL '1 day'
         GROUP BY DATE(created_at) ORDER BY 1"
    ).bind(claims.sub).bind(days).fetch_all(&state.db).await?;

    let total_spent: i64 = by_action.iter().map(|(_, s, _)| s).sum();
    let total_actions: i64 = by_action.iter().map(|(_, _, c)| c).sum();

    Ok(Json(json!({
        "byAction": by_action.into_iter().map(|(action, spent, count)| json!({
            "action": action, "totalSpent": spent, "count": count
        })).collect::<Vec<_>>(),
        "byDay": by_day.into_iter().map(|(date, spent, count)| json!({
            "date": date.to_string(), "totalSpent": spent, "count": count
        })).collect::<Vec<_>>(),
        "total": { "tokensSpent": total_spent, "actions": total_actions },
        "period": { "days": days },
    })))
}

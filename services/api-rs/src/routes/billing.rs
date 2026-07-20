use axum::{extract::{Extension, Query, State}, routing::get, Json, Router};
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
        .route("/license",       get(get_license).post(register_license))
        .route("/usage",         get(usage))
        .route("/usage/summary", get(usage_summary))
}

#[derive(Deserialize)]
struct LicenseQuery {
    /// When true, return the full license_key. Otherwise return a masked version.
    reveal: Option<bool>,
}

/// GET /api/billing/license — return the most recent active license for the
/// authenticated user, or `{ license: null }` if none exists.
///
/// Shape (when present):
/// `{ license: { licenseKey, tier, creditsAllocated, creditsUsed, status,
///               activatedAt, masked } }`
///
/// `licenseKey` is masked unless `?reveal=true` is passed. `masked` is always
/// the masked form so the UI can show it without re-fetching.
async fn get_license(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<LicenseQuery>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, (
        String, String, i32, i32, String, chrono::DateTime<chrono::Utc>
    )>(
        "SELECT license_key, tier, credits_allocated, credits_used, status, activated_at
         FROM licenses
         WHERE user_id = $1 AND status = 'active'
         ORDER BY activated_at DESC LIMIT 1"
    ).bind(claims.sub).fetch_optional(&state.db).await?;

    let Some((key, tier, allocated, used, status, activated_at)) = row else {
        return Ok(Json(json!({ "license": null })));
    };

    let masked = mask_license_key(&key);
    let reveal = q.reveal.unwrap_or(false);
    let display_key = if reveal { key.clone() } else { masked.clone() };

    Ok(Json(json!({
        "license": {
            "licenseKey":       display_key,
            "masked":           masked,
            "tier":             tier,
            "creditsAllocated": allocated,
            "creditsUsed":      used,
            "creditsRemaining": allocated - used,
            "status":           status,
            "activatedAt":      activated_at,
        }
    })))
}

/// Mask a license key to `XXXX-...-XXXX` form: keep the first segment up to the
/// first dash and the last 4 chars, replace everything else with `****`.
/// Examples:
///   `GCTRL-1234-5678-ABCD-WXYZ` → `GCTRL-****-****-****-WXYZ`
///   `short`                     → `*****` (just stars when too short)
fn mask_license_key(key: &str) -> String {
    if key.len() < 8 {
        return "*".repeat(key.len());
    }
    let segments: Vec<&str> = key.split('-').collect();
    if segments.len() <= 2 {
        // No segments / too few — fall back to first-3 + last-4 mask.
        let prefix = &key[..3];
        let suffix = &key[key.len() - 4..];
        return format!("{prefix}***{suffix}");
    }
    let first = segments[0];
    let last  = segments[segments.len() - 1];
    let middle_count = segments.len() - 2;
    let mut parts: Vec<String> = Vec::with_capacity(segments.len());
    parts.push(first.to_string());
    for _ in 0..middle_count {
        parts.push("****".to_string());
    }
    parts.push(last.to_string());
    parts.join("-")
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
    // Prefer active license if one exists for this user.
    // Subtract unsynced token_usage rows so balance reflects spend immediately
    // without waiting for the 60-second heartbeat round-trip to license-api.
    let license = sqlx::query_as::<_, (i32, i32, i64, String)>(
        "SELECT l.credits_allocated, l.credits_used,
                COALESCE(SUM(tu.tokens_spent), 0)::bigint AS unsynced_spent,
                l.tier
         FROM licenses l
         LEFT JOIN token_usage tu
           ON tu.user_id = l.user_id AND tu.synced_to_license_api = false
         WHERE l.user_id = $1 AND l.status = 'active'
         GROUP BY l.id, l.credits_allocated, l.credits_used, l.tier
         ORDER BY l.activated_at DESC LIMIT 1"
    ).bind(claims.sub).fetch_optional(&state.db).await?;

    if let Some((allocated, used, unsynced, tier)) = license {
        let balance = (allocated - used - unsynced as i32).max(0);
        return Ok(Json(json!({
            "balance": balance,
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

    // (Re)activate the gctrl-agent so KEX sees the license immediately. KEX gates
    // on the agent's signed JWT *file* (written only by the agent's own /activate),
    // NOT this DB row. The onboarding flow reaches here via App.tsx's post-login
    // /billing/license call, so firing /activate here closes the gap where a setup
    // that resolved WITHOUT the agent (branches 2/3) left KEX "not activated" until
    // a manual Settings re-entry. Best-effort: agent may be mid-start on a fresh box.
    let key = body.license_key.clone();
    tokio::spawn(async move {
        if let Err(e) = reqwest::Client::new()
            .post("http://gctrl-agent:7070/activate")
            .json(&json!({ "license_key": key }))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
        {
            tracing::warn!("register_license: best-effort agent activation failed: {e}");
        }
    });

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

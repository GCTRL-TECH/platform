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
    // NOTE: tier / credits are deliberately NOT read from the client. They are
    // resolved server-side from the license server (see register_license); any
    // tier/credits fields a client sends are ignored.
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

/// Tiers with UNLIMITED tokens: business and enterprise. `starter`/`pro` are
/// transitional aliases of business — migration 069 renamed local rows, but the
/// central license server may still mint those names until it is redeployed, so
/// they must not fall back to a metered path in the meantime.
pub(crate) fn is_unlimited_tier(tier: &str) -> bool {
    matches!(
        tier.to_ascii_lowercase().as_str(),
        "business" | "enterprise" | "starter" | "pro"
    )
}

/// Default token allocation per tier. Must stay in sync with the license server
/// (services/license-api/src/db/schema.ts → users.creditsBalance default = 3000).
///
/// Unlimited tiers have no real cap — this value is only a tracking allocation
/// for the legacy `credits_allocated` column (register_license fallback);
/// enforcement paths check is_unlimited_tier() and never gate on it.
fn tier_limit(tier: &str) -> i32 {
    if is_unlimited_tier(tier) {
        return i32::MAX;
    }
    1_000_000 // free — 1M/month local grant (migration 067)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlimited_tiers_and_aliases() {
        // business/enterprise are unlimited; starter/pro are transitional
        // aliases until the central license server ships the rename.
        for t in ["business", "enterprise", "starter", "pro", "Business", "PRO"] {
            assert!(is_unlimited_tier(t), "{t} should be unlimited");
        }
        for t in ["free", "Free", "", "individual"] {
            assert!(!is_unlimited_tier(t), "{t} should NOT be unlimited");
        }
        // Free keeps the 1M monthly local grant as its cap.
        assert_eq!(tier_limit("free"), 1_000_000);
    }
}

async fn balance(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // The free tier is a LOCAL monthly grant tracked on users.tokens_balance
    // (migration 067 + the free-grant tick); only a PAID license is metered by the
    // central license server. So read the local balance first and prefer it unless
    // the user holds an active NON-free license — this is what makes the 1M free
    // grant actually show in the dashboard instead of a stale free/3000 license.
    let (local_balance, user_tier): (Option<i32>, Option<String>) = sqlx::query_as(
        "SELECT tokens_balance, tier FROM users WHERE id = $1"
    ).bind(claims.sub).fetch_one(&state.db).await?;

    // Subtract unsynced token_usage so a paid balance reflects spend immediately
    // without waiting for the 60-second heartbeat round-trip to license-api.
    let paid_license = sqlx::query_as::<_, (i32, i32, i64, String)>(
        "SELECT l.credits_allocated, l.credits_used,
                COALESCE(SUM(tu.tokens_spent), 0)::bigint AS unsynced_spent,
                l.tier
         FROM licenses l
         LEFT JOIN token_usage tu
           ON tu.user_id = l.user_id AND tu.synced_to_license_api = false
         WHERE l.user_id = $1 AND l.status = 'active' AND l.tier <> 'free'
         GROUP BY l.id, l.credits_allocated, l.credits_used, l.tier
         ORDER BY l.activated_at DESC LIMIT 1"
    ).bind(claims.sub).fetch_optional(&state.db).await?;

    if let Some((allocated, used, unsynced, tier)) = paid_license {
        let balance = (allocated - used - unsynced as i32).max(0);
        // Unlimited tiers still report their tracking number as `balance` (the
        // dashboard graphs spend) but no cap: tierLimit null + unlimited true.
        if is_unlimited_tier(&tier) {
            return Ok(Json(json!({
                "balance": balance,
                "tier": tier,
                "tierLimit": Value::Null,
                "unlimited": true,
            })));
        }
        return Ok(Json(json!({
            "balance": balance,
            "tier": tier,
            "tierLimit": allocated,
            "unlimited": false,
        })));
    }

    // No paid license row, but users.tier can still be unlimited (e.g. tier
    // synced from the central server without a locally registered key) — the
    // effective tier must not degrade to a metered free view in that case.
    let tier = user_tier.unwrap_or_else(|| "free".into());
    if is_unlimited_tier(&tier) {
        return Ok(Json(json!({
            "balance": local_balance.unwrap_or(0),
            "tier": tier,
            "tierLimit": Value::Null,
            "unlimited": true,
        })));
    }

    // Free / no paid license → the local monthly grant is authoritative.
    Ok(Json(json!({
        "balance": local_balance.unwrap_or(0),
        "tier": tier,
        "tierLimit": tier_limit(&tier),
        "unlimited": false,
    })))
}

async fn register_license(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(body): Json<RegisterLicenseBody>,
) -> Result<Json<Value>> {
    // Resolve tier + credits AUTHORITATIVELY from the license server via the agent.
    // Client-supplied tier/credits are NEVER trusted — a logged-in user could
    // otherwise self-grant enterprise tier / arbitrary credits by editing this
    // request (or its localStorage source). This call also (re)activates the
    // agent's signed JWT so KEX recognizes the license — KEX gates on that file,
    // not this DB row.
    let agent_resp = reqwest::Client::new()
        .post("http://gctrl-agent:7070/activate")
        .json(&json!({ "license_key": body.license_key }))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;

    let resolved: Option<(String, i32)> = match agent_resp {
        Ok(resp) if resp.status().is_success() => {
            let v: Value = resp.json().await.unwrap_or_default();
            let tier = v["tier"].as_str().unwrap_or("free").to_string();
            let credits = v["credits_balance"].as_i64()
                .map(|c| c as i32)
                .unwrap_or_else(|| tier_limit(&tier));
            Some((tier, credits))
        }
        _ => None,
    };

    match resolved {
        // Authoritative values from the license server → upsert them.
        Some((tier, credits)) => {
            sqlx::query(
                "INSERT INTO licenses (user_id, license_key, tier, credits_allocated)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (license_key) DO UPDATE
                   SET tier = EXCLUDED.tier, credits_allocated = EXCLUDED.credits_allocated, updated_at = NOW()"
            )
            .bind(claims.sub).bind(&body.license_key).bind(&tier).bind(credits)
            .execute(&state.db).await?;
        }
        // Agent unreachable: register the key without trusting anyone. A brand-new
        // row defaults to free; an existing row keeps its authoritative values (the
        // heartbeat / a later reachable activation reconciles the real tier).
        None => {
            sqlx::query(
                "INSERT INTO licenses (user_id, license_key, tier, credits_allocated)
                 VALUES ($1, $2, 'free', $3)
                 ON CONFLICT (license_key) DO NOTHING"
            )
            .bind(claims.sub).bind(&body.license_key).bind(tier_limit("free"))
            .execute(&state.db).await?;
        }
    }

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

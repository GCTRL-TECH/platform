use axum::{
    extract::{Extension, Path, Query, State},
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use crate::{error::Result, middleware::auth::{require_role, JwtClaims}};

#[derive(Deserialize)]
struct LimitQuery { limit: Option<i64> }

#[derive(Deserialize)]
struct UpdateRoleBody { role: String, clearance: Option<String> }

#[derive(Deserialize)]
struct UpdateTokensBody { tokens_balance: i32 }

#[derive(Deserialize)]
struct UpdateLicenseBody {
    tier: Option<String>,
    credits_allocated: Option<i32>,
    status: Option<String>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/stats",               get(stats))
        .route("/users",               get(list_users))
        .route("/users/:id/role",      put(update_role))
        .route("/users/:id/tokens",    put(update_tokens))
        .route("/users/:id/licenses",  get(user_licenses))
        .route("/licenses/:id",        put(update_license))
        .route("/audit",               get(audit_log))
}

async fn stats(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db).await?;
    let jobs_total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM jobs")
        .fetch_one(&state.db).await?;
    let jobs_completed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE status = 'completed'")
        .fetch_one(&state.db).await?;
    let jobs_failed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE status = 'failed'")
        .fetch_one(&state.db).await?;
    let compilations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM compilations")
        .fetch_one(&state.db).await?;
    let tokens_spent: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(tokens_spent), 0) FROM token_usage")
        .fetch_one(&state.db).await?;
    let connectors: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM connectors WHERE status = 'active'")
        .fetch_one(&state.db).await.unwrap_or(0);

    Ok(Json(json!({
        "users": users,
        "jobs": { "total": jobs_total, "completed": jobs_completed, "failed": jobs_failed },
        "compilations": compilations,
        "tokensSpent": tokens_spent,
        "connectors": connectors,
    })))
}

async fn list_users(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    // LATERAL join picks the most recent active license per user.
    // Effective balance = credits_allocated - credits_used when a license exists,
    // otherwise fall back to users.tokens_balance so admin always sees the same
    // number as the client billing page.
    let rows = sqlx::query_as::<_, (
        uuid::Uuid, String, Option<String>, String, String,
        Option<String>, i32, bool, chrono::DateTime<chrono::Utc>,
        Option<String>, Option<i32>, Option<i32>
    )>(
        "SELECT u.id, u.email, u.name,
                u.role::TEXT AS role,
                u.clearance::TEXT AS clearance,
                u.tier,
                COALESCE(l.credits_allocated - l.credits_used, u.tokens_balance, 0) AS effective_balance,
                u.email_verified, u.created_at,
                l.tier AS license_tier,
                l.credits_allocated,
                l.credits_used
         FROM users u
         LEFT JOIN LATERAL (
             SELECT tier, credits_allocated, credits_used
             FROM licenses
             WHERE user_id = u.id AND status = 'active'
             ORDER BY activated_at DESC
             LIMIT 1
         ) l ON true
         ORDER BY u.created_at DESC"
    ).fetch_all(&state.db).await?;

    let users: Vec<Value> = rows.into_iter().map(|(id, email, name, role, clearance, tier, bal, verified, created, lic_tier, lic_alloc, lic_used)| {
        let has_license = lic_alloc.is_some();
        json!({
            "id": id,
            "email": email,
            "name": name,
            "role": role,
            "clearance": clearance,
            "tier": lic_tier.or(tier),
            "tokensBalance": bal,
            "hasLicense": has_license,
            "creditsAllocated": lic_alloc,
            "creditsUsed": lic_used,
            "emailVerified": verified,
            "createdAt": created,
        })
    }).collect();

    Ok(Json(json!({ "users": users })))
}

async fn update_role(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(user_id): Path<uuid::Uuid>,
    Json(body): Json<UpdateRoleBody>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let clearance = body.clearance.unwrap_or_else(|| match body.role.as_str() {
        "admin"   => "RESTRICTED".into(),
        "editor"  => "CONFIDENTIAL".into(),
        "analyst" => "INTERNAL".into(),
        _         => "PUBLIC".into(),
    });
    sqlx::query(
        "UPDATE users SET role = $1::user_role, clearance = $2::user_clearance, updated_at = NOW() WHERE id = $3"
    )
    .bind(&body.role)
    .bind(&clearance)
    .bind(user_id)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn update_tokens(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(user_id): Path<uuid::Uuid>,
    Json(body): Json<UpdateTokensBody>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    sqlx::query("UPDATE users SET tokens_balance = $1, updated_at = NOW() WHERE id = $2")
        .bind(body.tokens_balance)
        .bind(user_id)
        .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn user_licenses(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(user_id): Path<uuid::Uuid>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let rows = sqlx::query_as::<_, (uuid::Uuid, String, String, i32, i32, String, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, license_key, tier, credits_allocated, credits_used, status, activated_at
         FROM licenses WHERE user_id = $1 ORDER BY activated_at DESC"
    ).bind(user_id).fetch_all(&state.db).await?;

    let licenses: Vec<Value> = rows.into_iter().map(|(id, key, tier, alloc, used, status, activated)| {
        // Mask key: show first 8 chars then ***
        let masked = if key.len() > 8 {
            format!("{}***", &key[..8])
        } else {
            key.clone()
        };
        json!({
            "id": id,
            "licenseKey": masked,
            "tier": tier,
            "creditsAllocated": alloc,
            "creditsUsed": used,
            "creditsRemaining": alloc - used,
            "status": status,
            "activatedAt": activated,
        })
    }).collect();

    Ok(Json(json!({ "licenses": licenses })))
}

async fn update_license(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(license_id): Path<uuid::Uuid>,
    Json(body): Json<UpdateLicenseBody>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    if let Some(ref tier) = body.tier {
        sqlx::query("UPDATE licenses SET tier = $1, updated_at = NOW() WHERE id = $2")
            .bind(tier).bind(license_id).execute(&state.db).await?;
    }
    if let Some(credits) = body.credits_allocated {
        sqlx::query("UPDATE licenses SET credits_allocated = $1, updated_at = NOW() WHERE id = $2")
            .bind(credits).bind(license_id).execute(&state.db).await?;
    }
    if let Some(ref status) = body.status {
        sqlx::query("UPDATE licenses SET status = $1, updated_at = NOW() WHERE id = $2")
            .bind(status).bind(license_id).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn audit_log(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<LimitQuery>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let limit = q.limit.unwrap_or(100).min(500);
    let rows = sqlx::query_as::<_, (
        uuid::Uuid, Option<uuid::Uuid>, String, Option<String>, Option<String>,
        Option<Value>, Option<String>, chrono::DateTime<chrono::Utc>
    )>(
        "SELECT id, user_id, action, resource_type, resource_id, details,
                ip_address::TEXT, created_at
         FROM audit_log ORDER BY created_at DESC LIMIT $1"
    ).bind(limit).fetch_all(&state.db).await?;

    let entries: Vec<Value> = rows.into_iter().map(|(id, uid, action, rt, rid, details, ip, created)| {
        json!({
            "id": id,
            "userId": uid,
            "action": action,
            "resourceType": rt,
            "resourceId": rid,
            "details": details,
            "ipAddress": ip,
            "createdAt": created,
        })
    }).collect();

    Ok(Json(json!({ "logs": entries })))
}

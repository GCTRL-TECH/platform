//! A6 — USER-PROFILE / personalization memory (GDPR-aware, OPT-IN).
//!
//! Endpoints (all auth-required, owner-scoped; mounted under `/api/user`):
//!   • GET    /api/user/profile        — view the distilled facts + summary + enabled.
//!   • PUT    /api/user/profile        — edit: toggle `enabled` (opt-in) and/or
//!                                        correct/add/remove `facts` + `summary`.
//!   • DELETE /api/user/profile        — ERASE (right-to-be-forgotten): wipe the row.
//!   • POST   /api/user/profile/build  — distil facts from STANDARD-mode history via
//!                                        local Ollama (FUSE `/profile/build`).
//!
//! DSGVO: the profile is OFF by default; building requires `enabled=true`; the
//! source is STANDARD-mode conversation history only (incognito turns are never
//! persisted, so they can't be a source). The hot-block injection lives in rag.rs
//! and is skipped in incognito mode.

use axum::{extract::{Extension, State}, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;
use crate::{error::{AppError, Result}, middleware::auth::JwtClaims};

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/profile", get(get_profile).put(update_profile).delete(delete_profile))
        .route("/profile/build", axum::routing::post(build_profile))
}

#[derive(sqlx::FromRow)]
pub(crate) struct ProfileRow {
    facts: Value,
    summary: String,
    enabled: bool,
    updated_at: chrono::DateTime<chrono::Utc>,
}

/// Fetch the caller's profile row, if any.
pub(crate) async fn fetch_profile_row(db: &sqlx::PgPool, user_id: Uuid) -> Option<ProfileRow> {
    sqlx::query_as::<_, ProfileRow>(
        "SELECT facts, summary, enabled, updated_at FROM user_profile WHERE user_id = $1"
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

pub(crate) fn profile_json(row: Option<&ProfileRow>) -> Value {
    match row {
        Some(r) => json!({
            "enabled":   r.enabled,
            "facts":     r.facts,
            "summary":   r.summary,
            "updatedAt": r.updated_at,
        }),
        // No row yet → personalization has never been enabled.
        None => json!({
            "enabled":   false,
            "facts":     [],
            "summary":   "",
            "updatedAt": Value::Null,
        }),
    }
}

/// GET /api/user/profile — view distilled facts + summary + opt-in state.
async fn get_profile(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let row = fetch_profile_row(&state.db, claims.sub).await;
    Ok(Json(profile_json(row.as_ref())))
}

#[derive(Deserialize)]
struct UpdateProfileReq {
    /// Opt-in toggle. Some(true) enables personalization; Some(false) disables it
    /// (the row + distilled facts are kept; use DELETE to erase entirely).
    enabled: Option<bool>,
    /// User-curated facts ([{category, fact}]). When present, REPLACES stored facts
    /// (supports add/remove/correct from the Settings editor).
    facts: Option<Value>,
    /// User-curated summary. When present, REPLACES the stored summary.
    summary: Option<String>,
}

/// PUT /api/user/profile — opt-in toggle + edit facts/summary. Upserts the row so
/// the very first action (e.g. flipping `enabled` on) creates it.
async fn update_profile(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<UpdateProfileReq>,
) -> Result<Json<Value>> {
    // Validate facts shape if provided: must be an array of {category, fact}.
    if let Some(ref f) = req.facts {
        if !f.is_array() {
            return Err(AppError::BadRequest("facts must be an array".into()));
        }
    }

    // Ensure a row exists, then apply only the provided fields (COALESCE keeps the
    // rest untouched). enabled flips only when explicitly sent.
    sqlx::query(
        "INSERT INTO user_profile (user_id, facts, summary, enabled, updated_at) \
         VALUES ($1, COALESCE($2, '[]'::jsonb), COALESCE($3, ''), COALESCE($4, false), NOW()) \
         ON CONFLICT (user_id) DO UPDATE SET \
            facts      = COALESCE($2, user_profile.facts), \
            summary    = COALESCE($3, user_profile.summary), \
            enabled    = COALESCE($4, user_profile.enabled), \
            updated_at = NOW()"
    )
    .bind(claims.sub)
    .bind(req.facts.as_ref())
    .bind(req.summary.as_ref())
    .bind(req.enabled)
    .execute(&state.db)
    .await?;

    crate::services::audit::log_access(
        &state.db, &claims, "user_profile.update", "user_profile",
        &claims.sub.to_string(), 0, None, true, None,
    ).await;

    let row = fetch_profile_row(&state.db, claims.sub).await;
    Ok(Json(profile_json(row.as_ref())))
}

/// DELETE /api/user/profile — GDPR right-to-be-forgotten. Wipes the whole row.
async fn delete_profile(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let res = sqlx::query("DELETE FROM user_profile WHERE user_id = $1")
        .bind(claims.sub)
        .execute(&state.db)
        .await?;

    crate::services::audit::log_access(
        &state.db, &claims, "user_profile.erase", "user_profile",
        &claims.sub.to_string(), 0, None, true, None,
    ).await;

    Ok(Json(json!({ "ok": true, "erased": res.rows_affected() })))
}

/// POST /api/user/profile/build — distil the profile from STANDARD-mode history.
/// Refuses unless the profile is opted-in (enabled=true). Delegates the local
/// Ollama distillation to FUSE `/profile/build`.
async fn build_profile(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // OPT-IN gate (defence in depth — FUSE also checks).
    let enabled = fetch_profile_row(&state.db, claims.sub)
        .await
        .map(|r| r.enabled)
        .unwrap_or(false);
    if !enabled {
        return Err(AppError::Forbidden(
            "Enable personal memory first (opt-in) before building your profile.".into(),
        ));
    }

    let url = format!("{}/profile/build", state.cfg.fuse_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&json!({ "user_id": claims.sub.to_string() }))
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("FUSE unreachable: {e}")))?;

    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "FUSE profile build failed ({status}): {body}"
        )));
    }

    crate::services::audit::log_access(
        &state.db, &claims, "user_profile.build", "user_profile",
        &claims.sub.to_string(), 0, None, true, None,
    ).await;

    // Return the freshly-stored profile (FUSE wrote it; re-read for a single shape).
    let row = fetch_profile_row(&state.db, claims.sub).await;
    let mut out = profile_json(row.as_ref());
    if let Some(mc) = body.get("message_count") {
        out["messageCount"] = mc.clone();
    }
    Ok(Json(out))
}

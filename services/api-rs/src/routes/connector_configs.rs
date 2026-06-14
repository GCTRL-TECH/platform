//! Self-serve OAuth client credentials for connector providers.
//!
//! Lets a deployment administrator paste their own `client_id` + `client_secret`
//! for Google / Microsoft / Slack / GitHub through the Settings UI, instead of
//! requiring environment variables baked into the build.
//!
//! ## Design
//!
//! - One row per `provider`. Connector configs are deployment-wide (admin-managed),
//!   not per-user — Google OAuth clients are registered per deployment with a fixed
//!   redirect URI, so a global table matches reality.
//! - `client_secret` is stored plaintext for v1 — TODO: encrypt with pgcrypto
//!   before public release (see migration `011_connector_configs.sql`).
//! - All write/read endpoints require the `admin` role.
//! - `GET` endpoints mask the secret on the way out (`sk-****-WXYZ`-style).
//!
//! ## Routes (mounted under `/api/connectors`)
//!
//! - `GET    /config/providers`      → list every supported provider + setup state
//! - `GET    /config/:provider`      → read one provider's `client_id` (no secret)
//! - `PUT    /config/:provider`      → upsert `{ clientId, clientSecret }`
//! - `DELETE /config/:provider`      → clear that provider's config

use axum::{
    extract::{Extension, Path, State},
    routing::{get},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    error::{AppError, Result},
    middleware::auth::{require_role, JwtClaims},
};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Supported provider IDs and the developer console URL the user goes to to
/// create an OAuth client. Anything not in this list returns 400.
const SUPPORTED_PROVIDERS: &[(&str, &str, &str)] = &[
    ("google",    "Google Workspace",  "https://console.cloud.google.com/apis/credentials"),
    ("microsoft", "Microsoft 365",     "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"),
    ("slack",     "Slack",             "https://api.slack.com/apps"),
    ("github",    "GitHub",            "https://github.com/settings/developers"),
];

const DEFAULT_SCOPES: &[(&str, &[&str])] = &[
    ("google", &[
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
    ]),
    ("microsoft", &["Files.Read.All", "offline_access", "User.Read"]),
    ("slack",     &["channels:history", "channels:read"]),
    ("github",    &["repo", "read:org"]),
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn provider_info(provider: &str) -> Option<&'static (&'static str, &'static str, &'static str)> {
    SUPPORTED_PROVIDERS.iter().find(|(id, _, _)| *id == provider)
}

fn scopes_for(provider: &str) -> Vec<String> {
    DEFAULT_SCOPES
        .iter()
        .find(|(id, _)| *id == provider)
        .map(|(_, s)| s.iter().map(|x| x.to_string()).collect())
        .unwrap_or_default()
}

/// Derive the redirect URI from the deployment's `FRONTEND_URL`. Same shape used
/// by the live OAuth flow in `connectors.rs::google_callback`.
fn redirect_uri_for(provider: &str, frontend_url: &str) -> String {
    let base = frontend_url.trim_end_matches('/');
    format!("{base}/api/connectors/{provider}/callback")
}

/// Mask a secret so we can return it from `GET` without leaking. Shows the first
/// 4 + last 4 chars; everything in between becomes `***`. Empty / very short
/// secrets just collapse to `***`.
fn mask_secret(secret: &str) -> String {
    let len = secret.len();
    if len == 0 {
        return String::new();
    }
    if len <= 8 {
        return "*".repeat(len);
    }
    let head = &secret[..4];
    let tail = &secret[len - 4..];
    format!("{head}{}{tail}", "*".repeat(8))
}

// ─── DB row ──────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ConfigRow {
    provider:      String,
    client_id:     String,
    client_secret: String,
    is_active:     bool,
    updated_at:    chrono::DateTime<chrono::Utc>,
}

/// Public helper used by `connectors.rs`: returns `(client_id, client_secret)`
/// for a provider if a row exists and is active, else `None`. Callers should
/// fall back to env vars on `None` for backwards-compat.
pub async fn lookup_credentials(
    db: &sqlx::PgPool,
    provider: &str,
) -> Result<Option<(String, String)>> {
    let row: Option<(String, String, bool)> = sqlx::query_as(
        "SELECT client_id, client_secret, is_active
         FROM connector_configs WHERE provider = $1",
    )
    .bind(provider)
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|(id, secret, active)| {
        if active && !id.is_empty() && !secret.is_empty() {
            // Decrypt the at-rest secret for use (legacy plaintext passes through).
            Some((id, crate::services::crypto::open(&secret)))
        } else {
            None
        }
    }))
}

// ─── Request / response types ────────────────────────────────────────────────

#[derive(Deserialize)]
struct UpsertConfigReq {
    #[serde(rename = "clientId")]     client_id:     String,
    #[serde(rename = "clientSecret")] client_secret: String,
}

// ─── Router ──────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        // Frontend-expected shape (already wired in SettingsPage.tsx).
        .route("/config/providers", get(list_providers))
        .route("/config/:provider", get(get_provider).put(upsert_provider).delete(delete_provider))
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// GET /api/connectors/config/providers
///
/// Returns every supported provider with its setup URL, redirect URI to register
/// in the developer console, and whether a config is saved already.
async fn list_providers(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;

    let rows: Vec<ConfigRow> = sqlx::query_as(
        "SELECT provider, client_id, client_secret, is_active, updated_at
         FROM connector_configs",
    )
    .fetch_all(&state.db)
    .await?;

    let providers: Vec<Value> = SUPPORTED_PROVIDERS
        .iter()
        .map(|(id, name, setup_url)| {
            let row = rows.iter().find(|r| r.provider == *id);
            let configured = row.is_some_and(|r| {
                r.is_active && !r.client_id.is_empty() && !r.client_secret.is_empty()
            });
            json!({
                "id":           id,
                "name":         name,
                "description":  format!("Connect {} account", name),
                "setupUrl":     setup_url,
                "redirectUri":  redirect_uri_for(id, &state.cfg.frontend_url),
                "scopes":       scopes_for(id),
                "configured":   configured,
                // Mask the secret if present
                "clientId":     row.map(|r| r.client_id.clone()).unwrap_or_default(),
                "clientSecretMasked": row.map(|r| mask_secret(&crate::services::crypto::open(&r.client_secret))).unwrap_or_default(),
                "updatedAt":    row.map(|r| r.updated_at.to_rfc3339()),
            })
        })
        .collect();

    Ok(Json(json!({ "providers": providers })))
}

/// GET /api/connectors/config/:provider
///
/// Returns the saved `client_id` (plaintext, since it's not secret) and a masked
/// `clientSecret` so the UI can show that one is set without revealing it.
async fn get_provider(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(provider): Path<String>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;

    if provider_info(&provider).is_none() {
        return Err(AppError::BadRequest(format!(
            "Unsupported provider '{provider}'"
        )));
    }

    let row: Option<ConfigRow> = sqlx::query_as(
        "SELECT provider, client_id, client_secret, is_active, updated_at
         FROM connector_configs WHERE provider = $1",
    )
    .bind(&provider)
    .fetch_optional(&state.db)
    .await?;

    let Some(row) = row else {
        return Ok(Json(json!({
            "provider":           provider,
            "clientId":           "",
            "clientSecretMasked": "",
            "configured":         false,
        })));
    };

    Ok(Json(json!({
        "provider":           row.provider,
        "clientId":           row.client_id,
        "clientSecretMasked": mask_secret(&crate::services::crypto::open(&row.client_secret)),
        "configured":         row.is_active && !row.client_secret.is_empty(),
        "updatedAt":          row.updated_at.to_rfc3339(),
    })))
}

/// PUT /api/connectors/config/:provider
///
/// Upserts the row. Both fields are required. The row gets `updated_by = caller`
/// so we can audit who configured what.
async fn upsert_provider(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(provider): Path<String>,
    Json(req): Json<UpsertConfigReq>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;

    if provider_info(&provider).is_none() {
        return Err(AppError::BadRequest(format!(
            "Unsupported provider '{provider}'"
        )));
    }
    if req.client_id.trim().is_empty() || req.client_secret.trim().is_empty() {
        return Err(AppError::BadRequest(
            "clientId and clientSecret are both required".into(),
        ));
    }

    // client_secret is encrypted at rest via application-level AES-256-GCM
    // (see services/crypto.rs). Stored as `v1:<nonce>:<ciphertext>`; decrypted
    // on read by `lookup_credentials` and masked on GET.
    let caller: Uuid = claims.sub;
    let client_secret_sealed = crate::services::crypto::seal(req.client_secret.trim());
    sqlx::query(
        "INSERT INTO connector_configs (provider, client_id, client_secret, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider) DO UPDATE
            SET client_id     = EXCLUDED.client_id,
                client_secret = EXCLUDED.client_secret,
                is_active     = true,
                updated_by    = EXCLUDED.updated_by,
                updated_at    = NOW()",
    )
    .bind(&provider)
    .bind(req.client_id.trim())
    .bind(&client_secret_sealed)
    .bind(caller)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({
        "ok":       true,
        "provider": provider,
    })))
}

/// DELETE /api/connectors/config/:provider
async fn delete_provider(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(provider): Path<String>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;

    if provider_info(&provider).is_none() {
        return Err(AppError::BadRequest(format!(
            "Unsupported provider '{provider}'"
        )));
    }

    let res = sqlx::query("DELETE FROM connector_configs WHERE provider = $1")
        .bind(&provider)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({
        "ok":       true,
        "deleted":  res.rows_affected(),
    })))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_secret_short() {
        assert_eq!(mask_secret(""), "");
        assert_eq!(mask_secret("abc"), "***");
        assert_eq!(mask_secret("abcdefgh"), "********");
    }

    #[test]
    fn mask_secret_long() {
        // 12-char secret → first 4 + 8 stars + last 4
        let m = mask_secret("abcdEFGH1234");
        assert_eq!(m, "abcd********1234");
        assert!(!m.contains("EFGH"));
    }

    #[test]
    fn supported_providers_have_info() {
        assert!(provider_info("google").is_some());
        assert!(provider_info("nonsense").is_none());
    }

    #[test]
    fn redirect_uri_trims_trailing_slash() {
        let uri = redirect_uri_for("google", "http://localhost:4000/");
        assert_eq!(uri, "http://localhost:4000/api/connectors/google/callback");
    }
}

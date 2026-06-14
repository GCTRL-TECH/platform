//! Access audit trail.
//!
//! Records every classification-gated data read into `audit_log`, populating the
//! DSGVO access-audit columns added in migration 025 (which were previously
//! defined but never written). The acting access-token id is captured in
//! `details` so the Access Control page can show "which token read what".

use serde_json::json;
use crate::middleware::auth::JwtClaims;

/// Log one data-access event (best-effort, never blocks or fails the request).
///
/// * `effective_rank` — the clearance rank actually used to authorize the read
///   (base clearance raised by any per-graph grant).
/// * `classification_accessed` — the classification of the resource, when known.
/// * `granted` / `denial_reason` — outcome of the access decision.
#[allow(clippy::too_many_arguments)]
pub async fn log_access(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
    action: &str,
    resource_type: &str,
    resource_id: &str,
    effective_rank: i32,
    classification_accessed: Option<&str>,
    granted: bool,
    denial_reason: Option<&str>,
) {
    let details = json!({
        "api_key_id": claims.api_key_id,
        "email": claims.email,
        "via": if claims.api_key_id.is_some() { "token" } else { "session" },
    });
    let _ = sqlx::query(
        "INSERT INTO audit_log
            (user_id, action, resource_type, resource_id, details,
             clearance_level_used, classification_accessed, access_granted, denial_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)"
    )
    .bind(claims.sub)
    .bind(action)
    .bind(resource_type)
    .bind(resource_id)
    .bind(details)
    .bind(effective_rank.to_string())
    .bind(classification_accessed)
    .bind(granted)
    .bind(denial_reason)
    .execute(db)
    .await;
}

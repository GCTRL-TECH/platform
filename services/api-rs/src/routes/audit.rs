//! Read-only access-audit query API, backing the Access Control page's audit
//! trail. Lists `audit_log` rows for the caller, filterable by acting token,
//! compilation, time window, and allow/deny outcome.

use axum::{
    extract::{Extension, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::{error::Result, middleware::auth::JwtClaims};

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new().route("/", get(list_audit))
}

#[derive(Deserialize)]
struct AuditQuery {
    /// Filter by acting access-token id (recorded in details.api_key_id).
    token: Option<Uuid>,
    /// Filter by resource id (e.g. a compilation id).
    resource: Option<String>,
    /// Only granted (true) or only denied (false) accesses.
    granted: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// GET /api/audit?token=&resource=&granted=&limit=&offset=
async fn list_audit(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Value>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);

    // Scoped to the caller's own access events. Token filter matches the
    // api_key_id captured in the details JSONB.
    let rows = sqlx::query_as::<_, (
        Uuid, String, Option<String>, Option<String>, Value,
        Option<String>, Option<String>, Option<bool>, Option<String>,
        chrono::DateTime<chrono::Utc>, i64,
    )>(
        "SELECT id, action, resource_type, resource_id, details,
                clearance_level_used, classification_accessed, access_granted, denial_reason,
                created_at, COUNT(*) OVER () AS total
         FROM audit_log
         WHERE user_id = $1
           AND ($2::uuid IS NULL OR details->>'api_key_id' = $2::text)
           AND ($3::text IS NULL OR resource_id = $3)
           AND ($4::bool IS NULL OR access_granted = $4)
         ORDER BY created_at DESC
         LIMIT $5 OFFSET $6",
    )
    .bind(claims.sub)
    .bind(q.token)
    .bind(q.resource)
    .bind(q.granted)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = rows.first().map(|r| r.10).unwrap_or(0);
    let entries: Vec<Value> = rows.into_iter().map(|(
        id, action, rtype, rid, details, clearance, classification, granted, denial, created, _t,
    )| json!({
        "id": id, "action": action, "resourceType": rtype, "resourceId": rid,
        "tokenId": details.get("api_key_id"), "via": details.get("via"),
        "clearanceUsed": clearance, "classificationAccessed": classification,
        "granted": granted, "denialReason": denial, "createdAt": created,
    })).collect();

    Ok(Json(json!({ "entries": entries, "total": total })))
}

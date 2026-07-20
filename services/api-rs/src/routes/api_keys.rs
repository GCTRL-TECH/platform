use axum::{
    extract::{Extension, Path, State},
    routing::{delete, get},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Sha256, Digest};
use std::sync::Arc;
use uuid::Uuid;

use crate::{error::{AppError, Result}, middleware::auth::JwtClaims};

#[derive(Deserialize)]
struct CreateKeyReq {
    name: String,
    #[serde(rename = "maxClearanceRank", default = "default_clearance")]
    max_clearance_rank: i32,
    /// Preferred: the chosen classification level (system OR custom). When set,
    /// the rank + name are derived from it so custom levels are preserved.
    #[serde(rename = "maxClearanceLevelId", default)]
    max_clearance_level_id: Option<Uuid>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Optional per-graph grants: let this token reach specific compilations
    /// beyond its base clearance.
    #[serde(default)]
    grants: Vec<GrantInput>,
    /// KB-scoped (Single-Owner + Scoped Tokens): when true this token may ONLY
    /// read/write the compilations in its grant set — every other knowledge base
    /// is invisible. Use for colleague tokens. Default false = full owner access.
    #[serde(rename = "kbScoped", default)]
    kb_scoped: bool,
    /// Wave 2 — embed tokens: when true, the auth middleware rejects any
    /// request from this key that isn't GET/HEAD/OPTIONS (enforced in
    /// middleware/auth.rs, not here — this is just the flag's origin).
    #[serde(rename = "readOnly", default)]
    read_only: bool,
}

/// Resolve a token's clearance to (rank, level_name, level_id) — preferring an
/// explicit classification level (system or custom) and falling back to a bare
/// numeric rank mapped onto the standard bands.
async fn resolve_clearance(
    db: &sqlx::PgPool,
    level_id: Option<Uuid>,
    rank: i32,
) -> (i32, String, Option<Uuid>) {
    if let Some(lid) = level_id {
        if let Some((r, name)) = sqlx::query_as::<_, (i32, String)>(
            "SELECT rank, name FROM classification_levels WHERE id = $1"
        ).bind(lid).fetch_optional(db).await.ok().flatten() {
            return (r, name, Some(lid));
        }
    }
    (rank, clearance_name(rank).to_string(), None)
}
fn default_clearance() -> i32 { 100 }

/// Map a numeric clearance rank to the legacy level-name label stored on the key.
fn clearance_name(rank: i32) -> &'static str {
    match rank {
        r if r <= 0   => "PUBLIC",
        r if r <= 100 => "INTERNAL",
        r if r <= 200 => "CONFIDENTIAL",
        _             => "STRICTLY_CONFIDENTIAL",
    }
}

#[derive(Deserialize)]
struct GrantInput {
    #[serde(rename = "compilationId")] compilation_id: Uuid,
    #[serde(rename = "grantedRank")]  granted_rank: Option<i32>,
}

#[derive(Deserialize)]
struct UpdateKeyReq {
    name: Option<String>,
    #[serde(rename = "maxClearanceRank")] max_clearance_rank: Option<i32>,
    #[serde(rename = "maxClearanceLevelId")] max_clearance_level_id: Option<Uuid>,
}

#[derive(Serialize)]
struct ApiKeyView {
    id: Uuid,
    name: String,
    key_prefix: Option<String>,
    max_clearance_rank: i32,
    max_clearance_level: Option<String>,
    last_used_at: Option<chrono::DateTime<chrono::Utc>>,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: chrono::DateTime<chrono::Utc>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/api-keys",     get(list_keys).post(create_key))
        .route("/api-keys/:id", delete(delete_key).put(update_key))
        .route("/api-keys/:id/grants", axum::routing::post(add_grant))
        .route("/api-keys/:id/grants/:compilation_id", delete(remove_grant))
}

/// Fetch the per-graph grants for a set of api keys, keyed by api_key_id, with
/// the compilation name resolved for display.
async fn grants_for_keys(
    db: &sqlx::PgPool,
    key_ids: &[Uuid],
) -> std::collections::HashMap<Uuid, Vec<Value>> {
    let mut map: std::collections::HashMap<Uuid, Vec<Value>> = std::collections::HashMap::new();
    if key_ids.is_empty() { return map; }
    let rows = sqlx::query_as::<_, (Uuid, Uuid, String, Option<i32>)>(
        "SELECT g.api_key_id, g.compilation_id, c.name, g.granted_rank
         FROM api_key_grants g JOIN compilations c ON c.id = g.compilation_id
         WHERE g.api_key_id = ANY($1) ORDER BY c.name"
    ).bind(key_ids).fetch_all(db).await.unwrap_or_default();
    for (kid, cid, name, rank) in rows {
        map.entry(kid).or_default().push(json!({
            "compilationId": cid, "compilationName": name, "grantedRank": rank,
        }));
    }
    map
}

async fn list_keys(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, i32, Option<String>, Option<Uuid>, Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>, chrono::DateTime<chrono::Utc>, bool, bool)>(
        "SELECT id, name, key_prefix, max_clearance_rank, max_clearance_level, max_clearance_level_id,
                last_used_at, expires_at, created_at, kb_scoped, read_only
         FROM api_keys WHERE user_id = $1
         ORDER BY created_at DESC"
    )
    .bind(claims.sub)
    .fetch_all(&state.db).await?;

    let key_ids: Vec<Uuid> = rows.iter().map(|r| r.0).collect();
    let mut grants = grants_for_keys(&state.db, &key_ids).await;

    let keys: Vec<Value> = rows.into_iter().map(|(id, name, prefix, rank, level, level_id, used, exp, created, kb_scoped, read_only)| {
        json!({
            "id": id,
            "name": name,
            "keyPrefix": prefix,
            "maxClearanceRank": rank,
            "maxClearanceLevel": level,
            "maxClearanceLevelId": level_id,
            "lastUsedAt": used,
            "expiresAt": exp,
            "createdAt": created,
            "kbScoped": kb_scoped,
            "readOnly": read_only,
            "grants": grants.remove(&id).unwrap_or_default(),
        })
    }).collect();

    Ok(Json(json!({ "apiKeys": keys })))
}

async fn create_key(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateKeyReq>,
) -> Result<Json<Value>> {
    // Generate a random key in the format gctrl_<uuid_hex>
    let raw = format!("gctrl_{}", Uuid::new_v4().simple());
    let hash = hex::encode(Sha256::digest(raw.as_bytes()));
    let prefix = &raw[..raw.len().min(12)];

    // Derive (rank, level name, level id) from the chosen classification level
    // (preferred) or a bare rank — so custom levels are preserved on the token.
    let (rank, clearance_name, level_id) =
        resolve_clearance(&state.db, req.max_clearance_level_id, req.max_clearance_rank).await;

    // A key created WITH explicit compilation grants is a limited key by intent —
    // force kb_scoped so "limited" actually limits. Without this, an unscoped key
    // with grants could still list/read every other knowledge base at its base
    // clearance (grants would merely RAISE access instead of confining it).
    let kb_scoped = req.kb_scoped || !req.grants.is_empty();

    // ── Packaging boundary: scoped tokens are a Business feature ──────────────
    // Free is "one full-access token for yourself"; issuing SCOPED tokens to
    // colleagues is what a Business seat buys. Gate CREATION only — never
    // validation — so tokens already issued keep authenticating and no running
    // agent setup breaks when a license lapses.
    //
    // Per-tier packaging: free → none, business → 10 scoped tokens per active
    // license (stack licenses for more seats), enterprise → unlimited. Unknown
    // paid tiers are allowed but count-limited like business — an unrecognized
    // tier name must not end up MORE privileged than a paying business customer.
    //
    // This is a packaging guardrail, not DRM — GCTRL is self-hosted by design.
    if kb_scoped {
        let tier: Option<String> = sqlx::query_scalar(
            "SELECT tier FROM licenses
             WHERE user_id = $1 AND status = 'active'
             ORDER BY activated_at DESC LIMIT 1"
        ).bind(claims.sub).fetch_optional(&state.db).await?;

        let Some(tier) = tier.filter(|t| !t.eq_ignore_ascii_case("free")) else {
            return Err(AppError::Forbidden(
                "Scoped access tokens are a Business feature. The Free plan includes one \
                 full-access token for your own use — upgrade to issue scoped tokens to colleagues."
                    .into(),
            ));
        };

        if !tier.eq_ignore_ascii_case("enterprise") {
            let scoped_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM api_keys WHERE user_id = $1 AND kb_scoped = true"
            ).bind(claims.sub).fetch_one(&state.db).await?;

            // starter/pro are transitional business aliases until the central
            // license server is redeployed (see routes::billing::is_unlimited_tier).
            let license_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM licenses
                 WHERE user_id = $1 AND status = 'active'
                   AND tier IN ('business','starter','pro')"
            ).bind(claims.sub).fetch_one(&state.db).await?;

            // .max(1): an active NON-free license of an unrecognized tier still
            // buys one business-sized block of seats — count-limited, not blocked.
            let max = 10 * license_count.max(1);
            if scoped_count >= max {
                return Err(AppError::Forbidden(format!(
                    "Business includes 10 scoped tokens per license — you've used {scoped_count}/{max}. \
                     Add another Business license for more seats, or contact us for Enterprise (unlimited)."
                )));
            }
        }
    }

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO api_keys
           (user_id, key_hash, key_prefix, name, max_clearance_rank, max_clearance_level, max_clearance_level_id, expires_at, kb_scoped, read_only)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id"
    )
    .bind(claims.sub)
    .bind(&hash)
    .bind(prefix)
    .bind(&req.name)
    .bind(rank)
    .bind(&clearance_name)
    .bind(level_id)
    .bind(req.expires_at)
    .bind(kb_scoped)
    .bind(req.read_only)
    .fetch_one(&state.db).await?;

    // Per-graph grants — only for compilations the caller actually owns.
    for g in &req.grants {
        let owns: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM compilations WHERE id = $1 AND user_id = $2)"
        ).bind(g.compilation_id).bind(claims.sub).fetch_one(&state.db).await.unwrap_or(false);
        if !owns { continue; }
        let _ = sqlx::query(
            "INSERT INTO api_key_grants (api_key_id, compilation_id, granted_rank)
             VALUES ($1, $2, $3) ON CONFLICT (api_key_id, compilation_id) DO NOTHING"
        ).bind(id).bind(g.compilation_id).bind(g.granted_rank).execute(&state.db).await;
    }

    Ok(Json(json!({
        "id":               id,
        "key":              raw,    // returned ONCE — never stored in plain form
        "keyPrefix":        prefix,
        "name":             req.name,
        "maxClearanceRank": rank,
        "maxClearanceLevel": clearance_name,
        "maxClearanceLevelId": level_id,
        "expiresAt":        req.expires_at,
        "kbScoped":         kb_scoped,
        "readOnly":         req.read_only,
        "grants":           grants_for_keys(&state.db, &[id]).await.remove(&id).unwrap_or_default(),
    })))
}

async fn delete_key(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query("DELETE FROM api_keys WHERE id = $1 AND user_id = $2")
        .bind(id).bind(claims.sub).execute(&state.db).await?.rows_affected();
    if rows == 0 { return Err(AppError::NotFound); }
    Ok(Json(json!({ "ok": true })))
}

/// PUT /api/users/api-keys/:id  { name?, maxClearanceRank? }
/// Edit a token's name and/or base clearance after creation. The secret itself
/// is never re-issued; only metadata changes.
async fn update_key(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateKeyReq>,
) -> Result<Json<Value>> {
    // Resolve the new clearance from the chosen level (preferred) or a bare rank.
    let (rank, level_name, level_id, set_clear) =
        if req.max_clearance_level_id.is_some() || req.max_clearance_rank.is_some() {
            let (r, n, l) = resolve_clearance(
                &state.db, req.max_clearance_level_id,
                req.max_clearance_rank.unwrap_or_else(default_clearance),
            ).await;
            (Some(r), Some(n), l, true)
        } else {
            (None, None, None, false)
        };

    let rows = sqlx::query(
        "UPDATE api_keys SET
            name = COALESCE($1, name),
            max_clearance_rank = COALESCE($2, max_clearance_rank),
            max_clearance_level = COALESCE($3, max_clearance_level),
            max_clearance_level_id = CASE WHEN $4 THEN $5 ELSE max_clearance_level_id END
          WHERE id = $6 AND user_id = $7"
    )
    .bind(req.name)
    .bind(rank)
    .bind(level_name)
    .bind(set_clear)
    .bind(level_id)
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db).await?.rows_affected();
    if rows == 0 { return Err(AppError::NotFound); }
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/users/api-keys/:id/grants  { compilationId, grantedRank? }
/// Grant an existing token access to one compilation. Both the key and the
/// compilation must belong to the caller.
async fn add_grant(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(g): Json<GrantInput>,
) -> Result<Json<Value>> {
    let owns_key: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM api_keys WHERE id = $1 AND user_id = $2)"
    ).bind(id).bind(claims.sub).fetch_one(&state.db).await?;
    if !owns_key { return Err(AppError::NotFound); }

    let owns_comp: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM compilations WHERE id = $1 AND user_id = $2)"
    ).bind(g.compilation_id).bind(claims.sub).fetch_one(&state.db).await?;
    if !owns_comp { return Err(AppError::Forbidden("Not your compilation".into())); }

    sqlx::query(
        "INSERT INTO api_key_grants (api_key_id, compilation_id, granted_rank)
         VALUES ($1, $2, $3)
         ON CONFLICT (api_key_id, compilation_id) DO UPDATE SET granted_rank = EXCLUDED.granted_rank"
    ).bind(id).bind(g.compilation_id).bind(g.granted_rank).execute(&state.db).await?;

    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/users/api-keys/:id/grants/:compilation_id — revoke a grant.
async fn remove_grant(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path((id, compilation_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "DELETE FROM api_key_grants g USING api_keys k
         WHERE g.api_key_id = k.id AND k.user_id = $1
           AND g.api_key_id = $2 AND g.compilation_id = $3"
    ).bind(claims.sub).bind(id).bind(compilation_id).execute(&state.db).await?.rows_affected();
    if rows == 0 { return Err(AppError::NotFound); }
    Ok(Json(json!({ "ok": true })))
}

use axum::{extract::{Request, State}, http::StatusCode, middleware::Next, response::{IntoResponse, Response}};
use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub:       uuid::Uuid,
    pub email:     String,
    pub role:      String,
    pub clearance: Option<String>,
    pub exp:       usize,
    /// Max clearance rank imposed by the API key used for this request.
    /// None when authenticated via JWT (no cap beyond the user's own rank).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_rank: Option<i32>,
    /// Id of the API key (access token) used for this request, when any.
    /// Drives per-graph grants and the access audit trail. None for JWT auth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_id: Option<uuid::Uuid>,
    /// True when the API key used for this request is read-only (Wave 2 embed
    /// tokens). Enforced as a single chokepoint in both auth middlewares below:
    /// a read-only key gets 403 on anything but GET/HEAD/OPTIONS. Always false
    /// for JWT auth (a logged-in user is never read-only via this flag).
    /// `#[serde(default)]` so tokens signed before this field existed still
    /// decode fine (as non-read-only).
    #[serde(default)]
    pub read_only: bool,
    /// In-process-only per-session clearance override (NOT part of the JWT). Set
    /// by the agent chat handler so the onboard CTO agent can run at full access
    /// (i32::MAX) for an admin, or a downgraded rank. `#[serde(skip)]` means it is
    /// never read from or written to a token, so it can't be forged.
    #[serde(skip)]
    pub agent_override_rank: Option<i32>,
}

pub async fn require_auth(
    State(state): State<Arc<crate::models::AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let claims = if let Some(token) = auth_header.strip_prefix("Bearer ") {
        // ── JWT path (existing behaviour) ─────────────────────────────────────
        let key = DecodingKey::from_secret(state.cfg.jwt_secret.as_bytes());
        let claims = decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256))
            .map_err(|_| StatusCode::UNAUTHORIZED)?
            .claims;

        // SEC-2: reject deprovisioned (is_active=false) users. The JWT itself
        // carries no active flag, so we do a single cheap lookup. A removed user
        // whose access token hasn't expired is blocked here on the next request.
        let active: Option<bool> = sqlx::query_scalar(
            "SELECT is_active FROM users WHERE id = $1",
        )
        .bind(claims.sub)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        match active {
            Some(true) => {}
            _ => return Err(StatusCode::UNAUTHORIZED),
        }

        claims
    } else if let Some(raw_key) = auth_header.strip_prefix("ApiKey ") {
        // ── API key path ───────────────────────────────────────────────────────
        let raw_key = raw_key.trim();
        let hash = hex::encode(Sha256::digest(raw_key.as_bytes()));

        // SEC-2: the join also filters out inactive users (api_keys are deleted on
        // deprovision, but the is_active guard is belt-and-suspenders).
        let row = sqlx::query_as::<_, (uuid::Uuid, uuid::Uuid, i32, String, String, bool)>(
            "SELECT ak.id, ak.user_id, ak.max_clearance_rank, u.email, u.role, ak.read_only
             FROM api_keys ak
             JOIN users u ON u.id = ak.user_id
             WHERE ak.key_hash = $1
               AND u.is_active = true
               AND (ak.expires_at IS NULL OR ak.expires_at > NOW())"
        )
        .bind(&hash)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

        let (key_id, user_id, max_rank, email, role, read_only) = row;

        // Wave 2 — read-only embed tokens: a single chokepoint blocking any
        // mutating request before it ever reaches a route handler.
        if read_only && !matches!(req.method(), &axum::http::Method::GET | &axum::http::Method::HEAD | &axum::http::Method::OPTIONS) {
            return Err(StatusCode::FORBIDDEN);
        }

        // Update last_used_at asynchronously — don't wait, best-effort only
        let db = state.db.clone();
        let hash_clone = hash.clone();
        tokio::spawn(async move {
            let _ = sqlx::query(
                "UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1"
            )
            .bind(&hash_clone)
            .execute(&db)
            .await;
        });

        JwtClaims {
            sub: user_id,
            email,
            role,
            clearance: None,
            exp: usize::MAX,
            api_key_rank: Some(max_rank),
            api_key_id: Some(key_id),
            read_only,
            agent_override_rank: None,
        }
    } else {
        return Err(StatusCode::UNAUTHORIZED);
    };

    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

pub async fn optional_auth(
    State(state): State<Arc<crate::models::AppState>>,
    mut req: Request,
    next: Next,
) -> Response {
    let auth_value = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let method = req.method().clone();

    let claims: Option<JwtClaims> = match auth_value.as_deref() {
        // JWT path (existing behaviour) — best-effort, never fails the request.
        Some(v) if v.starts_with("Bearer ") => {
            let token = v.trim_start_matches("Bearer ");
            let key = DecodingKey::from_secret(state.cfg.jwt_secret.as_bytes());
            decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256))
                .ok()
                .map(|data| data.claims)
        }
        // ApiKey path — resolve a scoped access token so RAG (and the WIKI fast
        // path) work under `Authorization: ApiKey …` too. Non-fatal: an invalid
        // key just yields None and the public path is used.
        Some(v) if v.starts_with("ApiKey ") => {
            let raw_key = v.trim_start_matches("ApiKey ").trim();
            let hash = hex::encode(Sha256::digest(raw_key.as_bytes()));
            sqlx::query_as::<_, (uuid::Uuid, uuid::Uuid, i32, String, String, bool)>(
                "SELECT ak.id, ak.user_id, ak.max_clearance_rank, u.email, u.role, ak.read_only
                 FROM api_keys ak
                 JOIN users u ON u.id = ak.user_id
                 WHERE ak.key_hash = $1
                   AND u.is_active = true
                   AND (ak.expires_at IS NULL OR ak.expires_at > NOW())"
            )
            .bind(&hash)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .map(|(key_id, user_id, max_rank, email, role, read_only)| JwtClaims {
                sub: user_id,
                email,
                role,
                clearance: None,
                exp: usize::MAX,
                api_key_rank: Some(max_rank),
                api_key_id: Some(key_id),
                read_only,
                agent_override_rank: None,
            })
        }
        _ => None,
    };

    // Wave 2 — same read-only chokepoint as require_auth. optional_auth never
    // fails the request for a missing/invalid token, but a VALID read-only
    // token must not be allowed to mutate through the optional-auth routes
    // (e.g. RAG) either.
    if let Some(c) = &claims {
        if c.read_only && !matches!(method, axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    req.extensions_mut().insert(claims);
    next.run(req).await
}

pub fn require_role(claims: &JwtClaims, role: &str) -> crate::error::Result<()> {
    const ORDER: &[&str] = &["viewer", "analyst", "editor", "admin"];
    let user_level = ORDER.iter().position(|&r| r == claims.role).unwrap_or(0);
    let req_level  = ORDER.iter().position(|&r| r == role).unwrap_or(0);
    if user_level >= req_level { Ok(()) }
    else { Err(crate::error::AppError::Forbidden(format!("Requires role: {role}"))) }
}

pub fn sign_access(cfg: &crate::config::Config, claims: &JwtClaims) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    encode(&Header::default(), claims, &EncodingKey::from_secret(cfg.jwt_secret.as_bytes())).unwrap()
}

pub fn sign_refresh(cfg: &crate::config::Config, sub: uuid::Uuid, email: &str) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    #[derive(Serialize)]
    struct Refresh { sub: uuid::Uuid, email: String, exp: usize }
    let claims = Refresh {
        sub,
        email: email.into(),
        exp: (chrono::Utc::now() + chrono::Duration::days(7)).timestamp() as usize,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(cfg.jwt_refresh_secret.as_bytes())).unwrap()
}

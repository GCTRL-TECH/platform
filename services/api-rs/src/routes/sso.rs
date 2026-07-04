use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    response::IntoResponse,
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    error::{AppError, Result},
    middleware::auth::{sign_access, sign_refresh, JwtClaims},
};

// ─── Shared types ─────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct UserOut {
    id: Uuid,
    email: String,
    name: Option<String>,
    role: String,
    clearance: Option<String>,
    tier: Option<String>,
    #[serde(rename = "tokensBalance")]
    tokens_balance: Option<i32>,
}

#[derive(Serialize)]
struct AuthTokens {
    #[serde(rename = "token")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    user: UserOut,
}

// ─── Router constructors ──────────────────────────────────────────────────────

/// Public routes: no JWT required (OIDC authorize + callback).
pub fn public_router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/oidc/authorize", get(oidc_authorize))
        .route("/oidc/callback", get(oidc_callback))
}

/// Protected routes: require JWT (SSO config management + SCIM token management).
pub fn protected_router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/config", get(get_sso_config))
        .route("/config", post(create_sso_config))
        .route("/config/:id", delete(delete_sso_config))
        .route("/scim-tokens", get(list_scim_tokens).post(create_scim_token))
        .route("/scim-tokens/:id", delete(delete_scim_token))
}

/// SCIM v2 routes: authenticated via Bearer SCIM token (not JWT).
pub fn scim_router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/v2/Users", get(scim_list_users))
        .route("/v2/Users", post(scim_create_user))
        .route("/v2/Users/:id", get(scim_get_user))
        .route("/v2/Users/:id", put(scim_update_user))
        .route("/v2/Users/:id", patch(scim_patch_user))
        .route("/v2/Users/:id", delete(scim_delete_user))
}

// ═══════════════════════════════════════════════════════════════════════════════
// OIDC – Authorize
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
struct AuthorizeQuery {
    provider: Option<String>,
}

#[derive(Serialize)]
struct AuthorizeResponse {
    #[serde(rename = "authUrl")]
    auth_url: String,
}

async fn oidc_authorize(
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<AuthorizeQuery>,
) -> Result<axum::response::Response> {
    let provider_filter = q.provider.unwrap_or_default();

    // Load the first active SSO config (optionally filtered by provider)
    let row = if provider_filter.is_empty() {
        sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
            "SELECT issuer_url, client_id, redirect_uri, provider::TEXT
             FROM sso_configs WHERE is_active = true LIMIT 1",
        )
        .fetch_optional(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
            "SELECT issuer_url, client_id, redirect_uri, provider::TEXT
             FROM sso_configs WHERE is_active = true AND provider = $1 LIMIT 1",
        )
        .bind(&provider_filter)
        .fetch_optional(&state.db)
        .await?
    };

    let (issuer_url, client_id, redirect_uri, _provider) =
        row.ok_or(AppError::NotFound)?;

    let redirect = redirect_uri.unwrap_or_else(|| {
        format!(
            "http://localhost:{}/api/auth/sso/oidc/callback",
            state.cfg.port
        )
    });

    // CSRF + replay protection. The random `state` is (a) persisted server-side
    // single-use, AND (b) bound to the initiating browser via an HttpOnly cookie
    // checked at the callback — so an attacker can't feed a victim a state+code
    // pair they obtained themselves (login CSRF). The `nonce` is sent to the IdP
    // and verified inside the (JWKS-validated) id_token, proving the token was
    // minted for THIS login attempt.
    let state_param = hex::encode(Uuid::new_v4().as_bytes());
    let nonce = hex::encode(Uuid::new_v4().as_bytes());
    let _ = sqlx::query("DELETE FROM oidc_states WHERE created_at < NOW() - INTERVAL '10 minutes'")
        .execute(&state.db)
        .await;
    sqlx::query("INSERT INTO oidc_states (state, nonce) VALUES ($1, $2)")
        .bind(&state_param)
        .bind(&nonce)
        .execute(&state.db)
        .await?;

    // Percent-encode dynamic URL components using the `url` crate's serializer
    let encoded_client_id: String = url::form_urlencoded::byte_serialize(client_id.as_bytes()).collect();
    let encoded_redirect: String  = url::form_urlencoded::byte_serialize(redirect.as_bytes()).collect();

    let auth_url = format!(
        "{issuer_url}/authorize?response_type=code\
         &client_id={encoded_client_id}\
         &redirect_uri={encoded_redirect}\
         &scope=openid+email+profile\
         &state={state_param}\
         &nonce={nonce}"
    );

    // Bind the state to this browser. SameSite=Lax lets it ride the IdP's
    // top-level redirect back to the callback; HttpOnly/Secure keep it out of JS
    // and off plaintext.
    let cookie = format!(
        "oidc_state={state_param}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600"
    );
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(AuthorizeResponse { auth_url }),
    ).into_response())
}

// ═══════════════════════════════════════════════════════════════════════════════
// OIDC – Callback
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
struct CallbackQuery {
    code: String,
    state: Option<String>,
    // error from IdP (e.g. access_denied)
    error: Option<String>,
}

// Minimal token endpoint response
#[derive(Deserialize)]
struct TokenResponse {
    id_token: String,
}

// Minimal JWT claims we care about from the IdP's id_token
#[derive(Deserialize, Debug)]
struct IdTokenClaims {
    sub: String,
    email: Option<String>,
    name: Option<String>,
    nonce: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Value,
}

#[derive(Deserialize)]
struct OidcDiscovery {
    jwks_uri: String,
}

async fn oidc_callback(
    State(state): State<Arc<crate::models::AppState>>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Result<Json<AuthTokens>> {
    if let Some(err) = q.error {
        return Err(AppError::BadRequest(format!("IdP returned error: {err}")));
    }

    // CSRF protection (three checks):
    //  1. `state` must be one we issued and still unexpired (server-side store).
    //  2. It must equal the `oidc_state` cookie set on THIS browser at authorize
    //     time — so a state+code pair obtained by an attacker can't be replayed
    //     in a victim's session (login CSRF).
    //  3. It is consumed single-use (DELETE) and yields the bound `nonce`.
    let provided_state = q
        .state
        .clone()
        .ok_or_else(|| AppError::BadRequest("Missing OAuth state".into()))?;

    let cookie_state = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|c| {
                let c = c.trim();
                c.strip_prefix("oidc_state=").map(|s| s.to_string())
            })
        });
    match cookie_state {
        Some(cs) if cs == provided_state => {}
        _ => return Err(AppError::BadRequest("OAuth state cookie missing or mismatched".into())),
    }

    let nonce_row: Option<(Option<String>,)> = sqlx::query_as(
        "DELETE FROM oidc_states \
         WHERE state = $1 AND created_at > NOW() - INTERVAL '10 minutes' \
         RETURNING nonce",
    )
    .bind(&provided_state)
    .fetch_optional(&state.db)
    .await?;
    let Some((expected_nonce,)) = nonce_row else {
        return Err(AppError::BadRequest("Invalid or expired OAuth state".into()));
    };

    // Fetch active SSO config
    let (config_id, provider, issuer_url, client_id, client_secret, redirect_uri, default_role) =
        sqlx::query_as::<_, (Uuid, String, String, String, String, Option<String>, String)>(
            "SELECT id, provider::TEXT, issuer_url, client_id, client_secret, redirect_uri, default_role
             FROM sso_configs WHERE is_active = true LIMIT 1",
        )
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::BadRequest("No active SSO config found".into()))?;

    // client_secret is stored sealed (AES-256-GCM); decrypt before the token
    // exchange. crypto::open passes legacy plaintext rows through unchanged.
    let client_secret = crate::services::crypto::open(&client_secret);

    let redirect = redirect_uri.unwrap_or_else(|| {
        format!(
            "http://localhost:{}/api/auth/sso/oidc/callback",
            state.cfg.port
        )
    });

    // Exchange authorization code for tokens
    let token_url = format!("{issuer_url}/token");
    let http = reqwest::Client::new();
    let token_resp: TokenResponse = http
        .post(&token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &q.code),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("redirect_uri", &redirect),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Token exchange failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Token parse failed: {e}")))?;

    // Verify the id_token against the IdP's JWKS (signature + iss + aud + exp),
    // then check the nonce binds it to this login attempt.
    let id_claims = verify_id_token(&token_resp.id_token, &issuer_url, &client_id).await?;
    match (&id_claims.nonce, &expected_nonce) {
        (Some(got), Some(exp)) if got == exp => {}
        _ => return Err(AppError::BadRequest("id_token nonce mismatch".into())),
    }

    let sso_sub = &id_claims.sub;
    let email = id_claims
        .email
        .clone()
        .unwrap_or_else(|| format!("{sso_sub}@sso.local"));
    let display_name = id_claims.name.clone();
    // Namespace the subject per SSO config so two IdPs that both mint subject
    // "12345" can never collide into the same GCTRL account.
    let namespaced_sub = format!("{config_id}|{sso_sub}");

    // Upsert user by (sso_provider, sso_subject) — fall back to email match for
    // accounts that pre-existed before SSO was configured
    let user = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<String>, Option<String>, Option<i32>)>(
        r#"
        INSERT INTO users (id, email, name, role, clearance, tokens_balance, tier,
                           sso_provider, sso_subject, sso_attributes, password_hash)
        VALUES (uuid_generate_v4(), $1, $2, $3, 'PUBLIC', 3000, 'free',
                $4, $5, $6, '')
        ON CONFLICT (sso_provider, sso_subject) WHERE sso_provider IS NOT NULL
        DO UPDATE SET
            email          = EXCLUDED.email,
            name           = COALESCE(EXCLUDED.name, users.name),
            sso_attributes = EXCLUDED.sso_attributes,
            updated_at     = NOW()
        RETURNING id, email, name, role::TEXT, clearance::TEXT, tier, tokens_balance
        "#,
    )
    .bind(&email)
    .bind(&display_name)
    .bind(&default_role)
    .bind(&provider)          // real provider from sso_configs (not literal "oidc")
    .bind(&namespaced_sub)    // config-namespaced subject — no cross-IdP collision
    .bind(&id_claims.extra)
    .fetch_one(&state.db)
    .await?;

    let (id, email, name, role, clearance, tier, balance) = user;

    let claims = JwtClaims {
        sub: id,
        email: email.clone(),
        role: role.clone(),
        clearance: clearance.clone(),
        exp: (chrono::Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
        api_key_rank: None,
        api_key_id: None,
        read_only: false,
        agent_override_rank: None,
    };

    Ok(Json(AuthTokens {
        access_token: sign_access(&state.cfg, &claims),
        refresh_token: sign_refresh(&state.cfg, id, &email),
        user: UserOut {
            id,
            email,
            name,
            role,
            clearance,
            tier,
            tokens_balance: balance,
        },
    }))
}

/// Verify an OIDC id_token against the issuer's JWKS.
///
/// Fetches `{issuer}/.well-known/openid-configuration` → `jwks_uri` → the JWK
/// set, selects the key matching the token's `kid`, and validates the signature
/// plus `iss`, `aud` (= client_id) and `exp`. Returns the validated claims.
/// This is the trust anchor for SSO login — without it a forged id_token would
/// be accepted on its word.
async fn verify_id_token(
    token: &str,
    issuer_url: &str,
    client_id: &str,
) -> Result<IdTokenClaims> {
    use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};

    let header = decode_header(token)
        .map_err(|e| AppError::BadRequest(format!("Malformed id_token header: {e}")))?;
    let kid = header.kid
        .ok_or_else(|| AppError::BadRequest("id_token missing kid".into()))?;

    let http = reqwest::Client::new();
    let discovery: OidcDiscovery = http
        .get(format!("{}/.well-known/openid-configuration", issuer_url.trim_end_matches('/')))
        .timeout(std::time::Duration::from_secs(10))
        .send().await
        .map_err(|e| AppError::Internal(format!("OIDC discovery failed: {e}")))?
        .json().await
        .map_err(|e| AppError::Internal(format!("OIDC discovery parse: {e}")))?;

    let jwks: jsonwebtoken::jwk::JwkSet = http
        .get(&discovery.jwks_uri)
        .timeout(std::time::Duration::from_secs(10))
        .send().await
        .map_err(|e| AppError::Internal(format!("JWKS fetch failed: {e}")))?
        .json().await
        .map_err(|e| AppError::Internal(format!("JWKS parse: {e}")))?;

    let jwk = jwks.find(&kid)
        .ok_or_else(|| AppError::BadRequest("No JWKS key matches id_token kid".into()))?;
    let key = DecodingKey::from_jwk(jwk)
        .map_err(|e| AppError::Internal(format!("JWKS key decode: {e}")))?;

    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[issuer_url]);
    validation.set_audience(&[client_id]);

    let data = decode::<IdTokenClaims>(token, &key, &validation)
        .map_err(|e| AppError::BadRequest(format!("id_token verification failed: {e}")))?;
    Ok(data.claims)
}

// ═══════════════════════════════════════════════════════════════════════════════
// SSO Config management (protected)
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Serialize, sqlx::FromRow)]
struct SsoConfigOut {
    id: Uuid,
    provider: String,
    issuer_url: String,
    client_id: String,
    redirect_uri: Option<String>,
    scopes: Vec<String>,
    default_role: String,
    default_clearance_rank: i32,
    is_active: bool,
    created_at: chrono::DateTime<chrono::Utc>,
}

async fn get_sso_config(
    State(state): State<Arc<crate::models::AppState>>,
    axum::Extension(claims): axum::Extension<JwtClaims>,
) -> Result<Json<Vec<SsoConfigOut>>> {
    crate::middleware::auth::require_role(&claims, "admin")?;

    let configs = sqlx::query_as::<_, SsoConfigOut>(
        "SELECT id, provider, issuer_url, client_id, redirect_uri, scopes,
                default_role, default_clearance_rank, is_active, created_at
         FROM sso_configs
         WHERE user_id = $1
         ORDER BY created_at DESC",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(configs))
}

#[derive(Deserialize)]
struct CreateSsoConfigReq {
    provider: String,
    issuer_url: String,
    client_id: String,
    client_secret: String,
    redirect_uri: Option<String>,
    scopes: Option<Vec<String>>,
    default_role: Option<String>,
    default_clearance_rank: Option<i32>,
}

async fn create_sso_config(
    State(state): State<Arc<crate::models::AppState>>,
    axum::Extension(claims): axum::Extension<JwtClaims>,
    Json(req): Json<CreateSsoConfigReq>,
) -> Result<Json<SsoConfigOut>> {
    crate::middleware::auth::require_role(&claims, "admin")?;

    let scopes = req
        .scopes
        .unwrap_or_else(|| vec!["openid".into(), "email".into(), "profile".into()]);
    let default_role = req.default_role.unwrap_or_else(|| "viewer".into());
    let default_rank = req.default_clearance_rank.unwrap_or(100);

    let config = sqlx::query_as::<_, SsoConfigOut>(
        r#"
        INSERT INTO sso_configs
            (user_id, provider, issuer_url, client_id, client_secret,
             redirect_uri, scopes, default_role, default_clearance_rank)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, provider, issuer_url, client_id, redirect_uri, scopes,
                  default_role, default_clearance_rank, is_active, created_at
        "#,
    )
    .bind(claims.sub)
    .bind(&req.provider)
    .bind(&req.issuer_url)
    .bind(&req.client_id)
    // Encrypt the client secret at rest (AES-256-GCM via crypto::seal). Read sites
    // (oidc_callback) decrypt with crypto::open before the token exchange.
    .bind(crate::services::crypto::seal(&req.client_secret))
    .bind(&req.redirect_uri)
    .bind(&scopes)
    .bind(&default_role)
    .bind(default_rank)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(config))
}

async fn delete_sso_config(
    State(state): State<Arc<crate::models::AppState>>,
    axum::Extension(claims): axum::Extension<JwtClaims>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    crate::middleware::auth::require_role(&claims, "admin")?;

    let rows = sqlx::query(
        "DELETE FROM sso_configs WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCIM v2 – helpers
// ═══════════════════════════════════════════════════════════════════════════════

/// Authenticate a SCIM request by validating the Bearer token against scim_tokens.
async fn authenticate_scim(
    state: &Arc<crate::models::AppState>,
    headers: &axum::http::HeaderMap,
) -> Result<Uuid> {
    let raw_token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?
        .trim()
        .to_owned();

    let hash = hex::encode(Sha256::digest(raw_token.as_bytes()));

    let owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM scim_tokens WHERE token_hash = $1 LIMIT 1",
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;

    owner.ok_or(AppError::Unauthorized)
}

#[derive(Serialize)]
struct ScimUser {
    schemas: Vec<String>,
    id: Uuid,
    #[serde(rename = "userName")]
    user_name: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    emails: Vec<ScimEmail>,
    active: bool,
    meta: ScimMeta,
}

#[derive(Serialize)]
struct ScimEmail {
    value: String,
    primary: bool,
}

#[derive(Serialize)]
struct ScimMeta {
    #[serde(rename = "resourceType")]
    resource_type: String,
    created: chrono::DateTime<chrono::Utc>,
    #[serde(rename = "lastModified")]
    last_modified: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize)]
struct ScimListResponse {
    schemas: Vec<String>,
    #[serde(rename = "totalResults")]
    total_results: i64,
    #[serde(rename = "startIndex")]
    start_index: i64,
    #[serde(rename = "itemsPerPage")]
    items_per_page: i64,
    #[serde(rename = "Resources")]
    resources: Vec<ScimUser>,
}

// Row type pulled from DB for SCIM
#[derive(sqlx::FromRow)]
struct UserRow {
    id: Uuid,
    email: String,
    name: Option<String>,
    role: String,
    is_active: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

fn to_scim_user(row: &UserRow) -> ScimUser {
    // Reflect the real deprovisioning state, not a hardcoded value (SEC-2).
    let active = row.is_active && row.role != "suspended";
    ScimUser {
        schemas: vec!["urn:ietf:params:scim:schemas:core:2.0:User".into()],
        id: row.id,
        user_name: row.email.clone(),
        display_name: row.name.clone(),
        emails: vec![ScimEmail {
            value: row.email.clone(),
            primary: true,
        }],
        active,
        meta: ScimMeta {
            resource_type: "User".into(),
            created: row.created_at,
            last_modified: row.updated_at.unwrap_or(row.created_at),
        },
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCIM v2 – endpoints
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
struct ScimListQuery {
    #[serde(rename = "startIndex")]
    start_index: Option<i64>,
    count: Option<i64>,
}

async fn scim_list_users(
    State(state): State<Arc<crate::models::AppState>>,
    headers: axum::http::HeaderMap,
    Query(q): Query<ScimListQuery>,
) -> Result<Json<ScimListResponse>> {
    let owner_id = authenticate_scim(&state, &headers).await?;

    let start = q.start_index.unwrap_or(1).max(1);
    let limit = q.count.unwrap_or(100).clamp(1, 200);
    let offset = start - 1;

    // Only list SSO-provisioned users (not native accounts) — prevents
    // a SCIM token from enumerating all users in the system.
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE sso_provider = 'scim' AND provisioned_by = $1")
            .bind(owner_id)
            .fetch_one(&state.db)
            .await?;

    let rows = sqlx::query_as::<_, UserRow>(
        "SELECT id, email, name, role::TEXT as role, is_active, created_at, updated_at
         FROM users
         WHERE sso_provider = 'scim' AND provisioned_by = $1
         ORDER BY created_at ASC
         LIMIT $2 OFFSET $3",
    )
    .bind(owner_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let resources: Vec<ScimUser> = rows.iter().map(to_scim_user).collect();

    Ok(Json(ScimListResponse {
        schemas: vec!["urn:ietf:params:scim:api:messages:2.0:ListResponse".into()],
        total_results: total,
        start_index: start,
        items_per_page: limit,
        resources,
    }))
}

#[derive(Deserialize)]
struct ScimCreateReq {
    #[serde(rename = "userName")]
    user_name: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    emails: Option<Vec<ScimEmailIn>>,
    roles: Option<Vec<ScimRoleIn>>,
    active: Option<bool>,
}

#[derive(Deserialize)]
struct ScimEmailIn {
    value: String,
}

#[derive(Deserialize)]
struct ScimRoleIn {
    value: String,
}

/// Allowed roles that SCIM can assign — prevents privilege escalation.
fn validate_scim_role(role: &str) -> std::result::Result<&str, AppError> {
    match role {
        "viewer" | "editor" | "admin" => Ok(role),
        _ => Err(AppError::BadRequest(format!(
            "Role '{role}' is not allowed via SCIM; use viewer, editor, or admin"
        ))),
    }
}

async fn scim_create_user(
    State(state): State<Arc<crate::models::AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<ScimCreateReq>,
) -> Result<Json<ScimUser>> {
    let owner_id = authenticate_scim(&state, &headers).await?;

    // Resolve email: prefer emails[0].value, fall back to userName
    let email = req
        .emails
        .as_ref()
        .and_then(|e| e.first())
        .map(|e| e.value.clone())
        .unwrap_or_else(|| req.user_name.clone());

    let raw_role = req
        .roles
        .as_ref()
        .and_then(|r| r.first())
        .map(|r| r.value.as_str())
        .unwrap_or("viewer");
    let role = validate_scim_role(raw_role)?;

    // On email conflict: only update display name — never overwrite the role of an
    // existing account, preventing privilege escalation via SCIM upsert.
    //
    // SECURITY: the conflict path touches ONLY rows this SCIM owner already
    // provisioned (`users.provisioned_by = $4`). It must NOT claim native accounts
    // (`provisioned_by IS NULL`) or another tenant's rows — otherwise an attacker
    // could SCIM-create a user with a victim's email, claim the native password
    // account, and take it over via the IdP. `provisioned_by` is held immutable on
    // update (it already equals $4 by the WHERE). A collision with any
    // non-owned/native account fails the WHERE → fetch_optional None → 409.
    let row = sqlx::query_as::<_, UserRow>(
        r#"
        INSERT INTO users (id, email, name, role, clearance, tokens_balance, tier,
                           password_hash, sso_provider, provisioned_by)
        VALUES (uuid_generate_v4(), $1, $2, $3, 'PUBLIC', 3000, 'free', '', 'scim', $4)
        ON CONFLICT (email) DO UPDATE SET
            name           = COALESCE(EXCLUDED.name, users.name),
            provisioned_by = users.provisioned_by,
            updated_at     = NOW()
        WHERE users.provisioned_by = $4 AND users.sso_provider = 'scim'
        RETURNING id, email, name, role::TEXT as role, is_active, created_at, updated_at
        "#,
    )
    .bind(&email)
    .bind(&req.display_name)
    .bind(role)
    .bind(owner_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Conflict(
        "A user with this email already exists and is not SCIM-provisioned by this owner".into(),
    ))?;

    Ok(Json(to_scim_user(&row)))
}

async fn scim_get_user(
    State(state): State<Arc<crate::models::AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<ScimUser>> {
    let owner_id = authenticate_scim(&state, &headers).await?;

    // Restrict to users THIS SCIM owner provisioned (tenant isolation).
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, email, name, role::TEXT as role, is_active, created_at, updated_at
         FROM users WHERE id = $1 AND sso_provider = 'scim' AND provisioned_by = $2",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(to_scim_user(&row)))
}

/// Full replace (PUT) — updates display name, role, and active status
async fn scim_update_user(
    State(state): State<Arc<crate::models::AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<ScimCreateReq>,
) -> Result<Json<ScimUser>> {
    let owner_id = authenticate_scim(&state, &headers).await?;

    let raw_role = if req.active == Some(false) {
        "viewer"
    } else {
        req.roles
            .as_ref()
            .and_then(|r| r.first())
            .map(|r| r.value.as_str())
            .unwrap_or("viewer")
    };
    let role = validate_scim_role(raw_role)?;

    // SEC-2: PUT carries `active`; reflect it. Default (None) → active=true for a
    // full replace, matching SCIM semantics. Deprovision revokes access below.
    let new_active = req.active.unwrap_or(true);

    let row = sqlx::query_as::<_, UserRow>(
        "UPDATE users
         SET name = COALESCE($1, name),
             role = $2,
             is_active = $5,
             updated_at = NOW()
         WHERE id = $3 AND sso_provider = 'scim' AND provisioned_by = $4
         RETURNING id, email, name, role::TEXT as role, is_active, created_at, updated_at",
    )
    .bind(&req.display_name)
    .bind(role)
    .bind(id)
    .bind(owner_id)
    .bind(new_active)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    if !new_active {
        let _ = sqlx::query("DELETE FROM api_keys WHERE user_id = $1")
            .bind(id)
            .execute(&state.db)
            .await;
    }

    Ok(Json(to_scim_user(&row)))
}

/// Partial update (PATCH) — handles displayName and active
#[derive(Deserialize)]
struct ScimPatchReq {
    #[serde(rename = "Operations")]
    operations: Option<Vec<ScimPatchOp>>,
    // Direct fields (some clients send these instead of operations)
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    active: Option<bool>,
}

#[derive(Deserialize)]
struct ScimPatchOp {
    op: String,
    path: Option<String>,
    value: Option<serde_json::Value>,
}

async fn scim_patch_user(
    State(state): State<Arc<crate::models::AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<ScimPatchReq>,
) -> Result<Json<ScimUser>> {
    let owner_id = authenticate_scim(&state, &headers).await?;

    // Resolve new display_name and active from either Operations or direct fields
    let mut new_name: Option<String> = req.display_name;
    let mut new_active: Option<bool> = req.active;

    if let Some(ops) = &req.operations {
        for op in ops {
            if op.op.to_lowercase() == "replace" {
                match op.path.as_deref() {
                    Some("displayName") => {
                        new_name = op.value.as_ref().and_then(|v| v.as_str()).map(String::from);
                    }
                    Some("active") => {
                        new_active = op.value.as_ref().and_then(|v| v.as_bool());
                    }
                    _ => {}
                }
            }
        }
    }

    // Targeted update, scoped to sso_provider = 'scim' + provisioned_by so we
    // only ever touch users THIS SCIM owner provisioned (never native accounts).
    // SEC-2: `active=false` actually DEPROVISIONS — set is_active=false here and
    // revoke the user's access below; `active=true` reactivates. `active` does not
    // change role (no privilege change via PATCH).
    //
    // COALESCE($2, is_active) keeps is_active unchanged when `active` was omitted.
    let new_active_db: Option<bool> = new_active;
    let row = sqlx::query_as::<_, UserRow>(
            "UPDATE users
             SET name = COALESCE($1, name),
                 is_active = COALESCE($4, is_active),
                 updated_at = NOW()
             WHERE id = $2 AND sso_provider = 'scim' AND provisioned_by = $3
             RETURNING id, email, name, role::TEXT as role, is_active, created_at, updated_at",
        )
        .bind(&new_name)
        .bind(id)
        .bind(owner_id)
        .bind(new_active_db)
        .fetch_optional(&state.db)
        .await?;

    let row = row.ok_or(AppError::NotFound)?;

    // SEC-2: when deprovisioned, revoke the user's standing access immediately.
    // Delete their API keys so an `ApiKey`-authenticated request fails at once.
    // Refresh tokens are stateless JWTs, so they're not stored to delete — the
    // is_active check in the auth middleware / login blocks them on next use.
    if new_active == Some(false) {
        let _ = sqlx::query("DELETE FROM api_keys WHERE user_id = $1")
            .bind(id)
            .execute(&state.db)
            .await;
    }

    Ok(Json(to_scim_user(&row)))
}

async fn scim_delete_user(
    State(state): State<Arc<crate::models::AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<axum::http::StatusCode> {
    let owner_id = authenticate_scim(&state, &headers).await?;

    // Only allow deleting users THIS SCIM owner provisioned (tenant isolation).
    let rows = sqlx::query(
        "DELETE FROM users WHERE id = $1 AND sso_provider = 'scim' AND provisioned_by = $2",
    )
        .bind(id)
        .bind(owner_id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound);
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCIM Token management (protected JWT routes)
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Serialize, sqlx::FromRow)]
struct ScimTokenView {
    id: Uuid,
    description: Option<String>,
    last_used_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: chrono::DateTime<chrono::Utc>,
}

async fn list_scim_tokens(
    State(state): State<Arc<crate::models::AppState>>,
    axum::Extension(claims): axum::Extension<JwtClaims>,
) -> Result<Json<serde_json::Value>> {
    crate::middleware::auth::require_role(&claims, "admin")?;
    let tokens = sqlx::query_as::<_, ScimTokenView>(
        "SELECT id, description, last_used_at, created_at
         FROM scim_tokens WHERE user_id = $1 ORDER BY created_at DESC",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(serde_json::json!({ "tokens": tokens })))
}

#[derive(Deserialize)]
struct CreateScimTokenReq {
    description: Option<String>,
}

async fn create_scim_token(
    State(state): State<Arc<crate::models::AppState>>,
    axum::Extension(claims): axum::Extension<JwtClaims>,
    Json(req): Json<CreateScimTokenReq>,
) -> Result<Json<serde_json::Value>> {
    crate::middleware::auth::require_role(&claims, "admin")?;

    let raw = format!("scim_{}", hex::encode(Uuid::new_v4().as_bytes()));
    let hash = hex::encode(Sha256::digest(raw.as_bytes()));
    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO scim_tokens (id, user_id, token_hash, description) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(claims.sub)
    .bind(&hash)
    .bind(&req.description)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "id": id, "token": raw })))
}

async fn delete_scim_token(
    State(state): State<Arc<crate::models::AppState>>,
    axum::Extension(claims): axum::Extension<JwtClaims>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    crate::middleware::auth::require_role(&claims, "admin")?;
    sqlx::query("DELETE FROM scim_tokens WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(claims.sub)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

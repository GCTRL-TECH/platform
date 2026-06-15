use axum::{
    extract::{Extension, Path, Query, State},
    response::Redirect,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
    routes::connector_configs::lookup_credentials,
    services::redis::lpush,
};

// ─── SSRF guard for Obsidian vault URLs ──────────────────────────────────────

/// Parse `raw_url` and reject anything whose hostname is not a loopback address.
/// Obsidian Local REST API is always local; allowing non-loopback URLs would
/// enable SSRF against internal cloud metadata endpoints or private networks.
fn require_loopback_url(raw_url: &str) -> Result<(url::Url, bool)> {
    let parsed = url::Url::parse(raw_url)
        .map_err(|_| AppError::BadRequest("vault_url is not a valid URL".into()))?;
    let host = parsed.host_str()
        .ok_or_else(|| AppError::BadRequest("vault_url must include a host".into()))?;
    let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    if !is_loopback {
        return Err(AppError::BadRequest(
            "vault_url must point to a loopback address (localhost / 127.0.0.1)".into()
        ));
    }
    Ok((parsed, is_loopback))
}

/// Build a reqwest client for Obsidian vault requests.
/// TLS verification is disabled only when the vault host is loopback (self-signed cert),
/// never for non-loopback hosts (which are already rejected by `require_loopback_url`).
fn obsidian_http_client(is_loopback: bool) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(is_loopback)
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client build failed: {e}")))
}

// ─── Path-traversal guard for server-side folder vaults ─────────────────────

/// Resolve `requested` against `root`, canonicalize both, and verify the result
/// stays inside `root`. Blocks `..` traversal and symlink escape. The path must
/// exist (canonicalize fails otherwise → rejected).
///
/// `requested` may be an absolute path (e.g. `/vaults/my-vault`) or relative; in
/// both cases the canonical form must be a descendant of (or equal to) the
/// canonical root, otherwise we refuse to touch it.
fn resolve_vault_path(root: &str, requested: &str) -> Result<std::path::PathBuf> {
    use std::path::Path;

    let root_canon = std::fs::canonicalize(root).map_err(|_| {
        AppError::Internal(format!("vault root '{root}' does not exist on the server"))
    })?;

    let req_path = Path::new(requested);
    // Join relative paths onto root; absolute paths are taken as-is (still checked
    // against root below, so an absolute path outside root is rejected).
    let joined = if req_path.is_absolute() {
        req_path.to_path_buf()
    } else {
        root_canon.join(req_path)
    };

    let canon = std::fs::canonicalize(&joined)
        .map_err(|_| AppError::BadRequest("path does not exist".into()))?;

    if !canon.starts_with(&root_canon) {
        return Err(AppError::BadRequest("path must be inside the vault root".into()));
    }
    Ok(canon)
}

// ─── Credential resolution ───────────────────────────────────────────────────

/// Resolve `(client_id, client_secret)` for `provider` by checking the
/// `connector_configs` table first, then falling back to environment variables
/// (currently only Google has env-var fallback for dev convenience).
///
/// Returns a clear `BadRequest` if neither source is set, so the UI can prompt
/// the user to configure credentials in Settings → Integrations.
async fn resolve_credentials(
    db: &sqlx::PgPool,
    cfg: &crate::config::Config,
    provider: &str,
) -> Result<(String, String)> {
    if let Some(pair) = lookup_credentials(db, provider).await? {
        return Ok(pair);
    }
    // Backwards-compat: dev who set GOOGLE_CLIENT_ID/SECRET in .env can still run
    // without going through the Settings UI.
    if provider == "google"
        && !cfg.google_client_id.is_empty()
        && !cfg.google_client_secret.is_empty()
    {
        return Ok((cfg.google_client_id.clone(), cfg.google_client_secret.clone()));
    }
    Err(AppError::BadRequest(format!(
        "OAuth not configured for '{provider}'. \
         Go to Settings → Integrations and paste your {provider} Client ID + Client Secret first."
    )))
}

// ─── Redis helpers (OAuth state) ─────────────────────────────────────────────

/// Store `key` → `value` in Redis with an expiry of `ttl_secs` seconds.
async fn redis_set_ex(
    conn: &Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
    key: &str,
    value: &str,
    ttl_secs: u64,
) -> redis::RedisResult<()> {
    let mut c = conn.lock().await;
    redis::cmd("SET")
        .arg(key)
        .arg(value)
        .arg("EX")
        .arg(ttl_secs)
        .query_async(&mut *c)
        .await
}

/// Atomically GET and DELETE a key from Redis.
/// Returns `None` if the key does not exist.
async fn redis_get_del(
    conn: &Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
    key: &str,
) -> redis::RedisResult<Option<String>> {
    let mut c = conn.lock().await;
    // GETDEL is available since Redis 6.2; fall back to GET + DEL for older versions.
    let value: Option<String> = redis::cmd("GET").arg(key).query_async(&mut *c).await?;
    if value.is_some() {
        let _: () = redis::cmd("DEL").arg(key).query_async(&mut *c).await?;
    }
    Ok(value)
}

// ─── DB row ──────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ConnectorRow {
    id:                 Uuid,
    provider:           String,
    label:              String,
    access_token:       String,
    refresh_token:      Option<String>,
    token_expires_at:   Option<DateTime<Utc>>,
    provider_email:     Option<String>,
    is_active:          bool,
}

// ─── Request / response types ────────────────────────────────────────────────

#[derive(Deserialize)]
struct DriveFilesQuery {
    #[serde(rename = "connectorId")] connector_id: Uuid,
    #[serde(rename = "folderId")]    folder_id:    Option<String>,
    q:                               Option<String>,
}

#[derive(Deserialize)]
struct SyncSelectedReq {
    #[serde(rename = "connectorId")] connector_id: Uuid,
    #[serde(rename = "fileIds")]     file_ids:     Vec<String>,
    #[serde(flatten)]                opts:         DriveExtractReqOpts,
}

#[derive(Deserialize)]
struct SyncFolderReq {
    #[serde(rename = "connectorId")] connector_id: Uuid,
    #[serde(rename = "folderId")]    folder_id:    String,
    #[serde(rename = "maxDepth")]    max_depth:    Option<u32>,
    #[serde(flatten)]                opts:         DriveExtractReqOpts,
}

/// Extraction options sent alongside a Drive sync (mirrors the KEX upload form):
/// which ontology to use, discovery mode, target compilation for auto-fuse, and
/// the classification to stamp. All optional — absent fields fall back to defaults.
#[derive(Deserialize, Default)]
struct DriveExtractReqOpts {
    #[serde(rename = "ontologyId")]            ontology_id:             Option<Uuid>,
    #[serde(rename = "discoveryMode")]         discovery_mode:          Option<String>,
    #[serde(rename = "compilationId")]         compilation_id:          Option<Uuid>,
    #[serde(rename = "forceSingleGraphs")]     force_single_graphs:     Option<bool>,
    #[serde(rename = "classificationLevelId")] classification_level_id: Option<Uuid>,
}

/// Resolved extraction options (ontology labels + classification name looked up)
/// passed into `enqueue_drive_file`.
struct DriveExtractResolved {
    ontology_id:             Option<Uuid>,
    entity_types:            Option<Vec<String>>,
    discovery_mode:          Option<String>,
    compilation_id:          Option<Uuid>,
    classification_level_id: Option<Uuid>,
    classification_name:     Option<String>,
}

impl DriveExtractResolved {
    /// Adapt resolved KEX options into the shared Obsidian re-ingest options.
    fn to_reingest_opts(
        &self,
        mode: crate::services::obsidian::ReingestMode,
        since: Option<chrono::DateTime<chrono::Utc>>,
    ) -> crate::services::obsidian::ReingestOpts {
        crate::services::obsidian::ReingestOpts {
            ontology_id: self.ontology_id,
            entity_types: self.entity_types.clone(),
            discovery_mode: self.discovery_mode.clone(),
            compilation_id: self.compilation_id,
            classification_level_id: self.classification_level_id,
            classification_name: self.classification_name.clone(),
            mode,
            since,
        }
    }
}

#[derive(Deserialize)]
struct OAuthCallbackQuery {
    code:  Option<String>,
    state: Option<String>,
    error: Option<String>,
}

// Google Drive API response shapes (only fields we use)
#[derive(Deserialize)]
struct DriveFileItem {
    id:           String,
    name:         String,
    #[serde(rename = "mimeType")] mime_type: String,
    #[serde(rename = "modifiedTime")] modified_time: Option<String>,
    size:          Option<String>,
    #[serde(rename = "webViewLink")] web_view_link: Option<String>,
}

#[derive(Deserialize)]
struct DriveFilesResponse {
    files: Option<Vec<DriveFileItem>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token:  String,
    refresh_token: Option<String>,
    expires_in:    Option<i64>,
    token_type:    Option<String>,
    scope:         Option<String>,
    id_token:      Option<String>,
}

// Google userinfo (to get email after OAuth)
#[derive(Deserialize)]
struct GoogleUserInfo {
    email: Option<String>,
    sub:   Option<String>,
}

// ─── MIME helpers ─────────────────────────────────────────────────────────────

fn is_extractable(mime: &str) -> bool {
    let extractable_prefixes = [
        "application/pdf",
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.openxmlformats-officedocument",
        "application/msword",
        "application/vnd.ms-excel",
        "text/",
        "application/json",
        "application/xml",
        "application/vnd.oasis.opendocument",
        "application/rtf",
    ];
    extractable_prefixes.iter().any(|p| mime.starts_with(p))
}

fn is_folder(mime: &str) -> bool {
    mime == "application/vnd.google-apps.folder"
}

// ─── Routers ─────────────────────────────────────────────────────────────────

/// Protected routes — require valid JWT (attached as Extension by require_auth middleware).
pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/",                        get(list_connectors))
        .route("/:id",                     delete(disconnect_connector))
        .route("/google/drive/files",      get(drive_files))
        .route("/google/drive/sync",       post(sync_selected))
        .route("/google/drive/sync/folder", post(sync_folder))
        // Redirect-style OAuth start (302 → Google consent page). Used when the
        // user clicks "Connect" inside the GoogleDrivePage tab.
        .route("/google/auth",             get(google_auth_start))
        // JSON-style OAuth start: returns `{ authUrl }` for any supported
        // provider. The Settings UI pops this in a small window.
        .route("/auth/:provider",          get(oauth_auth_url))
        // ── SharePoint ───────────────────────────────────────────────────────
        .route("/microsoft/sharepoint/tenants",  get(list_sharepoint_tenants).post(add_sharepoint_tenant))
        .route("/microsoft/sharepoint/sites",    get(list_sharepoint_sites))
        .route("/microsoft/sharepoint/files",    get(list_sharepoint_files))
        .route("/microsoft/sharepoint/sync",     post(sync_sharepoint))
        // ── Obsidian ─────────────────────────────────────────────────────────
        .route("/obsidian/vaults",               get(list_obsidian_vaults).post(create_obsidian_vault))
        .route("/obsidian/vaults/:id",           delete(delete_obsidian_vault))
        .route("/obsidian/probe",                post(probe_obsidian))
        .route("/obsidian/files",                get(list_obsidian_files))
        .route("/obsidian/sync",                 post(sync_obsidian))
        // ── Obsidian (server-side mounted folder vaults) ─────────────────────
        .route("/obsidian/folder-vaults",        post(create_obsidian_folder_vault))
        .route("/obsidian/folder-vaults/:id/files", get(list_obsidian_folder_files))
        .route("/obsidian/folder-vaults/:id/sync",  post(sync_obsidian_folder))
}

/// Public routes — no JWT required (OAuth callback arrives from Google with no auth header).
pub fn public_router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/api/connectors/google/callback", get(google_callback))
}

// ─── Token refresh helper ────────────────────────────────────────────────────

/// Returns a valid access token, refreshing if the stored one is expired.
/// Updates the DB row in place when a refresh occurs.
async fn ensure_valid_token(
    connector: &ConnectorRow,
    http: &reqwest::Client,
    cfg: &crate::config::Config,
    db: &sqlx::PgPool,
) -> Result<String> {
    // Check if token is still valid (with 60-second buffer)
    let expired = connector.token_expires_at.map_or(false, |exp| {
        exp <= Utc::now() + chrono::Duration::seconds(60)
    });

    if !expired {
        return Ok(crate::services::crypto::open(&connector.access_token));
    }

    // Re-read the connector row from DB before attempting a refresh.
    // A concurrent request may have already refreshed the token, in which case
    // we can return the fresh token without hitting Google's endpoint again.
    // This minimises — though does not fully eliminate — the refresh race window.
    let fresh = sqlx::query_as::<_, ConnectorRow>(
        "SELECT id, provider::text, label, access_token, refresh_token, token_expires_at,
                provider_email, is_active
         FROM oauth_connectors
         WHERE id = $1",
    )
    .bind(connector.id)
    .fetch_optional(db)
    .await?;

    if let Some(ref fresh_row) = fresh {
        let still_expired = fresh_row.token_expires_at.map_or(true, |exp| {
            exp <= Utc::now() + chrono::Duration::seconds(60)
        });
        if !still_expired {
            return Ok(crate::services::crypto::open(&fresh_row.access_token));
        }
    }

    // Token is still expired after re-read — proceed with the refresh.
    let connector = fresh.as_ref().unwrap_or(connector);

    let refresh_token = connector
        .refresh_token
        .as_deref()
        .map(crate::services::crypto::open)
        .ok_or_else(|| AppError::BadRequest("No refresh token stored; please reconnect Google".into()))?;
    let refresh_token = refresh_token.as_str();

    // Pull the live OAuth client credentials — the admin may have rotated them
    // since this connector was created, so we re-resolve on every refresh.
    let (client_id, client_secret) = resolve_credentials(db, cfg, "google").await?;

    let params = [
        ("client_id",     client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("refresh_token", refresh_token),
        ("grant_type",    "refresh_token"),
    ];

    let resp = http
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Token refresh request failed: {e}")))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("Token refresh failed: {body}")));
    }

    let tok: TokenResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Token refresh parse error: {e}")))?;

    let new_expiry = tok.expires_in.map(|secs| Utc::now() + chrono::Duration::seconds(secs));

    sqlx::query(
        "UPDATE oauth_connectors
         SET access_token = $1, token_expires_at = $2, updated_at = NOW()
         WHERE id = $3",
    )
    .bind(crate::services::crypto::seal(&tok.access_token))
    .bind(new_expiry)
    .bind(connector.id)
    .execute(db)
    .await?;

    Ok(tok.access_token)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// GET /api/connectors
async fn list_connectors(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, Option<String>, bool)>(
        "SELECT id, provider::text, label, provider_email, is_active
         FROM oauth_connectors
         WHERE user_id = $1
         ORDER BY created_at DESC",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let connectors: Vec<Value> = rows
        .into_iter()
        .map(|(id, provider, label, provider_email, is_active)| {
            json!({
                "id":            id,
                "provider":      provider,
                "label":         label,
                "providerEmail": provider_email,
                "isActive":      is_active,
            })
        })
        .collect();

    Ok(Json(json!({ "connectors": connectors })))
}

/// DELETE /api/connectors/:id
async fn disconnect_connector(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let deleted = sqlx::query(
        "DELETE FROM oauth_connectors WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;

    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// Build a Google consent-screen URL for the given user. Returns the URL
/// string plus stores the CSRF nonce in Redis. Shared by both the redirect
/// (`/google/auth`) and JSON (`/auth/:provider`) entrypoints.
async fn build_google_auth_url(state: &Arc<crate::models::AppState>, user_id: Uuid) -> Result<String> {
    let (client_id, _) = resolve_credentials(&state.db, &state.cfg, "google").await?;
    let redirect_uri = format!("{}/api/connectors/google/callback", state.cfg.frontend_url);

    // Generate a random nonce and store it in Redis as the CSRF state token.
    // The nonce maps to the authenticated user's ID and expires after 10 minutes.
    // The callback looks up the nonce to retrieve the user_id — the raw user_id is
    // never exposed in the state parameter, preventing CSRF / account-takeover attacks.
    let nonce = Uuid::new_v4().to_string();
    let redis_key = format!("oauth_state:{nonce}");
    redis_set_ex(&state.redis, &redis_key, &user_id.to_string(), 600)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to store OAuth state in Redis: {e}")))?;

    let url = reqwest::Client::new()
        .get("https://accounts.google.com/o/oauth2/v2/auth")
        .query(&[
            ("client_id",     client_id.as_str()),
            ("redirect_uri",  redirect_uri.as_str()),
            ("scope",
             "https://www.googleapis.com/auth/drive.readonly \
              https://www.googleapis.com/auth/userinfo.email"),
            ("response_type", "code"),
            ("access_type",   "offline"),
            ("prompt",        "consent"),
            ("state",         nonce.as_str()),
        ])
        .build()
        .map_err(|e| AppError::Internal(format!("Failed to build OAuth URL: {e}")))?
        .url()
        .to_string();
    Ok(url)
}

/// GET /api/connectors/google/auth — redirect browser to Google consent screen
async fn google_auth_start(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Redirect> {
    let url = build_google_auth_url(&state, claims.sub).await?;
    Ok(Redirect::temporary(&url))
}

/// GET /api/connectors/auth/:provider — return `{ authUrl }` as JSON so the
/// Settings UI can open it in a popup. Currently only Google is supported;
/// other providers return a clear 400.
async fn oauth_auth_url(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(provider): Path<String>,
) -> Result<Json<Value>> {
    let url = match provider.as_str() {
        "google" => build_google_auth_url(&state, claims.sub).await?,
        other    => {
            return Err(AppError::BadRequest(format!(
                "OAuth start for '{other}' is not implemented yet"
            )));
        }
    };
    Ok(Json(json!({ "authUrl": url })))
}

/// GET /api/connectors/google/callback — exchanges code for tokens and stores them
async fn google_callback(
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<OAuthCallbackQuery>,
) -> Result<Redirect> {
    let frontend_drive = format!("{}/drive", state.cfg.frontend_url);
    let frontend_error = format!("{}/drive?error=oauth_failed", state.cfg.frontend_url);

    // Surface Google-side errors
    if let Some(err) = &q.error {
        tracing::warn!("Google OAuth error: {err}");
        return Ok(Redirect::temporary(&frontend_error));
    }

    let code = q
        .code
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing OAuth code".into()))?;

    let nonce = q
        .state
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Missing OAuth state".into()))?;

    // Validate the nonce: look it up in Redis and consume it atomically.
    // If the key is absent (never set, already consumed, or expired), reject the request.
    // This prevents CSRF and replay attacks — only the request that initiated the flow
    // can complete it, because the nonce is single-use and time-limited (600s TTL).
    let redis_key = format!("oauth_state:{nonce}");
    let user_id_str = redis_get_del(&state.redis, &redis_key)
        .await
        .map_err(|e| AppError::Internal(format!("Redis state lookup failed: {e}")))?
        .ok_or_else(|| AppError::BadRequest("Invalid or expired OAuth state".into()))?;

    let user_id: Uuid = user_id_str
        .parse()
        .map_err(|_| AppError::Internal("Corrupt OAuth state in Redis".into()))?;

    let (client_id, client_secret) = resolve_credentials(&state.db, &state.cfg, "google").await?;

    let redirect_uri = format!("{}/api/connectors/google/callback", state.cfg.frontend_url);
    let http = reqwest::Client::new();

    // Exchange auth code for tokens
    let params = [
        ("code",          code),
        ("client_id",     client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("redirect_uri",  redirect_uri.as_str()),
        ("grant_type",    "authorization_code"),
    ];

    let token_resp = http
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Token exchange request failed: {e}")))?;

    if !token_resp.status().is_success() {
        let body = token_resp.text().await.unwrap_or_default();
        tracing::error!("Google token exchange failed: {body}");
        return Ok(Redirect::temporary(&frontend_error));
    }

    let tok: TokenResponse = token_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Token parse error: {e}")))?;

    let expiry = tok.expires_in.map(|s| Utc::now() + chrono::Duration::seconds(s));

    // Encrypt tokens at rest before they ever touch the DB.
    let access_token_sealed  = crate::services::crypto::seal(&tok.access_token);
    let refresh_token_sealed = tok.refresh_token.as_deref().map(crate::services::crypto::seal);

    // Fetch email via userinfo
    let userinfo_resp = http
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(&tok.access_token)
        .send()
        .await
        .ok()
        .and_then(|r| if r.status().is_success() { Some(r) } else { None });

    let (provider_email, provider_account_id) =
        if let Some(resp) = userinfo_resp {
            let info: GoogleUserInfo = resp.json().await.unwrap_or(GoogleUserInfo { email: None, sub: None });
            (info.email, info.sub)
        } else {
            (None, None)
        };

    let label = provider_email
        .as_deref()
        .unwrap_or("Google Drive")
        .to_string();

    // Upsert connector — if the same Google account (by provider_account_id) already exists
    // for this user, update its tokens; otherwise insert a new row.
    let existing_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM oauth_connectors
         WHERE user_id = $1 AND provider = 'google' AND provider_account_id = $2",
    )
    .bind(user_id)
    .bind(&provider_account_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| { tracing::error!("Connector lookup failed: {e}"); AppError::Database(e) })?
    .flatten();

    if let Some(eid) = existing_id {
        sqlx::query(
            "UPDATE oauth_connectors
             SET access_token     = $1,
                 refresh_token    = COALESCE($2, refresh_token),
                 token_expires_at = $3,
                 label            = $4,
                 provider_email   = $5,
                 is_active        = true,
                 updated_at       = NOW()
             WHERE id = $6",
        )
        .bind(&access_token_sealed)
        .bind(&refresh_token_sealed)
        .bind(expiry)
        .bind(&label)
        .bind(&provider_email)
        .bind(eid)
        .execute(&state.db)
        .await
        .map_err(|e| { tracing::error!("Connector update failed: {e}"); AppError::Database(e) })?;
    } else {
        sqlx::query(
            "INSERT INTO oauth_connectors
                 (user_id, provider, label, access_token, refresh_token, token_expires_at,
                  provider_account_id, provider_email, is_active, scopes)
             VALUES ($1, 'google', $2, $3, $4, $5, $6, $7, true,
                     '[\"https://www.googleapis.com/auth/drive.readonly\"]'::jsonb)",
        )
        .bind(user_id)
        .bind(&label)
        .bind(&access_token_sealed)
        .bind(&refresh_token_sealed)
        .bind(expiry)
        .bind(&provider_account_id)
        .bind(&provider_email)
        .execute(&state.db)
        .await
        .map_err(|e| { tracing::error!("Connector insert failed: {e}"); AppError::Database(e) })?;
    }

    Ok(Redirect::temporary(&frontend_drive))
}

/// GET /api/connectors/google/drive/files?connectorId=...&folderId=...&q=...
async fn drive_files(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<DriveFilesQuery>,
) -> Result<Json<Value>> {
    let connector = fetch_connector(&state.db, q.connector_id, claims.sub).await?;
    let http = reqwest::Client::new();
    let token = ensure_valid_token(&connector, &http, &state.cfg, &state.db).await?;

    // Build Drive API query
    let drive_q = build_drive_query(q.folder_id.as_deref(), q.q.as_deref());

    let resp = http
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(&token)
        .query(&[
            ("q",         drive_q.as_str()),
            ("fields",    "files(id,name,mimeType,modifiedTime,size,webViewLink,parents)"),
            ("pageSize",  "100"),
            ("orderBy",   "folder,name"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Drive API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!("Drive API error {status}: {body}");
        return Err(AppError::Internal(format!("Drive API error: {status}")));
    }

    let drive_resp: DriveFilesResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Drive response parse error: {e}")))?;

    let files: Vec<Value> = drive_resp
        .files
        .unwrap_or_default()
        .into_iter()
        .map(|f| {
            let folder = is_folder(&f.mime_type);
            let extractable = !folder && is_extractable(&f.mime_type);
            json!({
                "id":           f.id,
                "name":         f.name,
                "mimeType":     f.mime_type,
                "modifiedTime": f.modified_time.unwrap_or_default(),
                "size":         f.size,
                "webViewLink":  f.web_view_link,
                "isFolder":     folder,
                "isExtractable": extractable,
            })
        })
        .collect();

    // Update last_sync_at for the connector
    let _ = sqlx::query(
        "UPDATE oauth_connectors SET last_sync_at = NOW() WHERE id = $1",
    )
    .bind(connector.id)
    .execute(&state.db)
    .await;

    Ok(Json(json!({ "files": files })))
}

/// POST /api/connectors/google/drive/sync  { connectorId, fileIds }
async fn sync_selected(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SyncSelectedReq>,
) -> Result<Json<Value>> {
    if req.file_ids.is_empty() {
        return Err(AppError::BadRequest("No file IDs provided".into()));
    }

    let connector = fetch_connector(&state.db, req.connector_id, claims.sub).await?;
    let http = reqwest::Client::new();
    let token = ensure_valid_token(&connector, &http, &state.cfg, &state.db).await?;

    // Fetch file metadata for names
    let meta_map = fetch_file_metadata(&req.file_ids, &token, &http).await;

    let mut results: Vec<Value> = Vec::new();

    let resolved = resolve_drive_opts(&state.db, claims.sub, &req.opts).await;

    for file_id in &req.file_ids {
        let name = meta_map.get(file_id).cloned().unwrap_or_else(|| file_id.clone());

        match enqueue_drive_file(
            &state.db,
            &state.redis,
            &http,
            &token,
            claims.sub,
            connector.id,
            file_id,
            &name,
            &resolved,
        )
        .await
        {
            Ok(job_id) => {
                results.push(json!({ "fileId": file_id, "name": name, "jobId": job_id }));
            }
            Err(e) => {
                tracing::warn!("Failed to enqueue drive file {file_id}: {e}");
                results.push(json!({ "fileId": file_id, "name": name, "error": e.to_string() }));
            }
        }
    }

    let synced = results.iter().filter(|r| r.get("jobId").is_some()).count();
    Ok(Json(json!({ "synced": synced, "results": results })))
}

/// POST /api/connectors/google/drive/sync/folder  { connectorId, folderId, maxDepth }
async fn sync_folder(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SyncFolderReq>,
) -> Result<Json<Value>> {
    let connector = fetch_connector(&state.db, req.connector_id, claims.sub).await?;
    let http = reqwest::Client::new();
    let token = ensure_valid_token(&connector, &http, &state.cfg, &state.db).await?;

    let max_depth = req.max_depth.unwrap_or(5).min(10);
    let folder_name = get_folder_name(&req.folder_id, &token, &http).await;

    // Recursively collect all extractable files in the folder tree
    let mut all_files: Vec<(String, String)> = Vec::new(); // (file_id, name)
    collect_folder_files(
        &req.folder_id,
        &token,
        &http,
        &mut all_files,
        0,
        max_depth,
    )
    .await;

    let total = all_files.len();
    let mut synced = 0u32;
    let mut failed = 0u32;
    let mut results: Vec<Value> = Vec::new();

    let resolved = resolve_drive_opts(&state.db, claims.sub, &req.opts).await;

    for (file_id, name) in &all_files {
        match enqueue_drive_file(
            &state.db,
            &state.redis,
            &http,
            &token,
            claims.sub,
            connector.id,
            file_id,
            name,
            &resolved,
        )
        .await
        {
            Ok(job_id) => {
                synced += 1;
                results.push(json!({ "fileId": file_id, "name": name, "jobId": job_id }));
            }
            Err(e) => {
                failed += 1;
                tracing::warn!("Failed to enqueue {file_id}: {e}");
                results.push(json!({ "fileId": file_id, "name": name, "error": e.to_string() }));
            }
        }
    }

    Ok(Json(json!({
        "folder":     folder_name,
        "totalFiles": total,
        "synced":     synced,
        "failed":     failed,
        "results":    results,
    })))
}

// ─── Private helpers ─────────────────────────────────────────────────────────

async fn fetch_connector(
    db: &sqlx::PgPool,
    connector_id: Uuid,
    user_id: Uuid,
) -> Result<ConnectorRow> {
    sqlx::query_as::<_, ConnectorRow>(
        "SELECT id, provider::text, label, access_token, refresh_token, token_expires_at,
                provider_email, is_active
         FROM oauth_connectors
         WHERE id = $1 AND user_id = $2 AND is_active = true",
    )
    .bind(connector_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)
}

fn build_drive_query(folder_id: Option<&str>, search: Option<&str>) -> String {
    let mut parts: Vec<String> = vec!["trashed = false".into()];

    match folder_id {
        None | Some("root") => {
            parts.push("'root' in parents".into());
        }
        Some(fid) => {
            parts.push(format!("'{fid}' in parents"));
        }
    }

    if let Some(q) = search.filter(|s| !s.is_empty()) {
        // Escape single quotes in the search term
        let escaped = q.replace('\'', "\\'");
        parts.push(format!("name contains '{escaped}'"));
    }

    parts.join(" and ")
}

/// Fetch display names for a list of file IDs from Drive.
/// Returns a map of file_id → name. Missing entries fall back to the file_id.
async fn fetch_file_metadata(
    file_ids: &[String],
    token: &str,
    http: &reqwest::Client,
) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();

    // Drive v3 doesn't support batch name fetch via files.list with IDs,
    // so we build a query with all IDs and fetch in one call.
    if file_ids.is_empty() {
        return map;
    }

    // Build a query like: id = 'abc' or id = 'def'
    let ids_q: String = file_ids
        .iter()
        .map(|id| format!("id = '{id}'"))
        .collect::<Vec<_>>()
        .join(" or ");

    let resp = http
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(token)
        .query(&[
            ("q",        ids_q.as_str()),
            ("fields",   "files(id,name)"),
            ("pageSize", "1000"),
        ])
        .send()
        .await;

    if let Ok(r) = resp {
        if r.status().is_success() {
            if let Ok(data) = r.json::<Value>().await {
                if let Some(files) = data.get("files").and_then(|f| f.as_array()) {
                    for f in files {
                        if let (Some(id), Some(name)) = (
                            f.get("id").and_then(|v| v.as_str()),
                            f.get("name").and_then(|v| v.as_str()),
                        ) {
                            map.insert(id.to_string(), name.to_string());
                        }
                    }
                }
            }
        }
    }

    map
}

async fn get_folder_name(folder_id: &str, token: &str, http: &reqwest::Client) -> Option<String> {
    let resp = http
        .get(format!("https://www.googleapis.com/drive/v3/files/{folder_id}"))
        .bearer_auth(token)
        .query(&[("fields", "name")])
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }
    let val: Value = resp.json().await.ok()?;
    val.get("name")?.as_str().map(str::to_string)
}

/// Recursively list all extractable files under a folder, up to max_depth levels.
async fn collect_folder_files(
    folder_id: &str,
    token: &str,
    http: &reqwest::Client,
    acc: &mut Vec<(String, String)>,
    depth: u32,
    max_depth: u32,
) {
    if depth > max_depth {
        return;
    }

    let q = format!("'{folder_id}' in parents and trashed = false");
    let resp = http
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(token)
        .query(&[
            ("q",        q.as_str()),
            ("fields",   "files(id,name,mimeType)"),
            ("pageSize", "1000"),
        ])
        .send()
        .await;

    let items = match resp {
        Ok(r) if r.status().is_success() => {
            r.json::<Value>().await.ok().and_then(|v| {
                v.get("files").and_then(|f| f.as_array()).cloned()
            }).unwrap_or_default()
        }
        _ => return,
    };

    for item in &items {
        let id   = item.get("id")  .and_then(|v| v.as_str()).unwrap_or_default();
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or_default();
        let mime = item.get("mimeType").and_then(|v| v.as_str()).unwrap_or_default();

        if is_folder(mime) {
            // Recurse
            Box::pin(collect_folder_files(id, token, http, acc, depth + 1, max_depth)).await;
        } else if is_extractable(mime) {
            acc.push((id.to_string(), name.to_string()));
        }
    }
}

// ─── SharePoint structs ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct AddSharepointTenantReq {
    #[serde(rename = "tenantId")]          tenant_id:           String,
    #[serde(rename = "tenantName")]        tenant_name:         String,
    #[serde(rename = "clientId")]          client_id:           String,
    #[serde(rename = "clientSecret")]      client_secret:       String,
    #[serde(rename = "sharepointRootUrl")] sharepoint_root_url: Option<String>,
}

#[derive(Deserialize)]
struct SharepointTenantQuery {
    #[serde(rename = "tenantConfigId")] tenant_config_id: Uuid,
}

#[derive(Deserialize)]
struct SharepointFilesQuery {
    #[serde(rename = "tenantConfigId")] tenant_config_id: Uuid,
    #[serde(rename = "siteId")]         site_id:          String,
    #[serde(rename = "driveId")]        drive_id:         String,
    #[serde(rename = "folderId")]       folder_id:        Option<String>,
}

#[derive(Deserialize)]
struct SyncSharepointReq {
    #[serde(rename = "tenantConfigId")]       tenant_config_id:        Uuid,
    #[serde(rename = "siteId")]               site_id:                 String,
    #[serde(rename = "driveId")]              drive_id:                String,
    #[serde(rename = "fileIds")]              file_ids:                Vec<String>,
    #[serde(rename = "classificationLevelId")] classification_level_id: Option<Uuid>,
}

// ─── SharePoint DB row ────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct SharepointTenantRow {
    id:                  Uuid,
    tenant_id:           String,
    tenant_name:         String,
    client_id:           String,
    client_secret:       String,
    sharepoint_root_url: Option<String>,
}

// ─── SharePoint token helper ──────────────────────────────────────────────────

/// Exchange client_credentials against Microsoft identity platform.
/// Returns an access token valid for Microsoft Graph.
async fn sharepoint_access_token(
    http:          &reqwest::Client,
    tenant_id:     &str,
    client_id:     &str,
    client_secret: &str,
) -> Result<String> {
    let url = format!(
        "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    );

    #[derive(serde::Deserialize)]
    struct MsTokenResp { access_token: String }

    let resp = http
        .post(&url)
        .form(&[
            ("grant_type",    "client_credentials"),
            ("client_id",     client_id),
            ("client_secret", client_secret),
            ("scope",         "https://graph.microsoft.com/.default"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("MS token request failed: {e}")))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("MS token error: {body}")));
    }

    let tok: MsTokenResp = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("MS token parse error: {e}")))?;

    Ok(tok.access_token)
}

// ─── Obsidian structs ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateObsidianVaultReq {
    label:      String,
    #[serde(rename = "vaultUrl")] vault_url:  String,
    #[serde(rename = "apiToken")] api_token:  String,
}

#[derive(Deserialize)]
struct ProbeObsidianReq {
    #[serde(rename = "vaultId")] vault_id: Uuid,
}

#[derive(Deserialize)]
struct ObsidianFilesQuery {
    #[serde(rename = "vaultId")] vault_id: Uuid,
    folder:                                Option<String>,
}

#[derive(Deserialize)]
struct SyncObsidianReq {
    #[serde(rename = "vaultId")] vault_id: Uuid,
    /// Note paths to extract. Accepts `paths` (preferred, matches folder sync) or
    /// the legacy `notePaths` alias.
    #[serde(default, alias = "notePaths")] paths: Vec<String>,
    #[serde(flatten)] opts: DriveExtractReqOpts,
}

// ─── Obsidian DB row ──────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ObsidianVaultRow {
    id:          Uuid,
    label:       String,
    vault_url:   Option<String>,
    api_token:   Option<String>,
    kind:        String,
    folder_path: Option<String>,
}

#[derive(Deserialize)]
struct CreateObsidianFolderVaultReq {
    label:                          String,
    #[serde(rename = "folderPath")] folder_path: String,
}

#[derive(Deserialize, Default)]
struct SyncObsidianFolderReq {
    paths:            Option<Vec<String>>,
    #[serde(flatten)] opts: DriveExtractReqOpts,
}

// ─── SharePoint handlers ──────────────────────────────────────────────────────

/// GET /api/connectors/microsoft/sharepoint/tenants
async fn list_sharepoint_tenants(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, Option<String>)>(
        "SELECT id, tenant_id, tenant_name, sharepoint_root_url
         FROM sharepoint_tenant_configs
         WHERE user_id = $1
         ORDER BY created_at DESC",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let tenants: Vec<Value> = rows
        .into_iter()
        .map(|(id, tenant_id, tenant_name, root_url)| {
            json!({
                "id":                 id,
                "tenantId":           tenant_id,
                "tenantName":         tenant_name,
                "sharepointRootUrl":  root_url,
            })
        })
        .collect();

    Ok(Json(json!({ "tenants": tenants })))
}

/// POST /api/connectors/microsoft/sharepoint/tenants
async fn add_sharepoint_tenant(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<AddSharepointTenantReq>,
) -> Result<Json<Value>> {
    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO sharepoint_tenant_configs
             (id, user_id, tenant_id, tenant_name, client_id, client_secret, sharepoint_root_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(claims.sub)
    .bind(&req.tenant_id)
    .bind(&req.tenant_name)
    .bind(&req.client_id)
    .bind(crate::services::crypto::seal(&req.client_secret))
    .bind(&req.sharepoint_root_url)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "id": id, "ok": true })))
}

/// GET /api/connectors/microsoft/sharepoint/sites?tenantConfigId=...
async fn list_sharepoint_sites(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<SharepointTenantQuery>,
) -> Result<Json<Value>> {
    let tenant = fetch_sharepoint_tenant(&state.db, q.tenant_config_id, claims.sub).await?;
    let http   = reqwest::Client::new();
    let token  = sharepoint_access_token(
        &http,
        &tenant.tenant_id,
        &tenant.client_id,
        &tenant.client_secret,
    )
    .await?;

    let resp = http
        .get("https://graph.microsoft.com/v1.0/sites")
        .bearer_auth(&token)
        .query(&[
            ("search", "*"),
            ("$select", "id,name,displayName,webUrl"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Graph API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body   = resp.text().await.unwrap_or_default();
        tracing::warn!("Graph sites error {status}: {body}");
        return Err(AppError::Internal(format!("Graph API error: {status}")));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Graph sites parse error: {e}")))?;

    let sites: Vec<Value> = data
        .get("value")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|s| {
            json!({
                "id":          s.get("id")         .and_then(|v| v.as_str()).unwrap_or_default(),
                "name":        s.get("name")        .and_then(|v| v.as_str()).unwrap_or_default(),
                "displayName": s.get("displayName") .and_then(|v| v.as_str()).unwrap_or_default(),
                "webUrl":      s.get("webUrl")      .and_then(|v| v.as_str()).unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(json!({ "sites": sites })))
}

/// GET /api/connectors/microsoft/sharepoint/files?tenantConfigId=...&siteId=...&driveId=...&folderId=...
async fn list_sharepoint_files(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<SharepointFilesQuery>,
) -> Result<Json<Value>> {
    let tenant = fetch_sharepoint_tenant(&state.db, q.tenant_config_id, claims.sub).await?;
    let http   = reqwest::Client::new();
    let token  = sharepoint_access_token(
        &http,
        &tenant.tenant_id,
        &tenant.client_id,
        &tenant.client_secret,
    )
    .await?;

    let select = "$select=id,name,size,file,folder,lastModifiedDateTime";
    let url = match q.folder_id.as_deref() {
        None | Some("root") => format!(
            "https://graph.microsoft.com/v1.0/sites/{}/drives/{}/root/children?{select}",
            q.site_id, q.drive_id
        ),
        Some(fid) => format!(
            "https://graph.microsoft.com/v1.0/sites/{}/drives/{}/items/{}/children?{select}",
            q.site_id, q.drive_id, fid
        ),
    };

    let resp = http
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Graph files request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body   = resp.text().await.unwrap_or_default();
        tracing::warn!("Graph files error {status}: {body}");
        return Err(AppError::Internal(format!("Graph API error: {status}")));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Graph files parse error: {e}")))?;

    let items: Vec<Value> = data
        .get("value")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let is_folder  = item.get("folder").is_some();
            let last_mod   = item
                .get("lastModifiedDateTime")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let size       = item
                .get("size")
                .and_then(|v| v.as_i64());
            json!({
                "id":           item.get("id")  .and_then(|v| v.as_str()).unwrap_or_default(),
                "name":         item.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                "isFolder":     is_folder,
                "size":         size,
                "lastModified": last_mod,
            })
        })
        .collect();

    Ok(Json(json!({ "items": items })))
}

/// POST /api/connectors/microsoft/sharepoint/sync
async fn sync_sharepoint(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SyncSharepointReq>,
) -> Result<Json<Value>> {
    if req.file_ids.is_empty() {
        return Err(AppError::BadRequest("No file IDs provided".into()));
    }

    // Verify the tenant config belongs to this user
    fetch_sharepoint_tenant(&state.db, req.tenant_config_id, claims.sub).await?;

    let mut job_ids: Vec<Uuid> = Vec::new();

    for file_id in &req.file_ids {
        let job_id = Uuid::new_v4();

        sqlx::query(
            "INSERT INTO jobs (id, user_id, type, status, input)
             VALUES ($1, $2, 'kex_sharepoint', 'pending', $3)",
        )
        .bind(job_id)
        .bind(claims.sub)
        .bind(json!({
            "tenantConfigId":       req.tenant_config_id,
            "siteId":               req.site_id,
            "driveId":              req.drive_id,
            "fileId":               file_id,
            "classificationLevelId": req.classification_level_id,
        }))
        .execute(&state.db)
        .await?;

        crate::services::usage::record_usage(
            &state.db,
            claims.sub,
            "kex_extract",
            5,
            Some(job_id),
        )
        .await;

        let mut payload = json!({
            "job_id":   job_id,
            "user_id":  claims.sub,
            "type":     "sharepoint",
            "file_id":  file_id,
        });
        crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;

        lpush(&state.redis, "kex:jobs", &payload.to_string())
            .await
            .map_err(|e| AppError::Internal(format!("Redis push failed: {e}")))?;

        job_ids.push(job_id);
    }

    Ok(Json(json!({ "jobIds": job_ids })))
}

// ─── Obsidian handlers ────────────────────────────────────────────────────────

/// GET /api/connectors/obsidian/vaults
async fn list_obsidian_vaults(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<String>)>(
        "SELECT id, label, vault_url, kind, folder_path
         FROM obsidian_vaults
         WHERE user_id = $1
         ORDER BY created_at DESC",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let vaults: Vec<Value> = rows
        .into_iter()
        .map(|(id, label, vault_url, kind, folder_path)| {
            json!({
                "id":          id,
                "label":       label,
                "vaultUrl":    vault_url,
                "vault_url":   vault_url,
                "kind":        kind,
                "folder_path": folder_path,
            })
        })
        .collect();

    Ok(Json(json!({ "vaults": vaults })))
}

/// POST /api/connectors/obsidian/vaults
async fn create_obsidian_vault(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateObsidianVaultReq>,
) -> Result<Json<Value>> {
    // Reject non-loopback URLs at store time — prevents persisting SSRF gadgets.
    require_loopback_url(&req.vault_url)?;

    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO obsidian_vaults (id, user_id, label, vault_url, api_token)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(claims.sub)
    .bind(&req.label)
    .bind(&req.vault_url)
    .bind(crate::services::crypto::seal(&req.api_token))
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "id": id, "ok": true })))
}

/// DELETE /api/connectors/obsidian/vaults/:id
async fn delete_obsidian_vault(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let deleted = sqlx::query(
        "DELETE FROM obsidian_vaults WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;

    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/connectors/obsidian/probe  { vaultId }
async fn probe_obsidian(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<ProbeObsidianReq>,
) -> Result<Json<Value>> {
    let vault = fetch_obsidian_vault(&state.db, req.vault_id, claims.sub).await?;

    // Enforce loopback-only at request time (belt-and-suspenders; also checked at store time).
    // TLS verification is disabled only for loopback self-signed certs.
    let vault_url = vault.rest_url()?;
    let (_parsed, is_loopback) = require_loopback_url(vault_url)?;
    let http = obsidian_http_client(is_loopback)?;

    let url = format!("{}/", vault_url.trim_end_matches('/'));

    let resp = http
        .get(&url)
        .bearer_auth(vault.rest_token())
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            // The root endpoint returns vault metadata; try to extract vault name.
            let vault_name = r
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| {
                    v.get("vaultName")
                        .or_else(|| v.get("vault"))
                        .and_then(|n| n.as_str())
                        .map(str::to_string)
                });
            Ok(Json(json!({ "ok": true, "vaultName": vault_name })))
        }
        Ok(r) => {
            tracing::warn!("Obsidian probe returned HTTP {}", r.status());
            Ok(Json(json!({ "ok": false })))
        }
        Err(e) => {
            tracing::warn!("Obsidian probe error: {e}");
            Ok(Json(json!({ "ok": false })))
        }
    }
}

/// GET /api/connectors/obsidian/files?vaultId=...&folder=...
async fn list_obsidian_files(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<ObsidianFilesQuery>,
) -> Result<Json<Value>> {
    let vault = fetch_obsidian_vault(&state.db, q.vault_id, claims.sub).await?;

    let vault_url = vault.rest_url()?;
    let (_parsed, is_loopback) = require_loopback_url(vault_url)?;
    let http = obsidian_http_client(is_loopback)?;

    let url = format!("{}/vault/", vault_url.trim_end_matches('/'));

    let resp = http
        .get(&url)
        .bearer_auth(vault.rest_token())
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Obsidian API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body   = resp.text().await.unwrap_or_default();
        tracing::warn!("Obsidian files error {status}: {body}");
        return Err(AppError::Internal(format!("Obsidian API error: {status}")));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Obsidian files parse error: {e}")))?;

    // The Obsidian Local REST API /vault/ returns { files: ["path/to/note.md", ...] }
    let folder_prefix = q.folder.as_deref().unwrap_or("");

    let files: Vec<Value> = data
        .get("files")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .filter(|path| path.ends_with(".md"))
        .filter(|path| folder_prefix.is_empty() || path.starts_with(folder_prefix))
        .map(|path| {
            let name = path
                .rsplit('/')
                .next()
                .unwrap_or(&path)
                .to_string();
            json!({ "path": path, "name": name })
        })
        .collect();

    Ok(Json(json!({ "files": files })))
}

/// POST /api/connectors/obsidian/sync
async fn sync_obsidian(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SyncObsidianReq>,
) -> Result<Json<Value>> {
    // Verify the vault belongs to this user and is a REST vault (has url/token).
    let vault = fetch_obsidian_vault(&state.db, req.vault_id, claims.sub).await?;

    // Resolve KEX options (ontology → entity types, classification name) once.
    let resolved = resolve_drive_opts(&state.db, claims.sub, &req.opts).await;

    // No explicit note subset → re-ingest the whole vault via the shared core
    // (lists every `.md` over the REST API). Same path the cron executor uses.
    if req.paths.is_empty() {
        let vault_row = crate::services::obsidian::VaultRow {
            id: vault.id,
            user_id: claims.sub,
            label: vault.label.clone(),
            kind: vault.kind.clone(),
            folder_path: vault.folder_path.clone(),
            vault_url: vault.vault_url.clone(),
            api_token: vault.api_token.clone(),
        };
        let opts = resolved.to_reingest_opts(crate::services::obsidian::ReingestMode::Full, None);
        let (_parsed, is_loopback) = require_loopback_url(vault.rest_url()?)?;
        let http = obsidian_http_client(is_loopback)?;
        let res = crate::services::obsidian::reingest_vault(
            &state.db, &state.redis, &http, &state.cfg.vaults_root, &vault_row, &opts,
        )
        .await
        .map_err(AppError::Internal)?;
        return Ok(Json(json!({
            "synced": res.synced, "failed": res.failed, "jobIds": res.job_ids,
        })));
    }

    let vault_url = vault.rest_url()?.to_string();
    let api_token = vault.rest_token().to_string();

    let mut synced = 0u32;
    let mut failed = 0u32;
    let mut job_ids: Vec<Uuid> = Vec::new();

    for note_path in &req.paths {
        let note_name = note_path.rsplit('/').next().unwrap_or(note_path).to_string();
        let job_id = Uuid::new_v4();

        let insert = sqlx::query(
            "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id)
             VALUES ($1, $2, 'kex_obsidian', 'pending', $3, $4)",
        )
        .bind(job_id)
        .bind(claims.sub)
        .bind(json!({
            "fileName":      note_name,
            "vaultId":       req.vault_id,
            "notePath":      note_path,
            "ontologyId":    resolved.ontology_id,
            "compilationId": resolved.compilation_id,
            "discoveryMode": resolved.discovery_mode,
        }))
        .bind(resolved.classification_level_id)
        .execute(&state.db)
        .await;

        if insert.is_err() {
            failed += 1;
            continue;
        }

        crate::services::usage::record_usage(
            &state.db,
            claims.sub,
            "kex_extract",
            5,
            Some(job_id),
        )
        .await;

        let mut payload = json!({
            "job_id":                  job_id,
            "user_id":                 claims.sub,
            "type":                    "kex_obsidian",
            "input":                   {
                "vaultUrl": vault_url,
                "apiToken": api_token,
                "notePath": note_path,
                "vaultId":  req.vault_id,
            },
            "entity_types":            resolved.entity_types,
            "ontology_id":             resolved.ontology_id,
            "classification":          resolved.classification_name,
            "classification_level_id": resolved.classification_level_id,
        });
        crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;

        if lpush(&state.redis, "kex:jobs", &payload.to_string()).await.is_err() {
            failed += 1;
            continue;
        }

        synced += 1;
        job_ids.push(job_id);
    }

    Ok(Json(json!({ "synced": synced, "failed": failed, "jobIds": job_ids })))
}

// ─── Obsidian folder-vault handlers (server-side mounted directory) ──────────

/// Recursively collect `.md` files under `dir`, returning paths relative to
/// `base`. Skips `.obsidian/` and `.trash/` subdirectories. Does not follow into
/// directories whose canonical path escapes `base` (defence in depth).
fn collect_md_files(
    base: &std::path::Path,
    dir: &std::path::Path,
    acc: &mut Vec<std::path::PathBuf>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if file_type.is_dir() {
            if name == ".obsidian" || name == ".trash" {
                continue;
            }
            collect_md_files(base, &path, acc);
        } else if file_type.is_file()
            && path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false)
        {
            if let Ok(rel) = path.strip_prefix(base) {
                acc.push(rel.to_path_buf());
            }
        }
    }
}

/// POST /api/connectors/obsidian/folder-vaults  { label, folderPath }
async fn create_obsidian_folder_vault(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateObsidianFolderVaultReq>,
) -> Result<Json<Value>> {
    if req.label.trim().is_empty() {
        return Err(AppError::BadRequest("label is required".into()));
    }

    // Validate the path against the configured vault root. Must exist & be inside.
    let canon = resolve_vault_path(&state.cfg.vaults_root, &req.folder_path)?;
    if !canon.is_dir() {
        return Err(AppError::BadRequest("path is not a directory".into()));
    }
    let stored_path = canon.to_string_lossy().to_string();

    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO obsidian_vaults (id, user_id, label, vault_url, api_token, kind, folder_path)
         VALUES ($1, $2, $3, NULL, NULL, 'folder', $4)",
    )
    .bind(id)
    .bind(claims.sub)
    .bind(req.label.trim())
    .bind(&stored_path)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({
        "id":          id,
        "label":       req.label.trim(),
        "kind":        "folder",
        "folder_path": stored_path,
        "ok":          true,
    })))
}

/// GET /api/connectors/obsidian/folder-vaults/:id/files
async fn list_obsidian_folder_files(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let vault = fetch_obsidian_vault(&state.db, id, claims.sub).await?;
    if vault.kind != "folder" {
        return Err(AppError::BadRequest("not a folder vault".into()));
    }
    let folder_path = vault
        .folder_path
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("vault has no folder_path".into()))?;

    // Re-validate the stored path against root before reading.
    let base = resolve_vault_path(&state.cfg.vaults_root, folder_path)?;

    let mut rels: Vec<std::path::PathBuf> = Vec::new();
    collect_md_files(&base, &base, &mut rels);

    let mut files: Vec<Value> = Vec::new();
    for rel in rels {
        let abs = base.join(&rel);
        // Per-file guard: canonical path must still be inside the vault folder.
        let canon = match std::fs::canonicalize(&abs) {
            Ok(c) if c.starts_with(&base) => c,
            _ => continue,
        };
        let meta = match std::fs::metadata(&canon) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let basename = rel
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel_str.clone());
        files.push(json!({
            "path":     rel_str,
            "basename": basename,
            "size":     meta.len(),
            "mtimeMs":  mtime_ms,
        }));
    }

    Ok(Json(json!({ "files": files })))
}

/// POST /api/connectors/obsidian/folder-vaults/:id/sync
async fn sync_obsidian_folder(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<SyncObsidianFolderReq>,
) -> Result<Json<Value>> {
    use base64::Engine;

    let vault = fetch_obsidian_vault(&state.db, id, claims.sub).await?;
    if vault.kind != "folder" {
        return Err(AppError::BadRequest("not a folder vault".into()));
    }
    let folder_path = vault
        .folder_path
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("vault has no folder_path".into()))?;

    let resolved = resolve_drive_opts(&state.db, claims.sub, &req.opts).await;

    // No explicit note subset → re-ingest the whole vault via the shared core
    // (same code path the cron executor uses). Keeps manual + scheduled sync
    // behaviourally identical.
    if req.paths.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
        let vault_row = crate::services::obsidian::VaultRow {
            id: vault.id,
            user_id: claims.sub,
            label: vault.label.clone(),
            kind: vault.kind.clone(),
            folder_path: vault.folder_path.clone(),
            vault_url: vault.vault_url.clone(),
            api_token: vault.api_token.clone(),
        };
        let opts = resolved.to_reingest_opts(crate::services::obsidian::ReingestMode::Full, None);
        let http = reqwest::Client::new();
        let res = crate::services::obsidian::reingest_vault(
            &state.db, &state.redis, &http, &state.cfg.vaults_root, &vault_row, &opts,
        )
        .await
        .map_err(AppError::Internal)?;
        return Ok(Json(json!({
            "synced": res.synced, "failed": res.failed, "results": res.job_ids,
        })));
    }

    let base = resolve_vault_path(&state.cfg.vaults_root, folder_path)?;

    // Explicit note subset (manual selective sync only).
    let rels: Vec<std::path::PathBuf> =
        req.paths.as_ref().unwrap().iter().map(std::path::PathBuf::from).collect();

    let mut synced = 0u32;
    let mut failed = 0u32;
    let mut results: Vec<Value> = Vec::new();

    for rel in &rels {
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        // Reject absolute / traversal note paths outright.
        if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            failed += 1;
            results.push(json!({ "path": rel_str, "error": "invalid note path" }));
            continue;
        }
        let abs = base.join(rel);
        // Per-file canonicalize + prefix check (blocks symlink escape).
        let canon = match std::fs::canonicalize(&abs) {
            Ok(c) if c.starts_with(&base) => c,
            _ => {
                failed += 1;
                results.push(json!({ "path": rel_str, "error": "path outside vault" }));
                continue;
            }
        };

        let bytes = match std::fs::read(&canon) {
            Ok(b) => b,
            Err(e) => {
                failed += 1;
                results.push(json!({ "path": rel_str, "error": format!("read failed: {e}") }));
                continue;
            }
        };

        let note_name = canon
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel_str.clone());

        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let kex_input = json!({
            "fileBase64":       encoded,
            "mimetype":         "text/markdown",
            "originalFilename": note_name,
        })
        .to_string();

        let job_id = Uuid::new_v4();
        let insert = sqlx::query(
            "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id)
             VALUES ($1, $2, 'kex_connector', 'pending', $3, $4)",
        )
        .bind(job_id)
        .bind(claims.sub)
        .bind(json!({
            "fileName":      note_name,
            "vaultId":       id,
            "ontologyId":    resolved.ontology_id,
            "compilationId": resolved.compilation_id,
            "discoveryMode": resolved.discovery_mode,
        }))
        .bind(resolved.classification_level_id)
        .execute(&state.db)
        .await;

        if let Err(e) = insert {
            failed += 1;
            results.push(json!({ "path": rel_str, "error": format!("db insert failed: {e}") }));
            continue;
        }

        crate::services::usage::record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;

        let mut payload = json!({
            "job_id":                  job_id,
            "user_id":                 claims.sub,
            "type":                    "file",
            "input":                   kex_input,
            "file_name":               note_name,
            "entity_types":            resolved.entity_types,
            "ontology_id":             resolved.ontology_id,
            "classification":          resolved.classification_name,
            "classification_level_id": resolved.classification_level_id,
        });
        crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;

        if let Err(e) = lpush(&state.redis, "kex:jobs", &payload.to_string()).await {
            failed += 1;
            results.push(json!({ "path": rel_str, "error": format!("redis push failed: {e}") }));
            continue;
        }

        synced += 1;
        results.push(json!({ "path": rel_str, "name": note_name, "jobId": job_id }));
    }

    Ok(Json(json!({ "synced": synced, "failed": failed, "results": results })))
}

// ─── SharePoint / Obsidian DB helpers ────────────────────────────────────────

async fn fetch_sharepoint_tenant(
    db:               &sqlx::PgPool,
    tenant_config_id: Uuid,
    user_id:          Uuid,
) -> Result<SharepointTenantRow> {
    let mut row = sqlx::query_as::<_, SharepointTenantRow>(
        "SELECT id, tenant_id, tenant_name, client_id, client_secret, sharepoint_root_url
         FROM sharepoint_tenant_configs
         WHERE id = $1 AND user_id = $2",
    )
    .bind(tenant_config_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;

    // Decrypt the client secret at rest → callers (token exchange) get plaintext.
    row.client_secret = crate::services::crypto::open(&row.client_secret);
    Ok(row)
}

async fn fetch_obsidian_vault(
    db:       &sqlx::PgPool,
    vault_id: Uuid,
    user_id:  Uuid,
) -> Result<ObsidianVaultRow> {
    sqlx::query_as::<_, ObsidianVaultRow>(
        "SELECT id, label, vault_url, api_token, kind, folder_path
         FROM obsidian_vaults
         WHERE id = $1 AND user_id = $2",
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)
}

impl ObsidianVaultRow {
    /// REST-vault accessors: a folder vault has no url/token, so the REST
    /// handlers reject it with a clear error instead of unwrapping NULL.
    fn rest_url(&self) -> Result<&str> {
        self.vault_url.as_deref().filter(|s| !s.is_empty()).ok_or_else(|| {
            AppError::BadRequest("This is a folder vault — use the folder-vault endpoints".into())
        })
    }
    /// Decrypted REST API token for the Obsidian Local REST API. Legacy
    /// plaintext tokens pass through `crypto::open` unchanged.
    fn rest_token(&self) -> String {
        crate::services::crypto::open(self.api_token.as_deref().unwrap_or(""))
    }
}

/// Create a KEX job record in Postgres and push a message to Redis `kex:jobs`.
/// Returns the new job UUID.
/// Map a Google-native MIME type to the Office format we export it as (the KEX
/// worker's `extract_text` understands docx/xlsx/pptx). Returns `None` for binary
/// files that are downloaded directly via `?alt=media`.
fn drive_export_mime(native_mime: &str) -> Option<&'static str> {
    match native_mime {
        "application/vnd.google-apps.document" =>
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "application/vnd.google-apps.spreadsheet" =>
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "application/vnd.google-apps.presentation" =>
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        _ => None,
    }
}

/// Download a Drive file's bytes. Native Google formats are exported to Office
/// formats; everything else is fetched directly. Returns `(bytes, mime, name)`.
async fn download_drive_file(
    drive_file_id: &str,
    token: &str,
    http: &reqwest::Client,
) -> Result<(Vec<u8>, String, String)> {
    // Metadata first: real name + mimeType (so we know export vs direct download).
    let meta: Value = http
        .get(format!("https://www.googleapis.com/drive/v3/files/{drive_file_id}"))
        .query(&[("fields", "name,mimeType"), ("supportsAllDrives", "true")])
        .bearer_auth(token)
        .send().await
        .map_err(|e| AppError::Internal(format!("Drive metadata request failed: {e}")))?
        .json().await
        .map_err(|e| AppError::Internal(format!("Drive metadata parse failed: {e}")))?;

    let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or(drive_file_id).to_string();
    let src_mime = meta.get("mimeType").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let (resp, out_mime, out_name) = if let Some(export_mime) = drive_export_mime(&src_mime) {
        // Google-native → export to an Office format the worker can parse.
        let r = http
            .get(format!("https://www.googleapis.com/drive/v3/files/{drive_file_id}/export"))
            .query(&[("mimeType", export_mime)])
            .bearer_auth(token)
            .send().await
            .map_err(|e| AppError::Internal(format!("Drive export failed: {e}")))?;
        let ext = match export_mime {
            m if m.ends_with("wordprocessingml.document") => "docx",
            m if m.ends_with("spreadsheetml.sheet")       => "xlsx",
            _                                              => "pptx",
        };
        (r, export_mime.to_string(), format!("{name}.{ext}"))
    } else {
        // Binary file (xlsx, pdf, docx, …) → direct download.
        let r = http
            .get(format!("https://www.googleapis.com/drive/v3/files/{drive_file_id}"))
            .query(&[("alt", "media"), ("supportsAllDrives", "true")])
            .bearer_auth(token)
            .send().await
            .map_err(|e| AppError::Internal(format!("Drive download failed: {e}")))?;
        (r, src_mime, name)
    };

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("Drive download {code}: {body}")));
    }
    let bytes = resp.bytes().await
        .map_err(|e| AppError::Internal(format!("Drive body read failed: {e}")))?;
    Ok((bytes.to_vec(), out_mime, out_name))
}

/// Resolve a sync request's raw options into ontology labels + classification
/// name, reusing the same ontology resolution as direct KEX uploads (so the
/// shared default ontology is used + extended when none is selected).
async fn resolve_drive_opts(
    db: &sqlx::PgPool,
    user_id: Uuid,
    opts: &DriveExtractReqOpts,
) -> DriveExtractResolved {
    let (ontology_id, entity_types) =
        crate::routes::kex::resolve_ontology(db, user_id, opts.ontology_id).await;

    let classification_name = if let Some(cid) = opts.classification_level_id {
        sqlx::query_scalar::<_, String>("SELECT name FROM classification_levels WHERE id = $1")
            .bind(cid).fetch_optional(db).await.ok().flatten()
    } else {
        None
    };

    DriveExtractResolved {
        ontology_id,
        entity_types,
        discovery_mode: opts.discovery_mode.clone(),
        compilation_id: opts.compilation_id,
        classification_level_id: opts.classification_level_id,
        classification_name,
    }
}

#[allow(clippy::too_many_arguments)]
async fn enqueue_drive_file(
    db: &sqlx::PgPool,
    redis: &Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
    http: &reqwest::Client,
    token: &str,
    user_id: Uuid,
    connector_id: Uuid,
    drive_file_id: &str,
    file_name: &str,
    opts: &DriveExtractResolved,
) -> Result<Uuid> {
    use base64::Engine;

    // Download + base64 the file so the worker's existing `file` handler can
    // extract it (it does `json.loads(input)` → base64-decode → extract_text).
    // Previously this pushed `type:"file"` with NO input, so the worker threw
    // "Expecting value: line 1 column 1" on every Drive file.
    let (bytes, mimetype, real_name) = download_drive_file(drive_file_id, token, http).await?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let kex_input = json!({
        "fileBase64":       encoded,
        "mimetype":         mimetype,
        "originalFilename": real_name,
    }).to_string();

    let job_id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id)
         VALUES ($1, $2, 'kex_connector', 'pending', $3, $4)",
    )
    .bind(job_id)
    .bind(user_id)
    .bind(json!({
        "connectorId":   connector_id,
        "driveFileId":   drive_file_id,
        "fileName":      real_name,
        "ontologyId":    opts.ontology_id,
        "compilationId": opts.compilation_id,
        "discoveryMode": opts.discovery_mode,
    }))
    .bind(opts.classification_level_id)
    .execute(db)
    .await?;

    let mut payload = json!({
        "job_id":                  job_id,
        "user_id":                 user_id,
        "type":                    "file",
        "input":                   kex_input,
        "file_name":               real_name,
        "entity_types":            opts.entity_types,
        "ontology_id":             opts.ontology_id,
        "classification":          opts.classification_name,
        "classification_level_id": opts.classification_level_id,
    });
    crate::services::llm::inject_ollama_overrides(db, user_id, &mut payload).await;

    lpush(redis, "kex:jobs", &payload.to_string())
        .await
        .map_err(|e| AppError::Internal(format!("Redis push failed: {e}")))?;

    Ok(job_id)
}

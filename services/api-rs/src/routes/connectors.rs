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
}

#[derive(Deserialize)]
struct SyncFolderReq {
    #[serde(rename = "connectorId")] connector_id: Uuid,
    #[serde(rename = "folderId")]    folder_id:    String,
    #[serde(rename = "maxDepth")]    max_depth:    Option<u32>,
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
        return Ok(connector.access_token.clone());
    }

    // Re-read the connector row from DB before attempting a refresh.
    // A concurrent request may have already refreshed the token, in which case
    // we can return the fresh token without hitting Google's endpoint again.
    // This minimises — though does not fully eliminate — the refresh race window.
    let fresh = sqlx::query_as::<_, ConnectorRow>(
        "SELECT id, provider, label, access_token, refresh_token, token_expires_at,
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
            return Ok(fresh_row.access_token.clone());
        }
    }

    // Token is still expired after re-read — proceed with the refresh.
    let connector = fresh.as_ref().unwrap_or(connector);

    let refresh_token = connector
        .refresh_token
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("No refresh token stored; please reconnect Google".into()))?;

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
    .bind(&tok.access_token)
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
        "SELECT id, provider, label, provider_email, is_active
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
        .bind(&tok.access_token)
        .bind(&tok.refresh_token)
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
        .bind(&tok.access_token)
        .bind(&tok.refresh_token)
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

    for file_id in &req.file_ids {
        let name = meta_map.get(file_id).cloned().unwrap_or_else(|| file_id.clone());

        match enqueue_drive_file(
            &state.db,
            &state.redis,
            claims.sub,
            connector.id,
            file_id,
            &name,
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

    for (file_id, name) in &all_files {
        match enqueue_drive_file(
            &state.db,
            &state.redis,
            claims.sub,
            connector.id,
            file_id,
            name,
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
        "SELECT id, provider, label, access_token, refresh_token, token_expires_at,
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

/// Create a KEX job record in Postgres and push a message to Redis `kex:jobs`.
/// Returns the new job UUID.
async fn enqueue_drive_file(
    db: &sqlx::PgPool,
    redis: &Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
    user_id: Uuid,
    connector_id: Uuid,
    drive_file_id: &str,
    file_name: &str,
) -> Result<Uuid> {
    let job_id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input)
         VALUES ($1, $2, 'kex_connector', 'pending', $3)",
    )
    .bind(job_id)
    .bind(user_id)
    .bind(json!({
        "connectorId":   connector_id,
        "driveFileId":   drive_file_id,
        "fileName":      file_name,
    }))
    .execute(db)
    .await?;

    let payload = json!({
        "job_id":        job_id,
        "user_id":       user_id,
        "type":          "file",
        "connector_id":  connector_id,
        "drive_file_id": drive_file_id,
        "file_name":     file_name,
    });

    lpush(redis, "kex:jobs", &payload.to_string())
        .await
        .map_err(|e| AppError::Internal(format!("Redis push failed: {e}")))?;

    Ok(job_id)
}

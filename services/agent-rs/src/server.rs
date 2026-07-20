use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{Mutex, RwLock};

use crate::{config::Config, credits, license::LicenseCache, usage_queue::UsageQueue};

#[derive(Clone)]
struct AppState {
    cache:       Arc<RwLock<LicenseCache>>,
    queue:       Arc<Mutex<UsageQueue>>,
    cfg:         Arc<Config>,
    http_client: reqwest::Client,
}

#[derive(Deserialize)]
struct ActivateRequest {
    license_key: String,
}

#[derive(Deserialize)]
struct CheckRequest {
    action: String,
    #[serde(default)]
    chars:  u64,
}

#[derive(Serialize)]
struct CheckResponse {
    allowed: bool,
    credits: i64,
    balance: i64,
    reason:  Option<String>,
}

#[derive(Deserialize)]
struct ReportRequest {
    action:          String,
    chars_processed: u64,
    credits_spent:   i64,
}

#[derive(Serialize)]
struct StatusResponse {
    activated:        bool,
    valid:            bool,
    tier:             String,
    balance:          i64,
    #[serde(rename = "updateAvailable")]
    update_available: bool,
    #[serde(rename = "updateRequired")]
    update_required:  bool,
    #[serde(rename = "latestVersion")]
    latest_version:   String,
    #[serde(rename = "currentVersion")]
    current_version:  String,
}

async fn handle_activate(
    State(state): State<AppState>,
    Json(req): Json<ActivateRequest>,
) -> impl IntoResponse {
    // 1. Compute hardware fingerprint
    let fingerprint = crate::fingerprint::compute().await;

    // 2. Call license API
    let api_url = format!("{}/v1/activate", state.cfg.api_url);
    let resp = match state.http_client
        .post(&api_url)
        .json(&serde_json::json!({
            "license_key": req.license_key,
            "hardware_fingerprint": fingerprint,
        }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": format!("Cannot reach activation server: {e}") })),
            );
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        let msg = body["error"].as_str().unwrap_or("Activation failed").to_string();
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_REQUEST),
            Json(serde_json::json!({ "error": msg })),
        );
    }

    // 3. Parse response
    #[derive(serde::Deserialize)]
    struct LicenseApiResponse {
        license_jwt:     String,
        registry_token:  String,
        tier:            String,
        credits_balance: i64,
    }
    let data: LicenseApiResponse = match resp.json().await {
        Ok(d) => d,
        Err(e) => return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Invalid activation response: {e}") })),
        ),
    };

    // 4. Save JWT to disk
    if let Err(e) = tokio::fs::write(&state.cfg.license_jwt_path, &data.license_jwt).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Failed to save license: {e}") })),
        );
    }

    // 5. Update in-memory cache
    match crate::license::LicenseCache::from_token(&data.license_jwt, &state.cfg.license_public_key) {
        Ok(new_cache) => {
            *state.cache.write().await = new_cache;
        }
        Err(e) => return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("JWT parse error: {e}") })),
        ),
    }

    tracing::info!("License activated — tier={} balance={}", data.tier, data.credits_balance);

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "tier": data.tier,
            "credits_balance": data.credits_balance,
            "registry_token": data.registry_token,
        })),
    )
}

/// Tiers with UNLIMITED tokens. Mirrors api-rs routes::billing::is_unlimited_tier
/// (agent-rs cannot import from api-rs, so the list is duplicated). starter/pro
/// are transitional aliases of business until the central license server is
/// redeployed with the renamed tiers.
fn is_unlimited_tier(tier: &str) -> bool {
    matches!(
        tier.to_ascii_lowercase().as_str(),
        "business" | "enterprise" | "starter" | "pro"
    )
}

async fn handle_check(
    State(state): State<AppState>,
    Json(req): Json<CheckRequest>,
) -> impl IntoResponse {
    let mut cache = state.cache.write().await;

    if !cache.is_activated() {
        return (
            StatusCode::PAYMENT_REQUIRED,
            Json(CheckResponse {
                allowed: false,
                credits: 0,
                balance: 0,
                reason:  Some("License not activated. Complete setup at http://localhost:3001".into()),
            }),
        );
    }

    if cache.is_update_required() {
        return (
            StatusCode::FORBIDDEN,
            Json(CheckResponse {
                allowed: false,
                credits: 0,
                balance: cache.balance(),
                reason:  Some("Required update pending. Run: curl -fsSL https://gctrl.tech/update | bash".into()),
            }),
        );
    }

    let cost = credits::calculate(&req.action, req.chars);
    // Unlimited tiers never fail the affordability gate. Spend is still recorded
    // identically (deduct_local below + the /report queue) so usage stays
    // observable — the balance just can't block work, even when negative. The
    // license-activated / update-required checks above still apply.
    let unlimited = is_unlimited_tier(cache.tier());
    if !unlimited && !cache.can_spend(cost) {
        return (
            StatusCode::PAYMENT_REQUIRED,
            Json(CheckResponse {
                allowed: false,
                credits: cost,
                balance: cache.balance(),
                reason:  Some("Insufficient credits".into()),
            }),
        );
    }

    cache.deduct_local(cost);
    (
        StatusCode::OK,
        Json(CheckResponse { allowed: true, credits: cost, balance: cache.balance(), reason: None }),
    )
}

async fn handle_report(
    State(state): State<AppState>,
    Json(req): Json<ReportRequest>,
) -> impl IntoResponse {
    state.queue.lock().await.enqueue(req.action, req.chars_processed, req.credits_spent);
    StatusCode::NO_CONTENT
}

async fn handle_status(State(state): State<AppState>) -> impl IntoResponse {
    let c = state.cache.read().await;
    let latest_version = c.latest_version().to_string();
    // The agent is the authority on whether ITS version is behind: read the local
    // current_version and recompute updateAvailable rather than trusting the JWT
    // claim (which is computed server-side and may lag this instance). Forced
    // updates (update_required) stay server-driven.
    let current_version = crate::version::read_current(&state.cfg.version_path)
        .await
        .unwrap_or_default();
    let update_available =
        !current_version.is_empty() && crate::version::version_gt(&latest_version, &current_version);
    Json(StatusResponse {
        activated:        c.is_activated(),
        valid:            c.is_valid(),
        tier:             c.tier().into(),
        balance:          c.balance(),
        update_available,
        update_required:  c.is_update_required(),
        latest_version,
        current_version,
    })
}

#[derive(Deserialize)]
struct SetVersionRequest {
    version: String,
}

/// POST /version — set the current instance RELEASE version. Called by the API
/// update executor over the internal docker network (`gctrl-agent:7070`) after a
/// successful update, so the agent immediately reflects the new version and
/// `/status` reports updateAvailable=false. Same internal trust boundary as
/// /check — only the local stack reaches this port.
async fn handle_set_version(
    State(state): State<AppState>,
    Json(req): Json<SetVersionRequest>,
) -> impl IntoResponse {
    match crate::version::write_current(&state.cfg.version_path, &req.version).await {
        Ok(()) => {
            tracing::info!("current_version set to {}", req.version.trim());
            // Signal the new version to the cloud immediately (don't wait up to a
            // full heartbeat interval). Best-effort + non-blocking: the change-
            // detection in beat() reports it once and marks it acknowledged; if
            // this fire fails, the next heartbeat re-sends it.
            let cache = state.cache.clone();
            let queue = state.queue.clone();
            let cfg   = state.cfg.clone();
            tokio::spawn(async move {
                crate::heartbeat::beat(cache, queue, &cfg).await;
            });
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            tracing::warn!("Failed to write current_version: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to persist version: {e}") })),
            )
                .into_response()
        }
    }
}

/// GET /tuning — serve the cached, signature-verified ER tuning profile to the
/// local FUSE service. License-bound: returns the profile ONLY while the license
/// is valid; otherwise 204 (FUSE then falls back to generic defaults). Same
/// internal trust boundary as /check — only the local stack reaches this port.
async fn handle_tuning(State(state): State<AppState>) -> impl IntoResponse {
    if !state.cache.read().await.is_valid() {
        return StatusCode::NO_CONTENT.into_response();
    }
    match crate::tuning::read_cache(&state.cfg.tuning_profile_path).await {
        Some(t) => Json(t).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

#[derive(Deserialize)]
struct RecreateRequest {
    container: String,
}

/// Constant-time string equality — a plain `!=` short-circuits on the first
/// differing byte and leaks secret prefixes through response timing.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A container name this endpoint may touch: `gctrl-` prefix AND a strict
/// charset/length. The name is interpolated into the HTTP request line sent to
/// the docker socket — without this gate a CR/LF (or other control char) could
/// smuggle a second request onto the socket. (Security review CRITICAL.)
fn valid_container_name(name: &str) -> bool {
    name.starts_with("gctrl-")
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// `POST /recreate {"container": "gctrl-api"}` — swaps `container` onto its
/// already-pulled image via the docker socket this agent mounts. Exists solely
/// so the api container can update ITSELF: the api can't delete-and-recreate
/// its own container without dying mid-operation, but this agent is already
/// recreated onto the new image earlier in the same update run, so it can do
/// the api's swap on its behalf.
///
/// Trust boundary (STRICTER than the read-only kex/fuse `/search` pattern —
/// this endpoint DELETES and recreates a container, so it fails CLOSED):
/// (a) only strictly-validated `gctrl-*` container names are accepted;
/// (b) `INTERNAL_API_SECRET` must be configured on the agent AND matched by the
///     caller's `X-Internal-Secret` (constant-time). An empty secret disables
///     the endpoint entirely (403) rather than running unauthenticated — the
///     installer always generates one, so real installs are unaffected.
///
/// Responds `202 Accepted` immediately and does the actual inspect → remove →
/// create → start dance in a spawned task ~1.5s later — long enough for the
/// caller (api-rs, mid-response to its OWN client) to finish sending its
/// response before the target container (possibly its own, for gctrl-api)
/// actually goes away.
async fn handle_recreate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RecreateRequest>,
) -> impl IntoResponse {
    if !valid_container_name(&req.container) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid container name" })),
        )
            .into_response();
    }

    // Fail CLOSED: a destructive endpoint must never run without a secret.
    // (Security review HIGH — fail-open.) The whole agent keeps serving /status
    // + the license heartbeat, so we reject just this route rather than panicking.
    if state.cfg.internal_api_secret.is_empty() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "recreate disabled: INTERNAL_API_SECRET is not configured on the agent"
            })),
        )
            .into_response();
    }
    let provided = headers
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !ct_eq(provided, &state.cfg.internal_api_secret) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden" })),
        )
            .into_response();
    }

    let container = req.container.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let name = container.clone();
        let result = tokio::task::spawn_blocking(move || crate::docker::recreate_container(&name)).await;
        match result {
            Ok(Ok(true)) => tracing::info!("recreate: {container} recreated"),
            Ok(Ok(false)) => tracing::warn!("recreate: {container} not found — nothing to recreate"),
            Ok(Err(e)) => tracing::error!("recreate: {container} failed: {e}"),
            Err(e) => tracing::error!("recreate: {container} task panicked: {e}"),
        }
    });

    (StatusCode::ACCEPTED, Json(serde_json::json!({ "ok": true }))).into_response()
}

pub async fn run(
    cache: Arc<RwLock<LicenseCache>>,
    queue: Arc<Mutex<UsageQueue>>,
    cfg:   Config,
) {
    let http_client = reqwest::Client::new();
    let state = AppState {
        cache,
        queue,
        cfg:         Arc::new(cfg.clone()),
        http_client,
    };

    let app = Router::new()
        .route("/activate", post(handle_activate))
        .route("/check",    post(handle_check))
        .route("/report",   post(handle_report))
        .route("/status",   get(handle_status))
        .route("/version",  post(handle_set_version))
        .route("/tuning",   get(handle_tuning))
        .route("/recreate", post(handle_recreate))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    tracing::info!("Agent listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod recreate_guard_tests {
    use super::{ct_eq, valid_container_name};

    #[test]
    fn rejects_non_gctrl_and_injection() {
        assert!(valid_container_name("gctrl-api"));
        assert!(valid_container_name("gctrl-web"));
        assert!(!valid_container_name("postgres"));           // no prefix
        assert!(!valid_container_name("gctrl-api/../etc"));    // slash
        assert!(!valid_container_name("gctrl-api\r\nGET /"));  // CRLF smuggling
        assert!(!valid_container_name("gctrl-api name"));      // space
        assert!(!valid_container_name(&format!("gctrl-{}", "a".repeat(70)))); // too long
    }

    #[test]
    fn ct_eq_matches_only_exact() {
        assert!(ct_eq("s3cr3t", "s3cr3t"));
        assert!(!ct_eq("s3cr3t", "s3cr3T"));
        assert!(!ct_eq("s3cr3t", "s3cr3t-longer"));
        assert!(!ct_eq("", "x"));
    }
}

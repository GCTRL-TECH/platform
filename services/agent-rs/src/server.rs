use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
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
    if !cache.can_spend(cost) {
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
    Json(StatusResponse {
        activated:        c.is_activated(),
        valid:            c.is_valid(),
        tier:             c.tier().into(),
        balance:          c.balance(),
        update_available: c.is_update_available(),
        update_required:  c.is_update_required(),
        latest_version:   c.latest_version().into(),
    })
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
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    tracing::info!("Agent listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

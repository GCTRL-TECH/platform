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
    cache: Arc<RwLock<LicenseCache>>,
    queue: Arc<Mutex<UsageQueue>>,
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

async fn handle_check(
    State(state): State<AppState>,
    Json(req): Json<CheckRequest>,
) -> impl IntoResponse {
    let mut cache = state.cache.write().await;

    if cache.is_update_required() {
        return (
            StatusCode::FORBIDDEN,
            Json(CheckResponse {
                allowed: false,
                credits: 0,
                balance: cache.balance(),
                reason: Some("Required update pending. Run: curl -fsSL https://gctrl.tech/update | bash".into()),
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
                reason: Some("Insufficient credits".into()),
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
    let state = AppState { cache, queue };
    let app = Router::new()
        .route("/check",  post(handle_check))
        .route("/report", post(handle_report))
        .route("/status", get(handle_status))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    tracing::info!("Agent listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

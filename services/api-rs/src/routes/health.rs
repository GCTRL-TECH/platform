use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new().route("/", get(handler))
}

async fn handler() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "timestamp": chrono::Utc::now() }))
}

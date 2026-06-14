use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;

use super::update::current_version;

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new().route("/public", get(public_config))
}

/// `GET /api/config/public` → the single source of truth for every user-visible
/// endpoint URL the UI displays (MCP/n8n setup strings, Neo4j Browser links,
/// agent health/license probes, version banner).
///
/// All URLs derive from one canonical external origin so that changing the
/// published port (and `FRONTEND_URL`) in `.env`/compose updates every displayed
/// reference automatically — no hardcoded `host:port` left in the bundle.
///
/// `apiOrigin` resolution order:
///   1. `FRONTEND_URL` config (the canonical external origin), if set.
///   2. Derived from the request: `X-Forwarded-Proto` + `X-Forwarded-Host`
///      (or `Host`) — works behind a reverse proxy.
///
/// `neo4jBrowser` / `agentHealth` prefer their explicit env overrides
/// (`GCTRL_NEO4J_BROWSER_URL` / `GCTRL_AGENT_URL`); when empty the value is an
/// empty string and the frontend derives `http://<window.hostname>:<port>`.
async fn public_config(
    State(state): State<Arc<crate::models::AppState>>,
    headers: HeaderMap,
) -> Json<Value> {
    let cfg = &state.cfg;

    let api_origin = canonical_origin(cfg, &headers);
    let api_base = format!("{api_origin}/api");

    // Fresh-install detection: a brand-new install has zero users. The first-run
    // UI uses this boolean to route to "create your admin account" instead of a
    // login form for an account that doesn't exist yet. No auth required — it's
    // just a count, and it flips to false permanently once the admin registers.
    // Best-effort: any DB hiccup defaults to "not fresh" so we never trap an
    // already-configured install behind a setup screen.
    let setup_required: bool = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await
        .map(|n| n == 0)
        .unwrap_or(false);

    Json(json!({
        "apiOrigin":             api_origin,
        "apiBase":               api_base,
        // True only on a brand-new install with no users. Drives the first-run
        // "create your admin account" screen.
        "setupRequired":         setup_required,
        // MCP-over-HTTP base the UI shows in the MCP/n8n setup tabs.
        "mcpEndpoint":           api_base,
        // Remote MCP gateway (Phase 6 Agent tab).
        "agentGatewayEndpoint":  format!("{api_origin}/api/agent/mcp"),
        // Empty string => frontend derives http://<hostname>:7474 from the browser.
        "neo4jBrowser":          cfg.neo4j_browser_url.clone(),
        // Empty string => frontend derives http://<hostname>:7070 from the browser.
        "agentHealth":           cfg.agent_url.clone(),
        "version":               current_version(),
    }))
}

/// Resolve the canonical external origin (scheme://host[:port]) the browser uses.
/// Prefers `FRONTEND_URL`; otherwise reconstructs it from forwarded/host headers.
fn canonical_origin(cfg: &crate::config::Config, headers: &HeaderMap) -> String {
    let fe = cfg.frontend_url.trim().trim_end_matches('/');
    if !fe.is_empty() {
        return fe.to_string();
    }

    let host = header_str(headers, "x-forwarded-host")
        .or_else(|| header_str(headers, "host"))
        .unwrap_or_else(|| format!("localhost:{}", cfg.port));

    let proto = header_str(headers, "x-forwarded-proto").unwrap_or_else(|| "http".to_string());

    format!("{proto}://{host}")
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        // X-Forwarded-* may contain a comma-separated list; take the first hop.
        .map(|s| s.split(',').next().unwrap_or(s).trim().to_string())
        .filter(|s| !s.is_empty())
}

//! Remote MCP gateway — makes the Pi agent harness addressable by external
//! multi-agent orchestrators (Hermes / OpenClaw / Codex / any MCP-HTTP client)
//! over the network.
//!
//! Transport: a pragmatic implementation of the MCP **Streamable-HTTP** binding.
//! A single `POST /api/agent/mcp` endpoint accepts JSON-RPC 2.0 requests and
//! returns a single JSON-RPC response per request (SSE streaming is not required
//! for v1). Methods handled: `initialize`, `tools/list`, `tools/call`, plus
//! `notifications/initialized` and `ping` no-ops.
//!
//! Security:
//!   * **Off by default** — gated behind `GCTRL_AGENT_GATEWAY_ENABLED`. When
//!     disabled, every request returns 403.
//!   * **Auth** — reuses the existing api-key path (`Authorization: ApiKey
//!     gctrl_…` → `JwtClaims`). Tool impls already enforce clearance + grants.
//!   * **Audit** — every `tools/call` is written to `audit_log`.

use axum::{
    extract::{Extension, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::middleware::auth::JwtClaims;

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/mcp", post(mcp_rpc))
        .route("/gateway/status", get(gateway_status))
}

/// GET /api/agent/gateway/status — tiny probe for the Agent settings tab.
async fn gateway_status(
    State(state): State<Arc<crate::models::AppState>>,
) -> Json<Value> {
    Json(json!({ "enabled": state.cfg.agent_gateway_enabled }))
}

// ── JSON-RPC helpers ───────────────────────────────────────────────────────────

fn rpc_result(id: Value, result: Value) -> Json<Value> {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn rpc_error(id: Value, code: i64, message: &str) -> Json<Value> {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }))
}

/// Turn the agent's `tool_schema()` (`{tools:[{name, description, args}]}`) into
/// MCP tool descriptors with a real JSON-Schema `inputSchema`. The `args` hint
/// map uses values like `"string"`, `"number?"`, `"string[]"` — we translate
/// those into property types and a `required` list (anything not `…?`).
fn mcp_tool_descriptors() -> Vec<Value> {
    let schema = crate::routes::agent::tool_schema();
    let mut out = Vec::new();
    if let Some(tools) = schema["tools"].as_array() {
        for t in tools {
            let name = t["name"].as_str().unwrap_or("");
            let desc = t["description"].as_str().unwrap_or("");
            let mut props = serde_json::Map::new();
            let mut required: Vec<Value> = Vec::new();
            if let Some(args) = t["args"].as_object() {
                for (key, hint) in args {
                    let raw = hint.as_str().unwrap_or("string");
                    let optional = raw.ends_with('?');
                    let base = raw.trim_end_matches('?');
                    let prop = if base.ends_with("[]") {
                        let item = base.trim_end_matches("[]");
                        json!({ "type": "array", "items": { "type": json_type(item) } })
                    } else {
                        json!({ "type": json_type(base) })
                    };
                    props.insert(key.clone(), prop);
                    if !optional {
                        required.push(json!(key));
                    }
                }
            }
            out.push(json!({
                "name": name,
                "description": desc,
                "inputSchema": {
                    "type": "object",
                    "properties": Value::Object(props),
                    "required": required,
                }
            }));
        }
    }
    out
}

fn json_type(hint: &str) -> &'static str {
    match hint {
        "number" => "number",
        "boolean" | "bool" => "boolean",
        _ => "string",
    }
}

// ── Main handler ────────────────────────────────────────────────────────────────

/// POST /api/agent/mcp — JSON-RPC 2.0 over HTTP (MCP Streamable-HTTP, single
/// JSON response per request).
async fn mcp_rpc(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<Value>,
) -> axum::response::Response {
    // Off-by-default gate. The route is always mounted (so the UI status probe
    // stays cheap), but the RPC surface is inert unless explicitly enabled.
    if !state.cfg.agent_gateway_enabled {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "agent gateway disabled",
                "hint": "set GCTRL_AGENT_GATEWAY_ENABLED=true in the API server env and restart"
            })),
        )
            .into_response();
    }

    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        // ── Handshake ──────────────────────────────────────────────────────────
        "initialize" => {
            // Prepend a pointer so the connecting model pulls the FULL skill
            // (exposed as the gctrl://skill resource below) — the short
            // MEMORY_INSTRUCTIONS is only the gist.
            let instructions = format!(
                "IMPORTANT: read the full GCTRL skill before your first task — it's the MCP resource `gctrl://skill` (call resources/read) or GET /api/agent/skill.md. Follow it: it covers the one-time setup interview, using GCTRL as your RAG/memory infrastructure, and the write-back discipline. Gist: {}",
                crate::routes::agent::MEMORY_INSTRUCTIONS
            );
            rpc_result(
                id,
                json!({
                    "protocolVersion": "2025-06-18",
                    "serverInfo": { "name": "gctrl", "version": env!("CARGO_PKG_VERSION") },
                    // `resources` advertised so a connecting client can auto-fetch the
                    // full GCTRL skill (setup interview, RAG-infra framing, write-back
                    // discipline) — the `instructions` below is only the gist + pointer.
                    "capabilities": { "tools": {}, "resources": {} },
                    "instructions": instructions
                }),
            )
            .into_response()
        }

        // ── Lifecycle no-ops ───────────────────────────────────────────────────
        // Notifications carry no `id` and expect no response body; a 202 with an
        // empty object is accepted by MCP clients.
        "notifications/initialized" | "notifications/cancelled" => {
            (StatusCode::ACCEPTED, Json(json!({}))).into_response()
        }
        "ping" => rpc_result(id, json!({})).into_response(),

        // ── Discovery ──────────────────────────────────────────────────────────
        "tools/list" => {
            rpc_result(id, json!({ "tools": mcp_tool_descriptors() })).into_response()
        }

        // ── Resources: expose the full GCTRL skill so a connecting agent can
        //    pull and follow it (the short `instructions` is only a pointer). ──
        "resources/list" => rpc_result(
            id,
            json!({ "resources": [ {
                "uri": "gctrl://skill",
                "name": "GCTRL Agent Skill",
                "title": "How to get the most out of GCTRL",
                "description": "Read and follow this on connect: first-run setup, using GCTRL as your RAG/memory infrastructure, and the write-back discipline.",
                "mimeType": "text/markdown"
            } ] }),
        )
        .into_response(),
        "resources/read" => {
            let uri = req.get("params").and_then(|p| p.get("uri")).and_then(|u| u.as_str()).unwrap_or("");
            if uri == "gctrl://skill" {
                rpc_result(id, json!({ "contents": [ {
                    "uri": "gctrl://skill",
                    "mimeType": "text/markdown",
                    "text": crate::routes::agent::MEMORY_SKILL_MD
                } ] })).into_response()
            } else {
                rpc_error(id, -32602, &format!("unknown resource: {uri}")).into_response()
            }
        }

        // ── Invocation ─────────────────────────────────────────────────────────
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if name.is_empty() {
                return rpc_error(id, -32602, "missing tool name").into_response();
            }

            // Reuse the exact tool dispatch behind POST /api/agent/tools/:name,
            // with the caller's claims → clearance + per-graph grants enforced
            // inside each tool impl.
            let result = crate::routes::agent::execute_tool(&state, &claims, &name, &args).await;

            // Audit every remote tool invocation. The acting api-key id + email
            // are captured in audit_log.details by log_access.
            let granted = result.get("error").is_none();
            crate::services::audit::log_access(
                &state.db,
                &claims,
                &format!("agent.mcp.{name}"),
                "tool",
                &name,
                claims.api_key_rank.unwrap_or(0),
                None,
                granted,
                result.get("error").and_then(|e| e.as_str()),
            )
            .await;

            let text = serde_json::to_string(&result).unwrap_or_else(|_| "{}".into());
            rpc_result(
                id,
                json!({
                    "content": [ { "type": "text", "text": text } ],
                    "isError": !granted
                }),
            )
            .into_response()
        }

        // ── Unknown ────────────────────────────────────────────────────────────
        other => rpc_error(id, -32601, &format!("method not found: {other}")).into_response(),
    }
}

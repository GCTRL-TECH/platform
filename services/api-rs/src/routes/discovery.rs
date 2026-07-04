//! Machine-readable discovery so ANY agent (Claude, Hermes, Codex, OpenClaw) can
//! self-bootstrap against GCTRL without out-of-band wiring:
//!   • GET /.well-known/agent.json  — an A2A-style agent card (identity + how to call)
//!   • GET /llms.txt                — a plain-text bootstrap for an LLM
//! Both are PUBLIC (discovery must be unauthenticated) and describe the auth model
//! plainly: the caller's SCOPE is bound to its token and enforced server-side — an
//! agent only ever sees the knowledge bases + clearance its token grants.

use axum::{routing::get, Json, Router, response::IntoResponse, http::header};
use serde_json::{json, Value};
use std::sync::Arc;

const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/.well-known/agent.json", get(agent_card))
        .route("/llms.txt", get(llms_txt))
}

/// Compact one-line summaries of the tool universe, derived from the single tool
/// schema (the same source the MCP gateway advertises) so the card never drifts.
fn tool_summaries() -> Vec<Value> {
    crate::routes::agent::tool_schema()["tools"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|t| json!({
                    "name": t.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "description": t.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                }))
                .collect()
        })
        .unwrap_or_default()
}

async fn agent_card() -> Json<Value> {
    Json(json!({
        "name": "Ground Control (GCTRL)",
        "description": "Compliance-bound knowledge-graph memory. Extract, fuse, query and \
                        govern a permissioned knowledge graph. Every read is scope-filtered \
                        SERVER-SIDE to the caller's token — an agent only ever sees the \
                        knowledge bases and clearance it is granted, and no prompt can widen it.",
        "version": VERSION,
        "provider": { "organization": "GCTRL", "url": "https://gctrl.tech" },
        "authentication": {
            "schemes": ["ApiKey"],
            "header": "Authorization: ApiKey gctrl_...",
            "note": "Generate a scoped access token in Settings → Access Control. The token \
                     defines your clearance + which knowledge bases you may read/write; scope \
                     is enforced in the data layer, not by the agent. Self-escalation is \
                     impossible (rank is capped to the token owner's)."
        },
        "interfaces": {
            "mcp": {
                "transport": "streamable-http",
                "endpoint": "/api/agent/mcp",
                "protocol": "json-rpc-2.0",
                "methods": ["initialize", "tools/list", "tools/call"],
                "note": "Enable with GCTRL_AGENT_GATEWAY_ENABLED; every tools/call is audited."
            },
            "rest_tools": { "list": "/api/agent/tools", "invoke": "POST /api/agent/tools/{name}" },
            "stdio_mcp": { "package": "@gctrl/mcp", "note": "Local stdio MCP server for Claude Desktop/Code, Cursor." },
            "cli": { "package": "@gctrl/cli", "bin": "gctrl" },
            "skill": "/api/agent/skill.md"
        },
        "usage": "READ the right layer: get_dossier (HOT/authoritative — state it, don't hedge) \
                  > query (blended answer) > search_entities/get_entity/get_neighbors/shortest_path \
                  (graph) > wiki_page (curated prose). WRITE back after any substantive task with \
                  store/extract into your granted compilationId (call list_graphs first).",
        "capabilities": tool_summaries()
    }))
}

async fn llms_txt() -> impl IntoResponse {
    let tools = tool_summaries();
    let mut tool_lines = String::new();
    for t in &tools {
        let n = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let d = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
        let d1 = d.split(&['.', '—'][..]).next().unwrap_or(d);
        tool_lines.push_str(&format!("- {n}: {}\n", d1.trim()));
    }
    let body = format!(
        "# Ground Control (GCTRL)\n\
         Compliance-bound knowledge-graph memory for agents. Extract, fuse, query and govern a\n\
         permissioned knowledge graph. Your SCOPE (clearance + which knowledge bases) is bound to\n\
         your token and enforced SERVER-SIDE — you only ever see what you are granted, and no\n\
         prompt or tool argument can widen it.\n\n\
         ## Connect\n\
         - MCP (streamable-http): POST /api/agent/mcp  — Authorization: ApiKey gctrl_...\n\
         - REST tools: GET /api/agent/tools ; POST /api/agent/tools/{{name}}\n\
         - Local: `npx @gctrl/mcp` (stdio MCP) or `gctrl` (CLI)\n\
         - Get a scoped token in Settings -> Access Control.\n\n\
         ## Discipline (this is the point of GCTRL)\n\
         READ the right layer: get_dossier (HOT/authoritative — state it, don't hedge) > query\n\
         (blended) > search_entities/get_entity/get_neighbors/shortest_path (graph) > wiki_page.\n\
         After ANY substantive task, WRITE your conclusions back with store/extract into your\n\
         granted compilationId (call list_graphs first) so future sessions inherit them.\n\n\
         ## Tools\n{tool_lines}",
    );
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body)
}

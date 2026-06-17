use axum::{
    extract::{Extension, Path, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
};

// ── GCTRL Memory skill (single source of truth) ─────────────────────────────
//
// Taught to the INTERNAL Pi agent (seeded as a system skill, folded into the
// system prompt), surfaced to EXTERNAL agents via the MCP `initialize`
// instructions (short form), and served verbatim at GET /api/agent/skill.md for
// the connect UI's copyable "drop into your agent" block.

pub const MEMORY_SKILL_MD: &str = r#"# GCTRL Knowledge & Memory — Agent Skill

You are connected to GCTRL, a graph-native long-term memory. Use it as your persistent second brain: read the right layer, and **always write your conclusions back** so every future session inherits them. That write-back habit is the whole point — it turns GCTRL into compounding memory instead of starting cold each time.

## Read the right layer
- **HOT — dossiers** · `get_dossier(name)`: the authoritative compiled profile of an entity (summary, key facts with confidence, origin files, timeline). When a dossier exists, state it directly — do not hedge.
- **Blended answer** · `query(message)`: blends all tiers (dense + keyword + graph + dossiers). Prefer this for open questions. Use `search_chunks` for raw evidence passages.
- **COLD — graph** · `search_entities`, `get_entity` (includes provenance / origin file), `get_neighbors`, `shortest_path`: structure, dependencies, "how is A connected to B".
- **WIKI — curated prose** · `wiki_page` / `wiki_graph`: distilled, cross-linked pages over a knowledge base.

## Write your conclusions back (the rule)
After any substantive task, persist durable conclusions so they compound:
- `store(text, compilationId)` / `extract(text, compilationId)` — write facts/notes into your assigned knowledge base. **Always pass a `compilationId`** (find yours via `list_graphs`) so nothing is orphaned.
- Confirm a fact you verified: `memory_feedback(entity, "up")`. Pin a key entity so it stays hot: `pin_dossier(name)`.
- Found something wrong: `correct_relationship(...)` or `memory_feedback(entity, "down", {compilationId, head, relType, tail})`.
- For a knowledge base you own, occasionally `distill(compilationId)` to refresh its wiki and `detect_communities(compilationId)` to surface structure.

## Your access is scoped
Your token sees only the knowledge bases it was granted — typically your own wiki + raw graph and, by clearance, a shared company KB. Call `list_graphs` to see what you can access; write only into KBs you're granted. Owner-level memory tools (pin, feedback, health, maintenance, profile) may be unavailable to a scoped token — if so, just keep feeding your KB with `store`.

## Habit
Read HOT/blended first → answer → **write the new conclusion back** with `store` into your `compilationId`. Do this every time and your GCTRL becomes a second brain that gets sharper with every task.
"#;

pub const MEMORY_INSTRUCTIONS: &str = "GCTRL is your long-term memory. READ the right layer (get_dossier = HOT/authoritative — state it, don't hedge; query = blended answer; search_entities/get_entity/get_neighbors/shortest_path = graph; wiki_page = curated prose). After ANY substantive task, WRITE your conclusions back with gctrl_store/gctrl_extract into your assigned compilationId (find it via list_graphs) so future sessions inherit them — that write-back habit is the point of GCTRL. Your token is scoped: you only see and write the knowledge bases you're granted; call list_graphs first.";

/// Core agent-discipline habits folded into Pi's system prompt. Four principles
/// (think-first, simplicity, surgical edits, goal-driven verification) that make
/// the agent's work reliable. Seeded as a system skill so it's on by default and
/// toggleable per user.
pub const AGENT_DISCIPLINE_MD: &str = r#"# Agent Discipline

Four habits that make your work reliable. Apply them on every task.

## 1. Think before doing
Surface assumptions, tradeoffs, and confusion BEFORE you act. Don't assume; don't hide uncertainty. When the request is ambiguous or several approaches exist, name them and choose one with a brief reason.

## 2. Simplicity first
Do the minimum that actually solves the problem. Nothing speculative — no extra features, abstractions, or handling the task doesn't need. Fewer moving parts, less to go wrong.

## 3. Surgical changes
When editing existing work, touch only what the request requires. Preserve the surrounding structure and style. Clean up only your own mess — don't refactor or "improve" unrelated parts.

## 4. Goal-driven execution
Turn the task into explicit, verifiable success criteria. Work step by step and loop until each criterion is actually met — don't stop at "looks done". State what you verified.
"#;

pub const NATIVE_OLLAMA_SKILL_MD: &str = r#"# Connecting native Ollama (GPU)

When the user asks how to use their GPU, switch to native Ollama, or reports
"Ollama not reachable / not connecting", guide them — but you CANNOT run host
commands yourself (you run inside a container; changing the host's Ollama service
needs host access, which would be a security hole). Explain and instruct only.

Why it happens: GCTRL's bundled Ollama runs in Docker and is CPU-only. A NATIVE
Ollama (for GPU) listens on `127.0.0.1` by default, so the GCTRL containers can't
reach it. Two steps fix it:

1. Make Ollama listen on all interfaces (Ollama's own setting, one env var), then
   restart it. Give the command for THEIR OS:
   - Linux (systemd): create `/etc/systemd/system/ollama.service.d/override.conf`
     with `[Service]` + `Environment="OLLAMA_HOST=0.0.0.0:11434"`, then
     `sudo systemctl daemon-reload && sudo systemctl restart ollama`.
   - macOS: `launchctl setenv OLLAMA_HOST "0.0.0.0:11434"`, then quit and reopen
     the Ollama app.
   - Windows: `setx OLLAMA_HOST "0.0.0.0:11434"`, then restart Ollama from the tray.
2. In Settings → AI Models, set the Ollama base URL to `http://localhost:11434`
   (GCTRL auto-routes localhost to the host) and Test connection.

Ask which OS they're on if unknown. Full guide: gctrl.tech/docs/gpu.
"#;

/// Idempotently ensure the system skills exist/upgraded so the internal Pi agent
/// always carries the core guidance. Single source: each manifest prompt is the
/// const above. Not locked → users can disable any of them.
pub async fn ensure_system_skills(db: &sqlx::PgPool) {
    let upserts: &[(&str, &str, &str, &str)] = &[
        (
            "gctrl-memory",
            "GCTRL Memory",
            "Use the hot/warm/cold/wiki layers and write conclusions back so memory compounds.",
            MEMORY_SKILL_MD,
        ),
        (
            "agent-discipline",
            "Agent Discipline",
            "Think before doing, keep it simple, make surgical edits, and verify against explicit success criteria.",
            AGENT_DISCIPLINE_MD,
        ),
        (
            "native-ollama-setup",
            "Native Ollama (GPU) setup",
            "Guide the user through connecting a native (GPU) Ollama — expose it on 0.0.0.0 and point GCTRL at localhost.",
            NATIVE_OLLAMA_SKILL_MD,
        ),
    ];
    for (slug, name, description, prompt) in upserts {
        let manifest = json!({ "prompt": prompt });
        let _ = sqlx::query(
            "INSERT INTO agent_skills (user_id, slug, name, description, kind, locked, enabled, manifest)
             VALUES (NULL, $1, $2, $3, 'curated', false, true, $4)
             ON CONFLICT (slug) WHERE user_id IS NULL
             DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, manifest = EXCLUDED.manifest"
        )
        .bind(slug).bind(name).bind(description).bind(&manifest)
        .execute(db).await;
    }
}

/// GET /api/agent/skill.md — the canonical GCTRL Memory skill, as markdown, so a
/// user can drop it into their own agent (Claude Code skill, Cursor rules, …).
async fn skill_md() -> impl axum::response::IntoResponse {
    ([("content-type", "text/markdown; charset=utf-8")], MEMORY_SKILL_MD)
}

// ── Router ────────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/chat", post(chat))
        .route("/skill.md", get(skill_md))
        .route("/tools", get(list_tools))
        .route("/tools/:name", post(invoke_tool))
}

/// POST /api/agent/tools/:name — invoke one GCTRL tool directly with `args` as
/// the JSON body, returning its result. This is the harness entry point: an
/// external agent (Hermes / OpenClaw / Paperclip) authenticated with a scoped
/// Access Token calls a tool and gets results already filtered to that token's
/// clearance + per-graph grants — no LLM round-trip, no over-sharing.
async fn invoke_tool(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(name): Path<String>,
    body: Option<Json<Value>>,
) -> Json<Value> {
    let args = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    Json(execute_tool(&state, &claims, &name, &args).await)
}

// ── Request model ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ChatReq {
    message: String,
    #[serde(rename = "sessionId")]
    _session_id: Option<String>, // reserved for future session memory
    #[serde(rename = "llmProvider")]
    llm_provider: Option<String>,
    #[serde(rename = "llmModel")]
    llm_model: Option<String>,
    /// Per-session clearance the agent should operate at (a classification rank, or
    /// i32::MAX for full access). Admins default to full access when omitted; a
    /// session may downgrade. A non-admin can never exceed their stored rank.
    #[serde(rename = "overrideClearanceRank")]
    override_clearance_rank: Option<i32>,
    /// Recent conversation turns from the client. Pi is server-stateless (the UI
    /// holds the thread), so the client sends the running history to seed the loop
    /// — that's what gives the agent cross-turn memory. `[{role, content}]`.
    history: Option<Vec<Value>>,
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT: &str = r#"You are Pi, GCTRL's built-in knowledge agent. GCTRL is a knowledge-graph data
layer. You can ingest data, search and read graphs + their source text, merge
graphs, EDIT graphs (add/remove relationships and entities), delete vector
chunks, manage compilations and ontologies, and report classification conflicts
— all within the caller's access rights. Every result is automatically filtered
to the caller's clearance and per-graph grants; you never see — or change — data
the caller isn't cleared for. Destructive actions are governed by the caller's
access token: an admin token has full control; a scoped token can only act
within its granted clearance and graphs.

Read tools:
- list_graphs        : List knowledge graphs the caller can see. No args.
- get_graph          : Read a compilation's entities + relationships. Args: { compilationId: string, limit?: number }
- search_entities    : Find entities by name. Args: { query: string, limit?: number }
- get_entity         : Read one entity, its connections AND its provenance (origin file / sourceRef / extraction job + timestamp). Use this to answer "where does X come from", "which file", "what's the source/origin of X". Args: { name: string }
- get_dossier        : Read the AUTHORITATIVE entity dossier (HOT memory) — a compiled summary, key facts (with confidence), origin files and timeline for a named entity. This is the HIGHEST-TRUST source: when a dossier exists for the asked entity, it directly answers "who/what is X" and "where does X come from" — use it and state the answer, do NOT hedge. Args: { name: string }
- get_neighbors      : List entities within N hops of a node (dependency tracing; code graphs — what does X touch?). Args: { name: string, depth?: number }
- shortest_path      : Shortest path between two entities (how A connects to B / does X depend on Y). Args: { from: string, to: string }
- search_chunks      : Retrieve source text passages for a question (RAG retrieval — use this to ANSWER questions, then cite the passages). Args: { query: string, compilationId?: string }
- list_extractions   : List KEX extraction jobs. No args.
- list_conflicts     : List open classification conflicts. No args.
- list_sources       : List connected data sources. No args.
- list_ontologies    : List ontologies. No args.
- check_balance      : Check token balance. No args.

Action tools:
- create_extraction  : Ingest text into the graph. Args: { text: string, classificationLevelId?: string }
- fuse_graphs        : Merge graphs by their source jobs. Args: { name: string, sourceJobIds: string[] }
- create_compilation : Create a new (empty) knowledge graph. Args: { name: string, description?: string }
- delete_compilation : Delete a compilation the caller owns. Args: { compilationId: string }
- refresh_compilation: Re-run fusion to refresh a compilation. Args: { compilationId: string }

Graph-edit / correction tools (use to FIX wrong knowledge — the deletion is
remembered so re-extraction never re-introduces it):
- add_relationship   : Add an edge between two existing entities. Args: { compilationId: string, head: string, relType: string, tail: string }
- correct_relationship: Delete a wrong edge and remember it. Args: { compilationId: string, head: string, relType: string, tail: string, reason?: string }
- delete_node        : Remove an entity and its edges. Args: { compilationId: string, name: string, reason?: string }
- delete_chunk       : Remove a source text chunk from Postgres + Qdrant. Args: { chunkId: string }

To use a tool, respond with ONLY a JSON object on a single line — exactly ONE tool
call, no prose, no second object. Wait for its result before the next call:
{"tool": "tool_name", "args": {...}}

How to think and act:
- Be decisive and resourceful. You are an operator of THIS system, not a generic
  chatbot. When a tool returns data, USE IT to answer directly — never reply with
  meta-commentary like "without more context I can't analyze this" or ask the user
  to explain data you just fetched. You have the context; interpret it.
- Chain tools to fully answer. Most questions need 1-3 tool calls, e.g.
  search_entities → get_entity, or list_graphs → get_graph.
- For "where does X come from / which file / origin / source / provenance of X":
  call get_entity and read its `provenance.originFile` (and `sourceRef`,
  `extractedAt`). Do NOT just search_chunks for this — provenance lives on the
  entity. If originFile is null, say it was extracted from raw text and give the
  sourceRef / extraction job + timestamp.
- To answer a general knowledge question, call search_chunks, then answer from the
  passages and cite them.
- For "give me / summarize / the full CV / work history / profile / everything about X":
  call search_chunks (query with the person's or topic's name), then COMPILE the
  answer from the returned passages — pull out and organise the concrete facts you
  find (roles, employers, education, languages, skills, dates, contacts). The
  passages ARE the document. NEVER tell the user to "refer to the file" or that the
  full text "is not available" when passages came back — read them and report what
  they say. Chunk text may have minor extraction artefacts (odd spacing); read past
  them. Cite the source file only as provenance, never as a substitute for the answer.
- To fix a wrong fact, use correct_relationship (or delete_node).
- You can operate on the system itself (KEX, FUSE, graphs, ontologies, chunks) —
  if asked to act, do it with the right tool rather than describing what you would do.
- When you have enough information, give a clear, specific, useful answer in plain
  text. Be concrete; cite entities, files, and IDs you actually retrieved."#;

/// Build the effective system prompt for this caller: the hard-wired GCTRL base
/// (always present — the `gctrl-mcp` builtin), plus a labelled section for each
/// enabled curated/github skill's guidance. Disabled skills contribute nothing.
pub(crate) async fn build_system_prompt(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
) -> String {
    let mut prompt = SYSTEM_PROMPT.to_string();
    let skills = crate::routes::skills::load_effective_skills(&state.db, claims.sub).await;
    for skill in skills.iter().filter(|s| s.enabled) {
        // The builtin GCTRL tools are already the base prompt — skip its (null)
        // guidance. Only curated/github skills add labelled guidance sections.
        if skill.kind == "builtin" {
            continue;
        }
        if let Some(guidance) = skill.prompt() {
            prompt.push_str(&format!(
                "\n\n## Skill: {}\n{}",
                skill.name.trim(),
                guidance.trim()
            ));
        }
    }
    prompt
}

// ── Tool definitions (for GET /tools) ────────────────────────────────────────

pub(crate) fn tool_schema() -> Value {
    json!({
        "tools": [
            { "name": "list_graphs",        "description": "List knowledge graphs the caller can access", "args": {} },
            { "name": "get_graph",          "description": "Read a compilation's entities and relationships", "args": { "compilationId": "string", "limit": "number?" } },
            { "name": "search_entities",    "description": "Find entities by name (clearance-filtered)", "args": { "query": "string", "limit": "number?" } },
            { "name": "get_entity",         "description": "Read one entity, its connections, and its provenance (origin file / sourceRef / extraction job) — use for 'where does X come from / which file'", "args": { "name": "string" } },
            { "name": "get_neighbors",      "description": "List entities within N hops of a node (dependency tracing; great for code graphs — what does X touch?)", "args": { "name": "string", "depth": "number?" } },
            { "name": "shortest_path",      "description": "Find the shortest path between two entities (how is A connected to B / does X depend on Y)", "args": { "from": "string", "to": "string" } },
            { "name": "get_dossier",        "description": "Read the authoritative entity dossier (HOT memory: summary, key facts with confidence, origin files, timeline). Highest-trust source for 'who/what is X' and 'where does X come from' — state it directly, do not hedge", "args": { "name": "string" } },
            { "name": "search_chunks",      "description": "Retrieve source text passages for a question (RAG retrieval)", "args": { "query": "string", "compilationId": "string?" } },
            { "name": "list_wiki_pages",    "description": "List the distilled pages of a WIKI compilation (clearance-filtered — you only see pages you're cleared for)", "args": { "compilationId": "string" } },
            { "name": "get_wiki_page",      "description": "Read one distilled wiki page (markdown body + citations) by slug from a WIKI compilation", "args": { "compilationId": "string", "slug": "string" } },
            { "name": "detect_communities", "description": "Run community detection + centrality on a graph (writes community/god-node tags onto nodes); returns the cluster summary + top 'god nodes'", "args": { "compilationId": "string" } },
            { "name": "pin_dossier",        "description": "Pin (or unpin) an entity's dossier so it stays in HOT memory and is always injected. Owner-level memory curation", "args": { "name": "string", "pinned": "boolean?" } },
            { "name": "memory_feedback",    "description": "Reinforce or distrust a fact: vote 'up' raises the entity dossier's trust, 'down' sets it to 0 (and, with a fact triple, deletes that wrong edge + remembers the correction). Owner-level", "args": { "entity": "string", "vote": "string", "compilationId": "string?", "head": "string?", "relType": "string?", "tail": "string?" } },
            { "name": "memory_health",      "description": "Read the memory snapshot: coverage, store sizes, heat/trust distribution, last maintenance cycle. Owner-level", "args": {} },
            { "name": "run_maintenance",    "description": "Run one memory governance cycle now (decay → dedup → promote hot → evict stale). Owner-level", "args": {} },
            { "name": "get_user_profile",   "description": "Read the owner's personalization profile (opt-in facts + summary) so answers can be tailored. Owner-level", "args": {} },
            { "name": "list_extractions",   "description": "List KEX extraction jobs", "args": {} },
            { "name": "list_conflicts",     "description": "List open classification conflicts", "args": {} },
            { "name": "list_sources",       "description": "List connected data sources", "args": {} },
            { "name": "list_ontologies",    "description": "List ontologies", "args": {} },
            { "name": "check_balance",      "description": "Check token balance", "args": {} },
            { "name": "create_extraction",  "description": "Ingest text into the knowledge graph", "args": { "text": "string", "classificationLevelId": "string?" } },
            { "name": "fuse_graphs",        "description": "Merge graphs by their source job ids", "args": { "name": "string", "sourceJobIds": "string[]" } },
            { "name": "create_compilation", "description": "Create a new empty knowledge graph", "args": { "name": "string", "description": "string?" } },
            { "name": "delete_compilation", "description": "Delete a compilation the caller owns", "args": { "compilationId": "string" } },
            { "name": "refresh_compilation","description": "Re-run fusion to refresh a compilation", "args": { "compilationId": "string" } },
            { "name": "add_relationship",   "description": "Add an edge between two existing entities", "args": { "compilationId": "string", "head": "string", "relType": "string", "tail": "string" } },
            { "name": "correct_relationship","description": "Delete a wrong edge and remember the correction", "args": { "compilationId": "string", "head": "string", "relType": "string", "tail": "string", "reason": "string?" } },
            { "name": "delete_node",        "description": "Remove an entity and its edges (remembered)", "args": { "compilationId": "string", "name": "string", "reason": "string?" } },
            { "name": "delete_chunk",       "description": "Delete a source text chunk from Postgres + Qdrant", "args": { "chunkId": "string" } }
        ]
    })
}

// ── Tool execution ────────────────────────────────────────────────────────────

pub(crate) async fn execute_tool(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    tool_name: &str,
    args: &Value,
) -> Value {
    match tool_name {
        // ── Read: list graphs the caller may see ──────────────────────────────
        "list_graphs" => {
            let rank = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
            let rows = sqlx::query_as::<_, (uuid::Uuid, String, Option<String>, Option<String>)>(
                "SELECT c.id, c.name, c.description, cl.name
                 FROM compilations c
                 LEFT JOIN classification_levels cl ON c.classification_level_id = cl.id
                 WHERE c.user_id = $1 AND (c.classification_level_id IS NULL OR cl.rank <= $2)
                 ORDER BY c.created_at DESC LIMIT 50"
            )
            .bind(claims.sub).bind(rank)
            .fetch_all(&state.db).await.unwrap_or_default();

            // KB-scoped token: only its assigned knowledge base(s) are visible.
            let scope = crate::routes::kg::api_key_scope(&state.db, claims).await;
            json!({
                "graphs": rows.iter()
                    .filter(|(id, ..)| scope.as_ref().map_or(true, |s| s.contains(id)))
                    .map(|(id, name, desc, cls)| json!({
                        "id": id, "name": name, "description": desc, "classification": cls
                    })).collect::<Vec<_>>()
            })
        }

        // ── Read: search entities by name (clearance-filtered) ────────────────
        "search_entities" => {
            let query = args["query"].as_str().unwrap_or("").to_string();
            let limit = args["limit"].as_i64().unwrap_or(10).clamp(1, 50);
            if query.trim().is_empty() {
                return json!({ "error": "query is required" });
            }
            let rank = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
            let uid = claims.sub.to_string();
            let cypher = "MATCH (n) \
                WHERE (n.name CONTAINS $q OR n.label CONTAINS $q) \
                  AND (n._owner = $uid OR n.user_id = $uid) \
                  AND coalesce(n._min_rank,0) <= $rank \
                RETURN n.name AS name, n.label AS label, n._classification AS cls LIMIT $limit";
            let mut out: Vec<Value> = Vec::new();
            if let Ok(mut stream) = state.neo.execute(
                neo4rs::query(cypher).param("q", query).param("uid", uid).param("rank", rank as i64).param("limit", limit),
            ).await {
                while let Ok(Some(row)) = stream.next().await {
                    out.push(json!({
                        "name": row.get::<String>("name").unwrap_or_default(),
                        "type": row.get::<String>("label").unwrap_or_default(),
                        "classification": row.get::<String>("cls").unwrap_or_default(),
                    }));
                }
            }
            crate::services::audit::log_access(&state.db, claims, "agent.search_entities", "graph", "*", rank, None, true, None).await;
            json!({ "entities": out })
        }

        // ── Read: one entity + its connections + PROVENANCE (origin file) ─────
        "get_entity" => {
            let name = args["name"].as_str().unwrap_or("").to_string();
            if name.trim().is_empty() { return json!({ "error": "name is required" }); }
            let rank = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
            let uid = claims.sub.to_string();
            // Pull `_source_job` too so we can resolve the origin file/provenance —
            // this is what lets Pi answer "where does X come from / which file".
            let cypher = "MATCH (n {name: $name}) \
                WHERE (n._owner = $uid OR n.user_id = $uid) AND coalesce(n._min_rank,0) <= $rank \
                OPTIONAL MATCH (n)-[r]->(m) WHERE coalesce(m._min_rank,0) <= $rank \
                RETURN n.name AS name, n.label AS label, n._classification AS cls, \
                       n._source_job AS sourceJob, \
                       collect(DISTINCT type(r) + ' → ' + coalesce(m.name,''))[..20] AS rels LIMIT 1";
            let mut result = json!({ "error": "not found or insufficient clearance" });
            if let Ok(mut stream) = state.neo.execute(
                neo4rs::query(cypher).param("name", name.clone()).param("uid", uid).param("rank", rank as i64),
            ).await {
                if let Ok(Some(row)) = stream.next().await {
                    // Resolve the origin file/provenance from the source job (Postgres).
                    let provenance: Value = match row.get::<String>("sourceJob").ok()
                        .and_then(|s| uuid::Uuid::parse_str(&s).ok())
                    {
                        Some(job_id) => {
                            let r: Option<(String, Option<String>, Option<String>, chrono::DateTime<chrono::Utc>)> =
                                sqlx::query_as(
                                    "SELECT type, input->>'fileName', input->>'sourceRef', created_at \
                                     FROM jobs WHERE id=$1 AND user_id=$2"
                                ).bind(job_id).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();
                            match r {
                                Some((jtype, file_name, source_ref, created)) => json!({
                                    "jobId": job_id,
                                    "jobType": jtype,
                                    "originFile": file_name,
                                    "sourceRef": source_ref,
                                    "extractedAt": created,
                                }),
                                None => Value::Null,
                            }
                        }
                        None => Value::Null,
                    };
                    result = json!({
                        "name": row.get::<String>("name").unwrap_or_default(),
                        "type": row.get::<String>("label").unwrap_or_default(),
                        "classification": row.get::<String>("cls").unwrap_or_default(),
                        "connections": row.get::<Vec<String>>("rels").unwrap_or_default(),
                        "provenance": provenance,
                    });
                }
            }
            crate::services::audit::log_access(&state.db, claims, "agent.get_entity", "entity", &name, rank, None, true, None).await;
            result
        }

        // ── Read: the AUTHORITATIVE entity dossier (HOT memory tier, A2) ──────
        "get_dossier" => {
            let name = args["name"].as_str().unwrap_or("").to_string();
            if name.trim().is_empty() { return json!({ "error": "name is required" }); }
            // Try the stored dossier; build on-the-fly via FUSE when missing.
            let mut row = crate::routes::kg::fetch_dossier_row(&state.db, claims.sub, &name).await;
            if row.is_none() {
                if let Ok(Some(())) = crate::routes::kg::build_dossier_via_fuse(state, claims.sub, &name).await {
                    row = crate::routes::kg::fetch_dossier_row(&state.db, claims.sub, &name).await;
                }
            }
            let result = match row {
                Some(d) => {
                    crate::routes::kg::bump_dossier_heat(&state.db, d.id).await;
                    json!({
                        "entityName":  d.entity_name,
                        "summary":     d.summary,
                        "keyFacts":    d.key_facts,
                        "originFiles": d.origin_files,
                        "timeline":    d.timeline,
                        "trust":       d.trust,
                        "pinned":      d.pinned,
                        "authoritative": true,
                    })
                }
                None => json!({ "error": "no dossier and no owned entity with that name" }),
            };
            crate::services::audit::log_access(&state.db, claims, "agent.get_dossier", "dossier", &name, 0, None, true, None).await;
            result
        }

        // ── Read: semantic retrieval of source text (RAG) ─────────────────────
        "search_chunks" => {
            let query = args["query"].as_str().unwrap_or("").to_string();
            if query.trim().is_empty() { return json!({ "error": "query is required" }); }
            let compilation_id = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            let rank: i64 = match compilation_id {
                Some(cid) => crate::routes::kg::effective_rank_for_compilation(&state.db, claims, cid).await as i64,
                None => crate::routes::kg::get_user_clearance_rank(&state.db, claims).await as i64,
            };
            let client = reqwest::Client::new();
            // Scope to the caller's own chunks (grounding + no cross-user leak).
            let body = json!({ "query": query, "limit": 5, "compilation_id": compilation_id, "user_id": claims.sub, "max_rank": rank });
            let chunks = match client.post(format!("{}/search", state.cfg.kex_worker_url))
                .json(&body).timeout(Duration::from_secs(10)).send().await
            {
                Ok(r) => r.json::<Value>().await.unwrap_or_else(|_| json!({ "chunks": [] })),
                Err(_) => json!({ "chunks": [] }),
            };
            crate::services::audit::log_access(&state.db, claims, "agent.search_chunks", "chunks", "*", rank as i32, None, true, None).await;
            chunks
        }

        // ── Read: open classification conflicts ───────────────────────────────
        "list_conflicts" => {
            let rows = sqlx::query_as::<_, (uuid::Uuid, Option<uuid::Uuid>, String, String)>(
                "SELECT cc.id, cc.compilation_id, cc.element_kind, cc.element_key
                 FROM classification_conflicts cc JOIN compilations c ON c.id = cc.compilation_id
                 WHERE c.user_id = $1 AND cc.status = 'open' ORDER BY cc.created_at DESC LIMIT 50"
            ).bind(claims.sub).fetch_all(&state.db).await.unwrap_or_default();
            json!({
                "conflicts": rows.iter().map(|(id, cid, kind, key)| json!({
                    "id": id, "compilationId": cid, "elementKind": kind, "elementKey": key
                })).collect::<Vec<_>>()
            })
        }

        // ── Action: ingest text ───────────────────────────────────────────────
        "create_extraction" => {
            let text = args["text"].as_str().unwrap_or("");
            if text.trim().len() < 10 { return json!({ "error": "text too short (min 10 chars)" }); }
            let clf = args["classificationLevelId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            // A token may not ingest content classified ABOVE its own clearance
            // ceiling — a colleague with INTERNAL clearance can't write CONFIDENTIAL.
            if let (Some(key_rank), Some(c)) = (claims.api_key_rank, clf) {
                let lvl_rank: Option<i32> = sqlx::query_scalar(
                    "SELECT rank FROM classification_levels WHERE id = $1"
                ).bind(c).fetch_optional(&state.db).await.ok().flatten();
                if lvl_rank.map_or(false, |r| r > key_rank) {
                    return json!({ "error": "classification exceeds this access token's clearance" });
                }
            }
            let job_id = uuid::Uuid::new_v4();
            let _ = sqlx::query("UPDATE users SET tokens_balance = GREATEST(0, tokens_balance - 5) WHERE id = $1")
                .bind(claims.sub).execute(&state.db).await;
            let _ = sqlx::query(
                "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id)
                 VALUES ($1, $2, 'kex_extract', 'pending', $3, $4)"
            ).bind(job_id).bind(claims.sub).bind(json!({ "source": "agent" })).bind(clf).execute(&state.db).await;
            crate::services::usage::record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;
            let clf_name: Option<String> = if let Some(c) = clf {
                sqlx::query_scalar("SELECT name FROM classification_levels WHERE id = $1").bind(c).fetch_optional(&state.db).await.ok().flatten()
            } else { None };
            let mut payload = json!({
                "job_id": job_id, "user_id": claims.sub, "type": "text",
                "input": text, "classification": clf_name, "classification_level_id": clf
            });
            crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;
            let _ = crate::services::redis::lpush(&state.redis, "kex:jobs", &payload.to_string()).await;
            json!({ "jobId": job_id, "status": "pending" })
        }

        // ── Action: merge graphs ──────────────────────────────────────────────
        "fuse_graphs" => {
            // Merging/creating a new graph is an owner (CEO) action. A KB-scoped
            // colleague token writes into its assigned KB but does not fuse new ones.
            if crate::routes::kg::api_key_scope(&state.db, claims).await.is_some() {
                return json!({ "error": "this access token is scoped to specific knowledge bases and cannot fuse new ones" });
            }
            let name = args["name"].as_str().unwrap_or("Merged Graph").to_string();
            let mut source_job_ids: Vec<uuid::Uuid> = args["sourceJobIds"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).filter_map(|s| s.parse().ok()).collect())
                .unwrap_or_default();
            source_job_ids.sort();
            source_job_ids.dedup();
            if source_job_ids.is_empty() { return json!({ "error": "sourceJobIds is required" }); }

            // IDOR guard: every source job must belong to the caller — never merge
            // another user's graph data into a compilation this token controls.
            let owned: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM jobs WHERE id = ANY($1) AND user_id = $2"
            ).bind(&source_job_ids).bind(claims.sub).fetch_one(&state.db).await.unwrap_or(0);
            if (owned as usize) != source_job_ids.len() {
                return json!({ "error": "one or more sourceJobIds are not yours" });
            }

            // Most-permissive source level (mirrors routes::fuse).
            let src_level = sqlx::query_as::<_, (uuid::Uuid, i32)>(
                "SELECT cl.id, cl.rank FROM jobs j JOIN classification_levels cl ON cl.id = j.classification_level_id
                 WHERE j.id = ANY($1) AND j.user_id = $2 ORDER BY cl.rank ASC LIMIT 1"
            ).bind(&source_job_ids).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();
            let (level_id, legacy): (Option<uuid::Uuid>, &str) = match src_level {
                Some((id, r)) if r <= 0   => (Some(id), "PUBLIC"),
                Some((id, r)) if r <= 100 => (Some(id), "INTERNAL"),
                Some((id, r)) if r <= 200 => (Some(id), "CONFIDENTIAL"),
                Some((id, _))             => (Some(id), "RESTRICTED"),
                None                      => (None, "PUBLIC"),
            };
            let comp_id = uuid::Uuid::new_v4();
            let _ = sqlx::query("UPDATE users SET tokens_balance = GREATEST(0, tokens_balance - 10) WHERE id = $1")
                .bind(claims.sub).execute(&state.db).await;
            if sqlx::query(
                "INSERT INTO compilations (id, user_id, name, source_job_ids, classification, classification_level_id, version)
                 VALUES ($1, $2, $3, $4, $5, $6, 1)"
            ).bind(comp_id).bind(claims.sub).bind(&name).bind(&source_job_ids).bind(legacy).bind(level_id)
            .execute(&state.db).await.is_err() {
                return json!({ "error": "failed to create merged compilation" });
            }
            let job_id = uuid::Uuid::new_v4();
            let _ = sqlx::query("INSERT INTO jobs (id, user_id, type, status, input) VALUES ($1,$2,'fuse_merge','pending',$3)")
                .bind(job_id).bind(claims.sub)
                .bind(json!({ "compilationId": comp_id, "sourceJobIds": source_job_ids, "name": name }))
                .execute(&state.db).await;
            crate::services::usage::record_usage(&state.db, claims.sub, "fuse_merge", 10, Some(job_id)).await;
            let _ = crate::services::redis::lpush(&state.redis, "fuse:jobs", &json!({
                "job_id": job_id, "user_id": claims.sub, "compilation_id": comp_id,
                "source_job_ids": source_job_ids, "name": name, "classification": legacy
            }).to_string()).await;
            json!({ "jobId": job_id, "compilationId": comp_id, "status": "pending" })
        }

        "check_balance" => {
            let row: Option<(i32, i32, String)> = sqlx::query_as(
                "SELECT credits_allocated, credits_used, tier FROM licenses \
                 WHERE user_id = $1 AND status='active' ORDER BY activated_at DESC LIMIT 1"
            )
            .bind(claims.sub)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);

            let unsynced: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(tokens_spent),0) FROM token_usage \
                 WHERE user_id=$1 AND synced_to_license_api=false"
            )
            .bind(claims.sub)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

            match row {
                Some((alloc, used, tier)) => json!({
                    "balance": alloc - used - unsynced as i32,
                    "tier": tier
                }),
                None => json!({ "balance": 0, "tier": "free" }),
            }
        }

        "list_sources" => {
            let rows = sqlx::query_as::<_, (uuid::Uuid, String, Option<String>, chrono::DateTime<chrono::Utc>)>(
                "SELECT id, provider, provider_email, created_at FROM oauth_connectors \
                 WHERE user_id=$1 AND is_active=true"
            )
            .bind(claims.sub)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

            json!({
                "sources": rows.iter().map(|(id, prov, email, _)| json!({
                    "id": id,
                    "provider": prov,
                    "email": email
                })).collect::<Vec<_>>()
            })
        }

        // ── Read: a compilation's entities + relationships ────────────────────
        "get_graph" => {
            let Some(cid) = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                return json!({ "error": "compilationId is required" });
            };
            let limit = args["limit"].as_i64().unwrap_or(100).clamp(1, 500);
            let rank = crate::routes::kg::effective_rank_for_compilation(&state.db, claims, cid).await;
            // Resolve the compilation's source jobs (owner-scoped).
            let row: Option<(Vec<uuid::Uuid>,)> = sqlx::query_as(
                "SELECT COALESCE(source_job_ids,'{}'::uuid[]) FROM compilations WHERE id=$1 AND user_id=$2"
            ).bind(cid).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();
            let Some((jobs,)) = row else { return json!({ "error": "graph not found" }); };
            let uid = claims.sub.to_string();
            let job_strs: Vec<String> = jobs.iter().map(|u| u.to_string()).collect();
            let scope = if jobs.is_empty() { "n._owner = $uid" } else { "n._source_job IN $jobIds" };
            let cypher = format!(
                "MATCH (n) WHERE {scope} AND coalesce(n._min_rank,0) <= $rank \
                 OPTIONAL MATCH (n)-[r]->(m) WHERE coalesce(m._min_rank,0) <= $rank AND coalesce(r._min_rank,0) <= $rank \
                 RETURN n.name AS n, type(r) AS rel, m.name AS m LIMIT $limit"
            );
            let mut entities = std::collections::BTreeSet::<String>::new();
            let mut rels: Vec<Value> = Vec::new();
            if let Ok(mut stream) = state.neo.execute(
                neo4rs::query(&cypher).param("uid", uid).param("jobIds", job_strs)
                    .param("rank", rank as i64).param("limit", limit),
            ).await {
                while let Ok(Some(row)) = stream.next().await {
                    if let Ok(n) = row.get::<String>("n") { entities.insert(n.clone());
                        if let (Ok(rel), Ok(m)) = (row.get::<String>("rel"), row.get::<String>("m")) {
                            entities.insert(m.clone());
                            rels.push(json!({ "head": n, "relType": rel, "tail": m }));
                        }
                    }
                }
            }
            crate::services::audit::log_access(&state.db, claims, "agent.get_graph", "compilation", &cid.to_string(), rank, None, true, None).await;
            json!({ "entities": entities.into_iter().collect::<Vec<_>>(), "relationships": rels })
        }

        // ── Read: KEX extraction jobs ─────────────────────────────────────────
        "list_extractions" => {
            let rows = sqlx::query_as::<_, (uuid::Uuid, String, String, chrono::DateTime<chrono::Utc>)>(
                "SELECT id, type, status, created_at FROM jobs \
                 WHERE user_id = $1 AND type LIKE 'kex_%' ORDER BY created_at DESC LIMIT 50"
            ).bind(claims.sub).fetch_all(&state.db).await.unwrap_or_default();
            json!({ "extractions": rows.iter().map(|(id, ty, st, ts)| json!({
                "jobId": id, "type": ty, "status": st, "createdAt": ts
            })).collect::<Vec<_>>() })
        }

        // ── Read: ontologies ──────────────────────────────────────────────────
        "list_ontologies" => {
            let rows = sqlx::query_as::<_, (uuid::Uuid, String, Option<String>)>(
                "SELECT id, name, description FROM ontologies \
                 WHERE user_id = $1 OR user_id IS NULL ORDER BY name LIMIT 100"
            ).bind(claims.sub).fetch_all(&state.db).await.unwrap_or_default();
            json!({ "ontologies": rows.iter().map(|(id, name, desc)| json!({
                "id": id, "name": name, "description": desc
            })).collect::<Vec<_>>() })
        }

        // ── Action: create an empty compilation ───────────────────────────────
        "create_compilation" => {
            // Creating a new knowledge base is an owner action; a KB-scoped token
            // may only write into its assigned KB(s), not spawn new ones.
            if crate::routes::kg::api_key_scope(&state.db, claims).await.is_some() {
                return json!({ "error": "this access token is scoped to specific knowledge bases and cannot create new ones" });
            }
            let name = args["name"].as_str().unwrap_or("").trim().to_string();
            if name.is_empty() { return json!({ "error": "name is required" }); }
            let desc = args["description"].as_str().map(|s| s.to_string());
            let comp_id = uuid::Uuid::new_v4();
            if sqlx::query(
                "INSERT INTO compilations (id, user_id, name, description, classification, version) \
                 VALUES ($1,$2,$3,$4,'PUBLIC',1)"
            ).bind(comp_id).bind(claims.sub).bind(&name).bind(desc.as_deref())
             .execute(&state.db).await.is_err() {
                return json!({ "error": "failed to create compilation (name may already exist)" });
            }
            crate::services::audit::log_access(&state.db, claims, "agent.create_compilation", "compilation", &comp_id.to_string(), 0, None, true, None).await;
            json!({ "compilationId": comp_id, "name": name })
        }

        // ── Action: delete a compilation (owner-scoped) ───────────────────────
        "delete_compilation" => {
            let Some(cid) = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                return json!({ "error": "compilationId is required" });
            };
            if let Err(e) = crate::routes::kg::enforce_kb_write_scope(&state.db, claims, cid).await {
                return json!({ "error": e.to_string() });
            }
            let res = sqlx::query("DELETE FROM compilations WHERE id=$1 AND user_id=$2")
                .bind(cid).bind(claims.sub).execute(&state.db).await;
            match res {
                Ok(r) if r.rows_affected() > 0 => {
                    crate::services::audit::log_access(&state.db, claims, "agent.delete_compilation", "compilation", &cid.to_string(), 0, None, true, None).await;
                    json!({ "ok": true, "deleted": cid })
                }
                _ => json!({ "error": "compilation not found or not yours" }),
            }
        }

        // ── Action: refresh (re-fuse) a compilation ───────────────────────────
        "refresh_compilation" => {
            let Some(cid) = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                return json!({ "error": "compilationId is required" });
            };
            if let Err(e) = crate::routes::kg::enforce_kb_write_scope(&state.db, claims, cid).await {
                return json!({ "error": e.to_string() });
            }
            // Owner check + source jobs.
            let row: Option<(Vec<uuid::Uuid>,)> = sqlx::query_as(
                "SELECT COALESCE(source_job_ids,'{}'::uuid[]) FROM compilations WHERE id=$1 AND user_id=$2"
            ).bind(cid).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();
            let Some((source_ids,)) = row else { return json!({ "error": "compilation not found or not yours" }); };
            let job_id = uuid::Uuid::new_v4();
            let _ = sqlx::query("INSERT INTO jobs (id,user_id,type,status,input) VALUES ($1,$2,'fuse_merge','pending',$3)")
                .bind(job_id).bind(claims.sub)
                .bind(json!({ "compilationId": cid, "sourceJobIds": source_ids }))
                .execute(&state.db).await;
            let _ = crate::services::redis::lpush(&state.redis, "fuse:jobs", &json!({
                "job_id": job_id, "compilation_id": cid, "source_job_ids": source_ids
            }).to_string()).await;
            json!({ "jobId": job_id, "status": "pending" })
        }

        // ── Action: add a relationship ────────────────────────────────────────
        "add_relationship" => {
            let cid = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            let (head, rel, tail) = (
                args["head"].as_str().unwrap_or(""),
                args["relType"].as_str().unwrap_or(""),
                args["tail"].as_str().unwrap_or(""),
            );
            let Some(cid) = cid else { return json!({ "error": "compilationId is required" }); };
            // KB-scope is enforced inside add_relationship_core → resolve_mutation_scope.
            match crate::routes::kg::add_relationship_core(state, claims, cid, head, rel, tail).await {
                Ok(created) => json!({ "ok": true, "created": created }),
                Err(e) => json!({ "error": e.to_string() }),
            }
        }

        // ── Action: correct (delete + remember) a relationship ────────────────
        "correct_relationship" | "delete_relationship" => {
            let cid = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            let (head, rel, tail) = (
                args["head"].as_str().unwrap_or(""),
                args["relType"].as_str().unwrap_or(""),
                args["tail"].as_str().unwrap_or(""),
            );
            let reason = args["reason"].as_str();
            let Some(cid) = cid else { return json!({ "error": "compilationId is required" }); };
            // KB-scope is enforced inside delete_relationship_core → resolve_mutation_scope.
            match crate::routes::kg::delete_relationship_core(state, claims, cid, head, rel, tail, reason).await {
                Ok(deleted) => json!({ "ok": true, "deleted": deleted, "remembered": true }),
                Err(e) => json!({ "error": e.to_string() }),
            }
        }

        // ── Action: delete a node (entity) ────────────────────────────────────
        "delete_node" => {
            let cid = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            let name = args["name"].as_str().unwrap_or("");
            let reason = args["reason"].as_str();
            let Some(cid) = cid else { return json!({ "error": "compilationId is required" }); };
            // KB-scope is enforced inside delete_node_core → resolve_mutation_scope.
            match crate::routes::kg::delete_node_core(state, claims, cid, name, reason).await {
                Ok(deleted) => json!({ "ok": true, "deleted": deleted, "remembered": true }),
                Err(e) => json!({ "error": e.to_string() }),
            }
        }

        // ── Action: delete a vector chunk ─────────────────────────────────────
        "delete_chunk" => {
            let Some(chunk_id) = args["chunkId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                return json!({ "error": "chunkId is required" });
            };
            match crate::routes::kex::delete_chunk_core(state, claims, chunk_id).await {
                Ok(vector_deleted) => json!({ "ok": true, "vectorDeleted": vector_deleted }),
                Err(e) => json!({ "error": e.to_string() }),
            }
        }

        // ── Read: neighbours of an entity (dependency tracing, code graphs) ───
        "get_neighbors" => {
            let name = args["name"].as_str().unwrap_or("").to_string();
            if name.trim().is_empty() { return json!({ "error": "name is required" }); }
            let depth = args["depth"].as_i64().unwrap_or(1).clamp(1, 3);
            let rank = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
            let uid = claims.sub.to_string();
            // Variable-length expansion, clearance-filtered on every hop's endpoint.
            let cypher = format!(
                "MATCH (n {{name: $name}}) \
                   WHERE (n._owner = $uid OR n.user_id = $uid) AND coalesce(n._min_rank,0) <= $rank \
                 MATCH (n)-[r*1..{depth}]-(m) \
                   WHERE (m._owner = $uid OR m.user_id = $uid) AND coalesce(m._min_rank,0) <= $rank \
                 RETURN DISTINCT m.name AS name, coalesce(m.coarse_type, m.label, m.type) AS type, \
                        length(r) AS hops \
                 ORDER BY hops ASC, name ASC LIMIT 100"
            );
            let mut out: Vec<Value> = Vec::new();
            if let Ok(mut stream) = state.neo.execute(
                neo4rs::query(&cypher).param("name", name.clone()).param("uid", uid).param("rank", rank as i64),
            ).await {
                while let Ok(Some(row)) = stream.next().await {
                    out.push(json!({
                        "name": row.get::<String>("name").unwrap_or_default(),
                        "type": row.get::<String>("type").unwrap_or_default(),
                        "hops": row.get::<i64>("hops").unwrap_or(0),
                    }));
                }
            }
            crate::services::audit::log_access(&state.db, claims, "agent.get_neighbors", "entity", &name, rank, None, true, None).await;
            json!({ "entity": name, "neighbors": out })
        }

        // ── Read: shortest path between two entities (dependency tracing) ─────
        "shortest_path" => {
            let from = args["from"].as_str().unwrap_or("").to_string();
            let to = args["to"].as_str().unwrap_or("").to_string();
            if from.trim().is_empty() || to.trim().is_empty() {
                return json!({ "error": "both 'from' and 'to' are required" });
            }
            let rank = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
            let uid = claims.sub.to_string();
            // shortestPath up to 8 hops; reject any path crossing a node above the
            // caller's clearance (no leaking a connection THROUGH classified nodes).
            let cypher = "MATCH (a {name: $from}), (b {name: $to}) \
                  WHERE (a._owner = $uid OR a.user_id = $uid) AND (b._owner = $uid OR b.user_id = $uid) \
                  MATCH p = shortestPath((a)-[*..8]-(b)) \
                  WHERE all(x IN nodes(p) WHERE coalesce(x._min_rank,0) <= $rank) \
                  RETURN [x IN nodes(p) | x.name] AS names, \
                         [r IN relationships(p) | type(r)] AS rels, length(p) AS hops LIMIT 1";
            let mut result = json!({ "found": false, "from": from, "to": to });
            if let Ok(mut stream) = state.neo.execute(
                neo4rs::query(cypher).param("from", from.clone()).param("to", to.clone()).param("uid", uid).param("rank", rank as i64),
            ).await {
                if let Ok(Some(row)) = stream.next().await {
                    result = json!({
                        "found": true, "from": from, "to": to,
                        "path": row.get::<Vec<String>>("names").unwrap_or_default(),
                        "relations": row.get::<Vec<String>>("rels").unwrap_or_default(),
                        "hops": row.get::<i64>("hops").unwrap_or(0),
                    });
                }
            }
            crate::services::audit::log_access(&state.db, claims, "agent.shortest_path", "graph", "*", rank, None, true, None).await;
            result
        }

        // ── Read: list a WIKI compilation's distilled pages (clearance-filtered) ─
        "list_wiki_pages" => {
            let Some(cid) = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                return json!({ "error": "compilationId is required" });
            };
            match crate::routes::kg::list_wiki_pages_core(state, claims, cid).await {
                Ok(v) => v,
                Err(e) => json!({ "error": e.to_string() }),
            }
        }

        // ── Read: one distilled wiki page by slug (clearance-gated) ───────────
        "get_wiki_page" => {
            let Some(cid) = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                return json!({ "error": "compilationId is required" });
            };
            let slug = args["slug"].as_str().unwrap_or("");
            if slug.is_empty() { return json!({ "error": "slug is required" }); }
            match crate::routes::kg::get_wiki_page_core(state, claims, cid, slug).await {
                Ok(v) => v,
                Err(e) => json!({ "error": e.to_string() }),
            }
        }

        // ── Action: community detection + centrality ("god nodes") ────────────
        "detect_communities" => {
            let Some(cid) = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                return json!({ "error": "compilationId is required" });
            };
            match crate::routes::kg::communities_core(state, claims, cid).await {
                Ok(v) => v,
                Err(e) => json!({ "error": e.to_string() }),
            }
        }

        // ── Owner-level memory curation (denied to KB-scoped colleague tokens, ─
        //    since dossiers/health/profile are per-user and span all KBs) ──────
        "pin_dossier" => {
            if crate::routes::kg::api_key_scope(&state.db, claims).await.is_some() {
                return json!({ "error": "owner-level memory tool — not available to a KB-scoped access token" });
            }
            let name = args["name"].as_str().unwrap_or("").trim().to_string();
            if name.is_empty() { return json!({ "error": "name is required" }); }
            let pinned = args["pinned"].as_bool();
            match crate::routes::kg::fetch_dossier_row(&state.db, claims.sub, &name).await {
                Some(d) => {
                    let new_pinned = pinned.unwrap_or(!d.pinned);
                    let _ = sqlx::query("UPDATE entity_dossiers SET pinned=$1, updated_at=NOW() WHERE id=$2")
                        .bind(new_pinned).bind(d.id).execute(&state.db).await;
                    json!({ "ok": true, "entityName": d.entity_name, "pinned": new_pinned })
                }
                None => json!({ "error": format!("no dossier found for '{name}'") }),
            }
        }

        "memory_feedback" => {
            if crate::routes::kg::api_key_scope(&state.db, claims).await.is_some() {
                return json!({ "error": "owner-level memory tool — not available to a KB-scoped access token" });
            }
            let entity = args["entity"].as_str().unwrap_or("").trim().to_string();
            let vote = args["vote"].as_str().unwrap_or("").to_lowercase();
            if vote != "up" && vote != "down" {
                return json!({ "error": "vote must be 'up' or 'down'" });
            }
            // Optional targeted fact correction on a downvote (deletes the edge +
            // remembers it via the write-scope-enforced core).
            let mut corrected = false;
            if vote == "down" {
                let cid = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
                let (h, rel, t) = (args["head"].as_str(), args["relType"].as_str(), args["tail"].as_str());
                if let (Some(cid), Some(h), Some(rel), Some(t)) = (cid, h, rel, t) {
                    if !h.trim().is_empty() && !rel.trim().is_empty() && !t.trim().is_empty() {
                        if crate::routes::kg::delete_relationship_core(
                            state, claims, cid, h, rel, t, Some("agent memory_feedback 👎"),
                        ).await.is_ok() { corrected = true; }
                    }
                }
            }
            let mut trust_after = Value::Null;
            let mut name_out = Value::Null;
            if !entity.is_empty() {
                if let Some(d) = crate::routes::kg::fetch_dossier_row(&state.db, claims.sub, &entity).await {
                    let new_trust: f32 = if vote == "down" { 0.0 } else { (d.trust + 0.1).clamp(0.8, 1.0) };
                    let _ = sqlx::query("UPDATE entity_dossiers SET trust=$1, updated_at=NOW() WHERE id=$2")
                        .bind(new_trust).bind(d.id).execute(&state.db).await;
                    trust_after = json!(new_trust);
                    name_out = json!(d.entity_name);
                }
            }
            json!({ "ok": true, "vote": vote, "entity": name_out, "trust": trust_after, "corrected": corrected })
        }

        "memory_health" => {
            if crate::routes::kg::api_key_scope(&state.db, claims).await.is_some() {
                return json!({ "error": "owner-level memory tool — not available to a KB-scoped access token" });
            }
            crate::routes::memory::health_json(state, claims.sub).await
        }

        "run_maintenance" => {
            if crate::routes::kg::api_key_scope(&state.db, claims).await.is_some() {
                return json!({ "error": "owner-level memory tool — not available to a KB-scoped access token" });
            }
            let s = crate::background::run_memory_cycle(state, "manual").await;
            json!({ "ok": true, "summary": {
                "decayedDossiers": s.decayed_dossiers, "decayedChunks": s.decayed_chunks,
                "dedupedChunks": s.deduped_chunks, "promoted": s.promoted,
                "evictedDossiers": s.evicted_dossiers, "evictedChunks": s.evicted_chunks,
                "durationMs": s.duration_ms, "trigger": s.trigger,
            }})
        }

        "get_user_profile" => {
            if crate::routes::kg::api_key_scope(&state.db, claims).await.is_some() {
                return json!({ "error": "owner-level memory tool — not available to a KB-scoped access token" });
            }
            let row = crate::routes::profile::fetch_profile_row(&state.db, claims.sub).await;
            crate::routes::profile::profile_json(row.as_ref())
        }

        _ => json!({ "error": format!("Unknown tool: {tool_name}") }),
    }
}

// ── SSE chat endpoint ─────────────────────────────────────────────────────────

async fn chat(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<ChatReq>,
) -> Result<Sse<std::pin::Pin<Box<dyn futures::Stream<Item = std::result::Result<Event, std::convert::Infallible>> + Send>>>> {
    let message = req.message.trim().to_string();
    if message.is_empty() || message.len() > 4000 {
        return Err(AppError::BadRequest("Message must be 1-4000 chars".into()));
    }

    // Resolve the per-user LLM target (provider/model/base_url/decrypted key).
    // Honours the request's llmProvider/llmModel; falls back to the user's active
    // provider, else local Ollama. Decryption happens inside resolve_for_user.
    let target = crate::services::llm::resolve_for_user(
        &state.db,
        claims.sub,
        req.llm_provider.as_deref(),
        req.llm_model.as_deref(),
    )
    .await;

    // Build the effective system prompt: GCTRL base + the caller's enabled skills.
    let system_prompt = build_system_prompt(&state, &claims).await;

    // Per-session clearance the agent runs at. The onboard CTO agent (admin)
    // defaults to FULL access (i32::MAX) so it can operate the whole system; any
    // session may DOWNGRADE. A non-admin can never exceed their stored rank.
    // `agent_override_rank` on the claims flows through every tool's existing rank
    // gate (get_user_clearance_rank / effective_rank_for_compilation) — no per-tool
    // plumbing. It's `#[serde(skip)]`, so it can never be forged via a token.
    let stored_rank = crate::routes::kg::get_user_clearance_rank(&state.db, &claims).await;
    let is_admin = claims.role == "admin";
    let agent_rank = match req.override_clearance_rank {
        Some(r) if is_admin => r,
        Some(r) => r.min(stored_rank),   // non-admin: downgrade only
        None if is_admin => i32::MAX,    // admin default: full access
        None => stored_rank,
    };
    let mut claims_clone = claims;
    claims_clone.agent_override_rank = Some(agent_rank);

    // WORKING MEMORY: normalize the client-sent recent turns into the loop's
    // transcript shape so the agent keeps cross-turn context. Pi stays
    // server-stateless (no DB) — the UI owns the thread and replays it each turn.
    // Cap to the last 8 turns; bound each content to keep the prompt lean.
    let history_seed: Vec<Value> = req.history.clone().unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            let role = m.get("role").and_then(|r| r.as_str())?;
            let content = m.get("content").and_then(|c| c.as_str())?;
            if content.trim().is_empty() { return None; }
            let r = if role == "assistant" || role == "ai" { "assistant" } else { "user" };
            let c: String = content.chars().take(2000).collect();
            Some(json!({ "role": r, "content": c }))
        })
        .collect();
    let history_seed: Vec<Value> = {
        let start = history_seed.len().saturating_sub(8);
        history_seed[start..].to_vec()
    };

    // Clone what we need to move into the async stream
    let state_clone = state.clone();

    let event_stream = async_stream::stream! {
        use crate::services::llm::{self, ChatMessages};
        use futures::StreamExt;

        let client = reqwest::Client::new();

        // Agentic loop: the model may chain up to MAX_ITERS tool calls, each fed
        // back as context, until it produces a plain-text answer (no tool call).
        // This is what lets Pi "fully control" GCTRL — e.g. list_graphs →
        // get_graph → correct_relationship → confirm, in one conversation turn.
        const MAX_ITERS: usize = 6;
        // Seed with prior turns (working memory), then this turn's question.
        let mut convo: Vec<Value> = history_seed;
        convo.push(json!({"role": "user", "content": &message}));
        let mut iter = 0usize;

        loop {
            let turn = ChatMessages { system: &system_prompt, messages: convo.clone() };
            let mut accumulated = String::new();
            // Suppress live streaming for a turn that is a tool call: if the first
            // non-whitespace char is `{`, the model is emitting tool JSON — buffer
            // it silently (we surface a tool-call card instead of raw JSON). Prose
            // answers stream live as before.
            let mut decided = false;
            let mut suppress = false;
            {
                let stream = llm::chat_stream(&client, &target, &turn).await;
                futures::pin_mut!(stream);
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(token) => {
                            accumulated.push_str(&token);
                            if !decided {
                                let lead = accumulated.trim_start();
                                if lead.is_empty() { continue; } // still only whitespace
                                decided = true;
                                suppress = lead.starts_with('{');
                                if suppress { continue; }
                                // Prose: flush what we've accumulated so far as one token.
                                let ev = Event::default()
                                    .data(json!({"type":"token","content": accumulated.clone()}).to_string());
                                yield Ok(ev);
                                continue;
                            }
                            if !suppress {
                                let ev = Event::default()
                                    .data(json!({"type":"token","content": token}).to_string());
                                yield Ok(ev);
                            }
                        }
                        Err(e) => {
                            let ev = Event::default()
                                .data(json!({"type":"error","message": e}).to_string());
                            yield Ok(ev);
                            return;
                        }
                    }
                }
            }

            // Detect a tool call in the full accumulated response. find_tool_json
            // parses the FIRST tool-call object and tolerates trailing content
            // (a second tool call / prose), so a model that emits more than one
            // call or adds chatter still gets its tool executed.
            let trimmed = accumulated.trim().to_string();
            let tool_call: Option<Value> = find_tool_json(&trimmed);

            let Some(call) = tool_call else {
                // No tool call. If we suppressed a `{`-leading turn that turned out
                // not to be valid tool JSON, flush it now so the user isn't left blank.
                if suppress && !trimmed.is_empty() {
                    let ev = Event::default()
                        .data(json!({"type":"token","content": trimmed}).to_string());
                    yield Ok(ev);
                }
                break;  // plain answer → done
            };

            iter += 1;
            let tool_name = call["tool"].as_str().unwrap_or("").to_string();
            let args = call.get("args").cloned().unwrap_or_else(|| json!({}));

            let ev = Event::default()
                .data(json!({"type":"tool_call","name": tool_name,"args": args}).to_string());
            yield Ok(ev);

            let result = execute_tool(&state_clone, &claims_clone, &tool_name, &args).await;

            let ev = Event::default()
                .data(json!({"type":"tool_result","name": tool_name,"result": result}).to_string());
            yield Ok(ev);

            // Feed the tool call + result back into the conversation for the next turn.
            convo.push(json!({"role": "assistant", "content": trimmed}));
            convo.push(json!({"role": "user", "content": format!(
                "Tool `{}` returned: {}",
                tool_name,
                serde_json::to_string_pretty(&result).unwrap_or_default()
            )}));

            if iter >= MAX_ITERS {
                // Safety stop: ask for a final plain-text answer without more tools.
                convo.push(json!({"role": "user", "content":
                    "You have reached the tool-call limit. Now give your final answer in plain text, no tool calls."}));
                let turn = ChatMessages { system: &system_prompt, messages: convo.clone() };
                let stream = llm::chat_stream(&client, &target, &turn).await;
                futures::pin_mut!(stream);
                while let Some(item) = stream.next().await {
                    if let Ok(token) = item {
                        let ev = Event::default()
                            .data(json!({"type":"token","content": token}).to_string());
                        yield Ok(ev);
                    }
                }
                break;
            }
        }

        // ── Send done event ───────────────────────────────────────────────────
        let ev = Event::default().data(json!({"type":"done"}).to_string());
        yield Ok(ev);
    };

    Ok(Sse::new(Box::pin(event_stream) as std::pin::Pin<Box<dyn futures::Stream<Item = std::result::Result<Event, std::convert::Infallible>> + Send>>)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

// ── Tools list endpoint ───────────────────────────────────────────────────────

async fn list_tools(
    Extension(_claims): Extension<JwtClaims>,
    State(_state): State<Arc<crate::models::AppState>>,
) -> Json<Value> {
    Json(tool_schema())
}

// ── Helper: scan text for embedded {"tool": ...} JSON ────────────────────────

pub(crate) fn find_tool_json(text: &str) -> Option<Value> {
    // Walk through the string looking for a '{' that opens a tool call. We parse
    // the FIRST JSON value starting there and IGNORE any trailing content — a
    // second tool call, prose, a code fence, etc. `serde_json::from_str` requires
    // the whole remainder to be exactly one value and fails on concatenated /
    // trailing output (e.g. `{"tool":"list_graphs"}{"tool":"list_extractions"}`),
    // which small/local models routinely emit — that failure was making the agent
    // silently skip the tool and hallucinate empty results. The streaming
    // Deserializer stops cleanly at the end of the first value instead.
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'{' {
            let mut it = serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>();
            if let Some(Ok(candidate)) = it.next() {
                if candidate["tool"].is_string() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

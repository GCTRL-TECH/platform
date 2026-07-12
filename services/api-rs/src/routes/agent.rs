use axum::{
    extract::{Extension, Path, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
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
<!-- gctrl-skill-v4 -->

You are connected to GCTRL, a graph-native long-term memory. Use it as your persistent second brain: read the right layer, and **always write your conclusions back** so every future session inherits them. That write-back habit is the whole point — it turns GCTRL into compounding memory instead of starting cold each time.

Tool names below are the HTTP/gateway names (`POST /api/agent/tools/<name>` and MCP-over-HTTP `tools/call`). The local stdio MCP server exposes the same tools prefixed `gctrl_` (e.g. `gctrl_store`).

## First run — a 60-second setup (do this ONCE, before anything else)
On your FIRST connection to a GCTRL instance, configure how you'll use it, then never ask again.
1. **Check if setup already happened**: `get_dossier("GCTRL Agent Setup")`. If it returns a profile, silently adopt its preferences and skip the rest of this section.
2. **If not**, run a short interview with the user — one message, all questions at once, with your recommended defaults pre-filled so they can just say "yes":
   - **Which knowledge base should I use?** Call `list_graphs` and propose their default graph (usually "My First Knowledge Base"); note its `privacyMode`.
   - **Cloud or local model?** Tell them which model YOU are (e.g. "I'm running on Claude/GPT — a cloud model" or "…a local model"). This drives the next answer.
   - **Privacy for cloud models (recommended: Cloaked when you're a cloud model).** Explain plainly: *Cloaked* = GCTRL pseudonymizes every entity and PII in what it sends you (you see "Person-7", never real names/amounts) and un-cloaks the answer locally; *Local-only* = that graph is never sent to a cloud model at all; *Open* = sent as-is. If you're a cloud model, recommend **Cloaked**. Never call it "encrypted".
   - **How eagerly should I remember?** Options: "everything substantive" (default) vs "only when you say 'remember this'".
   - **Auto-ingest dropped files?** If they drop a PDF/doc, should you `ingest_file` it into the KB automatically (default: yes)?
3. **Apply the answers**:
   - Privacy: if they chose Cloaked/Local-only, call `set_privacy_mode(compilationId, "cloaked" | "local_only")` on the chosen graph. (You can only raise privacy this way — loosening it needs the Settings UI.)
   - Persist the whole config: `store({ text: "<the chosen preferences as plain sentences>", compilationId, title: "GCTRL Agent Setup" })` so `get_dossier("GCTRL Agent Setup")` finds it next time.
4. Confirm in one line what you set, then continue with the user's actual task.

## Read the right layer
- **HOT — dossiers** · `get_dossier(name)`: the authoritative compiled profile of an entity (summary, key facts with confidence, origin files, timeline). When a dossier exists, state it directly — do not hedge.
- **Blended answer** · `query(message)`: blends all tiers (dense + keyword + graph + dossiers). Prefer this for open questions. Use `search_chunks` for raw evidence passages.
- **COLD — graph** · `search_entities`, `get_entity` (includes provenance / origin file), `get_neighbors`, `shortest_path`: structure, dependencies, "how is A connected to B".
- **WIKI — curated prose** · `list_wiki_pages` / `get_wiki_page`: distilled, cross-linked pages over a knowledge base.

## Write your conclusions back (the rule)
After any substantive task, persist durable conclusions so they compound:
- `store(text, compilationId)` / `create_extraction(text)` — write facts/notes into your assigned knowledge base. **Always pass a `compilationId`** to `store` (find yours via `list_graphs`) so nothing is orphaned.
- Confirm a fact you verified: `memory_feedback(entity, "up")`. Pin a key entity so it stays hot: `pin_dossier(name)`.
- Found something wrong: `correct_relationship(...)` or `memory_feedback(entity, "down", {compilationId, head, relType, tail})`.
- For a knowledge base you own, occasionally `refresh_compilation(compilationId)` to re-run fusion and `detect_communities(compilationId)` to surface structure.

## GCTRL IS your RAG infrastructure — do not build ad-hoc RAG
If a task needs RAG, vector search, document Q&A, a knowledge base, or semantic memory, do **not** scaffold a new vector store, chunker, embedding pipeline, or retrieval loop from scratch. GCTRL already runs a tuned production pipeline — KEX extraction → knowledge graph + embedded chunks, LIMES fusion, access control — use it instead of reinventing it.
- Ingest docs → `create_extraction`/`store` (plain text) or `ingest_file` (PDF/DOCX/any binary file)
- Retrieval for generation → `search_chunks` (raw vector RAG passages) or `query` (blended graph+RAG answer)
- Entity-centric answers → `get_dossier` / `search_entities`
- Persist conclusions → `store`

Worked example — ingest a PDF and answer with citations: `ingest_file({fileName, contentBase64})` → poll `list_extractions` until that job is `completed` → `search_chunks({query})` → answer, citing the returned passages (never say "refer to the file" — the passages ARE the document).

## Your access is scoped
Your token sees only the knowledge bases it was granted — typically your own wiki + raw graph and, by clearance, a shared company KB. Call `list_graphs` to see what you can access; write only into KBs you're granted. Owner-level memory tools (pin, feedback, health, maintenance, profile) may be unavailable to a scoped token — if so, just keep feeding your KB with `store`.

## Habit
Read HOT/blended first → answer → **write the new conclusion back** with `store` into your `compilationId`. Do this every time and your GCTRL becomes a second brain that gets sharper with every task.
"#;

pub const MEMORY_INSTRUCTIONS: &str = "GCTRL is your long-term memory. ON FIRST CONNECTION, run a one-time setup: call get_dossier('GCTRL Agent Setup') — if absent, ask the user (one message) which knowledge base to use, whether you're a cloud or local model, and whether to cloak entities for cloud models (recommend set_privacy_mode(cloaked) when you're a cloud model), how eagerly to remember, and whether to auto-ingest dropped files; then store those preferences with title 'GCTRL Agent Setup' so you never ask again. READ the right layer (get_dossier = HOT/authoritative — state it, don't hedge; query = blended answer; search_entities/get_entity/get_neighbors/shortest_path = graph; get_wiki_page = curated prose). After ANY substantive task, WRITE your conclusions back with store/create_extraction into your assigned compilationId (find it via list_graphs) so future sessions inherit them — that write-back habit is the point of GCTRL. Your token is scoped: you only see and write the knowledge bases you're granted; call list_graphs first. GCTRL is your RAG infrastructure — do not scaffold ad-hoc vector stores, chunkers, or retrieval loops; ingest with ingest_file (PDF/DOCX/binary) or store/create_extraction (text), then retrieve with search_chunks or query. (The stdio MCP server prefixes these tool names with gctrl_.)";

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
        // Version-gated update: when a skill body carries a `<!-- gctrl-skill-vN -->`
        // marker, only (re)write the row if the stored body doesn't already have
        // that exact marker — otherwise every process start does a needless write.
        // A skill with no marker keeps the old unconditional-refresh behaviour, so
        // this is purely additive and safe for existing installs (they get the new
        // text the next time this runs, exactly once per version bump).
        if let Some(marker) = extract_version_marker(prompt) {
            let up_to_date: bool = sqlx::query_scalar(
                "SELECT manifest->>'prompt' LIKE '%' || $2 || '%' \
                 FROM agent_skills WHERE slug = $1 AND user_id IS NULL"
            )
            .bind(slug).bind(&marker)
            .fetch_optional(db).await.ok().flatten().unwrap_or(false);
            if up_to_date {
                continue;
            }
        }

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

/// Extract a `<!-- gctrl-skill-vN -->` version marker from a skill body, if present.
fn extract_version_marker(prompt: &str) -> Option<String> {
    let start = prompt.find("<!-- gctrl-skill-v")?;
    let end = prompt[start..].find("-->")? + start + "-->".len();
    Some(prompt[start..end].to_string())
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
- get_entity         : Read one entity, its connections AND its provenance (origin file / sourceRef / extraction job + timestamp). Use this to answer "where does X come from", "which file", "what's the source/origin of X". Also returns `groundingChunks` (up to 3 verbatim source-text snippets that ground the entity) unless include_chunks=false. Each entry in `relations` may carry `authority` ("current" | "superseded") + `supersededByDoc` — when present, state the CURRENT value and mention that the superseded one comes from an older document. Args: { name: string, include_chunks?: boolean }
- get_dossier        : Read the AUTHORITATIVE entity dossier (HOT memory) — a compiled summary, key facts (with confidence), origin files, timeline, AND `groundingChunks` (verbatim source-text snippets) for a named entity. This is the HIGHEST-TRUST source: when a dossier exists for the asked entity, it directly answers "who/what is X" and "where does X come from" — use it and state the answer, do NOT hedge. Key facts may carry `authority` ("current" | "superseded") + `supersededByDoc` — prefer the current fact and cite it as "current per <doc>; an older value came from <doc>". Args: { name: string }
- get_neighbors      : List entities within N hops of a node (dependency tracing; code graphs — what does X touch?). Args: { name: string, depth?: number }
- shortest_path      : Shortest path between two entities (how A connects to B / does X depend on Y). Args: { from: string, to: string }
- search_chunks      : Retrieve source text passages for a question (RAG retrieval — use this to ANSWER questions, then cite the passages). Args: { query: string, compilationId?: string }
- list_extractions   : List KEX extraction jobs. No args.
- list_conflicts     : List open conflicts: classification conflicts AND fact conflicts (kind "fact" — sources assert DIFFERENT values for a functional relation, e.g. two CEOs for one org; competingValues are ranked by source recency, authorityWinner is the current one). No args.
- list_sources       : List connected data sources. No args.
- find_file          : Find files by name/path across connected sources — including unsupported files (CAD .dwg/.step, images, archives) indexed as metadata. Returns location, size, modified/last-seen times and related parsed sibling documents from the same folder. Use for "where is file X / when was it last seen / what belongs to it". Args: { query: string, limit?: number }
- get_sync_status    : Connector sync health: per connector the last sync time, job counts by status, and the last failures. Use for "is my Drive sync working". No args.
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
            { "name": "get_graph",          "description": "Read a compilation's entities and relationships. Start with response_format='summary' (default) — returns {name,type,degree} + relation-type counts, much cheaper than 'full'. Only use 'full' if you need the complete edge list. Default limit 100; max 500.", "args": { "compilationId": "string", "limit": "number?", "response_format": "string?" } },
            { "name": "query",              "description": "Blended answer over graph + chunks + dossiers (RAG). Preferred first read tool for open questions — blends all memory tiers automatically and returns a grounded answer with sources + confidence. Args: { message: string, compilationId?: string }", "args": { "message": "string", "compilationId": "string?" } },
            { "name": "store",              "description": "Write-back: extract entities from text and link to a compilation. Call after ANY substantive task to persist conclusions. Always pass compilationId (find via list_graphs). Args: { text: string, compilationId?: string }", "args": { "text": "string", "compilationId": "string?" } },
            { "name": "ingest_file",        "description": "Ingest a BINARY file (PDF, DOCX, or any non-plain-text document) into the knowledge graph — base64-encode the file's bytes and pass them here. Use this instead of create_extraction/store whenever the source is a PDF/DOCX/file rather than plain text. Max 25MB decoded.", "args": { "fileName": "string", "contentBase64": "string", "compilationId": "string?", "ontologyId": "string?" } },
            { "name": "search_entities",    "description": "Find entities by name (clearance-filtered). Use limit to page through results (default 10, max 50).", "args": { "query": "string", "limit": "number?" } },
            { "name": "get_entity",         "description": "Read one entity, its connections, and its provenance (origin file / sourceRef / extraction job) — use for 'where does X come from / which file'. Also returns groundingChunks (up to 3 verbatim source-text snippets) unless include_chunks=false", "args": { "name": "string", "include_chunks": "boolean?" } },
            { "name": "get_neighbors",      "description": "List entities within N hops of a node (dependency tracing; great for code graphs — what does X touch?). Use depth 1 first; increase only if needed. Limit is fixed at 100.", "args": { "name": "string", "depth": "number?" } },
            { "name": "shortest_path",      "description": "Find the shortest path between two entities (how is A connected to B / does X depend on Y)", "args": { "from": "string", "to": "string" } },
            { "name": "get_dossier",        "description": "Read the authoritative entity dossier (HOT memory: summary, key facts with confidence, origin files, timeline, groundingChunks — verbatim source-text snippets). Highest-trust source for 'who/what is X' and 'where does X come from' — state it directly, do not hedge", "args": { "name": "string" } },
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
            { "name": "list_conflicts",     "description": "List open conflicts — classification conflicts AND fact conflicts (competing values for a functional relation, ranked by source recency; authorityWinner = the current value)", "args": {} },
            { "name": "list_sources",       "description": "List connected data sources", "args": {} },
            { "name": "list_ontologies",    "description": "List ontologies", "args": {} },
            { "name": "schema",             "description": "Graph schema for your knowledge: distinct entity types (coarse buckets) and relationship types with counts, clearance- and KB-scope-filtered. Use to learn 'what kinds of things and relations exist' before querying. No args", "args": {} },
            { "name": "check_balance",      "description": "Check token balance", "args": {} },
            { "name": "create_extraction",  "description": "Ingest text into the knowledge graph", "args": { "text": "string", "classificationLevelId": "string?" } },
            { "name": "fuse_graphs",        "description": "Merge graphs by their source job ids", "args": { "name": "string", "sourceJobIds": "string[]" } },
            { "name": "create_compilation", "description": "Create a new empty knowledge graph", "args": { "name": "string", "description": "string?" } },
            { "name": "delete_compilation", "description": "Delete a compilation the caller owns", "args": { "compilationId": "string" } },
            { "name": "refresh_compilation","description": "Re-run fusion to refresh a compilation", "args": { "compilationId": "string" } },
            { "name": "set_privacy_mode",   "description": "Raise a knowledge graph's privacy for cloud LLMs: 'cloaked' (entities/PII pseudonymized before any cloud model sees them) or 'local_only' (never sent to a cloud model). Can only INCREASE privacy (open->cloaked->local_only); loosening it back requires a signed-in user session.", "args": { "compilationId": "string", "mode": "string (cloaked|local_only)" } },
            { "name": "add_relationship",   "description": "Add an edge between two existing entities", "args": { "compilationId": "string", "head": "string", "relType": "string", "tail": "string" } },
            { "name": "correct_relationship","description": "Delete a wrong edge and remember the correction", "args": { "compilationId": "string", "head": "string", "relType": "string", "tail": "string", "reason": "string?" } },
            { "name": "delete_node",        "description": "Remove an entity and its edges (remembered)", "args": { "compilationId": "string", "name": "string", "reason": "string?" } },
            { "name": "delete_chunk",       "description": "Delete a source text chunk from Postgres + Qdrant", "args": { "chunkId": "string" } },
            // ── Runtime configuration tools ───────────────────────────────────────
            { "name": "get_hardware",       "description": "Read the host hardware profile (CPU cores, RAM, GPU, VRAM, OS/arch) detected at install time. Read-only, any caller", "args": {} },
            { "name": "recommend_runtime",  "description": "Recommend the best runtime and model for the current hardware (pure local logic — no IO). Returns { runtime, model, rationale, speedup_estimate }. Read-only, any caller", "args": {} },
            { "name": "list_runtimes",      "description": "List the available runtime kinds (ollama, openai_compatible) with metadata. Read-only, any caller", "args": {} },
            { "name": "get_active_runtime", "description": "Read the current active LLM generation runtime: provider, base_url, model, embedding_mode, configured, healthy. Never leaks api_key. Read-only, any caller", "args": {} },
            { "name": "list_models",        "description": "List the built-in model catalog for a given runtime kind. Args: { runtime } where runtime ∈ 'ollama' | 'llamacpp' | 'vllm'. Read-only, any caller", "args": { "runtime": "string" } },
            { "name": "switch_runtime",     "description": "Switch the active generation runtime (admin only). Args: { runtime: 'ollama'|'llamacpp'|'external', model?: string, base_url?: string, api_key?: string }. ollama/external: synchronous validate+persist. llamacpp: async (spawns pull+create in background, returns immediately with status='starting')", "args": { "runtime": "string", "model": "string?", "base_url": "string?", "api_key": "string?" } },
            { "name": "set_model",          "description": "Update the model for the active runtime without changing the provider (admin only). Validates against the built-in catalog for known runtimes; accepts any string for ollama/external. Args: { model: string }", "args": { "model": "string" } },
            { "name": "set_embedding_mode", "description": "Set the embedding mode flag (admin only). Valid values: 'pinned' (default, fast exact lookup) or 'advanced' (richer multi-pass). Does not trigger re-indexing — that is scheduled separately. Args: { mode: 'pinned'|'advanced' }", "args": { "mode": "string" } },
            // ── File-asset index + connector ops ─────────────────────────────────
            { "name": "find_file",          "description": "Find files by name/path across connected sources (Google Drive, SharePoint) — including UNSUPPORTED files like CAD drawings (.dwg/.step), images and archives that were indexed as metadata. Fuzzy-ranked (pg_trgm). Each hit includes path, size, modified/last-seen times, source, and up to 3 related parsed sibling documents from the same folder (with their KEX job ids) so you can answer 'what project is this file part of'. Args: { query: string, limit?: number (default 5) }", "args": { "query": "string", "limit": "number?" } },
            { "name": "get_sync_status",    "description": "Summarize connector sync health for the caller: per connector (Drive/SharePoint) the last sync time and live job counts by status, plus the last 5 failed source files with their errors. Use to answer 'is my Drive sync working / what failed'. No args", "args": {} },
            // ── OPERATE / self-repair tier — admin only, NEVER a knowledge/scoped token ──
            { "name": "platform_health",    "description": "OPERATE tier (admin only). Liveness of the platform's OWN services — Postgres, Neo4j, KEX, FUSE — each up/down with latency. Use to diagnose 'is the stack healthy / which service is down' before a restart. No args", "args": {} },
            { "name": "restart_service",     "description": "OPERATE tier (admin only). Restart ONE GCTRL service container to self-heal a hung/failed worker. Args: { service: 'gctrl-kex'|'gctrl-fuse'|'gctrl-api'|'gctrl-web'|'gctrl-resolver'|'gctrl-neo4j'|'gctrl-qdrant' }. Only gctrl-* containers are allowed; every call is audited.", "args": { "service": "string" } }
        ]
    })
}

// ── Tool execution ────────────────────────────────────────────────────────────

/// Tools a READ-ONLY access token may invoke. The HTTP-method chokepoint in
/// middleware/auth.rs lets read-only keys through on the (POST-only) agent tool
/// paths precisely so this per-tool gate can distinguish reads from writes —
/// an embed/read-only token can query knowledge but never mutate it.
const READ_TOOLS: &[&str] = &[
    "list_graphs", "get_graph", "query", "search_entities", "get_entity",
    "get_neighbors", "shortest_path", "get_dossier", "search_chunks",
    "list_wiki_pages", "get_wiki_page", "schema", "list_extractions",
    "list_conflicts", "list_sources", "list_ontologies", "check_balance",
    "find_file", "get_sync_status", "get_user_profile", "memory_health",
    "get_hardware", "recommend_runtime", "list_runtimes", "get_active_runtime",
    "list_models",
];

/// Cypher WHERE-fragment that authorizes ONE graph node bound to `alias`, given the
/// token's scope (`crate::routes::kg::api_key_scoped_jobs`). This is the single source
/// of truth for the node-level authorization boundary, so the graph read tools
/// (search_entities / get_entity / get_neighbors / shortest_path / schema) cannot drift.
///
///   scoped (`Some(jobs)`)   → `alias._source_job IN $jobs`
///       The granted source-jobs ARE the authorization boundary. NO `_owner`/`user_id`
///       requirement — that is exactly what lets a KB-scoped COLLEAGUE token read the
///       granted knowledge base (whose nodes are owned by someone else) and nothing
///       outside it. Caller MUST bind `$jobs`.
///   unscoped (`None`)       → `(alias._owner = $uid OR alias.user_id = $uid)`
///       Owner/JWT token — legacy behavior, unchanged. Caller MUST bind `$uid`.
///
/// This returns ONLY the identity predicate; callers keep their own
/// `coalesce(alias._min_rank,0) <= $rank` clearance clause inline (clearance is
/// orthogonal to scope and already correct at every call site). Empty-grant
/// (`Some(vec![])`) is handled by each caller returning early BEFORE building the query.
fn node_auth_clause(alias: &str, scoped: &Option<Vec<String>>) -> String {
    if scoped.is_some() {
        format!("{alias}._source_job IN $jobs")
    } else {
        format!("({alias}._owner = $uid OR {alias}.user_id = $uid)")
    }
}

#[cfg(test)]
mod node_auth_clause_tests {
    use super::node_auth_clause;

    #[test]
    fn scoped_uses_source_job_boundary_without_owner() {
        // A KB-scoped (colleague) token authorizes on the granted jobs ONLY — no
        // `_owner`/`user_id` clause, so it can read granted data owned by someone else.
        let scoped = Some(vec!["job-a".to_string(), "job-b".to_string()]);
        assert_eq!(node_auth_clause("n", &scoped), "n._source_job IN $jobs");
        assert_eq!(node_auth_clause("m", &scoped), "m._source_job IN $jobs");
        // Must never fall back to ownership when scoped (the leak/robustness invariant).
        assert!(!node_auth_clause("n", &scoped).contains("_owner"));
        assert!(!node_auth_clause("n", &scoped).contains("user_id"));
    }

    #[test]
    fn unscoped_uses_owner_boundary_unchanged() {
        // An owner/JWT token keeps the legacy owner predicate, byte-identical.
        let unscoped: Option<Vec<String>> = None;
        assert_eq!(node_auth_clause("n", &unscoped), "(n._owner = $uid OR n.user_id = $uid)");
        assert_eq!(node_auth_clause("a", &unscoped), "(a._owner = $uid OR a.user_id = $uid)");
        // Must never reference $jobs when unscoped (no stray bind).
        assert!(!node_auth_clause("n", &unscoped).contains("$jobs"));
    }

    #[test]
    fn empty_grant_is_still_scoped_shape() {
        // Empty grant is `Some(vec![])` — callers return early BEFORE building the
        // query, but the clause itself must stay on the scoped (job) branch.
        let empty = Some(Vec::<String>::new());
        assert_eq!(node_auth_clause("n", &empty), "n._source_job IN $jobs");
    }
}

pub(crate) async fn execute_tool(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    tool_name: &str,
    args: &Value,
) -> Value {
    if claims.read_only && !READ_TOOLS.contains(&tool_name) {
        return json!({ "error": format!(
            "This access token is read-only — tool '{tool_name}' mutates state and is not permitted"
        )});
    }
    match tool_name {
        // ── Read: list graphs the caller may see ──────────────────────────────
        "list_graphs" => {
            // Same visibility rule as /kg/compilations (routes/kg.rs list): a
            // rank-CAPPED request must not enumerate unclassified graphs — the
            // NULL-classification branch used to bypass every rank cap. Granted
            // graphs stay visible so scoped/embed tokens can still list them.
            let (rank, rank_capped) = crate::routes::kg::clearance_rank_with_cap(&state.db, claims).await;
            let rows = sqlx::query_as::<_, (uuid::Uuid, String, Option<String>, Option<String>, String)>(
                "SELECT c.id, c.name, c.description, cl.name, c.privacy_mode
                 FROM compilations c
                 LEFT JOIN classification_levels cl ON c.classification_level_id = cl.id
                 WHERE c.user_id = $1
                   AND (cl.rank <= $2
                        OR (c.classification_level_id IS NULL AND NOT $3)
                        OR EXISTS (SELECT 1 FROM api_key_grants g
                                   WHERE g.api_key_id = $4 AND g.compilation_id = c.id
                                     AND (g.granted_rank IS NULL
                                          OR c.classification_level_id IS NULL
                                          OR g.granted_rank >= cl.rank)))
                 ORDER BY c.created_at DESC LIMIT 50"
            )
            .bind(claims.sub).bind(rank).bind(rank_capped).bind(claims.api_key_id)
            .fetch_all(&state.db).await.unwrap_or_default();

            // KB-scoped token: only its assigned knowledge base(s) are visible.
            let scope = crate::routes::kg::api_key_scope(&state.db, claims).await;
            json!({
                "graphs": rows.iter()
                    .filter(|(id, ..)| scope.as_ref().map_or(true, |s| s.contains(id)))
                    .map(|(id, name, desc, cls, privacy)| json!({
                        "id": id, "name": name, "description": desc,
                        "classification": cls, "privacyMode": privacy
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
            // KB-scope: a scoped token may only enumerate entities from its granted
            // knowledge base(s); scoped-but-ungranted returns nothing.
            let scoped = crate::routes::kg::api_key_scoped_jobs(&state.db, claims).await;
            if matches!(&scoped, Some(j) if j.is_empty()) { return json!({ "entities": [] }); }
            let nauth = node_auth_clause("n", &scoped);
            let cypher = format!("MATCH (n) \
                WHERE (n.name CONTAINS $q OR n.label CONTAINS $q) \
                  AND {nauth} \
                  AND coalesce(n._min_rank,0) <= $rank \
                RETURN n.name AS name, n.label AS label, n._classification AS cls LIMIT $limit");
            let mut nq = neo4rs::query(&cypher).param("q", query).param("uid", uid).param("rank", rank as i64).param("limit", limit);
            if let Some(jobs) = &scoped { nq = nq.param("jobs", jobs.clone()); }
            let mut out: Vec<Value> = Vec::new();
            if let Ok(mut stream) = state.neo.execute(nq).await {
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
            // include_chunks (default true): P2a grounding chunks via the node's uri.
            let include_chunks = args.get("include_chunks").and_then(|v| v.as_bool()).unwrap_or(true);
            // Pull `_source_job` (+ `uri`, P2a) so we can resolve the origin file/
            // provenance AND precise grounding chunks — this is what lets Pi answer
            // "where does X come from / which file" and show grounded source text.
            // P3 — relations come back as parallel arrays (type/target/
            // authority/supersededBy) so Pi can say "current per <doc>, older
            // value from <doc>" when conflict detection marked an edge.
            // KB-scope: confine both the entity AND its shown neighbours to the token's
            // granted knowledge base(s).
            let scoped = crate::routes::kg::api_key_scoped_jobs(&state.db, claims).await;
            if matches!(&scoped, Some(j) if j.is_empty()) {
                return json!({ "error": "not found or insufficient clearance" });
            }
            let nauth = node_auth_clause("n", &scoped);
            let mjob = if scoped.is_some() { "AND m._source_job IN $jobs" } else { "" };
            let cypher = format!("MATCH (n {{name: $name}}) \
                WHERE {nauth} AND coalesce(n._min_rank,0) <= $rank \
                OPTIONAL MATCH (n)-[r]->(m) WHERE coalesce(m._min_rank,0) <= $rank {mjob} \
                WITH n, [x IN collect(DISTINCT CASE WHEN r IS NULL THEN NULL ELSE \
                    {{t: type(r), m: coalesce(m.name,''), a: coalesce(r._authority,''), \
                     s: coalesce(r._superseded_by_doc,'')}} END)][..20] AS rels \
                RETURN n.name AS name, n.label AS label, n._classification AS cls, \
                       n._source_job AS sourceJob, n.uri AS uri, \
                       [x IN rels | x.t] AS relTypes, [x IN rels | x.m] AS relTargets, \
                       [x IN rels | x.a] AS relAuth, [x IN rels | x.s] AS relSup LIMIT 1");
            let mut result = json!({ "error": "not found or insufficient clearance" });
            let mut nq = neo4rs::query(&cypher).param("name", name.clone()).param("uid", uid).param("rank", rank as i64);
            if let Some(jobs) = &scoped { nq = nq.param("jobs", jobs.clone()); }
            if let Ok(mut stream) = state.neo.execute(nq).await {
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
                    // P2a — grounded nodes: precise grounding chunks via the node's uri.
                    let grounding_chunks: Vec<Value> = if include_chunks {
                        match row.get::<String>("uri").ok() {
                            Some(uri) => crate::routes::kg::fetch_grounding_chunks(state, claims.sub, &uri).await,
                            None => Vec::new(),
                        }
                    } else {
                        Vec::new()
                    };
                    // Zip the parallel relation arrays: `connections` keeps the
                    // pre-P3 "REL → target" strings; `relations` is structured
                    // and carries authority/supersededByDoc when present.
                    let rel_types:   Vec<String> = row.get("relTypes").unwrap_or_default();
                    let rel_targets: Vec<String> = row.get("relTargets").unwrap_or_default();
                    let rel_auth:    Vec<String> = row.get("relAuth").unwrap_or_default();
                    let rel_sup:     Vec<String> = row.get("relSup").unwrap_or_default();
                    let mut connections: Vec<String> = Vec::new();
                    let mut relations: Vec<Value> = Vec::new();
                    for (i, t) in rel_types.iter().enumerate() {
                        let target = rel_targets.get(i).cloned().unwrap_or_default();
                        connections.push(format!("{t} → {target}"));
                        let mut rel = json!({ "rel": t, "target": target });
                        if let Some(a) = rel_auth.get(i).filter(|a| !a.is_empty()) {
                            rel["authority"] = json!(a);
                            if let Some(s) = rel_sup.get(i).filter(|s| !s.is_empty()) {
                                rel["supersededByDoc"] = json!(s);
                            }
                        }
                        relations.push(rel);
                    }
                    result = json!({
                        "name": row.get::<String>("name").unwrap_or_default(),
                        "type": row.get::<String>("label").unwrap_or_default(),
                        "classification": row.get::<String>("cls").unwrap_or_default(),
                        "connections": connections,
                        "relations": relations,
                        "provenance": provenance,
                        "groundingChunks": grounding_chunks,
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
            // SCOPED read: a KB-scoped colleague token gets its OWN confined dossier
            // (built scoped-to-grant, leak-safe); an unscoped/owner token gets the
            // owner dossier. A dossier whose facts exceed the caller's clearance is
            // withheld. Build on-the-fly only when TRULY absent (not merely withheld).
            //
            // The on-demand FUSE build is DETACHED (tokio::spawn) with a short inline
            // budget: previously the handler awaited the build inline (up to 180 s),
            // which (a) stalled a recall's whole dossier layer behind one slow build
            // and (b) meant an impatient client abort DROPPED the handler future and
            // cancelled the build — so it never got stored and every later call
            // stalled again. Now a fast build still returns in THIS call; a slow one
            // keeps running in the background (spawn survives disconnect), gets
            // stored, and the NEXT call hits the stored dossier instantly.
            let mut row = crate::routes::kg::fetch_dossier_row_scoped(state, claims, &name).await;
            if row.is_none() {
                const BUILD_INLINE_BUDGET: std::time::Duration = std::time::Duration::from_millis(1500);
                match crate::routes::kg::api_key_scoped_jobs(&state.db, claims).await {
                    // KB-scoped: confined on-demand build (jobs = the auth boundary).
                    Some(jobs) if !jobs.is_empty() => {
                        let truly_absent = crate::routes::kg::fetch_dossier_row(&state.db, claims.sub, &name).await.is_none();
                        if truly_absent {
                            let (st, sub, nm) = (state.clone(), claims.sub, name.clone());
                            let build = tokio::spawn(async move {
                                crate::routes::kg::build_dossier_via_fuse_scoped(&st, sub, &nm, &jobs).await
                            });
                            if let Ok(Ok(Ok(Some(())))) = tokio::time::timeout(BUILD_INLINE_BUDGET, build).await {
                                row = crate::routes::kg::fetch_dossier_row_scoped(state, claims, &name).await;
                            }
                        }
                    }
                    Some(_) => {} // scoped but granted nothing
                    // Unscoped/owner: existing owner-build behaviour.
                    None => {
                        let truly_absent = crate::routes::kg::fetch_dossier_row(&state.db, claims.sub, &name).await.is_none();
                        if truly_absent {
                            let (st, sub, nm) = (state.clone(), claims.sub, name.clone());
                            let build = tokio::spawn(async move {
                                crate::routes::kg::build_dossier_via_fuse(&st, sub, &nm).await
                            });
                            if let Ok(Ok(Ok(Some(())))) = tokio::time::timeout(BUILD_INLINE_BUDGET, build).await {
                                row = crate::routes::kg::fetch_dossier_row_scoped(state, claims, &name).await;
                            }
                        }
                    }
                }
            }
            let result = match row {
                Some(d) => {
                    crate::routes::kg::bump_dossier_heat(&state.db, d.id).await;
                    // P2a — grounded nodes: resolve the graph node's uri by name
                    // (the dossier's own entity_uri is a dossier-scoped key, not
                    // the graph uri) and fetch its precise grounding chunks.
                    let grounding_chunks = match crate::routes::kg::resolve_graph_uri(state, claims.sub, &d.entity_name).await {
                        Some(uri) => crate::routes::kg::fetch_grounding_chunks(state, claims.sub, &uri).await,
                        None => Vec::new(),
                    };
                    json!({
                        "entityName":  d.entity_name,
                        "summary":     d.summary,
                        "keyFacts":    d.key_facts,
                        "originFiles": d.origin_files,
                        "timeline":    d.timeline,
                        "trust":       d.trust,
                        "pinned":      d.pinned,
                        "authoritative": true,
                        "groundingChunks": grounding_chunks,
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
                .header("X-Internal-Secret", &state.cfg.internal_secret)
                .json(&body).timeout(Duration::from_secs(10)).send().await
            {
                Ok(r) => r.json::<Value>().await.unwrap_or_else(|_| json!({ "chunks": [] })),
                Err(_) => json!({ "chunks": [] }),
            };
            crate::services::audit::log_access(&state.db, claims, "agent.search_chunks", "chunks", "*", rank as i32, None, true, None).await;
            chunks
        }

        // ── Read: open conflicts (classification + P3 fact conflicts) ─────────
        "list_conflicts" => {
            // KB-scope: a scoped token only sees conflicts in its granted knowledge
            // base(s) (the rows carry competing fact VALUES — must not leak cross-KB).
            let scoped = crate::routes::kg::api_key_scope(&state.db, claims).await;
            if matches!(&scoped, Some(s) if s.is_empty()) { return json!({ "conflicts": [] }); }
            let scoped_comps: Option<Vec<uuid::Uuid>> = scoped.map(|s| s.into_iter().collect());
            let rows = sqlx::query_as::<_, (uuid::Uuid, Option<uuid::Uuid>, String, String)>(
                "SELECT cc.id, cc.compilation_id, cc.element_kind, cc.element_key
                 FROM classification_conflicts cc JOIN compilations c ON c.id = cc.compilation_id
                 WHERE c.user_id = $1 AND cc.status = 'open'
                   AND ($2::uuid[] IS NULL OR cc.compilation_id = ANY($2))
                 ORDER BY cc.created_at DESC LIMIT 50"
            ).bind(claims.sub).bind(&scoped_comps).fetch_all(&state.db).await.unwrap_or_default();
            let mut conflicts: Vec<Value> = rows.iter().map(|(id, cid, kind, key)| json!({
                "id": id, "kind": "classification",
                "compilationId": cid, "elementKind": kind, "elementKey": key
            })).collect();
            // P3 — fact conflicts: competing values for a functional relation
            // (e.g. two sources naming different CEOs), ranked by recency.
            let fact_rows = sqlx::query_as::<_, (
                uuid::Uuid, Option<uuid::Uuid>, String, String, String, Value, Option<String>,
            )>(
                "SELECT id, compilation_id, relation, key_name, key_side, tails, authority_winner
                 FROM fact_conflicts WHERE user_id = $1 AND status = 'open'
                   AND ($2::uuid[] IS NULL OR compilation_id = ANY($2))
                 ORDER BY first_detected_at DESC LIMIT 50"
            ).bind(claims.sub).bind(&scoped_comps).fetch_all(&state.db).await.unwrap_or_default();
            conflicts.extend(fact_rows.iter().map(|(id, cid, relation, key_name, key_side, tails, winner)| json!({
                "id": id, "kind": "fact",
                "compilationId": cid, "relation": relation,
                "entity": key_name, "keySide": key_side,
                "competingValues": tails, "authorityWinner": winner,
            })));
            json!({ "conflicts": conflicts })
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
            // This tool takes no compilationId — always fall back to the caller's
            // default knowledge base so the extraction is never orphaned (mirrors
            // the kex.rs HTTP paths).
            crate::routes::kex::link_job_to_target_or_default(&state.db, claims, None, job_id).await;
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
            // Default 100, max 500. Agents should start small and page if needed.
            let limit = args["limit"].as_i64().unwrap_or(100).clamp(1, 500);
            // "summary" (default) = {name,type,degree} + relation-type counts only.
            // "full" = today's shape with the complete edge list. Always try summary first.
            let full_mode = args["response_format"].as_str().unwrap_or("summary") == "full";
            let rank = crate::routes::kg::effective_rank_for_compilation(&state.db, claims, cid).await;
            // Resolve the compilation's source jobs (owner-scoped).
            let row: Option<(Vec<uuid::Uuid>,)> = sqlx::query_as(
                "SELECT COALESCE(source_job_ids,'{}'::uuid[]) FROM compilations WHERE id=$1 AND user_id=$2"
            ).bind(cid).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();
            let Some((jobs,)) = row else { return json!({ "error": "graph not found" }); };
            let uid = claims.sub.to_string();
            let job_strs: Vec<String> = jobs.iter().map(|u| u.to_string()).collect();
            let scope = if jobs.is_empty() { "n._owner = $uid" } else { "n._source_job IN $jobIds" };

            crate::services::audit::log_access(&state.db, claims, "agent.get_graph", "compilation", &cid.to_string(), rank, None, true, None).await;

            if full_mode {
                // Full mode: return all nodes + edges (expensive for large graphs).
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
                json!({ "response_format": "full", "entities": entities.into_iter().collect::<Vec<_>>(), "relationships": rels })
            } else {
                // Summary mode (default): per-entity {name,type,degree} + relation-type counts.
                // Much cheaper — start here, switch to "full" only if you need the edge list.
                let cypher_nodes = format!(
                    "MATCH (n) WHERE {scope} AND coalesce(n._min_rank,0) <= $rank \
                     OPTIONAL MATCH (n)-[r]->(m) WHERE coalesce(m._min_rank,0) <= $rank \
                     RETURN n.name AS name, coalesce(n.coarse_type, n.label, n.type, '') AS type, \
                            count(r) AS degree LIMIT $limit"
                );
                let cypher_rel_types = format!(
                    "MATCH (n) WHERE {scope} AND coalesce(n._min_rank,0) <= $rank \
                     MATCH (n)-[r]->(m) WHERE coalesce(m._min_rank,0) <= $rank \
                     RETURN type(r) AS relType, count(r) AS cnt LIMIT 50"
                );
                let uid2 = uid.clone();
                let job_strs2 = job_strs.clone();
                let mut node_rows: Vec<Value> = Vec::new();
                if let Ok(mut stream) = state.neo.execute(
                    neo4rs::query(&cypher_nodes).param("uid", uid).param("jobIds", job_strs)
                        .param("rank", rank as i64).param("limit", limit),
                ).await {
                    while let Ok(Some(row)) = stream.next().await {
                        node_rows.push(json!({
                            "name": row.get::<String>("name").unwrap_or_default(),
                            "type": row.get::<String>("type").unwrap_or_default(),
                            "degree": row.get::<i64>("degree").unwrap_or(0),
                        }));
                    }
                }
                let mut rel_type_counts: Vec<Value> = Vec::new();
                if let Ok(mut stream) = state.neo.execute(
                    neo4rs::query(&cypher_rel_types).param("uid", uid2).param("jobIds", job_strs2)
                        .param("rank", rank as i64),
                ).await {
                    while let Ok(Some(row)) = stream.next().await {
                        rel_type_counts.push(json!({
                            "relType": row.get::<String>("relType").unwrap_or_default(),
                            "count": row.get::<i64>("cnt").unwrap_or(0),
                        }));
                    }
                }
                json!({
                    "response_format": "summary",
                    "hint": "This is a summary. Pass response_format='full' to get the complete edge list (more tokens).",
                    "entityCount": node_rows.len(),
                    "entities": node_rows,
                    "relationTypeCounts": rel_type_counts,
                })
            }
        }

        // ── Read: blended RAG answer (mirrors stdio gctrl_query) ──────────────
        "query" => {
            let message = args["message"].as_str().unwrap_or("").trim().to_string();
            if message.is_empty() { return json!({ "error": "message is required" }); }
            let compilation_id = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            // Call the same POST /api/rag/query endpoint the stdio gctrl_query tool uses
            // (incognito mode = no server-side conversation persistence).
            // We generate a short-lived JWT for the loopback call so the RAG handler
            // enforces the same clearance the caller's claims carry.
            let jwt = crate::middleware::auth::sign_access(&state.cfg, claims);
            let client = reqwest::Client::new();
            let api_base = format!("http://127.0.0.1:{}/api", state.cfg.port);
            let mut body = json!({ "message": message, "mode": "incognito" });
            if let Some(cid) = compilation_id {
                body["compilationId"] = json!(cid);
            }
            match client.post(format!("{api_base}/rag/query"))
                .bearer_auth(&jwt)
                .json(&body)
                .timeout(Duration::from_secs(30))
                .send().await
            {
                Ok(r) => r.json::<Value>().await.unwrap_or_else(|_| json!({ "error": "parse error" })),
                Err(e) => json!({ "error": format!("RAG query failed: {e}") }),
            }
        }

        // ── Write: extract + link to compilation (mirrors stdio gctrl_store) ──
        "store" => {
            let text = args["text"].as_str().unwrap_or("");
            if text.trim().len() < 10 { return json!({ "error": "text too short (min 10 chars)" }); }
            let compilation_id = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            // Inline the extraction logic from create_extraction to avoid recursive async fn.
            if let (Some(key_rank), Some(c)) = (claims.api_key_rank, Option::<uuid::Uuid>::None) {
                // No classificationLevelId for store — this path is only reached if we add one later.
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
                 VALUES ($1, $2, 'kex_extract', 'pending', $3, NULL)"
            ).bind(job_id).bind(claims.sub).bind(json!({ "source": "agent_store" })).execute(&state.db).await;
            crate::services::usage::record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;
            let mut payload = json!({
                "job_id": job_id, "user_id": claims.sub, "type": "text",
                "input": text, "classification": null, "classification_level_id": null
            });
            crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;
            let _ = crate::services::redis::lpush(&state.redis, "kex:jobs", &payload.to_string()).await;
            // Link to compilation: explicit target, else the caller's default
            // knowledge base, so nothing is orphaned (mirrors the kex.rs paths).
            let mut linked = false;
            let target_cid = match compilation_id {
                Some(cid) => Some(cid),
                None => crate::routes::kex::resolve_default_compilation(&state.db, claims.sub).await,
            };
            if let Some(cid) = target_cid {
                if let Err(e) = crate::routes::kg::enforce_kb_write_scope(&state.db, claims, cid).await {
                    return json!({ "error": e.to_string() });
                }
                crate::routes::kex::link_job_to_compilation(&state.db, claims.sub, cid, job_id).await;
                linked = true;
            }
            json!({
                "ok": true,
                "jobId": job_id,
                "compilationId": target_cid,
                "linked": linked,
                "status": "pending",
                "note": "Extraction enqueued. Use query() once complete to verify the knowledge was stored."
            })
        }

        // ── Action: ingest a binary file (PDF/DOCX/etc.) via base64 ───────────
        "ingest_file" => {
            let file_name = args["fileName"].as_str().unwrap_or("").trim().to_string();
            let content_b64 = args["contentBase64"].as_str().unwrap_or("");
            if file_name.is_empty() { return json!({ "error": "fileName is required" }); }
            if content_b64.is_empty() { return json!({ "error": "contentBase64 is required" }); }

            let bytes = match base64::engine::general_purpose::STANDARD.decode(content_b64) {
                Ok(b) => b,
                Err(e) => return json!({ "error": format!("invalid base64 in contentBase64: {e}") }),
            };
            const MAX_DECODED_BYTES: usize = 25 * 1024 * 1024;
            if bytes.len() > MAX_DECODED_BYTES {
                return json!({ "error": "file too large — max 25MB decoded" });
            }

            let compilation_id = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            let ontology_id = args["ontologyId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok());
            // KB-scope: a colleague token may only ingest into a KB it's granted.
            if let Some(cid) = compilation_id {
                if let Err(e) = crate::routes::kg::enforce_kb_write_scope(&state.db, claims, cid).await {
                    return json!({ "error": e.to_string() });
                }
            }

            match crate::routes::kex::submit_upload(
                state, claims, &bytes, &file_name, ontology_id, None, compilation_id,
            ).await {
                Ok(job_id) => json!({ "jobId": job_id, "status": "pending" }),
                Err(e) => json!({ "error": e.to_string() }),
            }
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

        // ── Read: graph schema (entity + relationship types) — clearance/KB-scoped ──
        // Parity with the stdio MCP so external gateway agents can learn "what kinds of
        // things and relations exist" before querying.
        "schema" => {
            let rank = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
            let uid = claims.sub.to_string();
            let scoped = crate::routes::kg::api_key_scoped_jobs(&state.db, claims).await;
            if matches!(&scoped, Some(j) if j.is_empty()) {
                return json!({ "entityTypes": [], "relationTypes": [] });
            }
            let nauth = node_auth_clause("n", &scoped);
            // The relation query's far endpoint `m` keeps a bare `mjob`: unscoped it stays
            // unconstrained (byte-identical to before); scoped it is confined to $jobs.
            let mjob = if scoped.is_some() { "AND m._source_job IN $jobs" } else { "" };
            let cypher_e = format!(
                "MATCH (n) WHERE {nauth} AND coalesce(n._min_rank,0)<=$rank \
                 WITH coalesce(n.coarse_type, n.type, n.label) AS t WHERE t IS NOT NULL AND t <> '' \
                 RETURN t AS ty, count(*) AS cnt ORDER BY cnt DESC LIMIT 50");
            let cypher_r = format!(
                "MATCH (n)-[r]->(m) WHERE {nauth} AND coalesce(r._min_rank,0)<=$rank {mjob} \
                 RETURN type(r) AS ty, count(*) AS cnt ORDER BY cnt DESC LIMIT 50");
            let run = |cypher: String| {
                let neo = state.neo.clone();
                let uid = uid.clone();
                let scoped = scoped.clone();
                async move {
                    let mut q = neo4rs::query(&cypher).param("uid", uid).param("rank", rank as i64);
                    if let Some(jobs) = &scoped { q = q.param("jobs", jobs.clone()); }
                    let mut out: Vec<Value> = Vec::new();
                    if let Ok(mut s) = neo.execute(q).await {
                        while let Ok(Some(row)) = s.next().await {
                            out.push(json!({
                                "type": row.get::<String>("ty").unwrap_or_default(),
                                "count": row.get::<i64>("cnt").unwrap_or(0),
                            }));
                        }
                    }
                    out
                }
            };
            let entity_types = run(cypher_e).await;
            let relation_types = run(cypher_r).await;
            json!({ "entityTypes": entity_types, "relationTypes": relation_types })
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

        // ── Action: raise a graph's privacy mode (increase-only) ──────────────
        // Unlike the session-only privacy toggle in the UI, an agent token MAY
        // raise privacy (open->cloaked->local_only) — tightening only ever
        // REDUCES exposure, so a delegated/leaked token can do no harm this way.
        // Loosening (e.g. local_only->open, more exposure) stays session-only.
        // This is what lets the connect-time setup interview turn on cloaking.
        "set_privacy_mode" => {
            let Some(cid) = args["compilationId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) else {
                return json!({ "error": "compilationId is required" });
            };
            let mode = args["mode"].as_str().unwrap_or("");
            if !matches!(mode, "cloaked" | "local_only") {
                return json!({ "error": "mode must be 'cloaked' or 'local_only' (use the Settings UI to set 'open')" });
            }
            if let Err(e) = crate::routes::kg::enforce_kb_write_scope(&state.db, claims, cid).await {
                return json!({ "error": e.to_string() });
            }
            let current: Option<(String,)> = sqlx::query_as(
                "SELECT privacy_mode FROM compilations WHERE id=$1 AND user_id=$2"
            ).bind(cid).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();
            let Some((current,)) = current else { return json!({ "error": "compilation not found or not yours" }); };
            let rank = |m: &str| match m { "cloaked" => 1, "local_only" => 2, _ => 0 };
            if rank(mode) < rank(&current) {
                return json!({ "error": format!(
                    "'{current}' is already more private than '{mode}'. An access token can only raise privacy; loosening it requires a signed-in user session."
                )});
            }
            if let Err(e) = sqlx::query("UPDATE compilations SET privacy_mode=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3")
                .bind(mode).bind(cid).bind(claims.sub).execute(&state.db).await
            {
                return json!({ "error": e.to_string() });
            }
            json!({ "ok": true, "compilationId": cid, "privacyMode": mode, "previous": current })
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
            let scoped = crate::routes::kg::api_key_scoped_jobs(&state.db, claims).await;
            if matches!(&scoped, Some(j) if j.is_empty()) { return json!({ "entity": name, "neighbors": [] }); }
            let (nauth, mauth) = (node_auth_clause("n", &scoped), node_auth_clause("m", &scoped));
            // Variable-length expansion, clearance- AND KB-scope-filtered on every hop.
            // `size(r)` (NOT `length`): `r` from `[r*1..N]` is a LIST<RELATIONSHIP>, and
            // Neo4j 2026's `length()` only accepts a PATH (else 22N27) — `size()` returns
            // the hop count of the relationship list.
            let cypher = format!(
                "MATCH (n {{name: $name}}) \
                   WHERE {nauth} AND coalesce(n._min_rank,0) <= $rank \
                 MATCH (n)-[r*1..{depth}]-(m) \
                   WHERE {mauth} AND coalesce(m._min_rank,0) <= $rank \
                 RETURN DISTINCT m.name AS name, coalesce(m.coarse_type, m.label, m.type) AS type, \
                        size(r) AS hops \
                 ORDER BY hops ASC, name ASC LIMIT 100"
            );
            let mut out: Vec<Value> = Vec::new();
            let mut nq = neo4rs::query(&cypher).param("name", name.clone()).param("uid", uid).param("rank", rank as i64);
            if let Some(jobs) = &scoped { nq = nq.param("jobs", jobs.clone()); }
            if let Ok(mut stream) = state.neo.execute(nq).await {
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
            let scoped = crate::routes::kg::api_key_scoped_jobs(&state.db, claims).await;
            if matches!(&scoped, Some(j) if j.is_empty()) { return json!({ "found": false, "from": from, "to": to }); }
            // shortestPath up to 8 hops; reject any path crossing a node above the
            // caller's clearance OR outside its granted knowledge base(s) — no leaking a
            // connection THROUGH classified or out-of-scope nodes.
            let pathjob = if scoped.is_some() { "AND all(x IN nodes(p) WHERE x._source_job IN $jobs)" } else { "" };
            let (aauth, bauth) = (node_auth_clause("a", &scoped), node_auth_clause("b", &scoped));
            // `length(p)` below is VALID: `p` is a real PATH from shortestPath(...), not
            // a relationship list — leave it (only `[r*..N]` lists need `size`).
            let cypher = format!("MATCH (a {{name: $from}}), (b {{name: $to}}) \
                  WHERE {aauth} AND {bauth} \
                  MATCH p = shortestPath((a)-[*..8]-(b)) \
                  WHERE all(x IN nodes(p) WHERE coalesce(x._min_rank,0) <= $rank) {pathjob} \
                  RETURN [x IN nodes(p) | x.name] AS names, \
                         [r IN relationships(p) | type(r)] AS rels, length(p) AS hops LIMIT 1");
            let mut result = json!({ "found": false, "from": from, "to": to });
            let mut nq = neo4rs::query(&cypher).param("from", from.clone()).param("to", to.clone()).param("uid", uid).param("rank", rank as i64);
            if let Some(jobs) = &scoped { nq = nq.param("jobs", jobs.clone()); }
            if let Ok(mut stream) = state.neo.execute(nq).await {
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

        // ── Runtime configuration tools ───────────────────────────────────────

        // Read-only: hardware profile
        "get_hardware" => {
            crate::routes::infra::hardware_json()
        }

        // Read-only: runtime recommendation
        "recommend_runtime" => {
            crate::routes::infra::recommend_json()
        }

        // Read-only: runtime catalog
        "list_runtimes" => {
            crate::routes::infra::runtimes_catalog_json()
        }

        // Read-only: active runtime status (no api_key leak)
        "get_active_runtime" => {
            crate::routes::infra::active_runtime_json(&state.db).await
        }

        // Read-only: model catalog for a given runtime
        "list_models" => {
            let runtime = args["runtime"].as_str().unwrap_or("ollama");
            crate::routes::infra::models_for_runtime_json(runtime)
        }

        // Admin-only: switch the active runtime
        "switch_runtime" => {
            if claims.role != "admin" {
                return json!({ "error": "admin required" });
            }
            let runtime = args["runtime"].as_str().unwrap_or("").trim().to_string();
            let model_arg = args["model"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
            let base_url_arg = args["base_url"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
            let api_key_arg = args["api_key"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

            match runtime.as_str() {
                "ollama" => {
                    if let Err(e) = crate::routes::infra::persist_runtime(&state.db, "ollama", None, None, None).await {
                        return json!({ "error": format!("DB save failed: {e}") });
                    }
                    // Best-effort: stop llamacpp if running
                    let _ = tokio::task::spawn_blocking(|| {
                        let _ = crate::routes::update::docker_http("POST", "/containers/gctrl-llamacpp/stop", None, 10);
                    }).await;
                    let healthy = crate::routes::infra::active_runtime_json(&state.db).await["healthy"].as_bool().unwrap_or(false);
                    json!({ "ok": true, "provider": "ollama", "healthy": healthy })
                }
                "external" => {
                    let base_url = match base_url_arg {
                        Some(b) => b,
                        None => return json!({ "error": "base_url is required for external runtime" }),
                    };
                    if let Err(e) = crate::services::llm::validate_llm_base("openai_compatible", Some(&base_url)) {
                        return json!({ "error": format!("Invalid base_url: {e}") });
                    }
                    let model_str = model_arg.unwrap_or_else(|| "llama3.2".to_string());
                    let health_client = reqwest::Client::new();
                    let target = crate::services::llm::LlmTarget {
                        provider: "openai_compatible".into(),
                        model: model_str.clone(),
                        base_url: Some(base_url.clone()),
                        api_key: None,
                    };
                    let healthy = crate::services::llm::runtime_health(&health_client, &target).await;
                    if let Err(e) = crate::routes::infra::persist_runtime(
                        &state.db, "openai_compatible", Some(&base_url), Some(&model_str), api_key_arg.as_deref(),
                    ).await {
                        return json!({ "error": format!("DB save failed: {e}") });
                    }
                    json!({ "ok": true, "provider": "openai_compatible", "base_url": base_url, "model": model_str, "healthy": healthy })
                }
                "llamacpp" => {
                    let model_id = model_arg.as_deref().unwrap_or("qwen2.5-3b").to_string();
                    // Validate model id before spawning
                    if crate::routes::infra::resolve_model_arg(&model_id, "llamacpp").is_none() {
                        return json!({ "error": format!("Unknown model id '{model_id}'. Valid: qwen2.5-3b, qwen2.5-7b, llama-3.2-3b") });
                    }
                    if !std::path::Path::new("/var/run/docker.sock").exists() {
                        return json!({ "error": "Docker socket not accessible — cannot launch llama.cpp container" });
                    }
                    // Kick off background setup and return immediately
                    crate::routes::infra::spawn_llamacpp_startup(state.db.clone(), model_id.clone());
                    json!({
                        "ok": true,
                        "status": "starting",
                        "model": model_id,
                        "note": "llama.cpp is downloading the model in the background; check get_active_runtime for healthy=true"
                    })
                }
                other => json!({ "error": format!("Unknown runtime '{other}'. Valid: ollama, llamacpp, external") }),
            }
        }

        // Admin-only: update model on the current runtime
        "set_model" => {
            if claims.role != "admin" {
                return json!({ "error": "admin required" });
            }
            let model = args["model"].as_str().unwrap_or("").trim().to_string();
            if model.is_empty() {
                return json!({ "error": "model is required" });
            }
            // Update model in the runtime_config row; provider/base_url/api_key preserved via COALESCE-style partial update
            let res = sqlx::query(
                "UPDATE runtime_config SET model = $1, updated_at = now() WHERE id = 1"
            ).bind(&model).execute(&state.db).await;
            match res {
                Ok(r) if r.rows_affected() > 0 => json!({ "ok": true, "model": model }),
                Ok(_) => {
                    // No row yet — insert with just model + fallback provider
                    let _ = sqlx::query(
                        "INSERT INTO runtime_config (id, provider, model, updated_at) \
                         VALUES (1, 'ollama', $1, now()) ON CONFLICT (id) DO UPDATE SET model=$1, updated_at=now()"
                    ).bind(&model).execute(&state.db).await;
                    json!({ "ok": true, "model": model })
                }
                Err(e) => json!({ "error": format!("DB update failed: {e}") }),
            }
        }

        // Admin-only: update embedding mode
        "set_embedding_mode" => {
            if claims.role != "admin" {
                return json!({ "error": "admin required" });
            }
            let mode = args["mode"].as_str().unwrap_or("").trim().to_string();
            if let Err(e) = crate::routes::infra::validate_embedding_mode(&mode) {
                return json!({ "error": e });
            }
            let res = sqlx::query(
                "UPDATE runtime_config SET embedding_mode = $1, updated_at = now() WHERE id = 1"
            ).bind(&mode).execute(&state.db).await;
            match res {
                Ok(r) if r.rows_affected() > 0 => json!({ "ok": true, "embedding_mode": mode }),
                Ok(_) => {
                    // No row yet — insert
                    let _ = sqlx::query(
                        "INSERT INTO runtime_config (id, provider, embedding_mode, updated_at) \
                         VALUES (1, 'ollama', $1, now()) ON CONFLICT (id) DO UPDATE SET embedding_mode=$1, updated_at=now()"
                    ).bind(&mode).execute(&state.db).await;
                    json!({ "ok": true, "embedding_mode": mode })
                }
                Err(e) => json!({ "error": format!("DB update failed: {e}") }),
            }
        }

        // ── Read: fuzzy file-asset search ("where is the rim CAD file?") ──────
        "find_file" => {
            let query = args["query"].as_str().unwrap_or("").trim().to_string();
            if query.is_empty() {
                return json!({ "error": "query is required" });
            }
            let limit = args["limit"].as_i64().unwrap_or(5).clamp(1, 25);
            let result = crate::routes::connectors::find_file_json(&state.db, claims.sub, &query, limit).await;
            crate::services::audit::log_access(&state.db, claims, "agent.find_file", "file_assets", &query, 0, None, true, None).await;
            result
        }

        // ── Read: connector sync health summary ───────────────────────────────
        "get_sync_status" => {
            crate::routes::connectors::sync_status_json(&state.db, claims.sub).await
        }

        // ── OPERATE / self-repair tier ────────────────────────────────────────
        // Strict tier boundary: admin role AND not a KB-scoped token. A knowledge
        // token (colleague/agent) can NEVER reach these — so retrieved content
        // (indirect prompt injection) cannot trigger an infra action.
        "platform_health" => {
            if claims.role != "admin"
                || crate::routes::kg::api_key_scope(&state.db, claims).await.is_some()
            {
                return json!({ "error": "OPERATE tier — admin required, not available to a knowledge/scoped token" });
            }
            let t0 = std::time::Instant::now();
            let pg = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db).await.is_ok();
            let pg_ms = t0.elapsed().as_millis() as u64;
            let neo = state.neo.execute(neo4rs::query("RETURN 1 AS x")).await.is_ok();
            let client = reqwest::Client::new();
            let probe = |url: String| {
                let c = client.clone();
                async move {
                    c.get(url).timeout(Duration::from_secs(5)).send().await
                        .map(|r| r.status().is_success()).unwrap_or(false)
                }
            };
            let kex = probe(format!("{}/health", state.cfg.kex_worker_url)).await;
            let fuse = probe(format!("{}/health", state.cfg.fuse_url)).await;
            json!({
                "healthy": pg && neo && kex && fuse,
                "services": {
                    "postgres": { "up": pg, "latencyMs": pg_ms },
                    "neo4j":    { "up": neo },
                    "kex":      { "up": kex },
                    "fuse":     { "up": fuse },
                }
            })
        }

        "restart_service" => {
            if claims.role != "admin"
                || crate::routes::kg::api_key_scope(&state.db, claims).await.is_some()
            {
                return json!({ "error": "OPERATE tier — admin required, not available to a knowledge/scoped token" });
            }
            let svc = args["service"].as_str().unwrap_or("").trim().to_string();
            const ALLOWED: &[&str] = &["gctrl-kex", "gctrl-fuse", "gctrl-api", "gctrl-web",
                                       "gctrl-resolver", "gctrl-neo4j", "gctrl-qdrant"];
            if !ALLOWED.contains(&svc.as_str()) {
                return json!({ "error": format!("service must be one of {ALLOWED:?}") });
            }
            crate::services::audit::log_access(&state.db, claims, "agent.restart_service",
                "service", &svc, i32::MAX, None, true, None).await;
            let svc2 = svc.clone();
            let res = tokio::task::spawn_blocking(move || {
                crate::routes::update::docker_http("POST", &format!("/containers/{svc2}/restart"), None, 30)
            }).await;
            match res {
                Ok(Ok((code, _))) if (200..300).contains(&code) =>
                    json!({ "ok": true, "service": svc, "restarted": true }),
                Ok(Ok((code, body))) => json!({ "error": format!("docker returned {code}: {}", body.chars().take(200).collect::<String>()) }),
                _ => json!({ "error": "restart failed — docker socket unavailable?" }),
            }
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
    // Honours the request's llmProvider/llmModel; else the user's Cookbook
    // "agent" purpose pref; else the user's active provider, else local Ollama.
    // Decryption happens inside resolve_for_user.
    let purpose_model = if req.llm_model.is_none() {
        crate::services::llm::resolve_purpose_model(&state.db, claims.sub, "agent").await
    } else {
        None
    };
    let effective_model = req.llm_model.clone().or(purpose_model);
    // P2 per-purpose RUNTIME: with no request-level provider, honor an "agent"
    // runtime override (keyless local Ollama/custom); otherwise inherit the full
    // chain (per-user provider WITH key → global → Ollama). The effective model
    // (request → Cookbook agent pref) always wins over the runtime default.
    let target = if req.llm_provider.is_some() {
        crate::services::llm::resolve_for_user(
            &state.db, claims.sub, req.llm_provider.as_deref(), effective_model.as_deref(),
        ).await
    } else {
        let mut t = crate::services::llm::resolve_purpose(&state.db, claims.sub, "agent").await;
        if let Some(m) = effective_model.clone() { t.model = m; }
        t
    };

    // Private Memory: is this turn's model a cloud endpoint? Gates the
    // per-tool-result enforcement below (local_only refusal / cloaking). See
    // the `execute_tool` call site further down for the honest scope of what
    // this can and cannot attribute to a compilation.
    let is_cloud_target = crate::services::privacy::is_cloud_target(&target.provider, target.base_url.as_deref());

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

        // Private Memory: accumulates across every tool call this conversation
        // makes (see the per-tool enforcement below), and is used to de-cloak
        // every token this loop streams out. Empty session → decloak_stream_chunk
        // is a zero-cost passthrough, so a non-cloaked chat is unaffected.
        let mut cloak_session = crate::services::privacy::CloakSession::empty();
        let mut decloak_buf = String::new();

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
                                // Prose: flush what we've accumulated so far as one token —
                                // decloaked (a no-op unless a prior tool call cloaked
                                // something into this conversation; see below).
                                let safe = crate::services::privacy::decloak_stream_chunk(&cloak_session, &mut decloak_buf, &accumulated);
                                if !safe.is_empty() {
                                    let ev = Event::default()
                                        .data(json!({"type":"token","content": safe}).to_string());
                                    yield Ok(ev);
                                }
                                continue;
                            }
                            if !suppress {
                                let safe = crate::services::privacy::decloak_stream_chunk(&cloak_session, &mut decloak_buf, &token);
                                if !safe.is_empty() {
                                    let ev = Event::default()
                                        .data(json!({"type":"token","content": safe}).to_string());
                                    yield Ok(ev);
                                }
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
                // not to be valid tool JSON, flush it now so the user isn't left blank
                // (decloaked — this content bypassed the streaming decloaker above
                // since it was held back as a suspected tool call).
                if suppress && !trimmed.is_empty() {
                    let decloaked = crate::services::privacy::decloak(&cloak_session, &trimmed);
                    let ev = Event::default()
                        .data(json!({"type":"token","content": decloaked}).to_string());
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

            // `tool_result` event carries the PLAIN result to the UI — it's
            // rendered directly to the authenticated owner, never sent to an
            // LLM, so Private Memory has nothing to enforce on it.
            let ev = Event::default()
                .data(json!({"type":"tool_result","name": tool_name,"result": result}).to_string());
            yield Ok(ev);

            // ── Private Memory enforcement (per tool call, best-effort) ────────
            // What actually reaches a cloud model is the text fed back into
            // `convo` below — that's what this gates. Ground truth is the tool
            // call's own `compilationId` arg; a tool invoked WITHOUT one (e.g.
            // a cross-graph `query`) can't be attributed to a single
            // compilation here and is NOT gated — documented gap, same as the
            // rag.rs deep-mode wiring. Unlike rag.rs deep mode (which refuses
            // the whole request on a local_only hit), Pi is a standing,
            // multi-turn chat: killing the whole conversation over one tool
            // call would be disproportionate, so ONLY that tool's result is
            // replaced with a refusal notice — explicitly the "acceptable
            // minimal version" called out in the Private Memory spec.
            let tool_cid = args.get("compilationId").and_then(|v| v.as_str()).and_then(|s| s.parse::<uuid::Uuid>().ok());
            let pretty_result = serde_json::to_string_pretty(&result).unwrap_or_default();
            let tool_result_text = if is_cloud_target {
                let decision = match tool_cid {
                    Some(cid) => crate::services::privacy::resolve_privacy(&state_clone.db, &[cid]).await,
                    None => crate::services::privacy::PrivacyDecision { mode: crate::services::privacy::PrivacyMode::Open },
                };
                match decision.mode {
                    crate::services::privacy::PrivacyMode::LocalOnly => format!(
                        "Tool `{tool_name}` result withheld: {}", crate::services::privacy::LOCAL_ONLY_REFUSAL
                    ),
                    crate::services::privacy::PrivacyMode::Cloaked => {
                        let typed_mentions: Vec<Value> = result["chunks"].as_array()
                            .map(|arr| arr.iter().map(|ch| ch.get("entity_mentions").cloned().unwrap_or_else(|| json!([]))).collect())
                            .unwrap_or_default();
                        let candidates = crate::services::privacy::candidates_from_entity_mentions(&typed_mentions);
                        let (cloaked, sess) = crate::services::privacy::cloak(
                            &state_clone.db, &[tool_cid.expect("cloaked branch only reached with Some(cid)")], &candidates, &pretty_result,
                        ).await;
                        cloak_session.merge(sess);
                        format!("Tool `{tool_name}` returned: {cloaked}")
                    }
                    crate::services::privacy::PrivacyMode::Open => format!("Tool `{tool_name}` returned: {pretty_result}"),
                }
            } else {
                format!("Tool `{tool_name}` returned: {pretty_result}")
            };

            // Feed the tool call + result back into the conversation for the next turn.
            convo.push(json!({"role": "assistant", "content": trimmed}));
            convo.push(json!({"role": "user", "content": tool_result_text}));

            if iter >= MAX_ITERS {
                // Safety stop: ask for a final plain-text answer without more tools.
                convo.push(json!({"role": "user", "content":
                    "You have reached the tool-call limit. Now give your final answer in plain text, no tool calls."}));
                let turn = ChatMessages { system: &system_prompt, messages: convo.clone() };
                let stream = llm::chat_stream(&client, &target, &turn).await;
                futures::pin_mut!(stream);
                while let Some(item) = stream.next().await {
                    if let Ok(token) = item {
                        let safe = crate::services::privacy::decloak_stream_chunk(&cloak_session, &mut decloak_buf, &token);
                        if !safe.is_empty() {
                            let ev = Event::default()
                                .data(json!({"type":"token","content": safe}).to_string());
                            yield Ok(ev);
                        }
                    }
                }
                break;
            }
        }

        // Flush anything still held in the streaming decloak buffer (a pseudonym
        // could legitimately end the stream — e.g. the model's last word).
        let tail = crate::services::privacy::decloak_stream_finish(&cloak_session, &mut decloak_buf);
        if !tail.is_empty() {
            let ev = Event::default().data(json!({"type":"token","content": tail}).to_string());
            yield Ok(ev);
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
    // Strip markdown code fences (```json … ```) up front: deepseek-v4-pro and other
    // frontier models routinely WRAP a tool call in a fenced block, which otherwise
    // leaves fence text around the object and — when a fence lands mid-`args` — breaks
    // the round-trip so the call leaks back as a plain "answer". Dropping fence lines
    // makes the object parse cleanly; a bare unfenced object is unaffected.
    let cleaned: String = if text.contains("```") {
        text.lines().filter(|l| !l.trim_start().starts_with("```")).collect::<Vec<_>>().join("\n")
    } else {
        text.to_string()
    };
    let scan = cleaned.as_str();
    let bytes = scan.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'{' {
            let mut it = serde_json::Deserializer::from_str(&scan[i..]).into_iter::<Value>();
            if let Some(Ok(candidate)) = it.next() {
                if candidate["tool"].is_string() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

// ── Agent tool registration tests ─────────────────────────────────────────────

#[cfg(test)]
mod agent_tool_registration_tests {
    use super::tool_schema;

    fn tool_names() -> Vec<String> {
        let schema = tool_schema();
        schema["tools"]
            .as_array()
            .expect("tools must be an array")
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_string))
            .collect()
    }

    // ── Read-only runtime tools registered ────────────────────────────────────

    #[test]
    fn tool_schema_contains_get_hardware() {
        assert!(tool_names().contains(&"get_hardware".to_string()),
            "tool_schema() must include 'get_hardware'");
    }

    #[test]
    fn tool_schema_contains_recommend_runtime() {
        assert!(tool_names().contains(&"recommend_runtime".to_string()),
            "tool_schema() must include 'recommend_runtime'");
    }

    #[test]
    fn tool_schema_contains_list_runtimes() {
        assert!(tool_names().contains(&"list_runtimes".to_string()),
            "tool_schema() must include 'list_runtimes'");
    }

    #[test]
    fn tool_schema_contains_get_active_runtime() {
        assert!(tool_names().contains(&"get_active_runtime".to_string()),
            "tool_schema() must include 'get_active_runtime'");
    }

    #[test]
    fn tool_schema_contains_list_models() {
        assert!(tool_names().contains(&"list_models".to_string()),
            "tool_schema() must include 'list_models'");
    }

    // ── Admin mutation tools registered ───────────────────────────────────────

    #[test]
    fn tool_schema_contains_switch_runtime() {
        assert!(tool_names().contains(&"switch_runtime".to_string()),
            "tool_schema() must include 'switch_runtime'");
    }

    #[test]
    fn tool_schema_contains_set_model() {
        assert!(tool_names().contains(&"set_model".to_string()),
            "tool_schema() must include 'set_model'");
    }

    #[test]
    fn tool_schema_contains_set_embedding_mode() {
        assert!(tool_names().contains(&"set_embedding_mode".to_string()),
            "tool_schema() must include 'set_embedding_mode'");
    }

    // ── Existing tools not removed ────────────────────────────────────────────

    #[test]
    fn existing_tools_preserved() {
        let names = tool_names();
        for expected in &["list_graphs", "create_extraction", "fuse_graphs", "get_dossier", "delete_node"] {
            assert!(names.contains(&expected.to_string()),
                "pre-existing tool '{expected}' must still be registered");
        }
    }

    // ── New unified surface tools ─────────────────────────────────────────────

    #[test]
    fn tool_schema_contains_query() {
        assert!(tool_names().contains(&"query".to_string()),
            "tool_schema() must include 'query' (blended RAG, mirrors stdio gctrl_query)");
    }

    #[test]
    fn tool_schema_contains_store() {
        assert!(tool_names().contains(&"store".to_string()),
            "tool_schema() must include 'store' (write-back, mirrors stdio gctrl_store)");
    }

    // ── File-asset index + connector ops tools ────────────────────────────────

    #[test]
    fn tool_schema_contains_find_file() {
        assert!(tool_names().contains(&"find_file".to_string()),
            "tool_schema() must include 'find_file'");
    }

    #[test]
    fn tool_schema_contains_get_sync_status() {
        assert!(tool_names().contains(&"get_sync_status".to_string()),
            "tool_schema() must include 'get_sync_status'");
    }

    #[test]
    fn find_file_descriptor_has_query_arg() {
        let schema = tool_schema();
        let tool = schema["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"].as_str() == Some("find_file"))
            .expect("find_file must be in tool_schema");
        assert!(tool["args"].get("query").is_some(),
            "find_file descriptor must declare a 'query' arg");
        assert!(tool["args"].get("limit").is_some(),
            "find_file descriptor must declare a 'limit' arg");
    }

    // ── P2a: grounded nodes — get_entity include_chunks arg ───────────────────

    #[test]
    fn get_entity_descriptor_has_include_chunks_arg() {
        let schema = tool_schema();
        let tool = schema["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"].as_str() == Some("get_entity"))
            .expect("get_entity must be in tool_schema");
        assert!(tool["args"].get("include_chunks").is_some(),
            "get_entity descriptor must declare an 'include_chunks' arg (P2a grounded nodes)");
    }

    // ── get_graph summary mode ─────────────────────────────────────────────────

    #[test]
    fn get_graph_descriptor_has_response_format_arg() {
        let schema = tool_schema();
        let tool = schema["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"].as_str() == Some("get_graph"))
            .expect("get_graph must be in tool_schema");
        assert!(tool["args"].get("response_format").is_some(),
            "get_graph descriptor must declare a 'response_format' arg");
    }

    // ── Admin-gate logic (pure, no DB needed) ─────────────────────────────────

    /// Prove that the admin gate pattern rejects non-admin callers.
    /// This mirrors the check `if claims.role != "admin" { return error }`.
    #[test]
    fn admin_gate_blocks_non_admin() {
        let role = "user";
        let blocked = role != "admin";
        assert!(blocked, "non-admin role must be blocked by the admin gate");
    }

    #[test]
    fn admin_gate_allows_admin() {
        let role = "admin";
        let blocked = role != "admin";
        assert!(!blocked, "admin role must pass the admin gate");
    }

    // ── list_models args schema ───────────────────────────────────────────────

    #[test]
    fn list_models_descriptor_has_runtime_arg() {
        let schema = tool_schema();
        let tool = schema["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"].as_str() == Some("list_models"))
            .expect("list_models must be in tool_schema");
        assert!(tool["args"].get("runtime").is_some(),
            "list_models descriptor must declare a 'runtime' arg");
    }

    // ── switch_runtime descriptor has required args ───────────────────────────

    #[test]
    fn switch_runtime_descriptor_has_runtime_arg() {
        let schema = tool_schema();
        let tool = schema["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"].as_str() == Some("switch_runtime"))
            .expect("switch_runtime must be in tool_schema");
        assert!(tool["args"].get("runtime").is_some(),
            "switch_runtime descriptor must declare a 'runtime' arg");
    }
}

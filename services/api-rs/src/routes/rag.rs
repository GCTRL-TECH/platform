use axum::{extract::{Extension, Path, State}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;
use crate::{error::{AppError, Result}, middleware::auth::JwtClaims};
use neo4rs::Node;

#[derive(Deserialize)]
struct QueryReq {
    message: String,
    #[serde(rename = "compilationId")] compilation_id: Option<Uuid>,
    /// Privacy mode: "standard" | "incognito" (browser-memory-only). Distinct
    /// from `agentic`/`depth` below — this controls server-side persistence, not
    /// retrieval depth. Kept for backwards compatibility; currently unused here
    /// because RAG never persists (GDPR design).
    mode: Option<String>,
    /// Retrieval depth. `false`/absent = fast single-pass RAG (default).
    /// `true` = agentic deep mode: a bounded tool-calling loop for multi-hop
    /// reasoning. Also accepts `depth: "deep"` as an alias from the UI.
    agentic: Option<bool>,
    depth: Option<String>,
    #[serde(rename = "llmConfig")] llm_config: Option<Value>,
    #[serde(rename = "conversationId")] conversation_id: Option<Uuid>,
    /// Incognito-mode conversation history sent by the client (never persisted —
    /// GDPR). Standard mode loads history server-side from `conversation_id`. Each
    /// item is `{ role: 'human'|'ai'|'user'|'assistant', content }`.
    context: Option<Vec<Value>>,
}

impl QueryReq {
    /// True when the caller asked for the agentic deep path (via `agentic:true`
    /// or `depth:"deep"`). Defaults to false (fast single-pass).
    fn is_deep(&self) -> bool {
        self.agentic.unwrap_or(false)
            || self.depth.as_deref().map(|d| d.eq_ignore_ascii_case("deep")).unwrap_or(false)
    }
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/query",             post(query))
        .route("/feedback",          post(feedback))
        .route("/conversations",     get(list_conversations))
        .route("/conversations/:id", get(get_conversation).delete(delete_conversation))
        .route("/models",            get(list_models))
}

/// A4 — HEAT on chunks. Bump heat / access_count / last_accessed on the chunks
/// that were actually returned by retrieval and used to ground an answer. One
/// batch UPDATE by id; owner-scoped so a chunk id can't bump another user's row.
/// Best-effort — a DB hiccup never fails the query. Mirrors `bump_dossier_heat`.
pub(crate) async fn bump_chunk_heat(db: &sqlx::PgPool, user_id: Uuid, chunk_ids: &[Uuid]) {
    if chunk_ids.is_empty() { return; }
    let _ = sqlx::query(
        "UPDATE text_chunks \
            SET heat = heat + 1.0, access_count = access_count + 1, \
                last_accessed = NOW(), archived = false \
          WHERE id = ANY($1) AND user_id = $2"
    )
    .bind(chunk_ids)
    .bind(user_id)
    .execute(db)
    .await;
}

/// A4 — TRUST feedback. `POST /api/rag/feedback`.
///
/// A 👍/👎 from the chat (or an explicit fact correction) adjusts the TRUST of the
/// referenced dossier/fact, closing the memory-dynamics loop:
///   • vote=down            → set the dossier's trust to 0 (distrusted; the hot
///                            block still renders but flagged low-trust, and the
///                            decay worker will let it cool). If a concrete fact
///                            triple {head,relType,tail,compilationId} is given,
///                            ALSO delete that edge + record a knowledge_correction
///                            so it is excluded from answers AND never re-extracted.
///   • vote=up              → raise trust toward 1.0 (min(1.0, trust+0.1), floor 0.8
///                            so a confirmation never demotes a healthy dossier).
///
/// The entity is resolved from `entity` (preferred) or, failing that, the longest
/// proper-name run in `fact.head`. No-ops gracefully when nothing resolves.
#[derive(Deserialize)]
struct FeedbackReq {
    #[serde(rename = "messageId")] message_id: Option<String>,
    /// The entity whose dossier the feedback targets (e.g. "Fabio").
    entity: Option<String>,
    /// Optional concrete fact triple for a targeted correction on 👎.
    fact: Option<FeedbackFact>,
    /// "up" | "down".
    vote: String,
}

#[derive(Deserialize)]
struct FeedbackFact {
    #[serde(rename = "compilationId")] compilation_id: Option<Uuid>,
    head: Option<String>,
    #[serde(rename = "relType")] rel_type: Option<String>,
    tail: Option<String>,
}

async fn feedback(
    State(state): State<Arc<crate::models::AppState>>,
    Extension(claims): Extension<Option<JwtClaims>>,
    Json(req): Json<FeedbackReq>,
) -> Result<Json<Value>> {
    // Feedback adjusts the caller's OWN dossiers/graph — it requires auth even
    // though the rest of the /rag nest allows anonymous queries.
    let claims = claims.ok_or(AppError::Unauthorized)?;
    let vote = req.vote.trim().to_lowercase();
    if vote != "up" && vote != "down" {
        return Err(AppError::BadRequest("vote must be 'up' or 'down'".into()));
    }

    // Resolve the target entity: explicit `entity`, else the fact's head, else the
    // longest proper-name run in the head string.
    let entity = req.entity.clone()
        .or_else(|| req.fact.as_ref().and_then(|f| f.head.clone()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| req.fact.as_ref()
            .and_then(|f| f.head.as_deref())
            .and_then(first_proper_name));

    // If a concrete false fact is named, delete + remember it on a downvote. This
    // reuses the exact graph-correction core (Neo4j delete + knowledge_corrections),
    // so the corrected relation is excluded from answers and never re-extracted.
    let mut corrected = false;
    if vote == "down" {
        if let Some(f) = &req.fact {
            if let (Some(cid), Some(h), Some(rel), Some(t)) =
                (f.compilation_id, f.head.as_deref(), f.rel_type.as_deref(), f.tail.as_deref())
            {
                if !h.trim().is_empty() && !rel.trim().is_empty() && !t.trim().is_empty() {
                    match crate::routes::kg::delete_relationship_core(
                        &state, &claims, cid, h, rel, t, Some("user 👎 feedback (rag)"),
                    ).await {
                        Ok(_) => corrected = true,
                        Err(e) => tracing::warn!("feedback: fact correction failed: {e}"),
                    }
                }
            }
        }
    }

    // Adjust dossier trust for the resolved entity (if it has a dossier).
    let mut trust_after: Option<f32> = None;
    let mut entity_name_out: Option<String> = None;
    if let Some(name) = &entity {
        if let Some(d) = crate::routes::kg::fetch_dossier_row(&state.db, claims.sub, name).await {
            let new_trust: f32 = if vote == "down" {
                0.0
            } else {
                // Confirmation: raise toward 1.0, never below the healthy 0.8 floor.
                (d.trust + 0.1).clamp(0.8, 1.0)
            };
            let _ = sqlx::query(
                "UPDATE entity_dossiers SET trust = $1, updated_at = NOW() WHERE id = $2"
            ).bind(new_trust).bind(d.id).execute(&state.db).await;
            trust_after = Some(new_trust);
            entity_name_out = Some(d.entity_name.clone());
            crate::services::audit::log_access(&state.db, &claims, "rag.feedback",
                "dossier", &d.entity_name, 0, None, true, None).await;
        }
    }

    tracing::info!(
        "rag feedback: vote={vote} entity={:?} corrected={corrected} trust_after={:?} (msg {:?})",
        entity_name_out, trust_after, req.message_id
    );

    Ok(Json(json!({
        "ok": true,
        "vote": vote,
        "entity": entity_name_out,
        "trust": trust_after,
        "corrected": corrected,
    })))
}

/// Persist one Q&A turn for STANDARD mode. Incognito is NEVER written (GDPR:
/// browser-memory only). Creates a conversation on the first turn (title derived
/// from the question) and appends the user + assistant messages, bumping
/// `updated_at`. Returns the conversation id so the client keeps writing to — and
/// can later reload — the same thread. Best-effort: a DB hiccup never fails the
/// query, it just means this turn isn't persisted.
/// Best-effort extraction of the most likely PROPER NAME in a free-text query —
/// the longest run of capitalised words (e.g. "Ground Control" in "who is Ground
/// Control?"). Used by the A3 hot-block path to decide which OWNED entity to build
/// a dossier for on first ask. Falls back to the single longest capitalised token.
/// Returns None when the query carries no capitalised content word.
fn first_proper_name(query: &str) -> Option<String> {
    // Stopwords that are capitalised at sentence start but aren't entity names.
    const STOP: &[&str] = &[
        "Who", "What", "Where", "When", "Why", "How", "Is", "Are", "Was", "Were",
        "The", "A", "An", "Tell", "Give", "Show", "Does", "Do", "Did", "Can",
        "Which", "Whose", "Me", "About", "Of",
    ];
    let mut runs: Vec<String> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for tok in query.split_whitespace() {
        let clean = tok.trim_matches(|c: char| !c.is_alphanumeric());
        let is_proper = clean.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
            && !STOP.contains(&clean);
        if is_proper {
            cur.push(clean);
        } else if !cur.is_empty() {
            runs.push(cur.join(" "));
            cur.clear();
        }
    }
    if !cur.is_empty() { runs.push(cur.join(" ")); }
    runs.into_iter().max_by_key(|r| r.len()).filter(|r| !r.is_empty())
}

/// A6 — USER-PROFILE hot block. Returns a TRUST TIER 1 personalization block when
/// the caller has OPTED IN (`user_profile.enabled`) and has a non-empty distilled
/// summary. Returns `None` otherwise — and the CALLER must skip it entirely in
/// incognito mode (the GDPR split: incognito never personalizes). Mirrors the
/// dossier hot-block contract so the model treats it as authoritative.
async fn user_profile_hot_block(db: &sqlx::PgPool, user_id: Uuid) -> Option<String> {
    let (enabled, summary, facts): (bool, String, Value) = sqlx::query_as(
        "SELECT enabled, summary, facts FROM user_profile WHERE user_id = $1"
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()?;

    if !enabled {
        return None;
    }
    // Render the summary plus any structured facts. Empty profile → no block.
    let mut lines: Vec<String> = Vec::new();
    if !summary.trim().is_empty() {
        lines.push(format!("Summary: {}", summary.trim()));
    }
    if let Some(arr) = facts.as_array() {
        for f in arr {
            let cat = f.get("category").and_then(|c| c.as_str()).unwrap_or("");
            let fact = f.get("fact").and_then(|c| c.as_str()).unwrap_or("");
            if fact.is_empty() { continue; }
            if cat.is_empty() {
                lines.push(format!("- {fact}"));
            } else {
                lines.push(format!("- [{cat}] {fact}"));
            }
        }
    }
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "=== HOT BLOCK · TRUST TIER 1 · USER PROFILE (the person asking) ===\n\
         The following are durable facts and preferences about the USER who is asking. \
         Use them to PERSONALIZE the answer (tailor depth, framing, and assumptions to \
         this person) — but do NOT fabricate facts about them beyond what is listed.\n{}\n\
         === END HOT BLOCK ===",
        lines.join("\n")
    ))
}

async fn persist_turn(
    db: &sqlx::PgPool,
    user_id: Uuid,
    conversation_id: Option<Uuid>,
    question: &str,
    answer: &str,
) -> Option<Uuid> {
    let cid = match conversation_id {
        // Reuse only a conversation the caller owns; otherwise start a fresh one.
        Some(id) => {
            match sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM conversations WHERE id=$1 AND user_id=$2"
            ).bind(id).bind(user_id).fetch_optional(db).await.ok().flatten() {
                Some(owned) => owned,
                None => return None,
            }
        }
        None => {
            let title: String = question.chars().take(60).collect();
            let new_id = Uuid::new_v4();
            sqlx::query("INSERT INTO conversations (id, user_id, title) VALUES ($1,$2,$3)")
                .bind(new_id).bind(user_id).bind(&title)
                .execute(db).await.ok()?;
            new_id
        }
    };
    // Roles match the frontend ChatMessage union ('human' | 'ai').
    let _ = sqlx::query(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1,'human',$2),($1,'ai',$3)"
    ).bind(cid).bind(question).bind(answer).execute(db).await;
    let _ = sqlx::query("UPDATE conversations SET updated_at=now() WHERE id=$1")
        .bind(cid).execute(db).await;
    Some(cid)
}

/// Find a wiki page in `compilation_id` whose title or slug best matches the
/// question. M1 strategy: case-insensitive substring match (title contains the
/// message or message contains the title; same for slug), preferring the longest
/// title match so "Tell me about Foo Bar" picks "Foo Bar" over "Foo". Returns
/// (title, body_md, citations) on a hit. Keeps it simple — no embeddings.
async fn match_wiki_page(
    db: &sqlx::PgPool,
    compilation_id: Uuid,
    message: &str,
    eff_rank: i64,
) -> Option<(String, String, Value)> {
    let q = message.trim().to_lowercase();
    if q.is_empty() { return None; }
    // Build a slug-ish form of the question for slug comparison.
    let q_slug: String = q.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();

    // Clearance gate: only consider pages at or below the caller's effective
    // clearance, so a wiki-served answer never returns a classified page.
    let rows = sqlx::query_as::<_, (String, String, String, Value)>(
        "SELECT title, slug, body_md, citations FROM wiki_pages \
         WHERE compilation_id=$1 AND min_rank <= $2"
    ).bind(compilation_id).bind(eff_rank).fetch_all(db).await.ok()?;

    let mut best: Option<(usize, String, String, Value)> = None;
    for (title, slug, body_md, citations) in rows {
        let tl = title.to_lowercase();
        let title_hit = !tl.is_empty() && (q.contains(&tl) || tl.contains(&q));
        let slug_hit = !slug.is_empty() && (q_slug.contains(&slug) || slug.contains(q_slug.trim_matches('-')));
        if title_hit || slug_hit {
            // Score by matched title length so the most specific page wins.
            let score = tl.len();
            if best.as_ref().map(|(s, ..)| score > *s).unwrap_or(true) {
                best = Some((score, title, body_md, citations));
            }
        }
    }
    best.map(|(_, t, b, c)| (t, b, c))
}

// ── Working memory (conversation history) ─────────────────────────────────────
// The hot/warm/cold/wiki memory layers are all in place; the missing tier is
// WORKING memory — the running conversation. Without it every question is answered
// in isolation, so follow-ups ("and his email?") lose their referent and the user
// must re-state context. These helpers thread the recent turns into both the
// prompt (so the model resolves references) AND the retrieval query (so search
// finds the right entity for an elliptical follow-up).

/// Load the last `limit` turns of a conversation as provider-neutral chat messages
/// (`[{role:'user'|'assistant', content}]`) in chronological order. Owner-scoped via
/// the join on `conversations.user_id`. DB roles 'human'/'ai' map to user/assistant;
/// each content is capped to bound tokens. Best-effort — empty on any DB issue.
async fn load_recent_turns(
    db: &sqlx::PgPool,
    user_id: Uuid,
    conversation_id: Uuid,
    limit: i64,
) -> Vec<Value> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT m.role, m.content FROM messages m \
         JOIN conversations c ON c.id = m.conversation_id \
         WHERE m.conversation_id = $1 AND c.user_id = $2 \
         ORDER BY m.created_at DESC LIMIT $3"
    ).bind(conversation_id).bind(user_id).bind(limit)
     .fetch_all(db).await.unwrap_or_default();
    // Rows come newest-first; reverse to chronological for the prompt.
    rows.into_iter().rev().map(|(role, content)| {
        let r = if role == "ai" { "assistant" } else { "user" };
        let c: String = content.chars().take(2000).collect();
        json!({ "role": r, "content": c })
    }).collect()
}

/// Normalize a client-sent `context` array (incognito — never persisted) into the
/// same provider-neutral message shape, keeping the last `limit` turns in order.
fn history_from_context(ctx: &[Value], limit: usize) -> Vec<Value> {
    let mapped: Vec<Value> = ctx.iter().filter_map(|m| {
        let role = m.get("role").and_then(|r| r.as_str())?;
        let content = m.get("content").and_then(|c| c.as_str())?;
        if content.trim().is_empty() { return None; }
        let r = match role { "ai" | "assistant" => "assistant", _ => "user" };
        let c: String = content.chars().take(2000).collect();
        Some(json!({ "role": r, "content": c }))
    }).collect();
    let start = mapped.len().saturating_sub(limit);
    mapped[start..].to_vec()
}

/// Resolve the conversation history for grounding follow-ups:
///   • incognito → the client-sent `context` (server stays stateless — GDPR);
///   • standard  → the persisted turns loaded by `conversation_id`.
async fn resolve_history(
    db: &sqlx::PgPool,
    claims: &Option<JwtClaims>,
    req: &QueryReq,
) -> Vec<Value> {
    const MAX_TURNS: usize = 8; // 4 exchanges — enough context, bounded tokens
    if req.mode.as_deref() == Some("incognito") {
        return req.context.as_deref().map(|c| history_from_context(c, MAX_TURNS)).unwrap_or_default();
    }
    match (claims, req.conversation_id) {
        (Some(c), Some(cid)) => load_recent_turns(db, c.sub, cid, MAX_TURNS as i64).await,
        _ => Vec::new(),
    }
}

/// Rewrite a possibly-elliptical follow-up into a STANDALONE retrieval query using
/// the recent history ("and his email?" → "Fabio Chiaramonte email"). One cheap LLM
/// call; returns the original message unchanged when there is no history or on any
/// failure, so first turns pay nothing and retrieval never breaks.
async fn contextualize_query(
    client: &reqwest::Client,
    target: &crate::services::llm::LlmTarget,
    history: &[Value],
    message: &str,
) -> String {
    if history.is_empty() { return message.to_string(); }
    let convo = history.iter().filter_map(|m| {
        let r = m["role"].as_str()?;
        let c = m["content"].as_str()?;
        let who = if r == "assistant" { "Assistant" } else { "User" };
        Some(format!("{who}: {}", c.chars().take(400).collect::<String>()))
    }).collect::<Vec<_>>().join("\n");
    let sys = "You rewrite a user's latest chat message into ONE standalone search query that resolves all pronouns and references using the conversation above. Output ONLY the query text — no quotes, no preamble, no explanation. If the message is already self-contained, return it unchanged.";
    let user = format!("Conversation so far:\n{convo}\n\nLatest message: {message}\n\nStandalone search query:");
    match crate::services::llm::chat_once(client, target, sys, &user).await {
        Ok(s) => {
            let q = s.trim().trim_matches('"').trim().to_string();
            if q.is_empty() || q.chars().count() > 400 { message.to_string() } else { q }
        }
        Err(_) => message.to_string(),
    }
}

async fn query(
    State(state): State<Arc<crate::models::AppState>>,
    Extension(claims): Extension<Option<JwtClaims>>,
    Json(req): Json<QueryReq>,
) -> Result<Json<Value>> {
    // Bug 1: Auth check — unauthenticated users cannot query specific compilations
    if claims.is_none() && req.compilation_id.is_some() {
        return Err(AppError::Unauthorized);
    }

    // Bug 1 (cont): If authenticated, verify the compilation belongs to this user
    if let (Some(ref c), Some(cid)) = (&claims, req.compilation_id) {
        let found = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM compilations WHERE id=$1 AND user_id=$2"
        )
        .bind(cid)
        .bind(c.sub)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        if found == 0 {
            return Err(AppError::Forbidden("Compilation not found or access denied".into()));
        }
    }

    if req.message.trim().is_empty() || req.message.len() > 4000 {
        return Err(AppError::BadRequest("Message must be 1-4000 chars".into()));
    }

    // ── WIKI fast path ─────────────────────────────────────────────────────────
    // When the target compilation is a distilled WIKI, try to answer directly
    // from a matching wiki page instead of re-synthesizing via the hybrid RAG.
    // A match returns the page body verbatim (servedFrom: "wiki-page"); no match
    // falls through to the normal path. RAW compilations skip this entirely.
    if let (Some(c), Some(cid)) = (&claims, req.compilation_id) {
        let is_wiki: Option<String> = sqlx::query_scalar(
            "SELECT type::text FROM compilations WHERE id=$1 AND user_id=$2"
        ).bind(cid).bind(c.sub).fetch_optional(&state.db).await.ok().flatten();
        if is_wiki.as_deref() == Some("WIKI") {
            let wiki_eff = crate::routes::kg::effective_rank_for_compilation(&state.db, c, cid).await as i64;
            if let Some(page) = match_wiki_page(&state.db, cid, &req.message, wiki_eff).await {
                let (title, body_md, citations) = page;
                let res_id = cid.to_string();
                crate::services::audit::log_access(&state.db, c, "rag.query.wiki",
                    "compilation", &res_id, 0, None, true, None).await;
                let conversation_id_out: Option<Uuid> = if req.mode.as_deref() != Some("incognito") {
                    persist_turn(&state.db, c.sub, req.conversation_id, &req.message, &body_md).await
                } else { None };
                return Ok(Json(json!({
                    "answer":     body_md,
                    "sources":    citations,
                    "confidence": 0.95,
                    "cypher":     Value::Null,
                    "graphTrace": [],
                    "servedFrom": "wiki-page",
                    "title":      title,
                    "conversationId": conversation_id_out,
                })));
            }
            // No page matched → fall through to the normal hybrid path below.
        }
    }

    // Per-element clearance: the most-permissive rank this caller may retrieve.
    // Applied to BOTH the vector search (chunk pre-filter) and the graph context
    // so answers never include or cite content above the caller's clearance.
    // Unauthenticated callers are limited to PUBLIC (rank 0).
    let eff_rank: i64 = match (&claims, req.compilation_id) {
        (Some(c), Some(cid)) =>
            crate::routes::kg::effective_rank_for_compilation(&state.db, c, cid).await as i64,
        (Some(c), None) =>
            crate::routes::kg::get_user_clearance_rank(&state.db, c).await as i64,
        (None, _) => 0,
    };

    let client = reqwest::Client::new();

    // WORKING MEMORY: resolve the running conversation — persisted turns (standard)
    // or client-sent context (incognito) — so BOTH the deep and fast paths can
    // ground elliptical follow-ups instead of answering each question in isolation.
    let history = resolve_history(&state.db, &claims, &req).await;

    // ── Deep (agentic) mode ───────────────────────────────────────────────────
    // Opt-in multi-hop path: drive the agent's tool-calling loop instead of one
    // single-pass LLM call. Requires authentication (the agent tools resolve a
    // per-user provider and enforce clearance via the caller's claims). Returns
    // the SAME response shape as fast mode. Falls through to fast mode for
    // unauthenticated callers — they have no agent tools/provider to drive.
    if req.is_deep() {
        if let Some(ref c) = claims {
            return deep_query(&state, c, &req, eff_rank, &history).await;
        }
        // No claims → no agent context; fall through to the fast public path.
    }

    // Resolve the per-user provider/model up front (the fast path needs it BEFORE
    // retrieval so it can contextualize the search query). Honours
    // llmConfig.provider/model; unauthenticated → Ollama default.
    let requested_provider = req.llm_config.as_ref().and_then(|c| c["provider"].as_str());
    let requested_model = req.llm_config.as_ref().and_then(|c| c["model"].as_str());
    let target = match &claims {
        Some(c) => crate::services::llm::resolve_for_user(
            &state.db, c.sub, requested_provider, requested_model,
        ).await,
        None => crate::services::llm::LlmTarget {
            provider: "ollama".into(),
            model: requested_model.unwrap_or("qwen2.5:7b").to_string(),
            base_url: None,
            api_key: None,
        },
    };

    // Contextualize retrieval: for a follow-up, rewrite it into a standalone query
    // using the conversation so search finds the right entity. First turn (no
    // history) → unchanged, so no extra cost. Used for chunk search + dossier/entity
    // resolution; the ORIGINAL message stays the question shown to the model.
    let search_query = contextualize_query(&client, &target, &history, &req.message).await;
    if search_query != req.message {
        tracing::info!("rag: contextualized follow-up '{}' → '{}'", req.message, search_query);
    }

    // ── 1. Semantic search via KEX ────────────────────────────────────────────
    #[derive(serde::Deserialize)]
    struct KexChunk {
        text:             String,
        score:            f64,
        entity_mentions:  Option<Vec<String>>,
        source:           Option<String>,
        chunk_id:         Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct KexSearchResp {
        chunks: Vec<KexChunk>,
    }

    let kex_url = format!("{}/search", state.cfg.kex_worker_url);
    let kex_body = json!({
        // Contextualized query (resolves follow-up references); falls back to the
        // raw message on the first turn. Fetch a larger candidate pool (12) so the
        // hybrid dense+lexical fusion has more to rank — wider net = more distinct
        // source sessions for parent-document expansion (Hebel 1: recall).
        "query":          search_query,
        "limit":          12,
        "compilation_id": req.compilation_id,
        // Scope retrieval to the caller's own chunks (grounding + no cross-user leak).
        "user_id":        claims.as_ref().map(|c| c.sub),
        "max_rank":       eff_rank,
    });

    let mut chunks: Vec<KexChunk> = match client
        .post(&kex_url)
        .json(&kex_body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => match resp.json::<KexSearchResp>().await {
            Ok(body) => body.chunks,
            Err(e) => {
                tracing::warn!("KEX response parse error: {e}");
                vec![]
            }
        },
        Err(e) => {
            tracing::warn!("KEX search unreachable: {e}");
            vec![]
        }
    };

    // Query-aware rerank over the hybrid-fused candidates. KEX already fuses
    // dense+lexical (RRF); this nudges chunks whose text / entity mentions overlap
    // the (contextualized) query terms to the top, then keeps the best 5 so the
    // prompt stays focused. A small additive bonus — it breaks ties toward
    // query-relevant chunks without overriding a strongly-retrieved one.
    {
        let terms: Vec<String> = search_query
            .to_lowercase()
            .split(|ch: char| !ch.is_alphanumeric())
            .filter(|t| t.chars().count() >= 3)
            .map(|t| t.to_string())
            .collect();
        if !terms.is_empty() {
            let score_of = |base: f64, text: &str, mentions: &Option<Vec<String>>| -> f64 {
                let hay = text.to_lowercase();
                let mut overlap = 0.0f64;
                for t in &terms {
                    if hay.contains(t) { overlap += 1.0; }
                    if let Some(ms) = mentions {
                        if ms.iter().any(|m| m.to_lowercase().contains(t)) { overlap += 0.5; }
                    }
                }
                base + (overlap / terms.len() as f64) * 0.25
            };
            chunks.sort_by(|a, b| {
                let sa = score_of(a.score, &a.text, &a.entity_mentions);
                let sb = score_of(b.score, &b.text, &b.entity_mentions);
                sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        chunks.truncate(6);
    }

    // A4 — HEAT on chunks. Every chunk that was actually returned by retrieval (and
    // therefore used to ground this answer) gets heat/access bumped in one cheap
    // batch UPDATE keyed by id. This is the COLD-tier analogue of bump_dossier_heat:
    // it gives the maintenance worker live signal about which chunks (and the
    // entities around them) are hot, so decay/promotion/eviction are data-driven.
    if let Some(ref c) = claims {
        let used_ids: Vec<Uuid> = chunks.iter()
            .filter_map(|ch| ch.chunk_id.as_deref().and_then(|s| Uuid::parse_str(s).ok()))
            .collect();
        bump_chunk_heat(&state.db, c.sub, &used_ids).await;
    }

    // ── 2. Graph context via Neo4j ────────────────────────────────────────────
    // Collect unique entity names from all chunk entity_mentions
    let mut entity_names: Vec<String> = chunks
        .iter()
        .flat_map(|c| c.entity_mentions.iter().flatten().cloned())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .take(15)
        .collect();
    entity_names.sort(); // deterministic ordering

    #[derive(Debug)]
    struct GraphTriple {
        from:     String,
        relation: String,
        to:       String,
    }

    // Bug 2: Scope Neo4j queries to the authenticated user's nodes (plus shared nodes
    // with no user_id) to prevent cross-user data leakage.
    let uid = claims.as_ref().map(|c| c.sub.to_string()).unwrap_or_default();

    let (graph_triples, cypher_used) = if entity_names.is_empty() {
        (vec![], None)
    } else {
        let cypher = format!(
            "MATCH (n) WHERE n.name IN $names AND (n.user_id IS NULL OR n.user_id = $uid) \
             AND coalesce(n._min_rank,0) <= $rank \
             OPTIONAL MATCH (n)-[r]->(m) \
               WHERE coalesce(m._min_rank,0) <= $rank AND coalesce(r._min_rank,0) <= $rank \
             RETURN n, r, m LIMIT 100"
        );
        let mut triples: Vec<GraphTriple> = vec![];

        match state
            .neo
            .execute(
                neo4rs::query(&cypher)
                    .param("names", entity_names.clone())
                    .param("uid", uid.clone())
                    .param("rank", eff_rank),
            )
            .await
        {
            Ok(mut result) => {
                while let Ok(Some(row)) = result.next().await {
                    let from_name = row
                        .get::<Node>("n")
                        .ok()
                        .and_then(|n| n.get::<String>("name").ok())
                        .unwrap_or_default();

                    let rel_type = row
                        .get::<neo4rs::Relation>("r")
                        .ok()
                        .map(|r| r.typ().to_string());

                    let to_name = row
                        .get::<Node>("m")
                        .ok()
                        .and_then(|n| n.get::<String>("name").ok());

                    if let (Some(rel), Some(to)) = (rel_type, to_name) {
                        if !from_name.is_empty() && !to.is_empty() {
                            triples.push(GraphTriple {
                                from:     from_name,
                                relation: rel,
                                to,
                            });
                        }
                    }
                }
                (triples, Some(cypher))
            }
            Err(e) => {
                tracing::warn!("Neo4j query error: {e}");
                (vec![], None)
            }
        }
    };

    // Resolve each retrieved chunk's ORIGIN FILE (chunk → job → fileName) so the
    // numbered context carries the real source document. KEX's /search often
    // returns an empty `source`, and a chunk's provenance is the most reliable
    // answer to "which file does this come from" (the entity name in the chunk is
    // frequently partial, e.g. "Fabio" for the node "Fabio Chiaramonte").
    // Resolve each retrieved chunk's ORIGIN FILE and PARENT DOCUMENT. HEBEL 1 —
    // parent-document ("read whole files") retrieval: a chunk is just a fragment of
    // a source session (one KEX extract job, full text in jobs.input.text). When a
    // chunk matches we put the WHOLE session into context, so a fact elsewhere in
    // the same session (a date, a name) is found even if its exact chunk didn't
    // rank top-k — directly targeting the "right session not retrieved" miss class.
    // Clearance is implicit: a chunk only survives the min_rank filter if its
    // session is within the caller's clearance, so its full text is safe to include.
    let mut chunk_files: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut parent_docs: Vec<(String, String)> = Vec::new(); // (source, full_text), rank-ordered, deduped by job
    if let Some(ref c) = claims {
        let ids: Vec<Uuid> = chunks.iter()
            .filter_map(|ch| ch.chunk_id.as_deref().and_then(|s| Uuid::parse_str(s).ok()))
            .collect();
        if !ids.is_empty() {
            let rows = sqlx::query_as::<_, (Uuid, Uuid, Option<String>, Option<String>)>(
                "SELECT tc.id, tc.job_id, COALESCE(j.input->>'fileName', j.input->>'sourceRef'), j.input->>'text' \
                 FROM text_chunks tc JOIN jobs j ON j.id = tc.job_id \
                 WHERE tc.id = ANY($1) AND tc.user_id = $2"
            ).bind(&ids).bind(c.sub).fetch_all(&state.db).await.unwrap_or_default();
            // chunk_id -> (job_id, source, full_text)
            let mut by_chunk: std::collections::HashMap<String, (Uuid, Option<String>, Option<String>)> =
                std::collections::HashMap::new();
            for (cid_, jid, src, txt) in rows {
                if let Some(ref s) = src { chunk_files.insert(cid_.to_string(), s.clone()); }
                by_chunk.insert(cid_.to_string(), (jid, src, txt));
            }
            // Build parent docs in chunk-RANK order, deduped by job, capped to the
            // top 4 distinct sessions (× ~4k chars) so the prompt stays bounded.
            let mut seen_jobs: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
            for ch in chunks.iter() {
                if parent_docs.len() >= 4 { break; }
                let Some(cid_) = ch.chunk_id.as_deref() else { continue; };
                let Some((jid, src, txt)) = by_chunk.get(cid_) else { continue; };
                if !seen_jobs.insert(*jid) { continue; }
                if let Some(t) = txt {
                    if !t.trim().is_empty() {
                        let name = src.clone().unwrap_or_else(|| "source".into());
                        let capped: String = t.chars().take(4000).collect();
                        parent_docs.push((name, capped));
                    }
                }
            }
        }
    }

    // ── 3. Assemble context string ────────────────────────────────────────────
    // A3 — GROUND-TRUTH INJECTION HIERARCHY. Blocks are ordered by trust tier and
    // each tier is LABELED in the prompt so the model can obey "answer from the
    // highest-trust block". Order is STRUCTURAL, not just prompt wording:
    //   tier 1: pinned/dossier (HOT block)  ← injected first, above everything
    //   tier 2: graph fact (high-confidence edge)
    //   tier 3: chunk (dense/lexical, hybrid-retrieved)
    let mut context_parts: Vec<String> = Vec::new();

    // ── TIER 1: HOT BLOCK — entity dossiers the query references. Built on-the-fly
    // when an owned-but-undossiered entity is named, so first-ask still gets the
    // authoritative block. Candidates: entities named in the query + entities
    // mentioned by the retrieved chunks. Empty → falls through to plain retrieval.
    let mut hot_matched: Vec<String> = Vec::new();
    // A6 — USER-PROFILE personalization block (TRUST TIER 1), injected FIRST so the
    // model tailors the whole answer to the person. GDPR split: ONLY in standard
    // mode (never incognito) and ONLY when the user opted in (`enabled`).
    if let Some(ref c) = claims {
        if req.mode.as_deref() != Some("incognito") {
            if let Some(profile_block) = user_profile_hot_block(&state.db, c.sub).await {
                tracing::info!("rag: injected user-profile hot block (user {})", c.sub);
                context_parts.push(profile_block);
            }
        }
    }
    if let Some(ref c) = claims {
        // Use the CONTEXTUALIZED query so a follow-up ("and his email?") still
        // resolves the referenced entity's dossier (the rewrite carries the name).
        let mut candidates =
            crate::routes::kg::dossiers_referenced_by_query(&state.db, c.sub, &search_query).await;
        // If the query names an OWNED entity that has no dossier yet, build it now.
        if candidates.is_empty() {
            // Cheap heuristic: try the longest capitalised token-run in the query.
            if let Some(name) = first_proper_name(&search_query) {
                if crate::routes::kg::build_dossier_via_fuse(&state, c.sub, &name).await
                    .ok().flatten().is_some()
                {
                    candidates.push(name);
                }
            }
        }
        // Add chunk-mentioned entities as secondary candidates.
        for e in entity_names.iter() {
            if !candidates.iter().any(|n| n.eq_ignore_ascii_case(e)) {
                candidates.push(e.clone());
            }
        }
        let (hot_block, matched) =
            crate::routes::kg::collect_hot_blocks(&state, c.sub, &candidates, 3).await;
        if !hot_block.is_empty() {
            tracing::info!(
                "rag: injected {} dossier hot-block(s) for [{}] (query: {:?})",
                matched.len(), matched.join(", "), req.message
            );
            context_parts.push(hot_block);
            hot_matched = matched;
        }
    }

    // TIER 2.5 — FULL SOURCE SESSIONS (parent documents). The whole sessions the
    // top passages were carved from, so the model can read them end-to-end and find
    // a fact that the fragment retrieval narrowly missed (Hebel 1: recall).
    if !parent_docs.is_empty() {
        context_parts.push(
            "--- FULL SOURCE SESSIONS (read each in full; the answer may be anywhere inside) ---".to_string());
        for (i, (name, text)) in parent_docs.iter().enumerate() {
            context_parts.push(format!("[Source {} — {}]\n{}\n", i + 1, name, text));
        }
    }

    if !chunks.is_empty() {
        context_parts.push("--- TRUST TIER 3 · retrieved passages (hybrid dense+lexical) ---".to_string());
        context_parts.push("Relevant context from knowledge base:\n".to_string());
        for (i, chunk) in chunks.iter().enumerate() {
            let source_str = chunk.chunk_id.as_deref()
                .and_then(|id| chunk_files.get(id).map(|s| s.as_str()))
                .or(chunk.source.as_deref())
                .filter(|s| !s.is_empty())
                .unwrap_or("unknown");
            context_parts.push(format!(
                "[{}] {} (source file: {}, relevance: {:.2})",
                i + 1,
                chunk.text,
                source_str,
                chunk.score
            ));
        }
    }

    if !graph_triples.is_empty() {
        context_parts.push("\n--- TRUST TIER 2 · graph relationships (structured facts) ---".to_string());
        for t in &graph_triples {
            context_parts.push(format!("{} -[{}]-> {}", t.from, t.relation, t.to));
        }
    }

    // Provenance: resolve each retrieved entity's ORIGIN FILE from its extraction
    // job (the node's `_source_job` → jobs.input.fileName/sourceRef). This lets the
    // model answer "which file / where does X come from" with the real source
    // document instead of evading — chunk text alone never carries that metadata.
    if let Some(ref c) = claims {
        if !entity_names.is_empty() {
            let prov_cypher = "MATCH (n) WHERE n.name IN $names \
                AND (n._owner = $uid OR n.user_id = $uid OR n.user_id IS NULL) \
                AND coalesce(n._min_rank,0) <= $rank \
                RETURN DISTINCT n.name AS name, n._source_job AS sj";
            if let Ok(mut result) = state.neo.execute(
                neo4rs::query(prov_cypher)
                    .param("names", entity_names.clone())
                    .param("uid", uid.clone())
                    .param("rank", eff_rank),
            ).await {
                let mut job_file: std::collections::HashMap<String, Option<String>> =
                    std::collections::HashMap::new();
                let mut prov_lines: Vec<String> = Vec::new();
                while let Ok(Some(row)) = result.next().await {
                    let nm = row.get::<String>("name").unwrap_or_default();
                    let Some(sj) = row.get::<String>("sj").ok() else { continue; };
                    let Ok(job_id) = Uuid::parse_str(&sj) else { continue; };
                    // Cache file lookups (many entities share one source job).
                    let file = match job_file.get(&sj) {
                        Some(f) => f.clone(),
                        None => {
                            let f: Option<String> = sqlx::query_scalar(
                                "SELECT COALESCE(input->>'fileName', input->>'sourceRef') \
                                 FROM jobs WHERE id=$1 AND user_id=$2"
                            ).bind(job_id).bind(c.sub).fetch_optional(&state.db).await.ok().flatten();
                            job_file.insert(sj.clone(), f.clone());
                            f
                        }
                    };
                    if let Some(f) = file {
                        if !nm.is_empty() {
                            prov_lines.push(format!("{nm} — origin file: {f}"));
                        }
                    }
                }
                if !prov_lines.is_empty() {
                    prov_lines.sort();
                    prov_lines.dedup();
                    context_parts.push("\nProvenance (origin files for entities above):".to_string());
                    context_parts.extend(prov_lines);
                }
            }
        }
    }

    let context = context_parts.join("\n");

    // Nothing retrieved → answer is ungrounded. Return a clear "not found" rather
    // than letting the LLM invent an answer from outside knowledge. A HOT dossier
    // block counts as grounding on its own (the authoritative tier-1 answer), so a
    // dossier match never falls into "not found" even when retrieval returns empty.
    if chunks.is_empty() && graph_triples.is_empty() && hot_matched.is_empty() {
        return Ok(Json(json!({
            "answer": "I couldn't find anything about that in your knowledge base. Try rephrasing the question, or make sure the relevant document has been extracted.",
            "sources": [],
            "confidence": 0.0,
            "cypher": Value::Null,
            "graphTrace": [],
        })));
    }

    // ── 4. LLM call with context (+ working memory) ───────────────────────────
    // `target` was resolved up front (before retrieval, for query contextualization).
    // The conversation `history` is threaded in as prior turns so the model resolves
    // references ("his email", "that company") instead of forcing the user to repeat.
    let user_content = if context.is_empty() {
        req.message.clone()
    } else {
        format!("Context:\n{context}\n\nQuestion: {}", req.message)
    };

    let system_prompt =
        "You are a knowledge-base assistant. Answer the question using ONLY the provided context. \
         The context is ranked into TRUST TIERS, highest first: \
         (1) the HOT BLOCK — a pinned/dossier of authoritative, compiled ground-truth about an entity; \
         (2) graph relationships — structured high-confidence facts; \
         (3) retrieved passages — hybrid dense+lexical chunks; then your model prior (LOWEST — never prefer it). \
         CONTRACT: Answer from the HIGHEST-TRUST block available. If a HOT BLOCK (dossier) or a graph fact answers the question, STATE IT DIRECTLY and cite it — do NOT hedge, do NOT say 'not in the knowledge base', do NOT ask to re-query. When a HOT BLOCK is present for the asked entity, it IS the answer to 'who/what is X' and 'where does X come from' — lead with its summary, key facts and origin files. \
         SYNTHESIZE a complete answer FROM the context: read every numbered chunk, pull out the relevant facts, and compile them. When the user asks for a summary, profile, CV, work history, biography, or 'everything about X', BUILD that answer — list the concrete facts you find (roles, employers, education, languages, skills, dates, contact details) and organise them. \
         NEVER reply with 'refer to the file', 'see the document', or 'the full X is not available' when context is present — the context IS the document; report it, don't redirect the user. The chunk text may have minor extraction artefacts (odd spacing); read through them and still report the facts. \
         Cite sources inline as [1], [2], … matching the numbered passages; cite the HOT BLOCK as the dossier and name its origin files when asked about provenance. \
         If — and only if — NO tier contains a relevant fact, say it isn't in the knowledge base. Do NOT use outside or general knowledge, and do not guess. \
         Use the prior conversation turns to resolve references (pronouns, 'that', 'the same one') — but ground every FACT in the context above, never invent from the chat alone.";

    // Thread the conversation: prior turns first, then the grounded question.
    let mut chat_msgs: Vec<Value> = history.clone();
    chat_msgs.push(json!({ "role": "user", "content": user_content }));
    let answer = crate::services::llm::chat_messages_once(
        &client,
        &target,
        &crate::services::llm::ChatMessages { system: system_prompt, messages: chat_msgs },
    )
    .await
    .map_err(AppError::Internal)?;

    // ── 5. Persist the turn (STANDARD mode only) ──────────────────────────────
    // Incognito stays browser-memory-only (GDPR). Standard mode writes the thread
    // so the conversation history sidebar works and a thread survives navigation.
    let conversation_id_out: Option<Uuid> = match (&claims, req.mode.as_deref()) {
        (Some(c), m) if m != Some("incognito") =>
            persist_turn(&state.db, c.sub, req.conversation_id, &req.message, &answer).await,
        _ => None,
    };

    // ── 6. Build response ─────────────────────────────────────────────────────
    let confidence: f64 = if chunks.is_empty() {
        0.5
    } else {
        let sum: f64 = chunks.iter().map(|c| c.score).sum();
        sum / chunks.len() as f64
    };

    let sources: Vec<Value> = chunks
        .iter()
        .map(|c| {
            // Prefer the resolved origin file (chunk → job → fileName) so source
            // cards show the real document name instead of a blank.
            let source_name = c.chunk_id.as_deref()
                .and_then(|id| chunk_files.get(id).map(|s| s.as_str()))
                .or(c.source.as_deref())
                .unwrap_or("");
            json!({
                "text":    c.text,
                "score":   c.score,
                "source":  source_name,
                "chunkId": c.chunk_id.as_deref().unwrap_or(""),
                // Entities this chunk mentions — lets the UI jump into the viewer
                // and focus a real node to trace the chunk's provenance.
                "entityMentions": c.entity_mentions.clone().unwrap_or_default(),
            })
        })
        .collect();

    let graph_trace: Vec<Value> = graph_triples
        .iter()
        .map(|t| json!({ "from": t.from, "relation": t.relation, "to": t.to }))
        .collect();

    let cypher_val: Value = match cypher_used {
        Some(_) => {
            // Embed the actual entity names into a readable cypher string for the response
            let names_repr: Vec<Value> = entity_names.iter().map(|n| json!(n)).collect();
            json!(format!("MATCH (n) WHERE n.name IN {:?} OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100", names_repr))
        }
        None => Value::Null,
    };

    if let Some(ref c) = claims {
        let res_id = req.compilation_id.map(|x| x.to_string()).unwrap_or_else(|| "global".into());
        crate::services::audit::log_access(&state.db, c, "rag.query",
            "compilation", &res_id, eff_rank as i32, None, true, None).await;
    }

    Ok(Json(json!({
        "answer":     answer,
        "sources":    sources,
        "confidence": confidence,
        "cypher":     cypher_val,
        "graphTrace": graph_trace,
        "conversationId": conversation_id_out,
    })))
}

/// Agentic ("deep") RAG: a bounded tool-calling loop reusing the agent machinery.
///
/// Instead of one single-pass LLM call, we let the model gather evidence over
/// several turns by emitting `{"tool":...,"args":...}` calls — exactly the same
/// protocol `agent::chat` uses. We reuse:
///   - `agent::build_system_prompt` so the caller's enabled skills apply,
///   - `agent::execute_tool` so clearance + per-graph grants are honoured
///     (the tools enforce them internally — we never re-implement that here),
///   - `agent::find_tool_json` for tool-call detection,
///   - `llm::resolve_for_user` + `llm::chat_messages_once` to drive turns.
///
/// The loop is hard-capped at `MAX_ITERS` tool round-trips so it always
/// terminates: if the model is still calling tools at the cap, we force a final
/// answer turn. Returns the SAME response JSON shape as fast mode — `answer`
/// (required), `sources` (from `search_chunks` results), `confidence`,
/// `graphTrace` (best-effort, from `search_entities`/`get_entity`), and
/// `cypher` (null in deep mode; the model drives retrieval, not a fixed query).
async fn deep_query(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    req: &QueryReq,
    eff_rank: i64,
    history: &[Value],
) -> Result<Json<Value>> {
    use crate::services::llm::{self, ChatMessages};

    const MAX_ITERS: usize = 5;

    let client = reqwest::Client::new();

    // Per-user provider/model (honours llmConfig.provider/model, else the user's
    // active provider, else local Ollama).
    let requested_provider = req.llm_config.as_ref().and_then(|c| c["provider"].as_str());
    let requested_model = req.llm_config.as_ref().and_then(|c| c["model"].as_str());
    let target = llm::resolve_for_user(&state.db, claims.sub, requested_provider, requested_model).await;

    // WORKING MEMORY: contextualize the question against the running conversation so
    // dossier/entity resolution (and the agent's own framing) follow a follow-up's
    // referent. The original message stays the user turn; this only steers retrieval.
    let search_query = contextualize_query(&client, &target, history, &req.message).await;

    // GCTRL base + the caller's enabled skills, plus a deep-mode preamble nudging
    // the model to gather evidence via tools before answering with citations.
    let base_prompt = crate::routes::agent::build_system_prompt(state, claims).await;
    let compilation_hint = req
        .compilation_id
        .map(|c| format!(" Scope retrieval to compilationId \"{c}\" by passing it to search_chunks."))
        .unwrap_or_default();
    // A3 — inject any entity dossier the query references as a HOT, authoritative
    // block at the TOP of the agent's system prompt (above the tool guidance), and
    // build one on-the-fly when an owned-but-undossiered entity is named. The agent
    // gets the highest-trust answer before it ever calls a tool, so it states the
    // answer directly instead of hedging or re-querying.
    let mut hot_candidates =
        crate::routes::kg::dossiers_referenced_by_query(&state.db, claims.sub, &search_query).await;
    if hot_candidates.is_empty() {
        if let Some(name) = first_proper_name(&search_query) {
            if crate::routes::kg::build_dossier_via_fuse(state, claims.sub, &name).await
                .ok().flatten().is_some()
            {
                hot_candidates.push(name);
            }
        }
    }
    let (hot_block, hot_matched) =
        crate::routes::kg::collect_hot_blocks(state, claims.sub, &hot_candidates, 3).await;
    // A6 — USER-PROFILE personalization block. GDPR split: standard mode + opted-in
    // only (skip entirely in incognito). Prepended above the dossier hot block.
    let profile_preamble = if req.mode.as_deref() != Some("incognito") {
        match user_profile_hot_block(&state.db, claims.sub).await {
            Some(b) => {
                tracing::info!("rag/deep: injected user-profile hot block (user {})", claims.sub);
                format!("\n\n## USER PROFILE · TRUST TIER 1 (the person asking)\n{b}")
            }
            None => String::new(),
        }
    } else {
        String::new()
    };
    let hot_preamble = if hot_block.is_empty() {
        profile_preamble
    } else {
        tracing::info!(
            "rag/deep: injected {} dossier hot-block(s) for [{}]",
            hot_matched.len(), hot_matched.join(", ")
        );
        format!(
            "{profile_preamble}\n\n## HOT BLOCK · TRUST TIER 1 (authoritative ground-truth)\n\
             The following dossier(s) are the HIGHEST-TRUST answer about the asked entity. \
             If they answer the question, STATE IT DIRECTLY and cite the dossier — do NOT hedge, \
             do NOT say 'not in the knowledge base', do NOT call tools just to re-confirm. Use \
             tools only to ADD detail beyond the dossier.\n\n{hot_block}"
        )
    };

    let system_prompt = format!(
        "{base}{hot}\n\n## Deep research mode\nYou are answering a knowledge question with multi-hop \
         reasoning. Trust hierarchy (highest first): HOT BLOCK / dossier > graph fact (get_entity / \
         get_dossier) > retrieved passage (search_chunks) > your prior. Answer from the highest-trust \
         source available. FIRST gather evidence by calling tools — use search_chunks to retrieve source \
         passages, and search_entities / get_entity / get_dossier to explore graph relationships. Gather \
         broadly: retrieve several passages and follow related entities before answering. You may call tools \
         across up to {max} turns. When you have enough evidence, STOP calling tools and write a \
         THOROUGH, well-structured final answer that synthesizes ALL the evidence you gathered, \
         explains the relationships and context, and cites sources as [1], [2], etc. Prefer depth \
         and completeness — this is deep mode, so be more detailed than a quick answer.{hint}",
        base = base_prompt,
        hot = hot_preamble,
        max = MAX_ITERS,
        hint = compilation_hint,
    );

    // Conversation transcript threaded across turns (user/assistant/tool). Seed it
    // with the prior conversation (working memory) so the agent resolves follow-up
    // references, THEN append this turn's question.
    let mut messages: Vec<Value> = history.to_vec();
    messages.push(json!({ "role": "user", "content": &req.message }));

    // Evidence surfaced by tools, deduped, for the response `sources`/`graphTrace`.
    let mut sources: Vec<Value> = Vec::new();
    let mut seen_chunks: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut score_sum: f64 = 0.0;
    let mut graph_trace: Vec<Value> = Vec::new();
    let mut seen_triples: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tools_invoked: usize = 0;

    let mut final_answer = String::new();

    for iter in 0..MAX_ITERS {
        // On the last allowed iteration, drop tool affordance from the prompt to
        // force a textual answer so the loop always terminates with content.
        let force_answer = iter == MAX_ITERS - 1;
        let turn_system = if force_answer {
            format!("{system_prompt}\n\nYou have reached the evidence-gathering limit. Do NOT call any more tools. Answer now using the evidence already gathered.")
        } else {
            system_prompt.clone()
        };

        let cm = ChatMessages { system: &turn_system, messages: messages.clone() };
        let reply = llm::chat_messages_once(&client, &target, &cm)
            .await
            .map_err(AppError::Internal)?;
        let trimmed = reply.trim().to_string();

        // Detect a tool call (same protocol as agent::chat). find_tool_json parses
        // the first tool object and tolerates trailing content (a second call /
        // prose), so the model still gets its tool executed instead of being
        // skipped (which made the agent hallucinate empty results).
        let tool_call: Option<Value> = crate::routes::agent::find_tool_json(&trimmed);

        let Some(call) = tool_call else {
            // No tool call → this is the final answer.
            final_answer = trimmed;
            break;
        };

        if force_answer {
            // The model is still trying to call a tool on the forced-answer turn.
            // Don't echo raw {"tool":...} JSON to the user — do ONE final
            // tool-free synthesis call over the evidence already gathered.
            let synth_system = format!(
                "{base}\n\nWrite a THOROUGH, well-structured answer to the user's question using \
                 ONLY the evidence below — synthesize across ALL the items, explain the context and \
                 connections between them, and cite sources as [1], [2], etc. Be detailed and \
                 complete (this is deep research mode). Do NOT output JSON or tool calls.",
                base = base_prompt,
            );
            let evidence = if sources.is_empty() {
                "(no evidence was retrieved)".to_string()
            } else {
                sources.iter().enumerate()
                    .map(|(i, s)| format!("[{}] {}", i + 1, s["text"].as_str().unwrap_or("")))
                    .collect::<Vec<_>>().join("\n")
            };
            let synth = ChatMessages {
                system: &synth_system,
                messages: vec![json!({
                    "role": "user",
                    "content": format!("Question: {}\n\nEvidence:\n{evidence}", req.message),
                })],
            };
            final_answer = llm::chat_messages_once(&client, &target, &synth)
                .await
                .unwrap_or_else(|_| {
                    if sources.is_empty() {
                        "I could not retrieve enough evidence to answer.".to_string()
                    } else {
                        evidence.clone()
                    }
                });
            break;
        }

        let tool_name = call["tool"].as_str().unwrap_or("").to_string();
        let args = call.get("args").cloned().unwrap_or_else(|| json!({}));

        let result = crate::routes::agent::execute_tool(state, claims, &tool_name, &args).await;
        tools_invoked += 1;

        // Harvest evidence for the response shape.
        if let Some(chunks) = result["chunks"].as_array() {
            for ch in chunks {
                let text = ch["text"].as_str().unwrap_or("").to_string();
                if text.is_empty() { continue; }
                let key = ch["chunk_id"].as_str().or_else(|| ch["chunkId"].as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| text.clone());
                if seen_chunks.insert(key) {
                    let score = ch["score"].as_f64().unwrap_or(0.0);
                    score_sum += score;
                    sources.push(json!({
                        "text":    text,
                        "score":   score,
                        "source":  ch["source"].as_str().unwrap_or(""),
                        "chunkId": ch["chunk_id"].as_str().or_else(|| ch["chunkId"].as_str()).unwrap_or(""),
                    }));
                }
            }
        }
        // Entities → graphTrace edges (best-effort, from get_entity connections).
        if let Some(conns) = result["connections"].as_array() {
            let from = result["name"].as_str().unwrap_or("").to_string();
            for conn in conns {
                // get_entity formats connections as "REL → target".
                if let Some(s) = conn.as_str() {
                    if let Some((rel, to)) = s.split_once('→') {
                        let triple = json!({ "from": from, "relation": rel.trim(), "to": to.trim() });
                        let k = format!("{from}|{rel}|{to}");
                        if seen_triples.insert(k) {
                            graph_trace.push(triple);
                        }
                    }
                }
            }
        }

        // Feed the assistant's tool call + the tool result back into the transcript.
        let tool_result_text = format!(
            "Tool `{}` returned: {}",
            tool_name,
            serde_json::to_string(&result).unwrap_or_default().chars().take(4000).collect::<String>()
        );
        messages.push(json!({ "role": "assistant", "content": trimmed }));
        messages.push(json!({ "role": "user", "content": tool_result_text }));
    }

    if final_answer.trim().is_empty() {
        final_answer = "I gathered evidence but could not produce a final answer within the iteration limit. Please try rephrasing your question.".to_string();
    }

    let confidence: f64 = if sources.is_empty() {
        0.5
    } else {
        score_sum / sources.len() as f64
    };

    let res_id = req.compilation_id.map(|x| x.to_string()).unwrap_or_else(|| "global".into());
    tracing::info!("rag deep mode: tools_invoked={tools_invoked}, sources={}", sources.len());
    crate::services::audit::log_access(&state.db, claims, "rag.query.deep",
        "compilation", &res_id, eff_rank as i32, None, true, None).await;

    // Persist the turn (STANDARD mode only — incognito never hits the deep path
    // with persistence; mirror the fast path's GDPR rule regardless).
    let conversation_id_out: Option<Uuid> = if req.mode.as_deref() != Some("incognito") {
        persist_turn(&state.db, claims.sub, req.conversation_id, &req.message, &final_answer).await
    } else { None };

    Ok(Json(json!({
        "answer":     final_answer,
        "sources":    sources,
        "confidence": confidence,
        "cypher":     Value::Null,
        "graphTrace": graph_trace,
        "conversationId": conversation_id_out,
    })))
}

async fn list_conversations(
    Extension(claims): Extension<Option<JwtClaims>>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // The /rag router uses OPTIONAL auth (so the public query path works); these
    // user-scoped endpoints must require a real identity themselves.
    let claims = claims.ok_or(AppError::Unauthorized)?;
    let rows = sqlx::query_as::<_, (Uuid, Option<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, title, updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50"
    ).bind(claims.sub).fetch_all(&state.db).await?;
    let convs: Vec<Value> = rows.into_iter().map(|(id,t,u)| json!({ "id":id,"title":t,"updatedAt":u })).collect();
    Ok(Json(json!({ "conversations": convs })))
}

async fn get_conversation(
    Extension(claims): Extension<Option<JwtClaims>>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let claims = claims.ok_or(AppError::Unauthorized)?;
    let conv = sqlx::query_as::<_, (Uuid, Option<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, title, updated_at FROM conversations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let messages = sqlx::query_as::<_, (Uuid, String, String, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, role, content, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at"
    ).bind(id).fetch_all(&state.db).await?;
    let (cid, title, updated) = conv;
    let msgs: Vec<Value> = messages.into_iter().map(|(mid,r,c,cr)| json!({ "id":mid,"role":r,"content":c,"createdAt":cr })).collect();
    // Shape matches the frontend ConversationDetailResponse ({ conversation: {…} }).
    Ok(Json(json!({ "conversation": { "id":cid,"title":title,"updatedAt":updated,"messages":msgs } })))
}

async fn delete_conversation(
    Extension(claims): Extension<Option<JwtClaims>>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let claims = claims.ok_or(AppError::Unauthorized)?;
    sqlx::query("DELETE FROM conversations WHERE id=$1 AND user_id=$2").bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_models(State(_state): State<Arc<crate::models::AppState>>) -> Json<Value> {
    let ollama_base = std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://localhost:11434".into());
    let client = reqwest::Client::new();
    let models = match client.get(format!("{}/api/tags", ollama_base))
        .timeout(std::time::Duration::from_secs(3)).send().await {
        Ok(r) => r.json::<Value>().await.ok()
            .and_then(|v| v["models"].as_array().cloned())
            .unwrap_or_default(),
        Err(_) => vec![],
    };
    Json(json!({ "ollama": models, "cloud": [] }))
}

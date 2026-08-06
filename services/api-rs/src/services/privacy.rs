//! Private Memory: per-compilation privacy modes that control what cloud LLMs
//! ever see (migration 065, `compilations.privacy_mode`).
//!
//! Three modes, strictest wins across the compilations touched by a request:
//!   - `open`       (default) — unchanged behaviour, zero change unless toggled.
//!   - `local_only` — content from this graph must NEVER reach a cloud LLM. A
//!                    request whose context involves this graph is REFUSED
//!                    (not silently rerouted) when the resolved chat target is
//!                    cloud.
//!   - `cloaked`    — cloud LLMs are allowed, but every known entity + a PII
//!                    regex fallback in the outgoing text is deterministically
//!                    pseudonymized first (`Person-7`, `Org-3`, `[AMOUNT-2]`,
//!                    `[DATE-4]`, ...). The cloak map (`cloak_maps`, migration
//!                    065) lives ONLY in the local Postgres — it is never sent
//!                    anywhere — and the LLM's answer is de-cloaked before the
//!                    caller sees it. Local models always see plaintext (no
//!                    cloaking needed — they never leave the machine).
//!
//! This module is deliberately split into PURE functions (matching,
//! substitution, cloud-target classification, decloak) that are unit-tested
//! without a database, and thin async wrappers that touch Postgres only for
//! the pseudonym registry (`cloak_maps`) and to resolve `compilations.privacy_mode`.
//!
//! Enforcement is wired at the actual LLM egress points — see
//! `routes::rag` (fast + deep Talk-to-Graph) and `routes::agent` (Pi chat).
//! Each call site documents exactly how airtight (or best-effort) its
//! enforcement is; see those modules for the honest caveats.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use once_cell::sync::Lazy;
use uuid::Uuid;

// ── Privacy mode resolution ───────────────────────────────────────────────────

/// Strictest-wins privacy mode across a set of involved compilations.
/// Declaration order IS the strictness order (`Ord`/`max()` rely on it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PrivacyMode {
    Open,
    Cloaked,
    LocalOnly,
}

impl PrivacyMode {
    fn from_db(s: &str) -> Self {
        match s {
            "local_only" => PrivacyMode::LocalOnly,
            "cloaked" => PrivacyMode::Cloaked,
            _ => PrivacyMode::Open,
        }
    }

    pub fn as_db_str(self) -> &'static str {
        match self {
            PrivacyMode::Open => "open",
            PrivacyMode::Cloaked => "cloaked",
            PrivacyMode::LocalOnly => "local_only",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PrivacyDecision {
    pub mode: PrivacyMode,
}

/// User-facing refusal shown when `local_only` content would otherwise reach a
/// cloud LLM. Actionable (tells the user what to do), never says "encrypted".
pub const LOCAL_ONLY_REFUSAL: &str =
    "This knowledge base is set to local-only — select a local model (Cookbook) or change the graph's privacy mode.";

/// Resolve the effective privacy mode across `compilation_ids` (strictest
/// wins: local_only > cloaked > open). Empty input, or ids that don't resolve
/// to a row, fold to `Open` — a request with NO identified compilation
/// context has nothing here to protect (fail open onto the pre-feature
/// default, matching this feature's opt-in design). Best-effort: a DB error
/// is treated the same as "not found".
pub async fn resolve_privacy(db: &sqlx::PgPool, compilation_ids: &[Uuid]) -> PrivacyDecision {
    if compilation_ids.is_empty() {
        return PrivacyDecision { mode: PrivacyMode::Open };
    }
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT privacy_mode FROM compilations WHERE id = ANY($1)",
    )
    .bind(compilation_ids)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let mode = rows
        .iter()
        .map(|(m,)| PrivacyMode::from_db(m))
        .max()
        .unwrap_or(PrivacyMode::Open);
    PrivacyDecision { mode }
}

/// Resolve the set of compilation ids actually involved in an assembled
/// RAG/agent context: the request-level `requested` compilation (when given)
/// UNIONed with the `text_chunks.compilation_id` of the chunk ids that were
/// actually retrieved and used — ground truth, since a chunk's own row is
/// authoritative even for requests that didn't scope by KB up front.
pub async fn compilations_for_chunks(
    db: &sqlx::PgPool,
    requested: Option<Uuid>,
    chunk_ids: &[Uuid],
) -> Vec<Uuid> {
    let mut set: HashSet<Uuid> = HashSet::new();
    if let Some(r) = requested {
        set.insert(r);
    }
    if !chunk_ids.is_empty() {
        let rows: Vec<(Option<Uuid>,)> = sqlx::query_as(
            "SELECT DISTINCT compilation_id FROM text_chunks WHERE id = ANY($1)",
        )
        .bind(chunk_ids)
        .fetch_all(db)
        .await
        .unwrap_or_default();
        for (cid,) in rows {
            if let Some(c) = cid {
                set.insert(c);
            }
        }
    }
    set.into_iter().collect()
}

// ── Cloud-target classification ───────────────────────────────────────────────

/// Is `host` a local/trusted endpoint (bundled runtime, LAN Ollama, a
/// docker-compose service, ...)? Deliberately permissive — the point of
/// `local_only` is to let LOCAL inference through while blocking cloud, so
/// loopback / RFC1918 / common docker-internal hostnames all count as local.
///
/// NOTE: this is NOT the SSRF guard (`services::llm::validate_llm_base` /
/// `is_metadata_host`) — a different, stricter allow-list for a different
/// purpose (preventing the server from being tricked into fetching an
/// attacker-chosen URL). This heuristic classifies egress for PRIVACY
/// enforcement and is documented as best-effort: a self-hosted "local" model
/// reachable at a public FQDN would be misclassified as cloud (fails safe —
/// it would be blocked/cloaked when it didn't strictly need to be) and,
/// conversely, an operator who points `openai_compatible` at an internal-only
/// reverse proxy sitting on a public-looking hostname could be misclassified
/// as local. Documented gap; not exploitable to leak data (worst case is an
/// over-eager refusal, not a bypass), see routes::rag / routes::agent.
fn is_local_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(addr) = host.parse::<std::net::Ipv4Addr>() {
        let o = addr.octets();
        return o[0] == 127
            || o[0] == 10
            || (o[0] == 172 && (16..=31).contains(&o[1]))
            || (o[0] == 192 && o[1] == 168)
            || (o[0] == 169 && o[1] == 254); // link-local, never routed off-box
    }
    if let Ok(addr) = host.parse::<std::net::Ipv6Addr>() {
        return addr.is_loopback();
    }
    if host.eq_ignore_ascii_case("host.docker.internal") {
        return true;
    }
    let lower = host.to_lowercase();
    if lower.starts_with("gctrl-") || lower.ends_with(".internal") || lower.ends_with(".local") {
        return true;
    }
    // A bare hostname with no dot (typical docker-compose service name, or a
    // LAN mDNS short name) — a real cloud endpoint always has a public FQDN.
    if !host.contains('.') {
        return true;
    }
    false
}

/// Is this resolved chat target a CLOUD endpoint? Gates `local_only` /
/// `cloaked` enforcement — never used for SSRF (see `services::llm` for that).
///
/// - `openai` / `anthropic` / `openrouter` / `ollama_cloud` → always cloud.
/// - `ollama` / `openai_compatible` (bundled llama.cpp, local vLLM, LM Studio,
///   a custom base) → cloud UNLESS the `base_url` host is local/LAN/docker per
///   [`is_local_host`], or explicitly points at `ollama.com`/`*.ollama.com`
///   (Ollama's hosted cloud models, reached via the `"ollama"` provider with a
///   cloud base — see `llm::resolve_for_user`'s `ollama_cloud` alias).
/// - No `base_url` at all → local (the bundled default install target).
pub fn is_cloud_target(provider: &str, base_url: Option<&str>, model: Option<&str>) -> bool {
    // A hosted cloud model carries a `*-cloud` / `*:cloud` tag (Ollama Cloud). It
    // is CLOUD even when reached through a localhost Ollama proxy — otherwise such
    // a model served via native localhost Ollama is misclassified as local and its
    // prompt is sent as PLAINTEXT to ollama.com, silently bypassing cloaking. The
    // tag wins over the host heuristic (matches llm_gateway::model_targets_cloud).
    if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
        let m = m.to_ascii_lowercase();
        if m.ends_with("-cloud") || m.ends_with(":cloud") {
            return true;
        }
    }
    if matches!(
        provider.trim().to_lowercase().as_str(),
        "openai" | "anthropic" | "openrouter" | "ollama_cloud"
    ) {
        return true;
    }
    let Some(base) = base_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return false; // no override → bundled local default
    };
    let Ok(u) = url::Url::parse(base) else { return false };
    let Some(host) = u.host_str() else { return false };
    if host.eq_ignore_ascii_case("ollama.com") || host.to_lowercase().ends_with(".ollama.com") {
        return true;
    }
    !is_local_host(host)
}

// ── Cloaking ───────────────────────────────────────────────────────────────

/// One cloak candidate: an entity mention (from `text_chunks.entity_mentions`,
/// JSONB shape `{name, type, uri?, pruned?}`) or a PII regex hit.
#[derive(Debug, Clone)]
pub struct EntityCandidate {
    pub name: String,
    /// Best-effort type bucket (kex-assigned `type`, or `"email"`/`"phone"`/
    /// `"iban"` for the regex fallback). Unknown/absent → bucketed as `Term-N`.
    pub kind: Option<String>,
}

/// Build cloak candidates from raw `text_chunks.entity_mentions` JSONB arrays —
/// used by callers that already fetched the chunk rows for retrieval, so this
/// adds NO extra query.
pub fn candidates_from_entity_mentions(mentions_arrays: &[serde_json::Value]) -> Vec<EntityCandidate> {
    let mut out = Vec::new();
    for arr in mentions_arrays {
        let Some(items) = arr.as_array() else { continue };
        for item in items {
            let Some(name) = item.get("name").and_then(|v| v.as_str()) else { continue };
            if name.trim().is_empty() {
                continue;
            }
            let kind = item.get("type").and_then(|v| v.as_str()).map(|s| s.to_string());
            out.push(EntityCandidate { name: name.to_string(), kind });
        }
    }
    out
}

// ── Free-chat cloak dictionary (LLM gateway) ─────────────────────────────────
//
// The RAG/agent paths cloak using the entity mentions of the CHUNKS they just
// retrieved. The OpenAI-compatible LLM gateway (`routes::llm_gateway`) has no
// retrieval step — it's a raw chat proxy — so it needs a per-user dictionary of
// the entities worth hiding: every entity name KEX ever extracted from that
// user's own documents. We pull those from `text_chunks.entity_mentions` (keyed
// by `user_id`, which is exactly "the compilations this user owns"), dedup by
// name, and cap the dictionary so a huge corpus can't make each request O(n).

/// PURE: dedup a raw candidate list by (case-folded) name and keep the `cap`
/// most useful entries — ranked by mention frequency, then by longer name
/// (longer surface forms are more specific and safer to pseudonymize). First
/// seen casing + kind wins for each key. No DB, no IO — unit-tested below.
fn dedup_and_cap(candidates: Vec<EntityCandidate>, cap: usize) -> Vec<EntityCandidate> {
    let mut agg: HashMap<String, (usize, EntityCandidate)> = HashMap::new();
    for c in candidates {
        let key = lower_key(c.name.trim());
        if key.chars().count() < 2 {
            continue;
        }
        let entry = agg.entry(key).or_insert_with(|| (0, c.clone()));
        entry.0 += 1;
    }
    let mut items: Vec<(usize, EntityCandidate)> = agg.into_values().collect();
    items.sort_by(|a, b| {
        b.0
            .cmp(&a.0)
            .then_with(|| b.1.name.chars().count().cmp(&a.1.name.chars().count()))
    });
    items.into_iter().take(cap).map(|(_, c)| c).collect()
}

/// PURE: build a capped, deduped cloak dictionary straight from raw
/// `text_chunks.entity_mentions` JSONB arrays. Extracted so it's testable with a
/// fake mentions array (no DB).
pub fn candidates_from_mentions_capped(
    mentions_arrays: &[serde_json::Value],
    cap: usize,
) -> Vec<EntityCandidate> {
    dedup_and_cap(candidates_from_entity_mentions(mentions_arrays), cap)
}

/// How many distinct entity names to keep in a user's free-chat cloak dictionary.
/// Bounds per-request substitution cost regardless of corpus size.
const CANDIDATE_CAP: usize = 2000;
/// In-memory TTL for the per-user dictionary — rebuilding it hits Postgres, and a
/// user's extracted-entity set changes slowly, so a short cache keeps the gateway
/// hop cheap without going stale for long.
const CANDIDATE_TTL: Duration = Duration::from_secs(600);

#[allow(clippy::type_complexity)]
static CANDIDATE_CACHE: Lazy<Mutex<HashMap<Uuid, (Instant, Arc<Vec<EntityCandidate>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Build the free-chat cloak dictionary for `user_id`: every entity name KEX
/// extracted from the documents this user owns (`text_chunks.entity_mentions`
/// scoped by `user_id`), deduped by name and capped at [`CANDIDATE_CAP`]. Cached
/// in-process per user for [`CANDIDATE_TTL`]. The PII regex fallback baked into
/// `collect_candidates` still runs at cloak time, so emails/IBANs/phones are
/// covered even when they were never extracted as named entities.
pub async fn user_entity_candidates(db: &sqlx::PgPool, user_id: Uuid) -> Vec<EntityCandidate> {
    // Fast path: a fresh cache entry.
    if let Some(hit) = {
        let guard = CANDIDATE_CACHE.lock().unwrap();
        guard
            .get(&user_id)
            .filter(|(t, _)| t.elapsed() < CANDIDATE_TTL)
            .map(|(_, v)| v.clone())
    } {
        return (*hit).clone();
    }

    let rows: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT COALESCE(entity_mentions, '[]'::jsonb) FROM text_chunks \
         WHERE user_id = $1 AND entity_mentions IS NOT NULL AND entity_mentions <> '[]'::jsonb",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let capped = Arc::new(candidates_from_mentions_capped(&rows, CANDIDATE_CAP));
    CANDIDATE_CACHE
        .lock()
        .unwrap()
        .insert(user_id, (Instant::now(), capped.clone()));
    (*capped).clone()
}

/// The result of a `cloak()` call: the pseudonym → canonical-original map
/// needed to de-cloak an answer. Lives only for the lifetime of one request
/// (never persisted as a session — the durable registry is `cloak_maps`).
#[derive(Debug, Clone, Default)]
pub struct CloakSession {
    /// pseudonym -> canonical original text (exact casing as first seen).
    pub map: HashMap<String, String>,
}

impl CloakSession {
    pub fn empty() -> Self {
        Self { map: HashMap::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Merge another session's mappings in (used when cloaking happens across
    /// several tool calls / turns in one conversation — e.g. the Pi agent).
    pub fn merge(&mut self, other: CloakSession) {
        self.map.extend(other.map);
    }
}

/// Normalize a string to a matching key. Per-character lowering (not
/// `str::to_lowercase()`) so the key's `char` count always matches the
/// original's — required for the char-index scan in [`apply_pseudonyms`] to
/// stay aligned. Known limitation: this misses locale-specific expansions
/// (e.g. German `ß` → `ss`, Turkish dotted-I) since it only takes the first
/// lowered char per input char; both sides of every comparison use this same
/// function, so matching stays internally consistent even where it diverges
/// from "true" Unicode case folding.
fn lower_key(s: &str) -> String {
    s.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

/// Which pseudonym family (and whether it's bracketed) a `kind` bucket maps
/// to. Bracketed forms (`[DATE-4]`) are used for non-named-entity classes so
/// they read as placeholders rather than names.
fn bucket_template(kind: Option<&str>) -> (&'static str, bool) {
    match kind.unwrap_or("").trim().to_lowercase().as_str() {
        "person" | "per" => ("Person", false),
        "organization" | "org" | "company" => ("Org", false),
        "location" | "place" | "gpe" | "loc" => ("Place", false),
        "date" | "time" | "temporal" => ("DATE", true),
        "money" | "amount" | "financial" | "currency" => ("AMOUNT", true),
        "quantity" | "number" | "num" | "cardinal" => ("NUM", true),
        "email" => ("EMAIL", true),
        "phone" => ("PHONE", true),
        "iban" => ("IBAN", true),
        _ => ("Term", false),
    }
}

// PII regex fallback (email / phone / IBAN). Deliberately minimal — this is a
// defense-in-depth net, NOT the primary detector (kex's NER pipeline is).
static EMAIL_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b").unwrap()
});
static IBAN_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b").unwrap()
});
// Loose net for phone-like digit runs; filtered by digit count below so it
// doesn't fire on every short number. Best-effort — no locale-aware parsing.
static PHONE_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r"(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?)?\d{3,4}[\s.\-]?\d{3,4}(?:[\s.\-]?\d{2,4})?").unwrap()
});

fn find_pii(text: &str) -> Vec<(String, &'static str)> {
    let mut out = Vec::new();
    for m in EMAIL_RE.find_iter(text) {
        out.push((m.as_str().to_string(), "email"));
    }
    for m in IBAN_RE.find_iter(text) {
        out.push((m.as_str().to_string(), "iban"));
    }
    for m in PHONE_RE.find_iter(text) {
        let digits = m.as_str().chars().filter(|c| c.is_ascii_digit()).count();
        if digits >= 7 {
            out.push((m.as_str().to_string(), "phone"));
        }
    }
    out
}

/// A dictionary entry with its match key already folded: `(lower key, kind,
/// canonical original text)`. Built ONCE per request — `lower_key` allocates,
/// and a chat request cloaks many messages against the same dictionary.
type PreparedCandidate = (String, Option<String>, String);

/// PURE: fold a candidate dictionary into match keys once, dropping entries too
/// short to be worth hiding (they would match noise).
fn prepare_candidates(candidates: &[EntityCandidate]) -> Vec<PreparedCandidate> {
    let mut out = Vec::with_capacity(candidates.len());
    for c in candidates {
        let trimmed = c.name.trim();
        let key = lower_key(trimmed);
        if key.chars().count() < 2 {
            continue;
        }
        out.push((key, c.kind.clone(), trimmed.to_string()));
    }
    out
}

/// PURE: the set of alphanumeric word tokens in `text`, folded with the same
/// per-char lowering [`lower_key`] uses so both sides of a comparison agree.
fn text_tokens(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut cur = String::new();
    for c in text.chars() {
        if c.is_alphanumeric() {
            cur.push(c.to_lowercase().next().unwrap_or(c));
        } else if !cur.is_empty() {
            out.insert(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.insert(cur);
    }
    out
}

/// PURE: could `key` match ANYWHERE in a text whose token set is `tokens`?
///
/// This is an EXACT pre-filter, not a heuristic — it can never drop a key that
/// would have matched. [`apply_pseudonyms`] only substitutes on WORD BOUNDARIES,
/// so at any real match every maximal alphanumeric run of the key lines up with
/// a complete token of the text (the run's outer edge is the boundary guard, its
/// inner edges are the key's own separators). One missing run therefore proves
/// the key cannot match. A key with no alphanumeric run at all (pure
/// punctuation) is unfilterable and always kept.
///
/// Why it matters: without it EVERY dictionary entry entered the pseudonym map,
/// making each request O(text × whole dictionary) — 60k chars against a
/// 2000-entity dictionary measured at tens of seconds — and minting a
/// `cloak_maps` row for every entity the user never actually mentioned.
fn key_can_occur(key: &str, tokens: &HashSet<String>) -> bool {
    let mut run = String::new();
    for c in key.chars() {
        if c.is_alphanumeric() {
            run.push(c);
        } else if !run.is_empty() {
            if !tokens.contains(&run) {
                return false;
            }
            run.clear();
        }
    }
    if !run.is_empty() && !tokens.contains(&run) {
        return false;
    }
    true
}

/// PURE: gather the cloak candidates that can actually occur in `text` — the
/// pre-filtered dictionary plus the PII regex sweep (whose hits come FROM the
/// text, so they are present by construction) — as a
/// `lower_key -> (kind, canonical original text)` map. No DB.
fn collect_prepared(
    prepared: &[PreparedCandidate],
    text: &str,
) -> HashMap<String, (Option<String>, String)> {
    let tokens = text_tokens(text);
    let mut seen: HashMap<String, (Option<String>, String)> = HashMap::new();
    for (key, kind, canonical) in prepared {
        if !key_can_occur(key, &tokens) {
            continue;
        }
        seen.entry(key.clone()).or_insert_with(|| (kind.clone(), canonical.clone()));
    }
    for (val, kind) in find_pii(text) {
        let key = lower_key(&val);
        seen.entry(key).or_insert_with(|| (Some(kind.to_string()), val));
    }
    seen
}

/// PURE: [`collect_prepared`] straight from a raw dictionary. Test-only — every
/// production path goes through [`cloak_batch`], which prepares the dictionary
/// once and reuses it across all texts of the request.
#[cfg(test)]
fn collect_candidates(
    candidates: &[EntityCandidate],
    text: &str,
) -> HashMap<String, (Option<String>, String)> {
    collect_prepared(&prepare_candidates(candidates), text)
}

/// PURE: longest-match-first, case-insensitive substitution of `text` using an
/// already-resolved `lower_key -> pseudonym` map. Non-candidate text is copied
/// through unchanged (byte-for-byte via the original `chars`).
pub fn apply_pseudonyms(text: &str, key_to_pseudonym: &HashMap<String, String>) -> String {
    if key_to_pseudonym.is_empty() {
        return text.to_string();
    }
    // Fold each key into chars ONCE. The previous shape re-counted the key's
    // chars and heap-allocated a window `String` for every (position × key)
    // pair — the O(text × dictionary) cost behind the multi-second cloak
    // overhead on long chat prompts.
    let mut keys: Vec<(Vec<char>, &str)> = key_to_pseudonym
        .iter()
        .map(|(k, p)| (k.chars().collect::<Vec<char>>(), p.as_str()))
        .filter(|(k, _)| !k.is_empty())
        .collect();
    // Longest first, so a longer entity always wins over one that prefixes it.
    keys.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));
    // Bucket by first char (the sort order carries into each bucket, keeping
    // longest-match-first intact): a position whose char starts no key costs one
    // hash lookup instead of a full sweep over the dictionary.
    let mut by_first: HashMap<char, Vec<usize>> = HashMap::new();
    for (n, (k, _)) in keys.iter().enumerate() {
        by_first.entry(k[0]).or_default().push(n);
    }

    let chars: Vec<char> = text.chars().collect();
    let lower_chars: Vec<char> = text.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect();

    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    'outer: while i < chars.len() {
        if let Some(bucket) = by_first.get(&lower_chars[i]) {
            for &n in bucket {
                let (key, pseudonym) = &keys[n];
                let klen = key.len();
                if i + klen > lower_chars.len() || lower_chars[i..i + klen] != key[..] {
                    continue;
                }
                // WORD-BOUNDARY guard: a key must never match INSIDE a word. Without
                // this, a short graph entity like "LAN" cloaked the middle of "plant"
                // → "pTerm-781t", and an "…EUR"-suffixed amount entity ate "Eur" out
                // of "Euro" → "[AMOUNT-156]o" — garbling the text the cloud model has
                // to reason over AND leaking word-shape structure. (Both observed
                // live in the mock-cloud gateway proof.)
                let before_ok = i == 0 || !chars[i - 1].is_alphanumeric();
                let after_ok = i + klen >= chars.len() || !chars[i + klen].is_alphanumeric();
                if before_ok && after_ok {
                    out.push_str(pseudonym);
                    i += klen;
                    continue 'outer;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// De-cloak: replace every pseudonym in `text` with its canonical original.
/// Pure, exact (non-overlapping) string replacement — pseudonyms are unique,
/// generated tokens so a naive `.replace()` per pseudonym is safe and simple.
pub fn decloak(session: &CloakSession, text: &str) -> String {
    if session.map.is_empty() {
        return text.to_string();
    }
    let mut keys: Vec<&String> = session.map.keys().collect();
    // Longest-first: robust even if a future numbering scheme ever produces
    // one pseudonym as a substring of another (not true today, but cheap to
    // guarantee).
    keys.sort_by_key(|k| std::cmp::Reverse(k.len()));
    let mut out = text.to_string();
    for pseudonym in keys {
        // `replace` allocates a fresh String even on a total miss, and the
        // streaming path calls this for every emitted chunk — skip the misses.
        if !out.contains(pseudonym.as_str()) {
            continue;
        }
        out = out.replace(pseudonym.as_str(), &session.map[pseudonym]);
    }
    out
}

/// Streaming-safe decloak for SSE: pseudonyms are opaque tokens that can be
/// split across two provider chunk boundaries (e.g. `"Person-` then `"7"`).
/// `buffer` holds text received so far that hasn't been proven safe to emit
/// yet; call this on every new `chunk`, emit the returned text immediately,
/// and call [`decloak_stream_finish`] at end-of-stream to flush what's held.
///
/// Strategy: always hold back the last `(max_pseudonym_len - 1)` characters —
/// long enough that ANY pseudonym starting in that tail could still complete
/// on the next push — and only decloak/emit the prefix in front of that tail.
pub fn decloak_stream_chunk(session: &CloakSession, buffer: &mut String, chunk: &str) -> String {
    buffer.push_str(chunk);
    if session.map.is_empty() {
        return std::mem::take(buffer);
    }
    let chars: Vec<char> = buffer.chars().collect();
    let total = chars.len();
    let max_len = session.map.keys().map(|k| k.chars().count()).max().unwrap_or(0);
    let hold = max_len.saturating_sub(1);
    if total <= hold {
        return String::new();
    }
    // Candidate cut: emit everything except the last `hold` chars. That alone
    // only protects a pseudonym STARTING in the tail — one that starts in the
    // emitted prefix and crosses the cut gets split ("Term-2|74") and the raw
    // prefix half leaks to the client (observed live: "Term-274 wird von …").
    // So: slide the cut LEFT onto the start of any pseudonym(-prefix) that
    // crosses it; that occurrence is then emitted complete on a later push
    // (or by decloak_stream_finish).
    let mut cut = total - hold;
    let keys: Vec<Vec<char>> = session.map.keys().map(|k| k.chars().collect()).collect();
    let scan_from = cut.saturating_sub(hold);
    'scan: for j in scan_from..cut {
        let avail = total - j;
        for k in &keys {
            if k.len() <= cut - j {
                continue; // liegt vollständig vor dem Cut — decloak(ready) ersetzt es
            }
            let take = avail.min(k.len());
            if take > 0 && chars[j..j + take] == k[..take] {
                cut = j;
                break 'scan;
            }
        }
    }
    if cut == 0 {
        return String::new();
    }
    let split_byte = buffer
        .char_indices()
        .nth(cut)
        .map(|(b, _)| b)
        .unwrap_or(buffer.len());
    let ready = buffer[..split_byte].to_string();
    *buffer = buffer[split_byte..].to_string();
    decloak(session, &ready)
}

/// Flush whatever remains in `buffer` at end-of-stream (decloaked).
pub fn decloak_stream_finish(session: &CloakSession, buffer: &mut String) -> String {
    decloak(session, &std::mem::take(buffer))
}

/// Fetch-or-assign a stable pseudonym for `entity_key` within `compilation_id`.
/// Sequential numbering per (compilation, bucket) via `COUNT(*) ... LIKE`; a
/// small retry loop absorbs the rare race where two concurrent requests pick
/// the same next index (the `UNIQUE (compilation_id, pseudonym)` constraint
/// rejects the loser, which just recounts and retries). Not unit-tested (it's
/// a thin DB upsert) — the pure matching/substitution logic it feeds IS
/// covered by the tests below; the persisted-stability property itself is
/// verified via the live smoke test (README/README verification section).
async fn next_pseudonym(
    db: &sqlx::PgPool,
    compilation_id: Uuid,
    entity_key: &str,
    prefix: &str,
    bracketed: bool,
) -> String {
    if let Ok(Some(existing)) = sqlx::query_scalar::<_, String>(
        "SELECT pseudonym FROM cloak_maps WHERE compilation_id=$1 AND entity_key=$2",
    )
    .bind(compilation_id)
    .bind(entity_key)
    .fetch_optional(db)
    .await
    {
        return existing;
    }

    let like_pattern = if bracketed { format!("[{prefix}-%") } else { format!("{prefix}-%") };
    for _ in 0..8 {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM cloak_maps WHERE compilation_id=$1 AND pseudonym LIKE $2",
        )
        .bind(compilation_id)
        .bind(&like_pattern)
        .fetch_one(db)
        .await
        .unwrap_or(0);
        let idx = count + 1;
        let candidate = if bracketed { format!("[{prefix}-{idx}]") } else { format!("{prefix}-{idx}") };

        let inserted: Option<(String,)> = sqlx::query_as(
            "INSERT INTO cloak_maps (compilation_id, entity_key, pseudonym) VALUES ($1,$2,$3)
             ON CONFLICT (compilation_id, entity_key) DO NOTHING RETURNING pseudonym",
        )
        .bind(compilation_id)
        .bind(entity_key)
        .bind(&candidate)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
        if let Some((p,)) = inserted {
            return p;
        }
        // Either entity_key already existed (race: another call won) or the
        // pseudonym collided with a different entity_key. Check the former
        // before retrying the latter.
        if let Ok(Some(existing)) = sqlx::query_scalar::<_, String>(
            "SELECT pseudonym FROM cloak_maps WHERE compilation_id=$1 AND entity_key=$2",
        )
        .bind(compilation_id)
        .bind(entity_key)
        .fetch_optional(db)
        .await
        {
            return existing;
        }
    }
    // Unreachable in practice; keeps cloaking from ever hard-failing under
    // pathological contention.
    format!("{prefix}-{}", Uuid::new_v4().simple())
}

/// Cloak `text`: pseudonymize every candidate entity mention + PII hit,
/// scoped to `compilation_ids[0]` (the cloak map is per-compilation; when a
/// request spans several compilations — not the common case in today's UI,
/// which scopes a request to one graph — the FIRST id is used as the storage
/// scope. Documented simplification, not a correctness bug: cloaking still
/// happens, just registered under one compilation's map rather than split
/// across several).
///
/// Returns the cloaked text and the [`CloakSession`] needed to de-cloak the
/// answer. `session.map.len()` is the "N entities hidden" count for the
/// response's `privacy` metadata.
pub async fn cloak(
    db: &sqlx::PgPool,
    compilation_ids: &[Uuid],
    candidates: &[EntityCandidate],
    text: &str,
) -> (String, CloakSession) {
    let (mut texts, session) = cloak_batch(db, compilation_ids, candidates, &[text]).await;
    (texts.pop().unwrap_or_else(|| text.to_string()), session)
}

/// Cloak SEVERAL texts of one request (e.g. every message of a chat completion)
/// against one shared pseudonym resolution: the candidate sets are unioned, the
/// registry is read ONCE, and the resulting map is applied to each text. Same
/// semantics as [`cloak`] per text — the only difference is that N messages cost
/// one database round trip instead of N.
///
/// Returns one cloaked string per input (same order) and the merged
/// [`CloakSession`] needed to de-cloak the answer.
pub async fn cloak_batch(
    db: &sqlx::PgPool,
    compilation_ids: &[Uuid],
    candidates: &[EntityCandidate],
    texts: &[&str],
) -> (Vec<String>, CloakSession) {
    let mut session = CloakSession::empty();
    let verbatim = || texts.iter().map(|t| t.to_string()).collect::<Vec<String>>();
    let Some(primary) = compilation_ids.first().copied() else {
        return (verbatim(), session);
    };
    // Fold the dictionary once, then narrow it per text to what can actually
    // occur there, and union the results.
    let prepared = prepare_candidates(candidates);
    let mut seen: HashMap<String, (Option<String>, String)> = HashMap::new();
    for text in texts {
        for (key, val) in collect_prepared(&prepared, text) {
            seen.entry(key).or_insert(val);
        }
    }
    if seen.is_empty() {
        return (verbatim(), session);
    }

    // ROUNDTRIP 1 (the hot-path win): batch-fetch every already-assigned
    // pseudonym for the seen keys in ONE query. A warm graph (entities recur
    // across chat turns) resolves fully here — turning the old N sequential
    // per-entity SELECTs (the ~1 s cloak TTFT overhead) into a single read.
    let keys: Vec<String> = seen.keys().cloned().collect();
    let existing: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT entity_key, pseudonym FROM cloak_maps WHERE compilation_id=$1 AND entity_key = ANY($2)",
    )
    .bind(primary)
    .bind(&keys)
    .fetch_all(db)
    .await
    .unwrap_or_default()
    .into_iter()
    .collect();

    let mut key_to_pseudonym: HashMap<String, String> = HashMap::with_capacity(seen.len());
    for (key, (kind, canonical)) in &seen {
        let pseudonym = if let Some(p) = existing.get(key) {
            p.clone()
        } else {
            // First time this entity is seen in this compilation — assign now
            // (per-key, concurrency-safe). Only ever runs once per entity's
            // lifetime, so it's off the recurring hot path.
            let (prefix, bracketed) = bucket_template(kind.as_deref());
            next_pseudonym(db, primary, key, prefix, bracketed).await
        };
        session.map.insert(pseudonym.clone(), canonical.clone());
        key_to_pseudonym.insert(key.clone(), pseudonym);
    }
    let cloaked = texts
        .iter()
        .map(|t| apply_pseudonyms(t, &key_to_pseudonym))
        .collect();
    (cloaked, session)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(name: &str, kind: Option<&str>) -> EntityCandidate {
        EntityCandidate { name: name.to_string(), kind: kind.map(|s| s.to_string()) }
    }

    // ── is_cloud_target matrix ────────────────────────────────────────────

    #[test]
    fn cloud_providers_always_cloud() {
        assert!(is_cloud_target("openai", None, None));
        assert!(is_cloud_target("anthropic", None, None));
        assert!(is_cloud_target("openrouter", None, None));
        assert!(is_cloud_target("ollama_cloud", None, None));
        assert!(is_cloud_target("OpenAI", None, None), "provider match must be case-insensitive");
    }

    #[test]
    fn ollama_no_base_is_local() {
        assert!(!is_cloud_target("ollama", None, None));
    }

    #[test]
    fn ollama_localhost_and_lan_are_local() {
        assert!(!is_cloud_target("ollama", Some("http://localhost:11434"), None));
        assert!(!is_cloud_target("ollama", Some("http://127.0.0.1:11434"), None));
        assert!(!is_cloud_target("ollama", Some("http://10.0.0.5:11434"), None));
        assert!(!is_cloud_target("ollama", Some("http://192.168.1.50:11434"), None));
        assert!(!is_cloud_target("ollama", Some("http://172.16.0.9:11434"), None));
        assert!(!is_cloud_target("ollama", Some("http://ollama:11434"), None), "docker service name (no dot) is local");
        assert!(!is_cloud_target("openai_compatible", Some("http://gctrl-llamacpp:8080"), None));
    }

    #[test]
    fn ollama_cloud_host_is_cloud() {
        assert!(is_cloud_target("ollama", Some("https://ollama.com"), None));
        assert!(is_cloud_target("ollama", Some("https://api.ollama.com"), None));
    }

    #[test]
    fn cloud_model_tag_overrides_local_host() {
        // A `*-cloud` / `*:cloud` model served through a localhost Ollama proxy is
        // still CLOUD — the tag wins so cloaking engages instead of leaking plaintext.
        assert!(is_cloud_target("ollama", Some("http://localhost:11434"), Some("gpt-oss:120b-cloud")));
        assert!(is_cloud_target("ollama", Some("http://127.0.0.1:11434"), Some("qwen3:cloud")));
        assert!(!is_cloud_target("ollama", Some("http://localhost:11434"), Some("llama3.2")), "a plain local model stays local");
    }

    #[test]
    fn openai_compatible_public_host_is_cloud() {
        assert!(is_cloud_target("openai_compatible", Some("https://my-llm.example.com"), None));
        assert!(is_cloud_target("openai_compatible", Some("https://api.together.xyz"), None));
    }

    #[test]
    fn openai_compatible_invalid_base_falls_back_local() {
        // An unparsable base fails safe to "local" here (this heuristic never
        // blocks on its own malformed input — the SSRF guard in services::llm
        // is the layer responsible for rejecting bad URLs outright).
        assert!(!is_cloud_target("openai_compatible", Some("not a url"), None));
    }

    // ── apply_pseudonyms: longest-match + case-insensitive ───────────────

    #[test]
    fn longest_match_wins_over_prefix() {
        let mut map = HashMap::new();
        map.insert(lower_key("Anna Schmidt-Weber"), "Person-1".to_string());
        map.insert(lower_key("Anna Schmidt"), "Person-2".to_string());
        let out = apply_pseudonyms("Anna Schmidt-Weber called Anna Schmidt yesterday.", &map);
        assert_eq!(out, "Person-1 called Person-2 yesterday.");
    }

    #[test]
    fn matching_is_case_insensitive() {
        let mut map = HashMap::new();
        map.insert(lower_key("Fabio"), "Person-1".to_string());
        let out = apply_pseudonyms("FABIO met fabio and Fabio.", &map);
        assert_eq!(out, "Person-1 met Person-1 and Person-1.");
    }

    #[test]
    fn non_candidate_text_passes_through_unchanged() {
        let mut map = HashMap::new();
        map.insert(lower_key("Fabio"), "Person-1".to_string());
        let out = apply_pseudonyms("The weather in Berlin is nice today.", &map);
        assert_eq!(out, "The weather in Berlin is nice today.");
    }

    // ── decloak roundtrip ─────────────────────────────────────────────────

    #[test]
    fn decloak_roundtrip_restores_canonical_original() {
        let mut map = HashMap::new();
        map.insert(lower_key("Fabio Chiaramonte"), "Person-1".to_string());
        let cloaked = apply_pseudonyms("Fabio Chiaramonte emailed the board.", &map);
        assert_eq!(cloaked, "Person-1 emailed the board.");

        let mut session = CloakSession::empty();
        session.map.insert("Person-1".to_string(), "Fabio Chiaramonte".to_string());
        let restored = decloak(&session, &cloaked);
        assert_eq!(restored, "Fabio Chiaramonte emailed the board.");
    }

    #[test]
    fn decloak_is_noop_for_empty_session() {
        let session = CloakSession::empty();
        assert_eq!(decloak(&session, "unchanged text"), "unchanged text");
    }

    // ── stream-split decloak ──────────────────────────────────────────────

    #[test]
    fn stream_decloak_handles_pseudonym_split_across_chunks() {
        let mut session = CloakSession::empty();
        session.map.insert("Person-7".to_string(), "Fabio Chiaramonte".to_string());

        let mut buf = String::new();
        let mut emitted = String::new();
        // Split the token right in the middle: "Hi Person-" | "7, welcome"
        emitted += &decloak_stream_chunk(&session, &mut buf, "Hi Person-");
        emitted += &decloak_stream_chunk(&session, &mut buf, "7, welcome");
        emitted += &decloak_stream_finish(&session, &mut buf);

        assert_eq!(emitted, "Hi Fabio Chiaramonte, welcome");
    }

    #[test]
    fn stream_decloak_passthrough_when_no_cloaking_active() {
        let session = CloakSession::empty();
        let mut buf = String::new();
        let mut emitted = String::new();
        emitted += &decloak_stream_chunk(&session, &mut buf, "hello ");
        emitted += &decloak_stream_chunk(&session, &mut buf, "world");
        emitted += &decloak_stream_finish(&session, &mut buf);
        assert_eq!(emitted, "hello world");
    }

    // ── candidate collection / bucket stability ──────────────────────────

    #[test]
    fn same_entity_different_casing_collapses_to_one_key() {
        let candidates = vec![cand("Fabio", Some("person")), cand("FABIO", Some("person")), cand("fabio", Some("person"))];
        let seen = collect_candidates(&candidates, "FABIO und fabio sprachen mit Fabio.");
        assert_eq!(seen.len(), 1, "case variations of the same entity must be one key");
    }

    #[test]
    fn a_text_that_names_nobody_cloaks_nothing() {
        let candidates = vec![cand("Fabio", Some("person")), cand("Cyberiade", Some("organization"))];
        assert!(
            collect_candidates(&candidates, "Wie ist das Wetter morgen?").is_empty(),
            "entities absent from the text must never enter the pseudonym map"
        );
        assert!(collect_candidates(&candidates, "").is_empty(), "empty text cloaks nothing");
    }

    #[test]
    fn prefilter_keeps_multi_word_and_punctuated_keys_that_can_still_match() {
        // Every alphanumeric run of a key must be present as a whole token —
        // "12,5 Mio. EUR" survives on a text carrying all four runs, and a key
        // whose LAST run is missing is dropped even though its first one matches.
        let candidates = vec![
            cand("12,5 Mio. EUR", Some("money")),
            cand("Anna Schmidt", Some("person")),
            cand("Anna Weber", Some("person")),
        ];
        let seen = collect_candidates(&candidates, "Budget: 12,5 Mio. EUR — freigegeben von Anna Schmidt.");
        let names: Vec<&String> = seen.values().map(|(_, canonical)| canonical).collect();
        assert!(names.iter().any(|n| n.as_str() == "12,5 Mio. EUR"));
        assert!(names.iter().any(|n| n.as_str() == "Anna Schmidt"));
        assert!(!names.iter().any(|n| n.as_str() == "Anna Weber"), "'Weber' never appears");
    }

    #[test]
    fn narrowing_the_dictionary_does_not_change_the_cloaked_text() {
        // The pre-filter must be a pure COST optimisation: what the cloud model
        // receives has to be byte-identical to substituting with the entire
        // dictionary. (It is: an entity absent from the text cannot match, so
        // carrying it in the map only ever cost time.)
        let names = [
            "LAN", "Anna Schmidt", "Anna Schmidt-Weber", "12,5 Mio. EUR",
            "Ground Control", "Projekt Nordwind", "Björn Öztürk", "ACME & Co.",
        ];
        let candidates: Vec<EntityCandidate> = names.iter().map(|n| cand(n, Some("person"))).collect();
        let full: HashMap<String, String> = names
            .iter()
            .enumerate()
            .map(|(n, name)| (lower_key(name), format!("Person-{n}")))
            .collect();
        for text in [
            "Anna Schmidt-Weber plant 12,5 Mio. EUR fuer Projekt Nordwind im LAN.",
            "Die Anlage plant mehr Euro, Björn Öztürk widerspricht.",
            "GROUND CONTROL und ACME & Co. sprachen mit Anna Schmidt.",
            "Nichts hiervon nennt eine Entitaet.",
        ] {
            let narrowed: HashMap<String, String> = collect_candidates(&candidates, text)
                .keys()
                .map(|k| (k.clone(), full[k].clone()))
                .collect();
            assert_eq!(
                apply_pseudonyms(text, &narrowed),
                apply_pseudonyms(text, &full),
                "narrowing changed what the cloud model sees for {text:?}"
            );
        }
    }

    #[test]
    fn prefilter_never_drops_a_key_the_substitution_would_have_matched() {
        // The pre-filter must be EXACT, not a heuristic: for a corpus of tricky
        // keys and texts, "survives the filter" must agree with "actually
        // substitutes" on every pair — otherwise an entity leaks in plaintext.
        let names = [
            "LAN", "Anna Schmidt", "Anna Schmidt-Weber", "12,5 Mio. EUR", "Ground Control",
            "GCTRL", "Projekt Nordwind", "Björn Öztürk", "ACME & Co.", "x9",
        ];
        let candidates: Vec<EntityCandidate> = names.iter().map(|n| cand(n, None)).collect();
        let texts = [
            "Das LAN ist offline.", "Die Anlage plant mehr.", "Anna Schmidt-Weber rief an.",
            "Anna Schmidt rief an.", "Budget 12,5 Mio. EUR heute.", "12,5 Mio. USD heute.",
            "GROUND CONTROL steuert das.", "gctrl/anvil läuft.", "Björn Öztürk kam.",
            "ACME & Co. liefert.", "ACME liefert.", "Wert x9 gesetzt.", "Wert x99 gesetzt.",
            "Nichts davon hier.", "",
        ];
        for text in texts {
            let survived = collect_candidates(&candidates, text);
            for name in names {
                let key = lower_key(name);
                let mut only = HashMap::new();
                only.insert(key.clone(), "PSEUDO".to_string());
                let substitutes = apply_pseudonyms(text, &only) != text;
                assert!(
                    !substitutes || survived.contains_key(&key),
                    "pre-filter dropped {name:?} although it substitutes in {text:?} — that entity would leak"
                );
            }
        }
    }

    #[test]
    fn bucket_template_maps_known_types() {
        assert_eq!(bucket_template(Some("person")), ("Person", false));
        assert_eq!(bucket_template(Some("organization")), ("Org", false));
        assert_eq!(bucket_template(Some("location")), ("Place", false));
        assert_eq!(bucket_template(Some("date")), ("DATE", true));
        assert_eq!(bucket_template(Some("money")), ("AMOUNT", true));
        assert_eq!(bucket_template(Some("quantity")), ("NUM", true));
        assert_eq!(bucket_template(Some("email")), ("EMAIL", true));
        assert_eq!(bucket_template(None), ("Term", false));
        assert_eq!(bucket_template(Some("unknown-weird-type")), ("Term", false));
    }

    // ── free-chat dictionary: dedup + cap ────────────────────────────────

    fn mentions(items: &[(&str, &str)]) -> serde_json::Value {
        serde_json::Value::Array(
            items
                .iter()
                .map(|(name, kind)| serde_json::json!({ "name": name, "type": kind }))
                .collect(),
        )
    }

    #[test]
    fn dictionary_dedups_by_name_across_chunks() {
        // "Fabio" appears in three chunks with different casing → one entry.
        let arrays = vec![
            mentions(&[("Fabio", "person"), ("Cyberiade", "organization")]),
            mentions(&[("FABIO", "person")]),
            mentions(&[("fabio", "person")]),
        ];
        let out = candidates_from_mentions_capped(&arrays, 2000);
        let fabio_count = out.iter().filter(|c| lower_key(&c.name) == "fabio").count();
        assert_eq!(fabio_count, 1, "case variants of one entity collapse to one dictionary entry");
        assert_eq!(out.len(), 2, "Fabio + Cyberiade");
    }

    #[test]
    fn dictionary_cap_keeps_most_frequent() {
        // "Common" mentioned 3×, "Rare" once; cap=1 must keep the frequent one.
        let arrays = vec![
            mentions(&[("Common", "person"), ("Rare", "person")]),
            mentions(&[("Common", "person")]),
            mentions(&[("Common", "person")]),
        ];
        let out = candidates_from_mentions_capped(&arrays, 1);
        assert_eq!(out.len(), 1, "cap is honoured");
        assert_eq!(lower_key(&out[0].name), "common", "the most-mentioned entity survives the cap");
    }

    #[test]
    fn dictionary_drops_blank_and_single_char_names() {
        let arrays = vec![mentions(&[("", "person"), ("X", "person"), ("Ok", "person")])];
        let out = candidates_from_mentions_capped(&arrays, 2000);
        assert_eq!(out.len(), 1, "empty and <2-char names are excluded");
        assert_eq!(out[0].name, "Ok");
    }

    #[test]
    fn apply_pseudonyms_respects_word_boundaries() {
        let mut map = HashMap::new();
        map.insert("lan".to_string(), "Term-1".to_string());
        map.insert("12,5 mio. eur".to_string(), "[AMOUNT-2]".to_string());
        map.insert("tom arenstam".to_string(), "Person-3".to_string());
        // Inside-word matches must NOT fire ("plant" contains "lan"; "Euro" ends
        // beyond the "…EUR" key) — the mock-cloud proof caught both garbling text.
        let out = apply_pseudonyms("Tom Arenstam plant 12,5 Mio. Euro im LAN.", &map);
        assert_eq!(out, "Person-3 plant 12,5 Mio. Euro im Term-1.");
        // Whole-word / punctuation-bounded matches still fire.
        assert_eq!(apply_pseudonyms("LAN", &map), "Term-1");
        assert_eq!(apply_pseudonyms("(lan)", &map), "(Term-1)");
        assert_eq!(apply_pseudonyms("Budget: 12,5 Mio. EUR heute", &map), "Budget: [AMOUNT-2] heute");
    }

    #[test]
    fn decloak_stream_never_leaks_a_cut_straddling_pseudonym() {
        // Live-observed leak: "Term-274" split at the hold boundary emitted
        // "Term-2" raw. Fuzz EVERY possible 2-chunk split of a response whose
        // pseudonyms sit at the start, middle and end — output must always
        // decloak completely, regardless of where the SSE chunking cuts.
        let mut map = HashMap::new();
        map.insert("Term-274".to_string(), "ScanModule".to_string());
        map.insert("Person-27".to_string(), "Tom Arenstam".to_string());
        let session = CloakSession { map };
        let text = "Term-274 wird von Person-27 entwickelt und Person-27 pflegt Term-274";
        let want = "ScanModule wird von Tom Arenstam entwickelt und Tom Arenstam pflegt ScanModule";
        let n = text.chars().count();
        for split in 0..=n {
            let a: String = text.chars().take(split).collect();
            let b: String = text.chars().skip(split).collect();
            let mut buffer = String::new();
            let mut out = String::new();
            out.push_str(&decloak_stream_chunk(&session, &mut buffer, &a));
            out.push_str(&decloak_stream_chunk(&session, &mut buffer, &b));
            out.push_str(&decloak_stream_finish(&session, &mut buffer));
            assert_eq!(out, want, "leak at split {split}");
        }
        // Und in Einzelzeichen-Chunks (worst case).
        let mut buffer = String::new();
        let mut out = String::new();
        for c in text.chars() {
            out.push_str(&decloak_stream_chunk(&session, &mut buffer, &c.to_string()));
        }
        out.push_str(&decloak_stream_finish(&session, &mut buffer));
        assert_eq!(out, want, "leak in single-char streaming");
    }

    #[test]
    fn pii_regex_finds_email_and_iban() {
        let hits = find_pii("Contact fabio@example.com, IBAN DE89370400440532013000.");
        assert!(hits.iter().any(|(v, k)| v == "fabio@example.com" && *k == "email"));
        assert!(hits.iter().any(|(v, k)| v == "DE89370400440532013000" && *k == "iban"));
    }

    // ── privacy mode strictness ordering ─────────────────────────────────

    // ── request-side cloak cost ───────────────────────────────────────────

    /// Build a realistic free-chat cloak workload: a full-size user dictionary
    /// and a long chat prompt that mentions only a handful of its entities.
    fn long_prompt_workload() -> (Vec<EntityCandidate>, String) {
        let dict: Vec<EntityCandidate> = (0..CANDIDATE_CAP)
            .map(|i| cand(&format!("Projekt Nordwind {i}"), Some("organization")))
            .collect();
        // ~60k chars ≈ the 8–19k-token prompts a real chat turn carries.
        let para = "Der Bericht fasst die Lage zusammen und nennt die offenen Punkte, \
                    ohne dabei neue Zusagen zu machen oder Zahlen zu wiederholen. ";
        let mut text = String::new();
        while text.chars().count() < 60_000 {
            text.push_str(para);
        }
        // Two dictionary entities genuinely appear, the other 1998 do not.
        text.push_str(" Projekt Nordwind 7 arbeitet mit Projekt Nordwind 42 zusammen.");
        (dict, text)
    }

    #[test]
    fn cloak_dictionary_is_narrowed_to_entities_present_in_the_text() {
        // THE hot-path invariant: substitution cost is O(text × entities that
        // can actually match), never O(text × whole dictionary). Before this
        // guard every one of the 2000 dictionary entries entered the pseudonym
        // map — for a 60k-char prompt that is ~120M windowed comparisons per
        // message (measured live on Asgard as +14 s per cloaked turn) and it
        // also minted a cloak_maps row for every entity the user never named.
        let (dict, text) = long_prompt_workload();
        let seen = collect_candidates(&dict, &text);
        let names: Vec<&String> = seen.values().map(|(_, canonical)| canonical).collect();
        assert_eq!(
            seen.len(),
            2,
            "only entities the text actually mentions may be cloaked, got {names:?}"
        );
        assert!(names.iter().any(|n| n.as_str() == "Projekt Nordwind 7"));
        assert!(names.iter().any(|n| n.as_str() == "Projekt Nordwind 42"));
    }

    #[test]
    fn cloaking_a_long_prompt_stays_fast() {
        // Coarse catastrophic-regression net (runs in an UNOPTIMIZED test build,
        // hence the generous bound — the pre-fix implementation took tens of
        // seconds here, so the signal is unambiguous either way).
        let (dict, text) = long_prompt_workload();
        let started = Instant::now();
        let seen = collect_candidates(&dict, &text);
        let map: HashMap<String, String> = seen
            .keys()
            .enumerate()
            .map(|(n, k)| (k.clone(), format!("Org-{n}")))
            .collect();
        let cloaked = apply_pseudonyms(&text, &map);
        let elapsed = started.elapsed();
        eprintln!("cloak of {} chars took {elapsed:?}", text.chars().count());
        assert!(cloaked.contains("Org-"), "the present entities were substituted");
        assert!(
            elapsed < Duration::from_millis(1500),
            "cloaking a 60k-char prompt took {elapsed:?} — the per-request cost is \
             back to O(text × dictionary)"
        );
    }

    #[test]
    fn privacy_mode_ordering_strictest_wins() {
        assert!(PrivacyMode::LocalOnly > PrivacyMode::Cloaked);
        assert!(PrivacyMode::Cloaked > PrivacyMode::Open);
        let modes = [PrivacyMode::Open, PrivacyMode::LocalOnly, PrivacyMode::Cloaked];
        assert_eq!(modes.iter().copied().max(), Some(PrivacyMode::LocalOnly));
    }

    #[test]
    fn privacy_mode_from_db_roundtrip() {
        assert_eq!(PrivacyMode::from_db("open").as_db_str(), "open");
        assert_eq!(PrivacyMode::from_db("cloaked").as_db_str(), "cloaked");
        assert_eq!(PrivacyMode::from_db("local_only").as_db_str(), "local_only");
        assert_eq!(PrivacyMode::from_db("garbage").as_db_str(), "open", "unknown value fails open");
    }
}

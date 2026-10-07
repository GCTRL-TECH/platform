//! OpenAI Responses API adapter for the cloak gateway: `POST /v1/responses`.
//!
//! Two upstreams, picked by `X-Upstream-Provider`:
//! * `chatgpt`: the ChatGPT subscription as the Codex CLI uses it
//!   (`https://chatgpt.com` + [`CHATGPT_CODEX_PATH`] + `/responses`; the caller's
//!   ChatGPT access token travels in `Authorization: Bearer`, the Codex session
//!   headers `chatgpt-account-id`, `originator`, `session-id`, `x-codex-*`, ... are
//!   forwarded to chatgpt.com only);
//! * `openai`: the public Responses API (`https://api.openai.com/v1/responses`).
//!
//! The gctrl token goes in `X-GCTRL-Token`; auth, header allowlist, base pinning and
//! the cloak namespace are shared with the sibling modules (`llm_gateway`).
//!
//! What is cloaked (request side): `instructions`, a string `input`, and the text of
//! every message item in `input[]` (string `content`, or `input_text` /
//! `output_text` parts), for every role. What never is: tool calls and tool
//! outputs of any kind, `reasoning` items (their `summary` and
//! `encrypted_content` are replayed by Codex and must stay byte-identical), images,
//! files, item references, and the keys `tools`, `tool_choice`, `text`,
//! `reasoning`, `metadata`, `prompt_cache_key`, `client_metadata`, `include`,
//! `model`, `store`, `stream`.
//!
//! Response side: [`ResponsesSseDecloaker`] is a pure SSE state machine (no
//! reqwest/axum, so it stays fuzzable). It de-cloaks `output_text` deltas, function
//! call argument deltas (JSON-escaped originals) and custom tool input deltas with
//! per-index rolling buffers, and the matching `.done` / `output_item.done` /
//! `response.completed` payloads. Invariant: for every index the concatenated
//! deltas equal the `.done` text equal the text in `response.completed`; a held-back
//! tail is emitted as an extra delta event right before the event that closes it.
//! Every other event (reasoning, annotations, created/in_progress, errors, unknown)
//! is passed through byte-identical; an event is re-serialized only when its
//! content actually changed.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use futures::StreamExt;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::llm_gateway::{
    authenticate_gateway, cloak_disabled, cloak_namespace, forward_headers, gateway_error_json,
    has_upstream_credential, relay_response_headers, upstream_base, upstream_from_headers,
    upstream_unreachable_message, Upstream, HTTP_NOREDIRECT,
};
use super::llm_gateway_anthropic::{json_escaped_session, relay_error};
use crate::models::AppState;
use crate::services::privacy;

/// Path of the Codex backend on the (host-only, pinned) ChatGPT base.
pub(super) const CHATGPT_CODEX_PATH: &str = "/backend-api/codex";

// ── request cloaker ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResponsesSlot {
    Instructions,
    InputString,
    ItemString(usize),
    ItemPart(usize, usize),
}

/// A message item: `type == "message"`, or no `type` at all but a `role`.
fn is_message_item(item: &Value) -> bool {
    match item.get("type") {
        Some(Value::String(t)) => t == "message",
        Some(_) => false,
        None => item.get("role").is_some_and(Value::is_string),
    }
}

/// Text of an `input_text` / `output_text` content part, when non-empty.
fn part_text(part: &Value) -> Option<&str> {
    match part.get("type").and_then(Value::as_str) {
        Some("input_text") | Some("output_text") => {}
        _ => return None,
    }
    part.get("text").and_then(Value::as_str).filter(|t| !t.is_empty())
}

/// Walk the request in order and return every cloakable text with its slot.
pub(super) fn collect_responses_cloak_texts(body: &Value) -> (Vec<ResponsesSlot>, Vec<String>) {
    let mut slots = Vec::new();
    let mut texts = Vec::new();
    if let Some(Value::String(s)) = body.get("instructions") {
        if !s.is_empty() {
            slots.push(ResponsesSlot::Instructions);
            texts.push(s.clone());
        }
    }
    match body.get("input") {
        Some(Value::String(s)) if !s.is_empty() => {
            slots.push(ResponsesSlot::InputString);
            texts.push(s.clone());
        }
        Some(Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                if !is_message_item(item) {
                    continue;
                }
                match item.get("content") {
                    Some(Value::String(s)) if !s.is_empty() => {
                        slots.push(ResponsesSlot::ItemString(i));
                        texts.push(s.clone());
                    }
                    Some(Value::Array(parts)) => {
                        for (j, p) in parts.iter().enumerate() {
                            if let Some(t) = part_text(p) {
                                slots.push(ResponsesSlot::ItemPart(i, j));
                                texts.push(t.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    (slots, texts)
}

/// Replace only the text of each slot (in order); sibling keys survive.
pub(super) fn write_responses_cloaked_texts(body: &mut Value, slots: &[ResponsesSlot], cloaked: &[String]) {
    for (slot, text) in slots.iter().zip(cloaked) {
        let target = match *slot {
            ResponsesSlot::Instructions => body.get_mut("instructions"),
            ResponsesSlot::InputString => body.get_mut("input"),
            ResponsesSlot::ItemString(i) => body
                .get_mut("input")
                .and_then(|m| m.get_mut(i))
                .and_then(|m| m.get_mut("content")),
            ResponsesSlot::ItemPart(i, j) => body
                .get_mut("input")
                .and_then(|m| m.get_mut(i))
                .and_then(|m| m.get_mut("content"))
                .and_then(|c| c.get_mut(j))
                .and_then(|p| p.get_mut("text")),
        };
        if let Some(t) = target {
            *t = Value::String(text.clone());
        }
    }
}

// ── response walker (non-stream, output_item.done, response.completed) ─────

/// De-cloak one output item: `message` -> `output_text` parts, `function_call` ->
/// `arguments` (raw JSON text, JSON-escaped session), `custom_tool_call` -> `input`.
/// Everything else (reasoning, web search, ...) is left untouched.
pub(super) fn decloak_responses_item(
    session: &privacy::CloakSession,
    json_session: &privacy::CloakSession,
    item: &mut Value,
) {
    match item.get("type").and_then(Value::as_str) {
        Some("message") => {
            if let Some(parts) = item.get_mut("content").and_then(Value::as_array_mut) {
                for p in parts {
                    if p.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(Value::String(t)) = p.get_mut("text") {
                            *t = privacy::decloak(session, t);
                        }
                    }
                }
            }
        }
        Some("function_call") => {
            if let Some(Value::String(a)) = item.get_mut("arguments") {
                *a = privacy::decloak(json_session, a);
            }
        }
        Some("custom_tool_call") => {
            if let Some(Value::String(a)) = item.get_mut("input") {
                *a = privacy::decloak(session, a);
            }
        }
        _ => {}
    }
}

/// De-cloak a response `output` (an array of items, or a single item).
pub(super) fn decloak_responses_output(
    session: &privacy::CloakSession,
    json_session: &privacy::CloakSession,
    output: &mut Value,
) {
    match output {
        Value::Array(items) => items.iter_mut().for_each(|i| decloak_responses_item(session, json_session, i)),
        Value::Object(_) => decloak_responses_item(session, json_session, output),
        _ => {}
    }
}

// ── SSE decloaker ───────────────────────────────────────────────────────────

/// One rolling buffer per streamed field.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
enum BufKey {
    /// `output_text` at (output_index, content_index).
    Text(u64, u64),
    /// function call arguments at output_index (JSON session).
    Args(u64),
    /// custom tool call input at output_index.
    Custom(u64),
}

impl BufKey {
    fn output_index(self) -> u64 {
        match self {
            BufKey::Text(o, _) | BufKey::Args(o) | BufKey::Custom(o) => o,
        }
    }
    fn delta_event(self) -> &'static str {
        match self {
            BufKey::Text(..) => "response.output_text.delta",
            BufKey::Args(_) => "response.function_call_arguments.delta",
            BufKey::Custom(_) => "response.custom_tool_call_input.delta",
        }
    }
}

#[derive(Default)]
struct StreamBuf {
    pending: String,
    item_id: Option<Value>,
}

pub(super) struct ResponsesSseDecloaker {
    session: privacy::CloakSession,
    /// Same pseudonyms, originals JSON-string-escaped: function call arguments are
    /// raw JSON text, so a replacement lands inside a JSON string literal.
    json_session: privacy::CloakSession,
    line_buf: Vec<u8>,
    event_lines: Vec<String>,
    event_name: Option<String>,
    data_lines: Vec<String>,
    bufs: HashMap<BufKey, StreamBuf>,
    out: String,
}

impl ResponsesSseDecloaker {
    pub fn new(session: privacy::CloakSession) -> Self {
        let json_session = json_escaped_session(&session);
        Self {
            session,
            json_session,
            line_buf: Vec::new(),
            event_lines: Vec::new(),
            event_name: None,
            data_lines: Vec::new(),
            bufs: HashMap::new(),
            out: String::new(),
        }
    }

    /// Feed raw upstream bytes; returns the bytes to emit now.
    pub fn feed(&mut self, chunk: &[u8]) -> String {
        self.line_buf.extend_from_slice(chunk);
        while let Some(pos) = self.line_buf.iter().position(|&b| b == b'\n') {
            let rest = self.line_buf.split_off(pos + 1);
            let mut line = std::mem::replace(&mut self.line_buf, rest);
            line.pop(); // the \n
            let line = Self::decode_line(&line);
            self.on_line(line);
        }
        std::mem::take(&mut self.out)
    }

    /// EOF: process a dangling line/event and flush every held tail.
    pub fn finish(&mut self) -> String {
        if !self.line_buf.is_empty() {
            let raw = std::mem::take(&mut self.line_buf);
            let line = Self::decode_line(&raw);
            self.on_line(line);
        }
        if !self.event_lines.is_empty() {
            self.on_event();
        }
        self.flush_where(|_| true, None);
        std::mem::take(&mut self.out)
    }

    fn decode_line(raw: &[u8]) -> String {
        let mut s = String::from_utf8_lossy(raw).into_owned();
        if s.ends_with('\r') {
            s.pop();
        }
        s
    }

    fn on_line(&mut self, line: String) {
        if line.is_empty() {
            self.on_event();
            return;
        }
        if let Some(v) = line.strip_prefix("event:") {
            self.event_name = Some(v.strip_prefix(' ').unwrap_or(v).to_string());
        } else if let Some(v) = line.strip_prefix("data:") {
            self.data_lines.push(v.strip_prefix(' ').unwrap_or(v).to_string());
        }
        // comments, `id:`, `retry:` and unknown fields are only recorded
        self.event_lines.push(line);
    }

    fn session_for(&self, key: BufKey) -> &privacy::CloakSession {
        if matches!(key, BufKey::Args(_)) {
            &self.json_session
        } else {
            &self.session
        }
    }

    fn emit_verbatim(&mut self, lines: &[String]) {
        for l in lines {
            self.out.push_str(l);
            self.out.push('\n');
        }
        self.out.push('\n');
    }

    /// Re-serialized event: replay id/retry/comment lines, then event + data.
    fn emit_rewritten(&mut self, lines: &[String], name: &str, data: &Value) {
        for l in lines {
            if !l.starts_with("event:") && !l.starts_with("data:") {
                self.out.push_str(l);
                self.out.push('\n');
            }
        }
        self.out.push_str(&format!("event: {name}\ndata: {data}\n\n"));
    }

    /// Emit verbatim when `json` still equals `before`, else re-serialized.
    fn emit_if_changed(&mut self, lines: &[String], name: Option<String>, before: &Value, json: &Value) {
        if json == before {
            self.emit_verbatim(lines);
        } else {
            let n = name.unwrap_or_else(|| json.get("type").and_then(Value::as_str).unwrap_or("").to_string());
            self.emit_rewritten(lines, &n, json);
        }
    }

    /// Flush the held tails of every buffer matching `pred` (sorted, deterministic)
    /// as extra delta events. `seq` is the closing event's `sequence_number`.
    fn flush_where(&mut self, pred: impl Fn(BufKey) -> bool, seq: Option<&Value>) {
        let mut keys: Vec<BufKey> = self.bufs.keys().copied().filter(|k| pred(*k)).collect();
        keys.sort_unstable();
        for k in keys {
            self.flush_key(k, None, seq);
        }
    }

    fn flush_key(&mut self, key: BufKey, item_id: Option<&Value>, seq: Option<&Value>) {
        let Some(mut buf) = self.bufs.remove(&key) else { return };
        let tail = privacy::decloak_stream_finish(self.session_for(key), &mut buf.pending);
        if tail.is_empty() {
            return;
        }
        let ty = key.delta_event();
        let mut ev = Map::new();
        ev.insert("type".into(), Value::String(ty.to_string()));
        if let Some(id) = item_id.cloned().or(buf.item_id) {
            ev.insert("item_id".into(), id);
        }
        ev.insert("output_index".into(), json!(key.output_index()));
        if let BufKey::Text(_, c) = key {
            ev.insert("content_index".into(), json!(c));
        }
        ev.insert("delta".into(), Value::String(tail));
        if let Some(s) = seq {
            ev.insert("sequence_number".into(), s.clone());
        }
        self.out.push_str(&format!("event: {ty}\ndata: {}\n\n", Value::Object(ev)));
    }

    fn on_delta(&mut self, lines: &[String], name: Option<String>, mut json: Value, key: BufKey) {
        let Some(original) = json.get("delta").and_then(Value::as_str).map(str::to_string) else {
            self.emit_verbatim(lines);
            return;
        };
        let item_id = json.get("item_id").cloned();
        let session = if matches!(key, BufKey::Args(_)) { &self.json_session } else { &self.session };
        let buf = self.bufs.entry(key).or_default();
        if item_id.is_some() {
            buf.item_id = item_id;
        }
        let emitted = privacy::decloak_stream_chunk(session, &mut buf.pending, &original);
        if emitted == original {
            self.emit_verbatim(lines);
        } else {
            json["delta"] = Value::String(emitted);
            let n = name.unwrap_or_else(|| key.delta_event().to_string());
            self.emit_rewritten(lines, &n, &json);
        }
    }

    fn on_done(&mut self, lines: &[String], name: Option<String>, mut json: Value, key: BufKey, field: &str) {
        let before = json.clone();
        self.flush_key(key, before.get("item_id"), before.get("sequence_number"));
        if let Some(Value::String(s)) = json.get(field) {
            let d = privacy::decloak(self.session_for(key), s);
            json[field] = Value::String(d);
        }
        self.emit_if_changed(lines, name, &before, &json);
    }

    fn on_event(&mut self) {
        let lines = std::mem::take(&mut self.event_lines);
        let name = self.event_name.take();
        let data_lines = std::mem::take(&mut self.data_lines);
        if data_lines.is_empty() {
            self.emit_verbatim(&lines);
            return;
        }
        let data = data_lines.join("\n");
        let mut json: Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => {
                self.emit_verbatim(&lines);
                return;
            }
        };
        let ty = json.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let oi = json.get("output_index").and_then(Value::as_u64);
        let ci = json.get("content_index").and_then(Value::as_u64);
        match (ty.as_str(), oi, ci) {
            ("response.output_text.delta", Some(o), Some(c)) => self.on_delta(&lines, name, json, BufKey::Text(o, c)),
            ("response.function_call_arguments.delta", Some(o), _) => self.on_delta(&lines, name, json, BufKey::Args(o)),
            ("response.custom_tool_call_input.delta", Some(o), _) => {
                self.on_delta(&lines, name, json, BufKey::Custom(o))
            }
            ("response.output_text.done", Some(o), Some(c)) => {
                self.on_done(&lines, name, json, BufKey::Text(o, c), "text")
            }
            ("response.function_call_arguments.done", Some(o), _) => {
                self.on_done(&lines, name, json, BufKey::Args(o), "arguments")
            }
            ("response.custom_tool_call_input.done", Some(o), _) => {
                self.on_done(&lines, name, json, BufKey::Custom(o), "input")
            }
            ("response.content_part.done", Some(o), Some(c)) => {
                let before = json.clone();
                self.flush_key(BufKey::Text(o, c), before.get("item_id"), before.get("sequence_number"));
                if let Some(part) = json.get_mut("part") {
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(Value::String(t)) = part.get_mut("text") {
                            *t = privacy::decloak(&self.session, t);
                        }
                    }
                }
                self.emit_if_changed(&lines, name, &before, &json);
            }
            ("response.output_item.done", Some(o), _) => {
                let before = json.clone();
                self.flush_where(|k| k.output_index() == o, before.get("sequence_number"));
                if let Some(item) = json.get_mut("item") {
                    decloak_responses_item(&self.session, &self.json_session, item);
                }
                self.emit_if_changed(&lines, name, &before, &json);
            }
            ("response.completed" | "response.incomplete" | "response.failed", _, _) => {
                let before = json.clone();
                self.flush_where(|_| true, before.get("sequence_number"));
                if let Some(output) = json.pointer_mut("/response/output") {
                    decloak_responses_output(&self.session, &self.json_session, output);
                }
                self.emit_if_changed(&lines, name, &before, &json);
            }
            _ => self.emit_verbatim(&lines),
        }
    }
}

// ── HTTP handlers ───────────────────────────────────────────────────────────

fn upstream_name(upstream: Upstream) -> &'static str {
    match upstream {
        Upstream::ChatGpt => "ChatGPT",
        _ => "OpenAI",
    }
}

fn provider_label(upstream: Upstream) -> &'static str {
    match upstream {
        Upstream::ChatGpt => "chatgpt",
        Upstream::OpenAi => "openai",
        Upstream::Anthropic => "anthropic",
        Upstream::Ollama => "ollama",
    }
}

fn credential_hint(upstream: Upstream) -> &'static str {
    match upstream {
        Upstream::ChatGpt => {
            "no upstream credential: send Authorization: Bearer <ChatGPT access token> and the gctrl token in X-GCTRL-Token"
        }
        _ => "no upstream credential: send Authorization: Bearer <openai key> and the gctrl token in X-GCTRL-Token",
    }
}

fn responses_url(upstream: Upstream, base: &str) -> String {
    let base = base.trim_end_matches('/');
    match upstream {
        Upstream::ChatGpt => format!("{base}{CHATGPT_CODEX_PATH}/responses"),
        _ => format!("{base}/v1/responses"),
    }
}

fn responses_models_url(upstream: Upstream, base: &str, query: Option<&str>) -> String {
    let base = base.trim_end_matches('/');
    let url = match upstream {
        Upstream::ChatGpt => format!("{base}{CHATGPT_CODEX_PATH}/models"),
        _ => format!("{base}/v1/models"),
    };
    match query.filter(|q| !q.is_empty()) {
        Some(q) => format!("{url}?{q}"),
        None => url,
    }
}

/// Only `POST /v1/responses`; `/v1/responses/compact` and the rest of
/// `/v1/responses/*` fall through to the `/v1/*rest` 404.
pub(super) fn router() -> Router<Arc<AppState>> {
    Router::new().route("/v1/responses", post(responses))
}

/// `X-Upstream-Provider` must be `chatgpt` or `openai` on this endpoint.
fn responses_upstream(headers: &HeaderMap) -> Result<Upstream, Response> {
    match upstream_from_headers(headers)? {
        u @ (Upstream::ChatGpt | Upstream::OpenAi) => Ok(u),
        _ => Err(gateway_error_json(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "/v1/responses needs X-Upstream-Provider: chatgpt or openai",
        )),
    }
}

/// Provider + auth + upstream credential + upstream base, in fail-closed order
/// (nothing is sent upstream before all of it passes).
struct Gate {
    upstream: Upstream,
    user_id: Uuid,
    fwd: HeaderMap,
    base: String,
}

async fn gate(state: &Arc<AppState>, headers: &HeaderMap) -> Result<Gate, Response> {
    let upstream = responses_upstream(headers)?;
    let Some(identity) = authenticate_gateway(state, headers).await else {
        return Err(gateway_error_json(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid gctrl token (send it in X-GCTRL-Token, or as `ApiKey <token>` / `Bearer <token>` in Authorization)",
        ));
    };
    if !has_upstream_credential(headers, upstream, identity.consumed_authorization) {
        return Err(gateway_error_json(StatusCode::UNAUTHORIZED, "unauthorized", credential_hint(upstream)));
    }
    let base = upstream_base(upstream).map_err(|e| {
        gateway_error_json(StatusCode::INTERNAL_SERVER_ERROR, "api_error", format!("invalid upstream base: {e}"))
    })?;
    Ok(Gate {
        upstream,
        user_id: identity.claims.sub,
        fwd: forward_headers(headers, upstream, identity.consumed_authorization),
        base,
    })
}

/// Traced wrapper: one CHAIN span per gateway request, exported to Phoenix when
/// enabled. Delegates so every early return of the inner handler is captured.
async fn responses(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> Response {
    use tracing::Instrument;
    let model = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let provider = upstream_from_headers(&headers).map(provider_label).unwrap_or("invalid");
    let span = tracing::info_span!(
        "gctrl.cloak_gateway",
        "openinference.span.kind" = "CHAIN",
        "llm.model_name" = %model,
        "gctrl.cloaked" = !cloak_disabled(&headers),
        "gctrl.upstream" = provider,
        "gctrl.route" = "/v1/responses",
        "http.status_code" = tracing::field::Empty,
    );
    let resp = responses_inner(state, headers, body).instrument(span.clone()).await;
    span.record("http.status_code", resp.status().as_u16());
    resp
}

async fn responses_inner(state: Arc<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let g = match gate(&state, &headers).await {
        Ok(g) => g,
        Err(r) => return r,
    };
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return gateway_error_json(StatusCode::BAD_REQUEST, "invalid_request_error", format!("invalid JSON body: {e}"))
        }
    };
    let model = parsed.get("model").and_then(Value::as_str).unwrap_or("").to_string();
    let stream = parsed.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let url = responses_url(g.upstream, &g.base);
    let name = upstream_name(g.upstream);

    // Every request on this route is a cloud egress; the toggle is the only opt-out.
    if cloak_disabled(&headers) {
        return proxy_passthrough_responses(name, reqwest::Method::POST, url, g.fwd, Some(body)).await;
    }
    let (out_bytes, session) = match cloak_responses_request(&state, g.user_id, parsed, &model).await {
        Ok(x) => x,
        Err(r) => return r,
    };
    if stream {
        proxy_stream_decloaked_responses(name, url, g.fwd, out_bytes, session).await
    } else {
        proxy_once_decloaked_responses(name, url, g.fwd, out_bytes, session).await
    }
}

/// `GET /v1/models` for `chatgpt` / `openai` (handed over by the anthropic module,
/// which owns the route): plain proxy, no prompt content, but gctrl auth and an
/// upstream credential are still required.
pub(super) async fn models_passthrough(state: Arc<AppState>, headers: HeaderMap, query: Option<String>) -> Response {
    let g = match gate(&state, &headers).await {
        Ok(g) => g,
        Err(r) => return r,
    };
    let url = responses_models_url(g.upstream, &g.base, query.as_deref());
    proxy_passthrough_responses(upstream_name(g.upstream), reqwest::Method::GET, url, g.fwd, None).await
}

/// Cloak the request body. FAIL CLOSED: no owned compilation -> 422, any
/// encode/length problem -> 500; plaintext is never returned as a fallback.
async fn cloak_responses_request(
    state: &Arc<AppState>,
    user_id: Uuid,
    mut body: Value,
    model: &str,
) -> Result<(Bytes, privacy::CloakSession), Response> {
    let Some(namespace) = cloak_namespace(state, user_id).await else {
        return Err(gateway_error_json(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloak_unavailable",
            "cloaking required but this account owns no knowledge base to anchor the cloak map - create one, or send X-Anvil-Cloak: off to route plaintext.",
        ));
    };
    let candidates = privacy::user_entity_candidates(&state.db, user_id).await;
    let (slots, plain) = collect_responses_cloak_texts(&body);
    let refs: Vec<&str> = plain.iter().map(String::as_str).collect();
    let (cloaked, session) = privacy::cloak_batch(&state.db, &[namespace], &candidates, &refs).await;
    // write_responses_cloaked_texts zips: a short result would leave plaintext slots.
    if cloaked.len() != slots.len() {
        return Err(gateway_error_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cloak_error",
            "cloak result does not match the request texts",
        ));
    }
    write_responses_cloaked_texts(&mut body, &slots, &cloaked);
    tracing::debug!(
        "llm_gateway_responses: cloaked {} entities for user {} (model {})",
        session.map.len(),
        user_id,
        model
    );
    match serde_json::to_vec(&body) {
        Ok(b) => Ok((Bytes::from(b), session)),
        Err(e) => Err(gateway_error_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cloak_error",
            format!("cloak encode failed: {e}"),
        )),
    }
}

fn unreachable_response(name: &str, e: reqwest::Error) -> Response {
    gateway_error_json(StatusCode::BAD_GATEWAY, "upstream_error", upstream_unreachable_message(name, &e))
}

/// Byte-for-byte proxy (cloak off, models): body streamed through.
async fn proxy_passthrough_responses(
    name: &str,
    method: reqwest::Method,
    url: String,
    fwd: HeaderMap,
    body: Option<Bytes>,
) -> Response {
    let mut req = HTTP_NOREDIRECT.request(method, url).headers(fwd);
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return unreachable_response(name, e),
    };
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let relayed = relay_response_headers(resp.headers());
    let mut out = Response::builder().status(status);
    for (n, v) in relayed {
        out = out.header(n, v);
    }
    let upstream = resp.bytes_stream().map(|r| r.map_err(std::io::Error::other));
    out.body(Body::from_stream(upstream)).expect("relayed parts are valid")
}

/// Cloaked streaming: re-stream the SSE response through the decloaker.
///
/// On a mid-stream transport error the held-back tails are deliberately DROPPED
/// (they may be half-reversed pseudonyms); the client gets an `error` event.
async fn proxy_stream_decloaked_responses(
    name: &str,
    url: String,
    fwd: HeaderMap,
    body: Bytes,
    session: privacy::CloakSession,
) -> Response {
    let resp = match HTTP_NOREDIRECT.post(url).headers(fwd).body(body).send().await {
        Ok(r) => r,
        Err(e) => return unreachable_response(name, e),
    };
    if !resp.status().is_success() {
        return relay_error(resp).await;
    }
    let relayed: Vec<_> = relay_response_headers(resp.headers())
        .into_iter()
        .filter(|(n, _)| n != "content-type")
        .collect();

    let out = async_stream::stream! {
        let mut bytes = resp.bytes_stream();
        let mut dec = ResponsesSseDecloaker::new(session);
        while let Some(chunk) = bytes.next().await {
            match chunk {
                Ok(b) => {
                    let text = dec.feed(&b);
                    if !text.is_empty() {
                        yield Ok::<Bytes, std::io::Error>(Bytes::from(text));
                    }
                }
                Err(e) => {
                    let ev = json!({"type": "error", "code": "stream_error", "message": format!("stream: {e}"), "param": null});
                    yield Ok(Bytes::from(format!("event: error\ndata: {ev}\n\n")));
                    return;
                }
            }
        }
        let tail = dec.finish();
        if !tail.is_empty() {
            yield Ok(Bytes::from(tail));
        }
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache");
    for (n, v) in relayed {
        builder = builder.header(n, v);
    }
    builder.body(Body::from_stream(out)).expect("relayed parts are valid")
}

/// Non-streaming cloak path: forward, de-cloak `output[]`, re-serialize.
async fn proxy_once_decloaked_responses(
    name: &str,
    url: String,
    fwd: HeaderMap,
    body: Bytes,
    session: privacy::CloakSession,
) -> Response {
    let resp = match HTTP_NOREDIRECT.post(url).headers(fwd).body(body).send().await {
        Ok(r) => r,
        Err(e) => return unreachable_response(name, e),
    };
    if !resp.status().is_success() {
        return relay_error(resp).await;
    }
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let relayed = relay_response_headers(resp.headers());
    let mut v: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return gateway_error_json(StatusCode::BAD_GATEWAY, "upstream_error", format!("upstream decode: {e}")),
    };
    let json_session = json_escaped_session(&session);
    if let Some(output) = v.get_mut("output") {
        decloak_responses_output(&session, &json_session, output);
    }
    let mut out = Response::builder().status(status).header("content-type", "application/json");
    for (n, val) in relayed {
        if n != "content-type" {
            out = out.header(n, val);
        }
    }
    out.body(Body::from(v.to_string())).expect("relayed parts are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> privacy::CloakSession {
        let mut map = HashMap::new();
        map.insert("Term-274".to_string(), "ScanModule".to_string());
        map.insert("Person-27".to_string(), "Tom Arenstam".to_string());
        privacy::CloakSession { map }
    }

    fn ev(name: &str, data: Value) -> String {
        format!("event: {name}\ndata: {data}\n\n")
    }
    fn created() -> String {
        ev(
            "response.created",
            json!({"type": "response.created", "sequence_number": 0,
                   "response": {"id": "resp_1", "status": "in_progress", "output": []}}),
        )
    }
    fn msg_added(o: u64) -> String {
        ev(
            "response.output_item.added",
            json!({"type": "response.output_item.added", "output_index": o, "sequence_number": 1,
                   "item": {"id": format!("msg_{o}"), "type": "message", "role": "assistant", "content": []}}),
        )
    }
    fn part_added(o: u64, c: u64) -> String {
        ev(
            "response.content_part.added",
            json!({"type": "response.content_part.added", "item_id": format!("msg_{o}"), "output_index": o,
                   "content_index": c, "sequence_number": 2, "part": {"type": "output_text", "text": ""}}),
        )
    }
    fn tdelta(o: u64, c: u64, t: &str) -> String {
        ev(
            "response.output_text.delta",
            json!({"type": "response.output_text.delta", "item_id": format!("msg_{o}"), "output_index": o,
                   "content_index": c, "delta": t, "sequence_number": 3}),
        )
    }
    fn tdone(o: u64, c: u64, t: &str, seq: u64) -> String {
        ev(
            "response.output_text.done",
            json!({"type": "response.output_text.done", "item_id": format!("msg_{o}"), "output_index": o,
                   "content_index": c, "text": t, "sequence_number": seq}),
        )
    }
    fn part_done(o: u64, c: u64, t: &str) -> String {
        ev(
            "response.content_part.done",
            json!({"type": "response.content_part.done", "item_id": format!("msg_{o}"), "output_index": o,
                   "content_index": c, "sequence_number": 20, "part": {"type": "output_text", "text": t, "annotations": []}}),
        )
    }
    fn msg_item(o: u64, t: &str) -> Value {
        json!({"id": format!("msg_{o}"), "type": "message", "role": "assistant", "status": "completed",
               "content": [{"type": "output_text", "text": t, "annotations": []}]})
    }
    fn fc_item(o: u64, args: &str) -> Value {
        json!({"id": format!("fc_{o}"), "type": "function_call", "call_id": "call_1", "name": "exec_command",
               "arguments": args, "status": "completed"})
    }
    fn item_done(o: u64, item: Value) -> String {
        ev(
            "response.output_item.done",
            json!({"type": "response.output_item.done", "output_index": o, "sequence_number": 21, "item": item}),
        )
    }
    fn fc_added(o: u64) -> String {
        ev(
            "response.output_item.added",
            json!({"type": "response.output_item.added", "output_index": o, "sequence_number": 1, "item": fc_item(o, "")}),
        )
    }
    fn adelta(o: u64, t: &str) -> String {
        ev(
            "response.function_call_arguments.delta",
            json!({"type": "response.function_call_arguments.delta", "item_id": format!("fc_{o}"),
                   "output_index": o, "delta": t, "sequence_number": 4}),
        )
    }
    fn adone(o: u64, args: &str, seq: u64) -> String {
        ev(
            "response.function_call_arguments.done",
            json!({"type": "response.function_call_arguments.done", "item_id": format!("fc_{o}"),
                   "output_index": o, "arguments": args, "sequence_number": seq}),
        )
    }
    fn completed(output: Value) -> String {
        ev(
            "response.completed",
            json!({"type": "response.completed", "sequence_number": 99,
                   "response": {"id": "resp_1", "status": "completed", "output": output, "usage": {"input_tokens": 1}}}),
        )
    }

    /// Parse emitted SSE into (event name, data json); asserts event: then data: pairing.
    fn parse_events(out: &str) -> Vec<(String, Value)> {
        assert!(out.is_empty() || out.ends_with("\n\n"), "output must end on an event boundary: {out:?}");
        out.split("\n\n")
            .filter(|c| !c.is_empty())
            .map(|c| {
                let lines: Vec<&str> = c.split('\n').collect();
                assert!(lines[0].starts_with("event: "), "event first: {c:?}");
                assert!(lines[1].starts_with("data: "), "data second: {c:?}");
                (lines[0][7..].to_string(), serde_json::from_str(&lines[1][6..]).expect("data is json"))
            })
            .collect()
    }

    fn run(s: privacy::CloakSession, chunks: &[&[u8]]) -> String {
        let mut d = ResponsesSseDecloaker::new(s);
        let mut out = String::new();
        for c in chunks {
            out.push_str(&d.feed(c));
        }
        out.push_str(&d.finish());
        out
    }

    /// Concatenated `delta` of every event of type `ty` at `output_index` (and
    /// `content_index` when given).
    fn deltas(events: &[(String, Value)], ty: &str, o: u64, c: Option<u64>) -> String {
        events
            .iter()
            .filter(|(_, d)| d["type"] == ty && d["output_index"] == o && c.map_or(true, |c| d["content_index"] == c))
            .map(|(_, d)| d["delta"].as_str().unwrap().to_string())
            .collect()
    }

    /// Concatenated output_text deltas of an SSE string (tolerant of odd framing).
    fn all_text(out: &str) -> String {
        out.split("\n\n")
            .filter(|c| !c.is_empty())
            .filter_map(|c| c.lines().find_map(|l| l.strip_prefix("data: ")))
            .filter_map(|d| serde_json::from_str::<Value>(d).ok())
            .filter(|v| v["type"] == "response.output_text.delta")
            .filter_map(|v| v["delta"].as_str().map(str::to_string))
            .collect()
    }

    // 1
    #[test]
    fn collect_covers_all_text_positions_in_order_and_round_trips() {
        let mut body = json!({
            "model": "gpt-5.5",
            "instructions": "instr",
            "input": [
                {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "dev"}]},
                {"type": "message", "role": "user", "content": "u-string"},
                {"role": "assistant", "content": [{"type": "output_text", "text": "a-out"}, {"type": "input_text", "text": "a-in"}]},
                {"type": "message", "role": "system", "content": [{"type": "input_text", "text": "sys"}]}
            ]
        });
        let (slots, texts) = collect_responses_cloak_texts(&body);
        assert_eq!(texts, vec!["instr", "dev", "u-string", "a-out", "a-in", "sys"]);
        assert_eq!(
            slots,
            vec![
                ResponsesSlot::Instructions,
                ResponsesSlot::ItemPart(0, 0),
                ResponsesSlot::ItemString(1),
                ResponsesSlot::ItemPart(2, 0),
                ResponsesSlot::ItemPart(2, 1),
                ResponsesSlot::ItemPart(3, 0)
            ]
        );
        let cloaked: Vec<String> = texts.iter().map(|t| format!("C({t})")).collect();
        write_responses_cloaked_texts(&mut body, &slots, &cloaked);
        assert_eq!(body["instructions"], "C(instr)");
        assert_eq!(body["input"][0]["content"][0]["text"], "C(dev)");
        assert_eq!(body["input"][1]["content"], "C(u-string)");
        assert_eq!(body["input"][2]["content"][0]["text"], "C(a-out)");
        assert_eq!(body["input"][2]["content"][1]["text"], "C(a-in)");
        assert_eq!(body["input"][3]["content"][0]["text"], "C(sys)");

        let mut b2 = json!({"input": "plain input"});
        let (s2, t2) = collect_responses_cloak_texts(&b2);
        assert_eq!(s2, vec![ResponsesSlot::InputString]);
        assert_eq!(t2, vec!["plain input"]);
        write_responses_cloaked_texts(&mut b2, &s2, &["X".to_string()]);
        assert_eq!(b2["input"], "X");
    }

    // 2
    #[test]
    fn non_message_items_are_never_collected() {
        let body = json!({"input": [
            {"type": "function_call", "call_id": "c", "name": "n", "arguments": "{\"text\":\"secret\"}", "content": "no"},
            {"type": "function_call_output", "call_id": "c", "output": "secret string"},
            {"type": "function_call_output", "call_id": "c", "output": [{"type": "input_text", "text": "nested secret"}]},
            {"type": "custom_tool_call", "call_id": "c", "name": "apply_patch", "input": "secret patch"},
            {"type": "custom_tool_call_output", "call_id": "c", "output": "secret"},
            {"type": "local_shell_call", "action": {"command": ["ls"]}},
            {"type": "local_shell_call_output", "output": "secret"},
            {"type": "web_search_call", "action": {"query": "secret"}},
            {"type": "mcp_call", "arguments": "{}", "output": "secret"},
            {"type": "mcp_list_tools", "tools": []},
            {"type": "mcp_approval_request", "arguments": "{}"},
            {"type": "mcp_approval_response", "approve": true},
            {"type": "item_reference", "id": "msg_1"},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Tom Arenstam"}],
             "encrypted_content": "gAAAA-secret", "content": [{"type": "input_text", "text": "no"}]},
            {"type": "message", "role": "user", "content": [
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
                {"type": "input_file", "file_data": "AAAA", "text": "no"},
                {"type": "input_text", "text": "keep me"}
            ]}
        ]});
        let (slots, texts) = collect_responses_cloak_texts(&body);
        assert_eq!(texts, vec!["keep me"]);
        assert_eq!(slots, vec![ResponsesSlot::ItemPart(14, 2)]);
    }

    // 3
    #[test]
    fn tools_and_request_options_untouched() {
        let mut body = json!({
            "model": "Tom Arenstam",
            "instructions": "Tom Arenstam",
            "tools": [{"type": "function", "name": "t", "description": "Tom Arenstam tool", "parameters": {"type": "object"}}],
            "tool_choice": "auto",
            "text": {"verbosity": "low", "format": {"type": "text"}},
            "metadata": {"user": "Tom Arenstam"},
            "prompt_cache_key": "Tom Arenstam",
            "client_metadata": {"x-codex-turn-metadata": "Tom Arenstam"},
            "include": ["reasoning.encrypted_content"],
            "reasoning": {"effort": "medium", "summary": "Tom Arenstam"},
            "store": false,
            "stream": true,
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Tom Arenstam"}]}]
        });
        let before = body.clone();
        let (slots, texts) = collect_responses_cloak_texts(&body);
        assert_eq!(texts.len(), 2);
        write_responses_cloaked_texts(&mut body, &slots, &["Person-27".to_string(), "Person-27".to_string()]);
        for k in [
            "model", "tools", "tool_choice", "text", "metadata", "prompt_cache_key", "client_metadata", "include",
            "reasoning", "store", "stream",
        ] {
            assert_eq!(body[k], before[k], "{k}");
        }
        assert_eq!(body["instructions"], "Person-27");
        assert_eq!(body["input"][0]["content"][0]["text"], "Person-27");
    }

    // 4
    #[test]
    fn sibling_keys_survive_a_rewrite() {
        let mut body = json!({
            "instructions": "s",
            "input": [{"type": "message", "role": "user", "id": "m1", "status": "completed", "content": [
                {"type": "input_text", "text": "m", "extra": {"k": 1}}
            ]}]
        });
        let (slots, texts) = collect_responses_cloak_texts(&body);
        let cloaked: Vec<String> = texts.iter().map(|t| t.to_uppercase()).collect();
        write_responses_cloaked_texts(&mut body, &slots, &cloaked);
        assert_eq!(body["instructions"], "S");
        assert_eq!(
            body["input"][0],
            json!({"type": "message", "role": "user", "id": "m1", "status": "completed", "content": [
                {"type": "input_text", "text": "M", "extra": {"k": 1}}
            ]})
        );
    }

    // 5
    #[test]
    fn empty_texts_and_missing_type_are_skipped() {
        let body = json!({
            "instructions": "",
            "input": [
                {"type": "message", "role": "user", "content": ""},
                {"content": "no role and no type"},
                {"type": 5, "role": "user", "content": "odd type"},
                {"role": "user", "content": [
                    {"type": "input_text", "text": ""},
                    {"text": "no type"},
                    {"type": "input_text"},
                    {"type": "input_text", "text": 5},
                    {"type": "input_text", "text": "ok"}
                ]}
            ]
        });
        let (slots, texts) = collect_responses_cloak_texts(&body);
        assert_eq!(texts, vec!["ok"]);
        assert_eq!(slots, vec![ResponsesSlot::ItemPart(3, 4)]);
        let (s, t) = collect_responses_cloak_texts(&json!({"model": "x", "input": ""}));
        assert!(s.is_empty() && t.is_empty());
    }

    // 6
    #[test]
    fn empty_session_is_byte_identical_passthrough() {
        let input = created()
            + ": ping\n\n"
            + &msg_added(0)
            + &part_added(0, 0)
            + &tdelta(0, 0, "Hallo ")
            + &tdelta(0, 0, "Welt")
            + &tdone(0, 0, "Hallo Welt", 9)
            + &part_done(0, 0, "Hallo Welt")
            + &item_done(0, msg_item(0, "Hallo Welt"))
            + &completed(json!([msg_item(0, "Hallo Welt")]));
        let out = run(privacy::CloakSession::empty(), &[input.as_bytes()]);
        assert_eq!(out, input);
        let (a, b) = input.as_bytes().split_at(17);
        assert_eq!(run(privacy::CloakSession::empty(), &[a, b]), input);
    }

    // 7
    #[test]
    fn text_delta_decloaked_and_tail_flushed_before_done() {
        let cloaked = "Hi Person-27, Term-274";
        let input = created()
            + &msg_added(0)
            + &part_added(0, 0)
            + &tdelta(0, 0, cloaked)
            + &tdone(0, 0, cloaked, 9)
            + &part_done(0, 0, cloaked)
            + &item_done(0, msg_item(0, cloaked))
            + &completed(json!([msg_item(0, cloaked)]));
        let out = run(session(), &[input.as_bytes()]);
        let events = parse_events(&out);
        let want = "Hi Tom Arenstam, ScanModule";
        assert_eq!(deltas(&events, "response.output_text.delta", 0, Some(0)), want);
        let done = events.iter().position(|(n, _)| n == "response.output_text.done").unwrap();
        let tail = &events[done - 1].1;
        assert_eq!(tail["type"], "response.output_text.delta", "tail precedes done");
        assert_eq!(tail["sequence_number"], 9, "sequence_number copied from the done event");
        assert_eq!(tail["item_id"], "msg_0");
        assert_eq!(tail["content_index"], 0);
        assert!(events[done + 1..].iter().all(|(n, _)| n != "response.output_text.delta"), "no delta after done");
        assert_eq!(events[done].1["text"], want);
        let pd = events.iter().find(|(n, _)| n == "response.content_part.done").unwrap();
        assert_eq!(pd.1["part"]["text"], want);
        let idone = events.iter().find(|(n, _)| n == "response.output_item.done").unwrap();
        assert_eq!(idone.1["item"]["content"][0]["text"], want);
        let comp = events.iter().find(|(n, _)| n == "response.completed").unwrap();
        assert_eq!(comp.1["response"]["output"][0]["content"][0]["text"], want);
        assert_eq!(comp.1["response"]["usage"]["input_tokens"], 1);
        assert!(!out.contains("Person-27") && !out.contains("Term-274"));
    }

    fn fuzz_transcript() -> (String, String, String) {
        let t = ["Term-274 wird von ", "Person-27 für Müller entwickelt und Per", "son-27 pflegt Ä Term-274"];
        let j = [r#"{"who":"Pers"#, r#"on-27","datei":"Te"#, r#"rm-274","n":"Grüße Person-27"}"#];
        let full_t: String = t.concat();
        let full_j: String = j.concat();
        let input = created()
            + &msg_added(0)
            + &part_added(0, 0)
            + &fc_added(1)
            + &tdelta(0, 0, t[0])
            + &adelta(1, j[0])
            + &tdelta(0, 0, t[1])
            + &adelta(1, j[1])
            + &tdelta(0, 0, t[2])
            + &adelta(1, j[2])
            + &tdone(0, 0, &full_t, 10)
            + &part_done(0, 0, &full_t)
            + &item_done(0, msg_item(0, &full_t))
            + &adone(1, &full_j, 11)
            + &item_done(1, fc_item(1, &full_j))
            + &completed(json!([msg_item(0, &full_t), fc_item(1, &full_j)]));
        let want_text = "ScanModule wird von Tom Arenstam für Müller entwickelt und Tom Arenstam pflegt Ä ScanModule";
        let want_json = r#"{"who":"Tom Arenstam","datei":"ScanModule","n":"Grüße Tom Arenstam"}"#;
        (input, want_text.to_string(), want_json.to_string())
    }

    fn assert_output_good(out: &str, input: &str, want_text: &str, want_json: &str, what: &str) {
        let events = parse_events(out);
        let in_events = parse_events(input);
        let text = deltas(&events, "response.output_text.delta", 0, Some(0));
        let args = deltas(&events, "response.function_call_arguments.delta", 1, None);
        assert_eq!(text, want_text, "{what}");
        assert_eq!(args, want_json, "{what}");
        serde_json::from_str::<Value>(&args).unwrap_or_else(|_| panic!("arguments must parse: {what}"));
        // invariant: deltas == .done == output_item.done == response.completed
        let find = |ty: &str, o: u64| {
            events.iter().find(|(_, d)| d["type"] == ty && d["output_index"] == o).unwrap().1.clone()
        };
        assert_eq!(find("response.output_text.done", 0)["text"], want_text, "{what}");
        assert_eq!(find("response.content_part.done", 0)["part"]["text"], want_text, "{what}");
        assert_eq!(find("response.output_item.done", 0)["item"]["content"][0]["text"], want_text, "{what}");
        assert_eq!(find("response.function_call_arguments.done", 1)["arguments"], want_json, "{what}");
        assert_eq!(find("response.output_item.done", 1)["item"]["arguments"], want_json, "{what}");
        let comp = &events.iter().find(|(n, _)| n == "response.completed").unwrap().1;
        assert_eq!(comp["response"]["output"][0]["content"][0]["text"], want_text, "{what}");
        assert_eq!(comp["response"]["output"][1]["arguments"], want_json, "{what}");
        // type sequence == input sequence + extra deltas only right before a closing event
        let o: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
        let i: Vec<&str> = in_events.iter().map(|(n, _)| n.as_str()).collect();
        let closing = |s: Option<&&str>| {
            matches!(
                s.copied(),
                Some("response.output_text.done")
                    | Some("response.function_call_arguments.done")
                    | Some("response.content_part.done")
                    | Some("response.output_item.done")
                    | Some("response.completed")
            )
        };
        let (mut p, mut q) = (0, 0);
        while p < o.len() {
            if q < i.len() && o[p] == i[q] {
                p += 1;
                q += 1;
            } else if o[p].ends_with(".delta") && closing(i.get(q)) {
                p += 1;
            } else {
                panic!("event sequence diverges at {p}: {what}\n{o:?}\n{i:?}");
            }
        }
        assert_eq!(q, i.len(), "{what}");
        assert!(!out.contains("Person-27") && !out.contains("Term-274"), "pseudonym leaked: {what}");
    }

    // 8
    #[test]
    fn two_chunk_split_fuzz_every_byte_position() {
        let (input, want_text, want_json) = fuzz_transcript();
        let bytes = input.as_bytes();
        for split in 0..=bytes.len() {
            let out = run(session(), &[&bytes[..split], &bytes[split..]]);
            assert_output_good(&out, &input, &want_text, &want_json, &format!("split {split}"));
        }
        let mut d = ResponsesSseDecloaker::new(session());
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.feed(std::slice::from_ref(b)));
        }
        out.push_str(&d.finish());
        assert_output_good(&out, &input, &want_text, &want_json, "single bytes");
    }

    // 9
    #[test]
    fn reasoning_summary_and_encrypted_content_pass_through_byte_identical() {
        let reasoning = json!({"id": "rs_0", "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "Ask Person-27 about Term-274"}],
            "encrypted_content": "gAAAAPerson-27Term-274=="});
        let input = created()
            + &ev(
                "response.output_item.added",
                json!({"type": "response.output_item.added", "output_index": 0,
                       "item": {"id": "rs_0", "type": "reasoning", "summary": []}}),
            )
            + &ev(
                "response.reasoning_summary_part.added",
                json!({"type": "response.reasoning_summary_part.added", "item_id": "rs_0", "output_index": 0,
                       "summary_index": 0, "part": {"type": "summary_text", "text": ""}}),
            )
            + &ev(
                "response.reasoning_summary_text.delta",
                json!({"type": "response.reasoning_summary_text.delta", "item_id": "rs_0", "output_index": 0,
                       "summary_index": 0, "delta": "Ask Person-27 about Term-274"}),
            )
            + &ev(
                "response.reasoning_summary_text.done",
                json!({"type": "response.reasoning_summary_text.done", "item_id": "rs_0", "output_index": 0,
                       "summary_index": 0, "text": "Ask Person-27 about Term-274"}),
            )
            + &ev(
                "response.reasoning_text.delta",
                json!({"type": "response.reasoning_text.delta", "item_id": "rs_0", "output_index": 0,
                       "content_index": 0, "delta": "Person-27"}),
            )
            + &item_done(0, reasoning.clone())
            + &completed(json!([reasoning]));
        let out = run(session(), &[input.as_bytes()]);
        assert_eq!(out, input);
    }

    // 10
    #[test]
    fn pseudonym_split_across_three_deltas() {
        let input = msg_added(0)
            + &tdelta(0, 0, "Hi Per")
            + &tdelta(0, 0, "son-")
            + &tdelta(0, 0, "27!")
            + &tdone(0, 0, "Hi Person-27!", 5);
        let out = run(session(), &[input.as_bytes()]);
        let events = parse_events(&out);
        assert_eq!(deltas(&events, "response.output_text.delta", 0, Some(0)), "Hi Tom Arenstam!");
        assert!(!out.contains("Person-27"));
    }

    // 11
    #[test]
    fn interleaved_output_indexes_do_not_corrupt_each_other() {
        let input = tdelta(0, 0, "Term-")
            + &tdelta(1, 0, "Person-")
            + &adelta(2, r#"{"a":"Person-"#)
            + &tdelta(0, 1, "Person-27 x")
            + &tdelta(0, 0, "274 ok")
            + &tdelta(1, 0, "27 yes")
            + &adelta(2, r#"27"}"#)
            + &completed(json!([]));
        let out = run(session(), &[input.as_bytes()]);
        let events = parse_events(&out);
        assert_eq!(deltas(&events, "response.output_text.delta", 0, Some(0)), "ScanModule ok");
        assert_eq!(deltas(&events, "response.output_text.delta", 0, Some(1)), "Tom Arenstam x");
        assert_eq!(deltas(&events, "response.output_text.delta", 1, Some(0)), "Tom Arenstam yes");
        assert_eq!(deltas(&events, "response.function_call_arguments.delta", 2, None), r#"{"a":"Tom Arenstam"}"#);
        // all tails flushed before the terminal event
        assert_eq!(events.last().unwrap().0, "response.completed");
    }

    // 12
    #[test]
    fn comments_non_json_and_custom_events_pass_verbatim() {
        let input = ": keepalive\n\nevent: custom\ndata: {\"type\":\"custom\",\"x\":\"Person-27\"}\n\ndata: not-json\n\ndata: [DONE]\n\nevent: error\ndata: {\"type\":\"error\",\"message\":\"Person-27\"}\n\nevent: weird\nid: 7\nretry: 100\ndata: {\"a\": 1}\n\n";
        let out = run(session(), &[input.as_bytes()]);
        assert_eq!(out, input);
    }

    // 13
    #[test]
    fn crlf_input_is_normalized_and_complete() {
        let lf = tdelta(0, 0, "Hi Person-27") + &tdone(0, 0, "Hi Person-27", 4);
        let crlf = lf.replace('\n', "\r\n");
        let out = run(session(), &[crlf.as_bytes()]);
        assert!(!out.contains('\r'));
        assert_eq!(all_text(&out), "Hi Tom Arenstam");
        assert_eq!(parse_events(&out).len(), 3); // delta, tail delta, done
    }

    // 14
    #[test]
    fn eof_without_blank_line_flushes_held_tail() {
        let mut input = tdelta(0, 0, "Hallo Person-27");
        input.truncate(input.len() - 2); // no blank line and no final newline
        assert!(!input.ends_with('\n'));
        let mut d = ResponsesSseDecloaker::new(session());
        let during = d.feed(input.as_bytes());
        assert_eq!(all_text(&during), "", "the dangling event is not processed before EOF");
        let out = during + &d.finish();
        assert_eq!(all_text(&out), "Hallo Tom Arenstam");
    }

    // 15
    #[test]
    fn multi_line_data_is_joined_with_newline() {
        let ev = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\ndata: \"content_index\":0,\"item_id\":\"m\",\"delta\":\"Person-27\"}\n\n";
        let input = ev.to_string() + &tdone(0, 0, "Person-27", 3);
        let out = run(session(), &[input.as_bytes()]);
        assert_eq!(all_text(&out), "Tom Arenstam");
    }

    // 16
    #[test]
    fn completed_walker_decloaks_message_function_call_custom_only() {
        let s = session();
        let js = json_escaped_session(&s);
        let reasoning = json!({"type": "reasoning", "summary": [{"type": "summary_text", "text": "Person-27"}],
                               "encrypted_content": "Term-274"});
        let mut output = json!([
            {"type": "message", "id": "Person-27", "content": [
                {"type": "output_text", "text": "Hi Person-27"},
                {"type": "refusal", "refusal": "Person-27"}
            ]},
            {"type": "function_call", "name": "Person-27", "call_id": "c", "arguments": "{\"p\":\"Term-274\"}"},
            {"type": "custom_tool_call", "name": "apply_patch", "input": "*** Person-27"},
            reasoning.clone(),
            {"type": "web_search_call", "action": {"query": "Person-27"}}
        ]);
        decloak_responses_output(&s, &js, &mut output);
        assert_eq!(output[0]["content"][0]["text"], "Hi Tom Arenstam");
        assert_eq!(output[0]["content"][1]["refusal"], "Person-27");
        assert_eq!(output[0]["id"], "Person-27");
        assert_eq!(output[1]["arguments"], "{\"p\":\"ScanModule\"}");
        assert_eq!(output[1]["name"], "Person-27");
        assert_eq!(output[2]["input"], "*** Tom Arenstam");
        assert_eq!(output[3], reasoning);
        assert_eq!(output[4]["action"]["query"], "Person-27");
        // a single item works too
        let mut one = json!({"type": "custom_tool_call", "input": "Term-274"});
        decloak_responses_output(&s, &js, &mut one);
        assert_eq!(one["input"], "ScanModule");
    }

    // 17
    #[test]
    fn json_escaped_original_in_arguments_stays_valid_json() {
        let original = r#"Ada "Lovelace" \ Co"#;
        let mut map = HashMap::new();
        map.insert("Person-27".to_string(), original.to_string());
        let s = privacy::CloakSession { map };
        let full = r#"{"p":"Person-27"}"#;
        let input = adelta(0, r#"{"p":"Per"#)
            + &adelta(0, "son-")
            + &adelta(0, r#"27"}"#)
            + &adone(0, full, 6)
            + &item_done(0, fc_item(0, full))
            + &completed(json!([fc_item(0, full)]));
        let out = run(s.clone(), &[input.as_bytes()]);
        let events = parse_events(&out);
        let acc = deltas(&events, "response.function_call_arguments.delta", 0, None);
        let v: Value = serde_json::from_str(&acc).expect("accumulated arguments must be valid JSON");
        assert_eq!(v["p"], original);
        let done = &events.iter().find(|(n, _)| n == "response.function_call_arguments.done").unwrap().1;
        assert_eq!(done["arguments"].as_str().unwrap(), acc);
        let comp = &events.iter().find(|(n, _)| n == "response.completed").unwrap().1;
        assert_eq!(comp["response"]["output"][0]["arguments"].as_str().unwrap(), acc);
        // a held tail flushed at the terminal event is escaped too
        let input = adelta(0, r#"{"p":"Person-27"#) + &completed(json!([]));
        let out = run(s, &[input.as_bytes()]);
        let acc = deltas(&parse_events(&out), "response.function_call_arguments.delta", 0, None);
        let v: Value = serde_json::from_str(&format!("{acc}\"}}")).unwrap();
        assert_eq!(v["p"], original);
    }

    // 18
    #[test]
    fn upstream_urls_join_for_both_upstreams() {
        use super::super::llm_gateway::upstream_base_from;
        let pinned = upstream_base_from(Upstream::ChatGpt, None, false).unwrap();
        assert_eq!(pinned, "https://chatgpt.com");
        // a path in the env value is dropped by the pin (host only)
        assert_eq!(
            upstream_base_from(Upstream::ChatGpt, Some("https://chatgpt.com/backend-api/codex"), false).unwrap(),
            "https://chatgpt.com"
        );
        assert!(upstream_base_from(Upstream::ChatGpt, Some("http://127.0.0.1:9797"), false).is_err());
        assert!(upstream_base_from(Upstream::ChatGpt, Some("https://evil.example"), false).is_err());
        assert_eq!(responses_url(Upstream::ChatGpt, &pinned), "https://chatgpt.com/backend-api/codex/responses");
        assert_eq!(
            responses_models_url(Upstream::ChatGpt, &pinned, Some("client_version=0.154.0")),
            "https://chatgpt.com/backend-api/codex/models?client_version=0.154.0"
        );
        let dev = upstream_base_from(Upstream::ChatGpt, Some("http://127.0.0.1:9797/"), true).unwrap();
        assert_eq!(responses_url(Upstream::ChatGpt, &dev), "http://127.0.0.1:9797/backend-api/codex/responses");
        assert_eq!(responses_models_url(Upstream::ChatGpt, &dev, None), "http://127.0.0.1:9797/backend-api/codex/models");

        let oa = upstream_base_from(Upstream::OpenAi, None, false).unwrap();
        assert_eq!(responses_url(Upstream::OpenAi, &oa), "https://api.openai.com/v1/responses");
        assert_eq!(responses_models_url(Upstream::OpenAi, &oa, Some("")), "https://api.openai.com/v1/models");
        assert_eq!(responses_url(Upstream::OpenAi, "http://x:1/"), "http://x:1/v1/responses");
        assert_eq!(responses_models_url(Upstream::OpenAi, "http://x:1", Some("a=b")), "http://x:1/v1/models?a=b");
    }

    fn hm(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    // 19
    #[test]
    fn chatgpt_header_allowlist() {
        let incoming = hm(&[
            ("authorization", "Bearer eyJhbGciOi.jwt"),
            ("chatgpt-account-id", "acc"),
            ("originator", "codex_exec"),
            ("session-id", "s1"),
            ("session_id", "s2"),
            ("thread-id", "t1"),
            ("conversation_id", "c1"),
            ("x-client-request-id", "r1"),
            ("x-openai-subagent", "review"),
            ("x-codex-beta-features", "remote_compaction_v2"),
            ("x-codex-window-id", "w"),
            ("x-codex-turn-metadata", "{}"),
            ("openai-beta", "responses=v1"),
            ("accept", "text/event-stream"),
            ("user-agent", "codex_exec/0.154.0"),
            ("anthropic-version", "2023-06-01"),
            ("anthropic-beta", "b"),
            ("x-api-key", "sk-ant"),
            ("x-app", "cli"),
            ("x-gctrl-token", "gctrl_t"),
            ("x-upstream-provider", "chatgpt"),
            ("accept-encoding", "gzip"),
            ("cookie", "a=b"),
            ("host", "gw"),
            ("content-length", "12"),
            ("x-anvil-cloak", "on"),
        ]);
        let out = forward_headers(&incoming, Upstream::ChatGpt, false);
        let mut names: Vec<&str> = out.keys().map(|k| k.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "accept",
                "authorization",
                "chatgpt-account-id",
                "content-type",
                "conversation_id",
                "openai-beta",
                "originator",
                "session-id",
                "session_id",
                "thread-id",
                "user-agent",
                "x-client-request-id",
                "x-codex-beta-features",
                "x-codex-turn-metadata",
                "x-codex-window-id",
                "x-openai-subagent",
            ]
        );
        assert_eq!(out["content-type"], "application/json");
        // Codex headers never reach api.openai.com; openai-beta does.
        let oa = forward_headers(&incoming, Upstream::OpenAi, false);
        let mut names: Vec<&str> = oa.keys().map(|k| k.as_str()).collect();
        names.sort();
        assert_eq!(names, ["accept", "authorization", "content-type", "openai-beta", "user-agent"]);
        // ... nor Anthropic.
        let an = forward_headers(&incoming, Upstream::Anthropic, false);
        assert!(!an.contains_key("openai-beta") && !an.contains_key("x-codex-window-id") && !an.contains_key("originator"));
        // a consumed authorization is not forwarded
        assert!(!forward_headers(&incoming, Upstream::ChatGpt, true).contains_key("authorization"));
    }

    // 20
    #[test]
    fn chatgpt_upstream_selection_and_credentials() {
        assert_eq!(upstream_from_headers(&hm(&[("x-upstream-provider", "ChatGPT")])).ok(), Some(Upstream::ChatGpt));
        assert_eq!(responses_upstream(&hm(&[("x-upstream-provider", "chatgpt")])).ok(), Some(Upstream::ChatGpt));
        assert_eq!(responses_upstream(&hm(&[("x-upstream-provider", "openai")])).ok(), Some(Upstream::OpenAi));
        for bad in [hm(&[]), hm(&[("x-upstream-provider", "anthropic")]), hm(&[("x-upstream-provider", "foo")])] {
            let r = responses_upstream(&bad).err().expect("rejected");
            assert_eq!(r.status(), StatusCode::BAD_REQUEST);
            assert_eq!(r.headers()["x-cloak-gateway-error"], "1");
        }
        let jwt = hm(&[("authorization", "Bearer eyJhbGciOiJSUzI1NiJ9.x.y")]);
        assert!(has_upstream_credential(&jwt, Upstream::ChatGpt, false));
        assert!(!has_upstream_credential(&jwt, Upstream::ChatGpt, true));
        assert!(!has_upstream_credential(&hm(&[("x-api-key", "sk-1")]), Upstream::ChatGpt, false));
        assert!(!has_upstream_credential(&hm(&[("authorization", "Bearer gctrl_abc")]), Upstream::ChatGpt, false));
        assert!(!has_upstream_credential(&HeaderMap::new(), Upstream::ChatGpt, false));
        assert!(credential_hint(Upstream::ChatGpt).contains("X-GCTRL-Token"));
    }

    // 21
    #[tokio::test]
    async fn capabilities_list_chatgpt() {
        let v = super::super::llm_gateway::capabilities().await.0;
        assert_eq!(v["upstreams"], json!(["ollama", "anthropic", "openai", "chatgpt"]));
    }

    // 22
    #[test]
    fn routers_build_without_path_conflicts() {
        let _ = router();
        let _ = super::super::llm_gateway_anthropic::router();
        let _ = super::super::llm_gateway::router();
    }
}

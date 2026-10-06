//! Anthropic Messages API adapter for the cloak gateway: the PURE parts.
//!
//! * request side: collect the text slots that may be cloaked (and write the
//!   cloaked texts back), never touching tool results, tool inputs, thinking,
//!   images, documents, tool definitions or the Claude Code identity block;
//! * response side: an SSE state machine that de-cloaks `text_delta` and
//!   `input_json_delta` with per-index rolling buffers, keeps `event:`/`data:`
//!   pairing intact and passes everything else (thinking, signatures, pings,
//!   unknown events) through byte-identical;
//! * non-stream: recursive de-cloak of a finished message.
//!
//! No reqwest/axum in the state machine so it stays fuzzable. The HTTP handlers
//! come in a later task, hence the `dead_code` allowance.
#![allow(dead_code)]

use std::collections::HashMap;

use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};
use serde_json::{json, Value};

use crate::services::privacy;

/// Anthropic error envelope with `application/json`.
pub(super) fn anthropic_error(status: StatusCode, kind: &str, message: impl Into<String>) -> Response {
    let body = json!({"type": "error", "error": {"type": kind, "message": message.into()}});
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("static response parts are valid")
}

// ── request cloaker ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AnthropicSlot {
    SystemString,
    SystemBlock(usize),
    MessageString(usize),
    MessageBlock(usize, usize),
}

/// The Claude Code identity block must reach Anthropic byte-identical.
pub(super) fn is_identity_block(text: &str) -> bool {
    text.trim_start().starts_with("You are Claude Code")
}

fn cloakable(text: &str) -> bool {
    !text.is_empty() && !is_identity_block(text)
}

fn text_block_text(block: &Value) -> Option<&str> {
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    block.get("text").and_then(Value::as_str).filter(|t| cloakable(t))
}

/// Walk the request in order and return every cloakable text with its slot.
pub(super) fn collect_anthropic_cloak_texts(body: &Value) -> (Vec<AnthropicSlot>, Vec<String>) {
    let mut slots = Vec::new();
    let mut texts = Vec::new();
    match body.get("system") {
        Some(Value::String(s)) if cloakable(s) => {
            slots.push(AnthropicSlot::SystemString);
            texts.push(s.clone());
        }
        Some(Value::Array(blocks)) => {
            for (i, b) in blocks.iter().enumerate() {
                if let Some(t) = text_block_text(b) {
                    slots.push(AnthropicSlot::SystemBlock(i));
                    texts.push(t.to_string());
                }
            }
        }
        _ => {}
    }
    if let Some(Value::Array(messages)) = body.get("messages") {
        for (i, m) in messages.iter().enumerate() {
            match m.get("content") {
                Some(Value::String(s)) if cloakable(s) => {
                    slots.push(AnthropicSlot::MessageString(i));
                    texts.push(s.clone());
                }
                Some(Value::Array(blocks)) => {
                    for (j, b) in blocks.iter().enumerate() {
                        if let Some(t) = text_block_text(b) {
                            slots.push(AnthropicSlot::MessageBlock(i, j));
                            texts.push(t.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    (slots, texts)
}

/// Replace only the text of each slot (in order); sibling keys survive.
pub(super) fn write_anthropic_cloaked_texts(body: &mut Value, slots: &[AnthropicSlot], cloaked: &[String]) {
    for (slot, text) in slots.iter().zip(cloaked) {
        let target = match *slot {
            AnthropicSlot::SystemString => body.get_mut("system"),
            AnthropicSlot::SystemBlock(i) => body
                .get_mut("system")
                .and_then(|s| s.get_mut(i))
                .and_then(|b| b.get_mut("text")),
            AnthropicSlot::MessageString(i) => body
                .get_mut("messages")
                .and_then(|m| m.get_mut(i))
                .and_then(|m| m.get_mut("content")),
            AnthropicSlot::MessageBlock(i, j) => body
                .get_mut("messages")
                .and_then(|m| m.get_mut(i))
                .and_then(|m| m.get_mut("content"))
                .and_then(|c| c.get_mut(j))
                .and_then(|b| b.get_mut("text")),
        };
        if let Some(t) = target {
            *t = Value::String(text.clone());
        }
    }
}

// ── SSE decloaker ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BlockKind {
    Text,
    InputJson,
    Passthrough,
}

pub(super) struct AnthropicSseDecloaker {
    session: privacy::CloakSession,
    line_buf: Vec<u8>,
    event_lines: Vec<String>,
    event_name: Option<String>,
    data_lines: Vec<String>,
    kinds: HashMap<u64, BlockKind>,
    bufs: HashMap<u64, String>,
    out: String,
}

impl AnthropicSseDecloaker {
    pub fn new(session: privacy::CloakSession) -> Self {
        Self {
            session,
            line_buf: Vec::new(),
            event_lines: Vec::new(),
            event_name: None,
            data_lines: Vec::new(),
            kinds: HashMap::new(),
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
        self.flush_all();
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

    fn emit_tail(&mut self, index: u64, kind: BlockKind, tail: String) {
        if tail.is_empty() {
            return;
        }
        let delta = match kind {
            BlockKind::Text => json!({"type": "text_delta", "text": tail}),
            BlockKind::InputJson => json!({"type": "input_json_delta", "partial_json": tail}),
            BlockKind::Passthrough => return,
        };
        let ev = json!({"type": "content_block_delta", "index": index, "delta": delta});
        self.out.push_str(&format!("event: content_block_delta\ndata: {ev}\n\n"));
    }

    fn flush_index(&mut self, index: u64) {
        if let (Some(kind), Some(mut buf)) = (self.kinds.get(&index).copied(), self.bufs.remove(&index)) {
            let tail = privacy::decloak_stream_finish(&self.session, &mut buf);
            self.emit_tail(index, kind, tail);
        }
    }

    fn flush_all(&mut self) {
        let mut idx: Vec<u64> = self.bufs.keys().copied().collect();
        idx.sort_unstable();
        for i in idx {
            self.flush_index(i);
        }
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
        let index = json.get("index").and_then(Value::as_u64);
        match (ty.as_str(), index) {
            ("content_block_start", Some(i)) => {
                let kind = match json.pointer("/content_block/type").and_then(Value::as_str) {
                    Some("text") => BlockKind::Text,
                    Some("tool_use") => BlockKind::InputJson,
                    _ => BlockKind::Passthrough,
                };
                self.kinds.insert(i, kind);
                if kind != BlockKind::Passthrough {
                    self.bufs.insert(i, String::new());
                }
                self.emit_verbatim(&lines);
            }
            ("content_block_delta", Some(i)) => {
                let field = match json.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => "text",
                    Some("input_json_delta") => "partial_json",
                    _ => {
                        self.emit_verbatim(&lines);
                        return;
                    }
                };
                let original = json.pointer(&format!("/delta/{field}")).and_then(Value::as_str).map(str::to_string);
                let (Some(original), Some(buf)) = (original, self.bufs.get_mut(&i)) else {
                    self.emit_verbatim(&lines);
                    return;
                };
                let emitted = privacy::decloak_stream_chunk(&self.session, buf, &original);
                if emitted == original {
                    self.emit_verbatim(&lines);
                } else {
                    json["delta"][field] = Value::String(emitted);
                    let n = name.unwrap_or(ty);
                    self.emit_rewritten(&lines, &n, &json);
                }
            }
            ("content_block_stop", Some(i)) => {
                self.flush_index(i);
                self.kinds.remove(&i);
                self.bufs.remove(&i);
                self.emit_verbatim(&lines);
            }
            ("message_stop", _) => {
                self.flush_all();
                self.emit_verbatim(&lines);
            }
            _ => self.emit_verbatim(&lines),
        }
    }
}

// ── non-stream ──────────────────────────────────────────────────────────────

/// Decloak every string VALUE (keys untouched), recursively.
pub(super) fn decloak_json_strings(session: &privacy::CloakSession, v: &mut Value) {
    match v {
        Value::String(s) => *s = privacy::decloak(session, s),
        Value::Array(a) => a.iter_mut().for_each(|x| decloak_json_strings(session, x)),
        Value::Object(o) => o.values_mut().for_each(|x| decloak_json_strings(session, x)),
        _ => {}
    }
}

/// Decloak a finished Messages response: text and tool_use.input only.
pub(super) fn decloak_anthropic_message(session: &privacy::CloakSession, msg: &mut Value) {
    let Some(content) = msg.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(Value::String(t)) = block.get_mut("text") {
                    *t = privacy::decloak(session, t);
                }
            }
            Some("tool_use") => {
                if let Some(input) = block.get_mut("input") {
                    decloak_json_strings(session, input);
                }
            }
            _ => {}
        }
    }
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
    fn start(i: u64, kind: &str) -> String {
        let cb = match kind {
            "text" => json!({"type": "text", "text": ""}),
            "tool_use" => json!({"type": "tool_use", "id": "toolu_1", "name": "read", "input": {}}),
            k => json!({"type": k}),
        };
        ev("content_block_start", json!({"type": "content_block_start", "index": i, "content_block": cb}))
    }
    fn delta(i: u64, d: Value) -> String {
        ev("content_block_delta", json!({"type": "content_block_delta", "index": i, "delta": d}))
    }
    fn text(i: u64, t: &str) -> String {
        delta(i, json!({"type": "text_delta", "text": t}))
    }
    fn pj(i: u64, t: &str) -> String {
        delta(i, json!({"type": "input_json_delta", "partial_json": t}))
    }
    fn stop(i: u64) -> String {
        ev("content_block_stop", json!({"type": "content_block_stop", "index": i}))
    }
    fn msg_start() -> String {
        ev("message_start", json!({"type": "message_start", "message": {"id": "msg_1", "content": []}}))
    }
    fn msg_end() -> String {
        ev("message_delta", json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}))
            + &ev("message_stop", json!({"type": "message_stop"}))
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
        let mut d = AnthropicSseDecloaker::new(s);
        let mut out = String::new();
        for c in chunks {
            out.push_str(&d.feed(c));
        }
        out.push_str(&d.finish());
        out
    }

    /// Concatenated text_delta texts of an SSE string (tolerant of odd framing).
    fn all_text(out: &str) -> String {
        out.split("\n\n")
            .filter(|c| !c.is_empty())
            .filter_map(|c| c.lines().nth(1).and_then(|l| l.strip_prefix("data: ")))
            .filter_map(|d| serde_json::from_str::<Value>(d).ok())
            .filter_map(|v| v["delta"]["text"].as_str().map(str::to_string))
            .collect()
    }

    // 1
    #[test]
    fn collect_covers_all_text_positions_in_order_and_round_trips() {
        let mut body = json!({
            "model": "claude",
            "system": [{"type": "text", "text": "sys0"}, {"type": "text", "text": "sys1"}],
            "messages": [
                {"role": "user", "content": "u-string"},
                {"role": "assistant", "content": [{"type": "text", "text": "a-text"}]},
                {"role": "user", "content": [{"type": "text", "text": "u-block"}]}
            ]
        });
        let (slots, texts) = collect_anthropic_cloak_texts(&body);
        assert_eq!(texts, vec!["sys0", "sys1", "u-string", "a-text", "u-block"]);
        assert_eq!(
            slots,
            vec![
                AnthropicSlot::SystemBlock(0),
                AnthropicSlot::SystemBlock(1),
                AnthropicSlot::MessageString(0),
                AnthropicSlot::MessageBlock(1, 0),
                AnthropicSlot::MessageBlock(2, 0)
            ]
        );
        let cloaked: Vec<String> = texts.iter().map(|t| format!("C({t})")).collect();
        write_anthropic_cloaked_texts(&mut body, &slots, &cloaked);
        assert_eq!(body["system"][1]["text"], "C(sys1)");
        assert_eq!(body["messages"][0]["content"], "C(u-string)");
        assert_eq!(body["messages"][1]["content"][0]["text"], "C(a-text)");
        assert_eq!(body["messages"][2]["content"][0]["text"], "C(u-block)");

        let mut b2 = json!({"system": "plain system", "messages": []});
        let (s2, t2) = collect_anthropic_cloak_texts(&b2);
        assert_eq!(s2, vec![AnthropicSlot::SystemString]);
        assert_eq!(t2, vec!["plain system"]);
        write_anthropic_cloaked_texts(&mut b2, &s2, &["X".to_string()]);
        assert_eq!(b2["system"], "X");
    }

    // 2
    #[test]
    fn identity_block_is_never_cloaked_in_any_position() {
        let ident = "  You are Claude Code, Anthropic's official CLI";
        let mut body = json!({
            "system": [
                {"type": "text", "text": ident, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "second system"}
            ],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "text", "text": ident}]},
                {"role": "user", "content": ident}
            ]
        });
        let before = body.clone();
        let (slots, texts) = collect_anthropic_cloak_texts(&body);
        assert_eq!(texts, vec!["second system", "hi"]);
        let cloaked: Vec<String> = texts.iter().map(|t| format!("C({t})")).collect();
        write_anthropic_cloaked_texts(&mut body, &slots, &cloaked);
        assert_eq!(body["system"][0], before["system"][0]);
        assert_eq!(body["messages"][0]["content"][1], before["messages"][0]["content"][1]);
        assert_eq!(body["messages"][1], before["messages"][1]);
        assert_eq!(body["system"][1]["text"], "C(second system)");
        assert!(is_identity_block("\n You are Claude Code"));
        assert!(!is_identity_block("Hello, You are Claude Code"));
    }

    // 3
    #[test]
    fn non_text_blocks_are_never_collected() {
        let body = json!({"messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t", "content": "secret string"},
            {"type": "tool_result", "tool_use_id": "t", "content": [{"type": "text", "text": "nested secret"}]},
            {"type": "tool_use", "id": "t", "name": "n", "input": {"text": "in input", "type": "text"}},
            {"type": "thinking", "thinking": "hmm", "signature": "sig", "text": "no"},
            {"type": "redacted_thinking", "data": "xx", "text": "no"},
            {"type": "image", "source": {"type": "base64", "data": "AAAA"}},
            {"type": "document", "source": {"type": "text", "data": "doc body"}, "text": "no"},
            {"type": "mystery", "text": "unknown type"},
            {"type": "text", "text": "keep me"}
        ]}]});
        let (slots, texts) = collect_anthropic_cloak_texts(&body);
        assert_eq!(texts, vec!["keep me"]);
        assert_eq!(slots, vec![AnthropicSlot::MessageBlock(0, 8)]);
    }

    // 4
    #[test]
    fn tools_tool_choice_and_metadata_untouched() {
        let mut body = json!({
            "tools": [{"name": "t", "description": "Tom Arenstam tool", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "tool", "name": "t"},
            "metadata": {"user_id": "Tom Arenstam"},
            "messages": [{"role": "user", "content": "Tom Arenstam"}]
        });
        let before = body.clone();
        let (slots, _) = collect_anthropic_cloak_texts(&body);
        write_anthropic_cloaked_texts(&mut body, &slots, &["Person-27".to_string()]);
        assert_eq!(body["tools"], before["tools"]);
        assert_eq!(body["tool_choice"], before["tool_choice"]);
        assert_eq!(body["metadata"], before["metadata"]);
        assert_eq!(body["messages"][0]["content"], "Person-27");
    }

    // 5
    #[test]
    fn cache_control_and_sibling_keys_survive() {
        let mut body = json!({
            "system": [{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}, "extra": 1}],
            "messages": [{"role": "user", "extra": true, "content": [
                {"type": "text", "text": "m", "cache_control": {"type": "ephemeral", "ttl": "1h"}}
            ]}]
        });
        let (slots, texts) = collect_anthropic_cloak_texts(&body);
        let cloaked: Vec<String> = texts.iter().map(|t| t.to_uppercase()).collect();
        write_anthropic_cloaked_texts(&mut body, &slots, &cloaked);
        assert_eq!(body["system"][0], json!({"type": "text", "text": "S", "cache_control": {"type": "ephemeral"}, "extra": 1}));
        assert_eq!(body["messages"][0]["extra"], true);
        assert_eq!(
            body["messages"][0]["content"][0],
            json!({"type": "text", "text": "M", "cache_control": {"type": "ephemeral", "ttl": "1h"}})
        );
    }

    // 6
    #[test]
    fn empty_texts_and_missing_type_are_skipped() {
        let body = json!({
            "system": "",
            "messages": [
                {"role": "user", "content": ""},
                {"role": "user", "content": [
                    {"type": "text", "text": ""},
                    {"text": "no type"},
                    {"type": "text"},
                    {"type": "text", "text": 5},
                    {"type": "text", "text": "ok"}
                ]}
            ]
        });
        let (slots, texts) = collect_anthropic_cloak_texts(&body);
        assert_eq!(texts, vec!["ok"]);
        assert_eq!(slots, vec![AnthropicSlot::MessageBlock(1, 4)]);
        let (s, t) = collect_anthropic_cloak_texts(&json!({"model": "x"}));
        assert!(s.is_empty() && t.is_empty());
    }

    // 7
    #[test]
    fn empty_session_is_byte_identical_passthrough() {
        let input = msg_start()
            + "event: ping\ndata: {\"type\": \"ping\"}\n\n"
            + &start(0, "text")
            + &text(0, "Hallo ")
            + &text(0, "Welt")
            + &stop(0)
            + &msg_end();
        let out = run(privacy::CloakSession::empty(), &[input.as_bytes()]);
        assert_eq!(out, input);
        let (a, b) = input.as_bytes().split_at(17);
        assert_eq!(run(privacy::CloakSession::empty(), &[a, b]), input);
    }

    // 8
    #[test]
    fn text_delta_decloaked_and_tail_flushed_before_stop() {
        let input = msg_start() + &start(0, "text") + &text(0, "Hi Person-27, Term-274") + &stop(0) + &msg_end();
        let out = run(session(), &[input.as_bytes()]);
        let events = parse_events(&out);
        let mut acc = String::new();
        let mut stop_pos = None;
        for (k, (name, data)) in events.iter().enumerate() {
            assert_eq!(data["type"], *name);
            if name == "content_block_delta" {
                assert!(stop_pos.is_none(), "no delta after the stop");
                acc.push_str(data["delta"]["text"].as_str().unwrap());
            }
            if name == "content_block_stop" {
                stop_pos = Some(k);
            }
        }
        assert_eq!(acc, "Hi Tom Arenstam, ScanModule");
        assert_eq!(events[stop_pos.unwrap() - 1].0, "content_block_delta", "tail precedes stop");
        assert!(!out.contains("Person-27") && !out.contains("Term-274"));
    }

    fn fuzz_transcript() -> (String, String, String) {
        let t = [
            "Term-274 wird von ",
            "Person-27 für Müller entwickelt und Per",
            "son-27 pflegt Ä Term-274",
        ];
        let j = [r#"{"who":"Pers"#, r#"on-27","datei":"Te"#, r#"rm-274","n":"Grüße Person-27"}"#];
        let input = msg_start()
            + &start(0, "text")
            + &start(1, "tool_use")
            + &text(0, t[0])
            + &pj(1, j[0])
            + &text(0, t[1])
            + &pj(1, j[1])
            + &text(0, t[2])
            + &pj(1, j[2])
            + &stop(0)
            + &stop(1)
            + &msg_end();
        let want_text = "ScanModule wird von Tom Arenstam für Müller entwickelt und Tom Arenstam pflegt Ä ScanModule";
        let want_json = r#"{"who":"Tom Arenstam","datei":"ScanModule","n":"Grüße Tom Arenstam"}"#;
        (input, want_text.to_string(), want_json.to_string())
    }

    fn assert_output_good(out: &str, input: &str, want_text: &str, want_json: &str, what: &str) {
        let events = parse_events(out);
        let in_events = parse_events(input);
        let mut acc: HashMap<u64, String> = HashMap::new();
        for (name, data) in &events {
            if name == "content_block_delta" {
                let i = data["index"].as_u64().unwrap();
                let d = &data["delta"];
                let piece = d["text"].as_str().or_else(|| d["partial_json"].as_str()).unwrap();
                acc.entry(i).or_default().push_str(piece);
            }
        }
        assert_eq!(acc[&0], want_text, "{what}");
        assert_eq!(acc[&1], want_json, "{what}");
        serde_json::from_str::<Value>(&acc[&1]).unwrap_or_else(|_| panic!("partial_json must parse: {what}"));
        // type sequence == input sequence + at most one extra delta right before each stop
        let o: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
        let i: Vec<&str> = in_events.iter().map(|(n, _)| n.as_str()).collect();
        let (mut p, mut q) = (0, 0);
        while p < o.len() {
            if q < i.len() && o[p] == i[q] {
                p += 1;
                q += 1;
            } else if o[p] == "content_block_delta"
                && o.get(p + 1) == Some(&"content_block_stop")
                && i.get(q) == Some(&"content_block_stop")
            {
                p += 1;
            } else {
                panic!("event sequence diverges at {p}: {what}\n{o:?}\n{i:?}");
            }
        }
        assert_eq!(q, i.len(), "{what}");
        assert!(!out.contains("Person-27") && !out.contains("Term-274"), "pseudonym leaked: {what}");
    }

    // 9
    #[test]
    fn two_chunk_split_fuzz_every_byte_position() {
        let (input, want_text, want_json) = fuzz_transcript();
        let bytes = input.as_bytes();
        for split in 0..=bytes.len() {
            let out = run(session(), &[&bytes[..split], &bytes[split..]]);
            assert_output_good(&out, &input, &want_text, &want_json, &format!("split {split}"));
        }
        let mut d = AnthropicSseDecloaker::new(session());
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.feed(std::slice::from_ref(b)));
        }
        out.push_str(&d.finish());
        assert_output_good(&out, &input, &want_text, &want_json, "single bytes");
    }

    // 10
    #[test]
    fn thinking_blocks_pass_through_byte_identical() {
        let input = msg_start()
            + &start(0, "thinking")
            + &delta(0, json!({"type": "thinking_delta", "thinking": "Ask Person-27 about Term-274"}))
            + &delta(0, json!({"type": "signature_delta", "signature": "Person-27sig"}))
            + &stop(0)
            + &start(1, "redacted_thinking")
            + &stop(1)
            + &msg_end();
        let out = run(session(), &[input.as_bytes()]);
        assert_eq!(out, input);
    }

    // 11
    #[test]
    fn input_json_pseudonym_split_across_three_deltas() {
        let input = start(0, "tool_use") + &pj(0, r#"{"p":"Per"#) + &pj(0, "son-") + &pj(0, r#"27"}"#) + &stop(0);
        let out = run(session(), &[input.as_bytes()]);
        let acc: String = parse_events(&out)
            .iter()
            .filter_map(|(_, d)| d["delta"]["partial_json"].as_str().map(str::to_string))
            .collect();
        let v: Value = serde_json::from_str(&acc).unwrap();
        assert_eq!(v["p"], "Tom Arenstam");
    }

    // 12
    #[test]
    fn interleaved_indexes_do_not_corrupt_each_other() {
        let input = start(0, "text")
            + &start(1, "tool_use")
            + &text(0, "Term-")
            + &pj(1, r#"{"a":"Person-"#)
            + &text(0, "274 ok")
            + &pj(1, r#"27"}"#)
            + &stop(1)
            + &stop(0);
        let out = run(session(), &[input.as_bytes()]);
        let (mut t, mut j) = (String::new(), String::new());
        for (_, d) in parse_events(&out) {
            if let Some(x) = d["delta"]["text"].as_str() {
                assert_eq!(d["index"], 0);
                t.push_str(x);
            }
            if let Some(x) = d["delta"]["partial_json"].as_str() {
                assert_eq!(d["index"], 1);
                j.push_str(x);
            }
        }
        assert_eq!(t, "ScanModule ok");
        assert_eq!(j, r#"{"a":"Tom Arenstam"}"#);
    }

    // 13
    #[test]
    fn comments_non_json_done_and_custom_events_pass_verbatim() {
        let input = ": keepalive\n\nevent: custom\ndata: {\"type\":\"custom\",\"x\":\"Person-27\"}\n\ndata: not-json\n\ndata: [DONE]\n\nevent: weird\nid: 7\nretry: 100\ndata: {\"a\": 1}\n\n";
        let out = run(session(), &[input.as_bytes()]);
        assert_eq!(out, input);
    }

    // 14
    #[test]
    fn crlf_input_is_normalized_and_complete() {
        let lf = start(0, "text") + &text(0, "Hi Person-27") + &stop(0);
        let crlf = lf.replace('\n', "\r\n");
        let out = run(session(), &[crlf.as_bytes()]);
        assert!(!out.contains('\r'));
        assert_eq!(all_text(&out), "Hi Tom Arenstam");
        assert_eq!(parse_events(&out).len(), 4); // start, delta, tail delta, stop
    }

    // 15
    #[test]
    fn eof_without_blank_line_flushes_held_tail() {
        let mut input = start(0, "text") + &text(0, "Hallo Person-27");
        input.truncate(input.len() - 2); // no blank line and no final newline
        assert!(!input.ends_with('\n'));
        let mut d = AnthropicSseDecloaker::new(session());
        let during = d.feed(input.as_bytes());
        assert_eq!(all_text(&during), "", "the dangling event is not processed before EOF");
        let out = during + &d.finish();
        assert_eq!(all_text(&out), "Hallo Tom Arenstam");
    }

    // 16
    #[test]
    fn multi_line_data_is_joined_with_newline() {
        let ev = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\ndata: \"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Person-27\"}}\n\n";
        let input = start(0, "text") + ev + &stop(0);
        let out = run(session(), &[input.as_bytes()]);
        assert_eq!(all_text(&out), "Tom Arenstam");
    }

    // 17
    #[test]
    fn non_stream_message_decloaked() {
        let mut msg = json!({"content": [
            {"type": "text", "text": "Hi Person-27"},
            {"type": "tool_use", "id": "Person-27", "name": "w", "input": {"Person-27": ["Term-274", {"k": "x Person-27"}], "n": 3}},
            {"type": "thinking", "thinking": "Person-27", "signature": "Term-274"}
        ]});
        decloak_anthropic_message(&session(), &mut msg);
        assert_eq!(msg["content"][0]["text"], "Hi Tom Arenstam");
        let input = &msg["content"][1]["input"];
        assert_eq!(input["Person-27"][0], "ScanModule", "keys untouched, values decloaked");
        assert_eq!(input["Person-27"][1]["k"], "x Tom Arenstam");
        assert_eq!(input["n"], 3);
        assert_eq!(msg["content"][1]["id"], "Person-27");
        assert_eq!(msg["content"][2]["thinking"], "Person-27");
        assert_eq!(msg["content"][2]["signature"], "Term-274");
    }

    // 18
    #[tokio::test]
    async fn anthropic_error_shape() {
        let r = anthropic_error(StatusCode::UNPROCESSABLE_ENTITY, "cloak_unavailable", "no compilation");
        assert_eq!(r.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(r.headers()[header::CONTENT_TYPE], "application/json");
        let bytes = axum::body::to_bytes(r.into_body(), 4096).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v, json!({"type": "error", "error": {"type": "cloak_unavailable", "message": "no compilation"}}));
    }
}

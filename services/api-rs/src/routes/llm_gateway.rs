//! Cloaking LLM gateway — an OpenAI-compatible `POST /v1/chat/completions`
//! endpoint that sits IN FRONT OF Ollama and pseudonymizes ("cloaks") requests
//! bound for CLOUD models before they leave the machine, then de-cloaks the
//! streamed answer. Local models pass through transparently with zero cloaking.
//!
//! ## Why it forwards to Ollama
//! Ollama's own `/v1/chat/completions` is the single egress: local tags run
//! on-box; `*-cloud` tags (e.g. `gpt-oss:120b-cloud`) are proxied by Ollama out
//! to ollama.com. So this gateway does NOT talk to cloud providers directly — it
//! cloaks the body, hands it to Ollama, and Ollama decides local-vs-cloud from
//! the model tag. The cloud-vs-local decision HERE (does the answer need
//! cloaking?) is therefore driven by the model tag, not a base URL.
//!
//! ## OLLAMA_HOST env + Docker caveat
//! Upstream base is read from `OLLAMA_HOST` (falling back to `OLLAMA_BASE`, then
//! `http://localhost:11434`). When the API runs inside a container, a loopback
//! host refers to the container itself, not the host where a native (GPU) Ollama
//! listens — [`crate::services::llm::containerize_ollama_base`] rewrites
//! localhost → `host.docker.internal` so the natural `http://localhost:11434`
//! just works from inside Docker.
//!
//! ## Auth
//! `Authorization: ApiKey <gctrl-token>` (same scheme as the agent MCP endpoint)
//! OR `Authorization: Bearer <gctrl-token>` — some OpenAI clients (pi's
//! `--api-key`) force Bearer, so both prefixes are accepted and resolved against
//! `api_keys` first, then tried as a JWT. Missing/invalid → 401. This route is
//! mounted OUTSIDE the auth middleware so it can accept the Bearer-as-api-key
//! shape (the shared middleware treats Bearer strictly as a JWT).
//!
//! ## Cloak toggle
//! `X-Anvil-Cloak: on|off` (default **on**). `off` forces transparent
//! passthrough even for a cloud model. Cloaking only ever engages for a
//! cloud-tagged model with the toggle on; local models never cloak.
//!
//! ## Fail-closed
//! If cloaking is required (cloud model + toggle on) but any cloak step can't be
//! completed — no per-user namespace compilation to key the pseudonym registry,
//! a malformed body — the request is REJECTED. Plaintext is never forwarded to a
//! cloud-tagged model as a fallback. A local-passthrough upstream failure is a
//! normal 502.

use std::sync::Arc;

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::middleware::auth::JwtClaims;
use crate::services::privacy;

/// Reused across requests so the upstream Ollama connection is keep-alived and
/// the proxy hop stays sub-millisecond (no fresh TCP/TLS per request).
static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .expect("reqwest client builds")
});

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new().route("/v1/chat/completions", post(chat_completions))
}

// ── Upstream resolution ──────────────────────────────────────────────────────

/// Resolve the upstream Ollama base URL (env-driven, Docker-aware). See the
/// module docs for the OLLAMA_HOST/OLLAMA_BASE precedence and the Docker caveat.
fn ollama_base() -> String {
    let raw = std::env::var("OLLAMA_HOST")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("OLLAMA_BASE").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    // Ollama's own OLLAMA_HOST is often bare (`0.0.0.0:11434`) — normalize to a URL.
    let raw = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw
    } else {
        format!("http://{raw}")
    };
    crate::services::llm::containerize_ollama_base(raw.trim_end_matches('/'))
}

fn completions_url() -> String {
    format!("{}/v1/chat/completions", ollama_base().trim_end_matches('/'))
}

// ── Cloud-vs-local decision ──────────────────────────────────────────────────

/// Does this model tag route OUT to a cloud provider (via Ollama's cloud
/// passthrough)? Ollama's hosted models carry a `-cloud`/`:cloud` suffix
/// (`gpt-oss:120b-cloud`, `deepseek-v3.1:671b-cloud`). Everything else is a
/// local, on-box model. Pure so it's unit-tested.
fn model_targets_cloud(model: &str) -> bool {
    let m = model.trim().to_ascii_lowercase();
    m.ends_with("-cloud") || m.ends_with(":cloud")
}

/// Is the caller opting OUT of cloaking? `X-Anvil-Cloak: off|0|false` disables it;
/// anything else (including absent) leaves the default ON.
fn cloak_disabled(headers: &HeaderMap) -> bool {
    headers
        .get("x-anvil-cloak")
        .or_else(|| headers.get("x-cloak"))
        .and_then(|v| v.to_str().ok())
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no"))
        .unwrap_or(false)
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/// Resolve `Authorization` to a user. Accepts `ApiKey <t>` and `Bearer <t>`; the
/// token is tried as a gctrl api-key first (hash lookup), then as a JWT. Returns
/// `None` for missing/invalid/expired/inactive.
async fn authenticate(
    state: &Arc<crate::models::AppState>,
    headers: &HeaderMap,
) -> Option<JwtClaims> {
    let raw = headers.get("authorization").and_then(|v| v.to_str().ok())?;
    let token = raw
        .strip_prefix("ApiKey ")
        .or_else(|| raw.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())?;

    // 1. Try as a gctrl access token (the primary shape — same query the auth
    //    middleware uses). Inactive users / expired keys are filtered by the join.
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    if let Ok(Some((key_id, user_id, max_rank, email, role, read_only))) =
        sqlx::query_as::<_, (uuid::Uuid, uuid::Uuid, i32, String, String, bool)>(
            "SELECT ak.id, ak.user_id, ak.max_clearance_rank, u.email, u.role, ak.read_only
             FROM api_keys ak JOIN users u ON u.id = ak.user_id
             WHERE ak.key_hash = $1 AND u.is_active = true
               AND (ak.expires_at IS NULL OR ak.expires_at > NOW())",
        )
        .bind(&hash)
        .fetch_optional(&state.db)
        .await
    {
        return Some(JwtClaims {
            sub: user_id,
            email,
            role,
            clearance: None,
            exp: usize::MAX,
            api_key_rank: Some(max_rank),
            api_key_id: Some(key_id),
            read_only,
            agent_override_rank: None,
        });
    }

    // 2. Fall back to a JWT (a logged-in browser user forced through Bearer).
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
    let key = DecodingKey::from_secret(state.cfg.jwt_secret.as_bytes());
    let claims = decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256))
        .ok()?
        .claims;
    let active: Option<bool> = sqlx::query_scalar("SELECT is_active FROM users WHERE id = $1")
        .bind(claims.sub)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    matches!(active, Some(true)).then_some(claims)
}

/// Pick the per-user namespace compilation that keys the pseudonym registry
/// (`cloak_maps.compilation_id`, a FK to `compilations`). We use the user's
/// earliest-created owned compilation as a STABLE per-user namespace so the same
/// entity → the same pseudonym across turns and sessions of free chat (there is
/// no per-conversation graph here). Returns `None` if the user owns no
/// compilation — the caller then fails closed rather than send plaintext.
async fn cloak_namespace(state: &Arc<crate::models::AppState>, user_id: uuid::Uuid) -> Option<uuid::Uuid> {
    sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT id FROM compilations WHERE user_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
}

// ── Handler ──────────────────────────────────────────────────────────────────

/// Traced wrapper: one CHAIN span per gateway request (model, whether cloaking
/// engaged, resulting HTTP status), exported to Phoenix when enabled. Delegates
/// so the inner handler's many early-return paths are all captured. No-op when
/// tracing is off.
async fn chat_completions(
    state: axum::extract::State<Arc<crate::models::AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    use tracing::Instrument;
    let model = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_default();
    let cloak_on = model_targets_cloud(&model) && !cloak_disabled(&headers);
    let span = tracing::info_span!(
        "gctrl.cloak_gateway",
        "openinference.span.kind" = "CHAIN",
        "llm.model_name" = %model,
        "gctrl.cloaked" = cloak_on,
        "http.status_code" = tracing::field::Empty,
    );
    let resp = chat_completions_inner(state, headers, body).instrument(span.clone()).await;
    span.record("http.status_code", resp.status().as_u16());
    resp
}

async fn chat_completions_inner(
    axum::extract::State(state): axum::extract::State<Arc<crate::models::AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Auth (manual — this route is not behind the auth middleware).
    let Some(claims) = authenticate(&state, &headers).await else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": { "message": "missing or invalid Authorization (use `ApiKey <token>` or `Bearer <token>`)", "type": "unauthorized" } })),
        )
            .into_response();
    };

    // Parse the OpenAI body.
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": { "message": format!("invalid JSON body: {e}"), "type": "invalid_request_error" } })),
            )
                .into_response()
        }
    };

    let model = parsed.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let stream = parsed.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let is_cloud = model_targets_cloud(&model);
    let cloak_on = is_cloud && !cloak_disabled(&headers);

    // ── Transparent passthrough: local model, or cloud with cloak explicitly off.
    if !cloak_on {
        return proxy_passthrough(body, stream).await;
    }

    // ── Cloak path (cloud model + toggle on) — FAIL CLOSED from here on. ──
    // Namespace to key the persistent pseudonym registry. No owned compilation →
    // we cannot durably/stably cloak → refuse (never forward plaintext to cloud).
    let Some(namespace) = cloak_namespace(&state, claims.sub).await else {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": { "message": "cloaking required for a cloud model but this account owns no knowledge base to anchor the cloak map — create one, or send X-Anvil-Cloak: off to route plaintext.", "type": "cloak_unavailable" } })),
        )
            .into_response();
    };

    // Dictionary of the user's own extracted entities (+ PII regex fallback inside
    // cloak()). Cached per-user for 10 min.
    let candidates = privacy::user_entity_candidates(&state.db, claims.sub).await;

    // Cloak every message's string content, accumulating ONE session so the same
    // entity → the same pseudonym across the whole conversation.
    let mut cloak_session = privacy::CloakSession::empty();
    let mut out_body = parsed.clone();
    let ns = [namespace];
    if let Some(messages) = out_body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for msg in messages.iter_mut() {
            let Some(content) = msg.get("content").and_then(|c| c.as_str()) else { continue };
            if content.is_empty() {
                continue;
            }
            let (cloaked, sess) = privacy::cloak(&state.db, &ns, &candidates, content).await;
            cloak_session.merge(sess);
            msg["content"] = json!(cloaked);
        }
    }
    tracing::debug!(
        "llm_gateway: cloaked {} entities for user {} (model {})",
        cloak_session.map.len(),
        claims.sub,
        model
    );

    let out_bytes = match serde_json::to_vec(&out_body) {
        Ok(b) => Bytes::from(b),
        // Serializing our own JSON should never fail; fail closed if it somehow does.
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": { "message": format!("cloak encode failed: {e}"), "type": "cloak_error" } })),
            )
                .into_response()
        }
    };

    if stream {
        proxy_stream_decloaked(out_bytes, cloak_session).await
    } else {
        proxy_once_decloaked(out_bytes, cloak_session).await
    }
}

// ── Transparent passthrough ──────────────────────────────────────────────────

/// Byte-for-byte reverse proxy to Ollama. Streams the upstream body through
/// unchanged; used for local models and for cloud+cloak-off.
async fn proxy_passthrough(body: Bytes, stream: bool) -> Response {
    let resp = match HTTP
        .post(completions_url())
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(e),
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| if stream { "text/event-stream".into() } else { "application/json".into() });

    let upstream = resp.bytes_stream().map(|r| r.map_err(std::io::Error::other));
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Body::from_stream(upstream))
        .unwrap()
}

// ── Cloaked streaming ────────────────────────────────────────────────────────

/// Forward the cloaked body with `stream:true` and re-stream the SSE response,
/// de-cloaking each `choices[].delta.content` (streaming-safe across chunk
/// boundaries) so the CALLER receives plaintext. The SSE envelope is preserved —
/// only the delta text is rewritten.
async fn proxy_stream_decloaked(body: Bytes, session: privacy::CloakSession) -> Response {
    let resp = match HTTP
        .post(completions_url())
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(e),
    };
    if !resp.status().is_success() {
        let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let text = resp.text().await.unwrap_or_default();
        return (status, text).into_response();
    }

    let out = async_stream::stream! {
        let mut bytes = resp.bytes_stream();
        let mut line_buf = String::new();      // reassembles SSE lines across TCP chunks
        let mut decloak_buf = String::new();   // holds partial pseudonyms across content deltas
        // Reasoning models stream their chain-of-thought as a SEPARATE delta field
        // (`reasoning`/`reasoning_content`/`thinking`) that quotes the cloaked
        // prompt — it needs its own rolling buffer, or interleaved content/
        // reasoning deltas would corrupt each other's partial-pseudonym state.
        let mut reasoning_buf = String::new();

        while let Some(chunk) = bytes.next().await {
            let chunk = match chunk {
                Ok(b) => b,
                Err(e) => { yield Ok::<Bytes, std::io::Error>(Bytes::from(format!("data: {{\"error\":\"stream: {e}\"}}\n\n"))); break; }
            };
            let Ok(text) = std::str::from_utf8(&chunk) else { continue };
            line_buf.push_str(text);

            while let Some(nl) = line_buf.find('\n') {
                // Keep the newline semantics: take the line incl. trailing \n.
                let raw_line: String = line_buf.drain(..=nl).collect();
                let line = raw_line.trim_end_matches(['\n', '\r']);

                let Some(data) = line.strip_prefix("data:") else {
                    // Non-data SSE line (comment/blank/event:) — pass through verbatim.
                    yield Ok(Bytes::from(raw_line));
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    // Flush any held-back tails as final deltas, then [DONE].
                    let r_tail = privacy::decloak_stream_finish(&session, &mut reasoning_buf);
                    if !r_tail.is_empty() {
                        let ev = json!({ "choices": [ { "index": 0, "delta": { "reasoning": r_tail }, "finish_reason": Value::Null } ] });
                        yield Ok(Bytes::from(format!("data: {ev}\n\n")));
                    }
                    let tail = privacy::decloak_stream_finish(&session, &mut decloak_buf);
                    if !tail.is_empty() {
                        let ev = json!({ "choices": [ { "index": 0, "delta": { "content": tail }, "finish_reason": Value::Null } ] });
                        yield Ok(Bytes::from(format!("data: {ev}\n\n")));
                    }
                    yield Ok(Bytes::from("data: [DONE]\n\n"));
                    continue;
                }
                let Ok(mut v) = serde_json::from_str::<Value>(data) else {
                    // Not JSON we understand — pass the original line through.
                    yield Ok(Bytes::from(raw_line));
                    continue;
                };

                // De-cloak each choice's delta (usually one): `content` and any
                // reasoning-style field, each through its OWN rolling buffer.
                if let Some(choices) = v.get_mut("choices").and_then(|c| c.as_array_mut()) {
                    for choice in choices.iter_mut() {
                        let has_finish = choice.get("finish_reason").map(|f| !f.is_null()).unwrap_or(false);

                        // Reasoning delta (whichever variant the upstream uses).
                        for field in ["reasoning", "reasoning_content", "thinking"] {
                            let Some(text) = choice.get("delta").and_then(|d| d.get(field)).and_then(|c| c.as_str()) else { continue };
                            let mut emit = privacy::decloak_stream_chunk(&session, &mut reasoning_buf, text);
                            if has_finish {
                                emit.push_str(&privacy::decloak_stream_finish(&session, &mut reasoning_buf));
                            }
                            if let Some(delta) = choice.get_mut("delta").and_then(|d| d.as_object_mut()) {
                                delta.insert(field.into(), json!(emit));
                            }
                        }

                        let content = choice
                            .get("delta")
                            .and_then(|d| d.get("content"))
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        let mut emit = privacy::decloak_stream_chunk(&session, &mut decloak_buf, content);
                        if has_finish {
                            emit.push_str(&privacy::decloak_stream_finish(&session, &mut decloak_buf));
                        }
                        // Only rewrite when there was a content field or we have text to flush,
                        // so role-only preamble deltas stay untouched.
                        let had_content = choice.get("delta").and_then(|d| d.get("content")).is_some();
                        if had_content || !emit.is_empty() {
                            if let Some(delta) = choice.get_mut("delta").and_then(|d| d.as_object_mut()) {
                                delta.insert("content".into(), json!(emit));
                            }
                        }
                    }
                }
                yield Ok(Bytes::from(format!("data: {v}\n\n")));
            }
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(out))
        .unwrap()
}

/// Non-streaming cloak path: forward, then de-cloak each choice's
/// `message.content` in the full JSON response before returning it.
async fn proxy_once_decloaked(body: Bytes, session: privacy::CloakSession) -> Response {
    let resp = match HTTP
        .post(completions_url())
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(e),
    };
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut v: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": { "message": format!("upstream decode: {e}"), "type": "upstream_error" } }))).into_response(),
    };
    if let Some(choices) = v.get_mut("choices").and_then(|c| c.as_array_mut()) {
        for choice in choices.iter_mut() {
            // De-cloak EVERY text field the model can emit — reasoning models
            // (gpt-oss, deepseek-r1, …) return their chain-of-thought in a
            // `reasoning`/`reasoning_content`/`thinking` field that quotes the
            // (cloaked) prompt, so de-cloaking only `content` leaked pseudonyms
            // like [EMAIL-N] to the client (caught by the release cloaking gate).
            for field in ["content", "reasoning", "reasoning_content", "thinking"] {
                if let Some(text) = choice.get("message").and_then(|m| m.get(field)).and_then(|c| c.as_str()) {
                    let plain = privacy::decloak(&session, text);
                    if let Some(msg) = choice.get_mut("message").and_then(|m| m.as_object_mut()) {
                        msg.insert(field.into(), json!(plain));
                    }
                }
            }
        }
    }
    (status, Json(v)).into_response()
}

fn upstream_unreachable(e: reqwest::Error) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": { "message": format!("Ollama upstream unreachable: {e}"), "type": "upstream_error" } })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn cloud_tag_detection() {
        assert!(model_targets_cloud("gpt-oss:120b-cloud"));
        assert!(model_targets_cloud("deepseek-v3.1:671b-cloud"));
        assert!(model_targets_cloud("GPT-OSS:120B-CLOUD"), "case-insensitive");
        assert!(model_targets_cloud("something:cloud"));
        // Local tags are NOT cloud.
        assert!(!model_targets_cloud("llama3.2"));
        assert!(!model_targets_cloud("qwen2.5:7b"));
        assert!(!model_targets_cloud("cloudy-llama"), "'cloud' only counts as a tag suffix");
        assert!(!model_targets_cloud(""));
    }

    #[test]
    fn cloak_toggle_defaults_on() {
        let mut h = HeaderMap::new();
        assert!(!cloak_disabled(&h), "absent header → cloak stays on");
        h.insert("x-anvil-cloak", HeaderValue::from_static("on"));
        assert!(!cloak_disabled(&h));
        h.insert("x-anvil-cloak", HeaderValue::from_static("off"));
        assert!(cloak_disabled(&h));
        h.insert("x-anvil-cloak", HeaderValue::from_static("0"));
        assert!(cloak_disabled(&h));
        h.insert("x-anvil-cloak", HeaderValue::from_static("FALSE"));
        assert!(cloak_disabled(&h));
    }

    #[test]
    fn ollama_base_normalizes_bare_host() {
        // Bare host:port (Ollama's own OLLAMA_HOST convention) gains a scheme.
        std::env::set_var("OLLAMA_HOST", "0.0.0.0:11434");
        assert!(ollama_base().starts_with("http://"));
        std::env::remove_var("OLLAMA_HOST");
    }
}

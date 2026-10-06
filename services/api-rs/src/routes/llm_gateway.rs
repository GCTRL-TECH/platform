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
//! ## Upstream selection
//! `X-Upstream-Provider: anthropic|openai` (case-insensitive) picks the upstream;
//! absent/empty = local Ollama, byte for byte today's behaviour. This module serves
//! `POST /v1/chat/completions` for Ollama and OpenAI; Anthropic's `/v1/messages`
//! lives in the sibling module `llm_gateway_anthropic`, which builds on the
//! `pub(super)` items here (auth, upstream base, header allowlist, cloak helpers).
//! Bases come from `ANTHROPIC_BASE` / `OPENAI_BASE` (official host pinned via
//! `validate_llm_base`; dev escape hatch `GCTRL_CLOAK_UPSTREAM_UNPINNED=1`).
//! `GET /v1/cloak/capabilities` (no auth) lists the supported upstreams.
//!
//! ## Auth
//! Ollama route: `Authorization: ApiKey <gctrl-token>` OR `Authorization: Bearer
//! <gctrl-token>` (pi's `--api-key` forces Bearer), resolved against `api_keys`
//! first, then tried as a JWT. Missing/invalid -> 401. This route is mounted
//! OUTSIDE the auth middleware so it can accept the Bearer-as-api-key shape (the
//! shared middleware treats Bearer strictly as a JWT).
//!
//! Vendor upstreams (OpenAI/Anthropic): the caller's vendor credential travels in
//! the STANDARD place (`x-api-key` or `Authorization: Bearer`) and is forwarded;
//! the gctrl token goes in `X-GCTRL-Token` (optional `ApiKey `/`Bearer ` prefix).
//! If `X-GCTRL-Token` is absent the gctrl token is read from `Authorization`
//! (fallback) and that header is then NOT forwarded upstream. Only an ALLOWLIST
//! of request headers reaches the upstream (see [`forward_headers`]).
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
    routing::{get, post},
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
pub(super) static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .expect("reqwest client builds")
});

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/cloak/capabilities", get(capabilities))
}

/// Capability probe (no auth): which upstreams this gateway can cloak for.
/// Anvil polls it to decide what to offer; keep the list stable.
async fn capabilities() -> Json<Value> {
    Json(json!({
        "upstreams": ["ollama", "anthropic", "openai"],
        "version": crate::routes::update::current_version(),
    }))
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

/// Which upstream a request is bound for (`X-Upstream-Provider`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Upstream {
    Ollama,
    Anthropic,
    OpenAi,
}

/// Read `x-upstream-provider`. Absent/empty -> Ollama; unknown -> 400.
pub(super) fn upstream_from_headers(headers: &HeaderMap) -> Result<Upstream, Response> {
    let raw = headers
        .get("x-upstream-provider")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match raw.as_str() {
        "" => Ok(Upstream::Ollama),
        "anthropic" => Ok(Upstream::Anthropic),
        "openai" => Ok(Upstream::OpenAi),
        other => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "message": format!("unknown X-Upstream-Provider '{other}' (allowed: anthropic, openai; omit for ollama)"), "type": "invalid_request_error" } })),
        )
            .into_response()),
    }
}

/// Pure core of [`upstream_base`] (testable without env). `raw` is the env value;
/// `unpinned` skips the official-host pin (dev only).
pub(super) fn upstream_base_from(upstream: Upstream, raw: Option<&str>, unpinned: bool) -> Result<String, String> {
    let (provider, default) = match upstream {
        Upstream::Ollama => return Ok(ollama_base()),
        Upstream::Anthropic => ("anthropic", "https://api.anthropic.com"),
        Upstream::OpenAi => ("openai", "https://api.openai.com"),
    };
    let raw = raw.map(str::trim).filter(|s| !s.is_empty());
    if unpinned {
        tracing::warn!("GCTRL_CLOAK_UPSTREAM_UNPINNED set: {provider} upstream base is NOT pinned to the official host");
        return Ok(raw.unwrap_or(default).trim_end_matches('/').to_string());
    }
    let url = crate::services::llm::validate_llm_base(provider, raw)?;
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Resolve the upstream base URL from env (`ANTHROPIC_BASE` / `OPENAI_BASE`).
/// An invalid base is an error (-> 500 api_error), never a silent fallback.
pub(super) fn upstream_base(upstream: Upstream) -> Result<String, String> {
    let var = match upstream {
        Upstream::Ollama => return Ok(ollama_base()),
        Upstream::Anthropic => "ANTHROPIC_BASE",
        Upstream::OpenAi => "OPENAI_BASE",
    };
    let unpinned = std::env::var("GCTRL_CLOAK_UPSTREAM_UNPINNED")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true"))
        .unwrap_or(false);
    upstream_base_from(upstream, std::env::var(var).ok().as_deref(), unpinned)
}

// ── Header allowlist ─────────────────────────────────────────────────────────

/// Build the upstream request headers from the caller's. ALLOWLIST only: anything
/// not listed (host, content-length, accept-encoding, hop-by-hop, cookie,
/// x-forwarded-*, x-gctrl-token, x-anvil-cloak, x-upstream-provider, ...) is
/// dropped. `authorization` is dropped when it carried the gctrl token.
pub(super) fn forward_headers(incoming: &HeaderMap, upstream: Upstream, consumed_authorization: bool) -> HeaderMap {
    const ALLOW: [&str; 8] = [
        "x-api-key",
        "authorization",
        "anthropic-version",
        "anthropic-beta",
        "user-agent",
        "x-app",
        "anthropic-dangerous-direct-browser-access",
        "accept",
    ];
    let mut out = HeaderMap::new();
    for (name, value) in incoming.iter() {
        let n = name.as_str();
        if n == "authorization" && consumed_authorization {
            continue;
        }
        if ALLOW.contains(&n) || n.starts_with("x-stainless-") {
            out.append(name.clone(), value.clone());
        }
    }
    out.insert("content-type", axum::http::HeaderValue::from_static("application/json"));
    if upstream == Upstream::Anthropic && !out.contains_key("anthropic-version") {
        out.insert("anthropic-version", axum::http::HeaderValue::from_static("2023-06-01"));
    }
    out
}

/// Upstream response headers worth relaying to the caller.
pub(super) fn relay_response_headers(
    upstream: &reqwest::header::HeaderMap,
) -> Vec<(axum::http::HeaderName, axum::http::HeaderValue)> {
    upstream
        .iter()
        .filter(|(n, _)| {
            let n = n.as_str();
            matches!(n, "content-type" | "request-id" | "retry-after") || n.starts_with("anthropic-ratelimit-")
        })
        .filter_map(|(n, v)| {
            Some((
                axum::http::HeaderName::from_bytes(n.as_str().as_bytes()).ok()?,
                axum::http::HeaderValue::from_bytes(v.as_bytes()).ok()?,
            ))
        })
        .collect()
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
pub(super) fn cloak_disabled(headers: &HeaderMap) -> bool {
    headers
        .get("x-anvil-cloak")
        .or_else(|| headers.get("x-cloak"))
        .and_then(|v| v.to_str().ok())
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no"))
        .unwrap_or(false)
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/// Resolve `Authorization` to a user. Accepts `ApiKey <t>` and `Bearer <t>`;
/// the token is handed to [`resolve_gctrl_token`]. Returns `None` for
/// missing/invalid/expired/inactive.
pub(super) async fn authenticate(
    state: &Arc<crate::models::AppState>,
    headers: &HeaderMap,
) -> Option<JwtClaims> {
    let raw = headers.get("authorization").and_then(|v| v.to_str().ok())?;
    let token = raw
        .strip_prefix("ApiKey ")
        .or_else(|| raw.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())?;
    resolve_gctrl_token(state, token).await
}

/// Resolve a bare gctrl token to a user: api-key hash lookup first, then JWT.
pub(super) async fn resolve_gctrl_token(
    state: &Arc<crate::models::AppState>,
    token: &str,
) -> Option<JwtClaims> {
    // 1. Try as a gctrl access token (the primary shape — same query the auth
    //    middleware uses). Inactive users / expired keys are filtered by the join.
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    if let Ok(Some((key_id, user_id, max_rank, email, role, read_only, code_access))) =
        sqlx::query_as::<_, (uuid::Uuid, uuid::Uuid, i32, String, String, bool, bool)>(
            "SELECT ak.id, ak.user_id, ak.max_clearance_rank, u.email, u.role, ak.read_only, ak.code_access
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
            code_access,
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
pub(super) async fn cloak_namespace(state: &Arc<crate::models::AppState>, user_id: uuid::Uuid) -> Option<uuid::Uuid> {
    sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT id FROM compilations WHERE user_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
}

/// Who is calling, and whether their `Authorization` header was spent on the
/// gctrl token (then it must NOT be forwarded as the vendor credential).
pub(super) struct GatewayIdentity {
    pub claims: JwtClaims,
    pub consumed_authorization: bool,
}

/// Vendor-route auth: `X-GCTRL-Token` first (optional `ApiKey `/`Bearer ` prefix),
/// else fall back to `Authorization` (consumed).
pub(super) async fn authenticate_gateway(
    state: &Arc<crate::models::AppState>,
    headers: &HeaderMap,
) -> Option<GatewayIdentity> {
    let dedicated = headers
        .get("x-gctrl-token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|t| !t.is_empty());
    if let Some(raw) = dedicated {
        let token = raw
            .strip_prefix("ApiKey ")
            .or_else(|| raw.strip_prefix("Bearer "))
            .map(str::trim)
            .unwrap_or(raw);
        let claims = resolve_gctrl_token(state, token).await?;
        return Some(GatewayIdentity { claims, consumed_authorization: false });
    }
    let claims = authenticate(state, headers).await?;
    Some(GatewayIdentity { claims, consumed_authorization: true })
}

/// Does the request carry a vendor credential for the upstream? Non-empty
/// `x-api-key`, or an `authorization` header that was not spent on the gctrl token.
pub(super) fn has_upstream_credential(headers: &HeaderMap, consumed_authorization: bool) -> bool {
    let non_empty = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    };
    non_empty("x-api-key") || (!consumed_authorization && non_empty("authorization"))
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
    let upstream = upstream_from_headers(&headers).unwrap_or(Upstream::Ollama);
    let cloud = upstream == Upstream::OpenAi || model_targets_cloud(&model);
    let cloak_on = cloud && !cloak_disabled(&headers);
    let span = tracing::info_span!(
        "gctrl.cloak_gateway",
        "openinference.span.kind" = "CHAIN",
        "llm.model_name" = %model,
        "gctrl.upstream" = ?upstream,
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
    let upstream = match upstream_from_headers(&headers) {
        Ok(u) => u,
        Err(resp) => return resp,
    };
    if upstream == Upstream::Anthropic {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "message": "use /v1/messages for anthropic", "type": "invalid_request_error" } })),
        )
            .into_response();
    }
    let unauthorized = || {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": { "message": "missing or invalid Authorization (use `ApiKey <token>` or `Bearer <token>`)", "type": "unauthorized" } })),
        )
            .into_response()
    };

    // Auth (manual — this route is not behind the auth middleware).
    let (claims, url, upstream_headers) = if upstream == Upstream::OpenAi {
        let Some(identity) = authenticate_gateway(&state, &headers).await else {
            return unauthorized();
        };
        if !has_upstream_credential(&headers, identity.consumed_authorization) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": { "message": "no upstream credential: send Authorization: Bearer <openai key> and the gctrl token in X-GCTRL-Token", "type": "unauthorized" } })),
            )
                .into_response();
        }
        let base = match upstream_base(upstream) {
            Ok(b) => b,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": { "message": format!("invalid upstream base: {e}"), "type": "api_error" } })),
                )
                    .into_response()
            }
        };
        let fwd = forward_headers(&headers, upstream, identity.consumed_authorization);
        (identity.claims, format!("{base}/v1/chat/completions"), fwd)
    } else {
        let Some(claims) = authenticate(&state, &headers).await else {
            return unauthorized();
        };
        let mut fwd = HeaderMap::new();
        fwd.insert("content-type", axum::http::HeaderValue::from_static("application/json"));
        (claims, completions_url(), fwd)
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
    // OpenAI is always a cloud egress (not tag based); Ollama keeps the tag rule.
    let is_cloud = upstream == Upstream::OpenAi || model_targets_cloud(&model);
    let cloak_on = is_cloud && !cloak_disabled(&headers);

    // ── Transparent passthrough: local model, or cloud with cloak explicitly off.
    if !cloak_on {
        return proxy_passthrough(body, stream, url, upstream_headers).await;
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

    // Cloak every message's string content in ONE pass, so the same entity → the
    // same pseudonym across the whole conversation AND the pseudonym registry is
    // read once per request rather than once per message.
    let mut out_body = parsed.clone();
    let ns = [namespace];
    let (slots, plain) = out_body
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|m| collect_cloak_texts(m))
        .unwrap_or_default();
    let refs: Vec<&str> = plain.iter().map(String::as_str).collect();
    let (cloaked, cloak_session) = privacy::cloak_batch(&state.db, &ns, &candidates, &refs).await;
    if let Some(messages) = out_body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        write_cloaked_texts(messages, &slots, &cloaked);
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
        proxy_stream_decloaked(out_bytes, cloak_session, url, upstream_headers).await
    } else {
        proxy_once_decloaked(out_bytes, cloak_session, url, upstream_headers).await
    }
}

// ── Transparent passthrough ──────────────────────────────────────────────────

/// Byte-for-byte reverse proxy to Ollama. Streams the upstream body through
/// unchanged; used for local models and for cloud+cloak-off.
async fn proxy_passthrough(body: Bytes, stream: bool, url: String, upstream_headers: HeaderMap) -> Response {
    let resp = match HTTP
        .post(url)
        .headers(upstream_headers)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(e),
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let relayed = relay_response_headers(resp.headers());
    let has_content_type = relayed.iter().any(|(n, _)| n == "content-type");

    let upstream = resp.bytes_stream().map(|r| r.map_err(std::io::Error::other));
    let mut out = Response::builder().status(status);
    if !has_content_type {
        out = out.header("content-type", if stream { "text/event-stream" } else { "application/json" });
    }
    for (n, v) in relayed {
        out = out.header(n, v);
    }
    out.body(Body::from_stream(upstream)).unwrap()
}

// ── Cloaked streaming ────────────────────────────────────────────────────────

/// Forward the cloaked body with `stream:true` and re-stream the SSE response,
/// de-cloaking each `choices[].delta.content` (streaming-safe across chunk
/// boundaries) so the CALLER receives plaintext. The SSE envelope is preserved —
/// only the delta text is rewritten.
async fn proxy_stream_decloaked(
    body: Bytes,
    session: privacy::CloakSession,
    url: String,
    upstream_headers: HeaderMap,
) -> Response {
    let resp = match HTTP
        .post(url)
        .headers(upstream_headers)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(e),
    };
    if !resp.status().is_success() {
        let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let relayed = relay_response_headers(resp.headers());
        let text = resp.text().await.unwrap_or_default();
        let mut out = (status, text).into_response();
        for (n, v) in relayed {
            out.headers_mut().insert(n, v);
        }
        return out;
    }
    let relayed: Vec<_> = relay_response_headers(resp.headers())
        .into_iter()
        .filter(|(n, _)| n != "content-type")
        .collect();

    let out = async_stream::stream! {
        let mut bytes = resp.bytes_stream();
        let mut line_buf = String::new();      // reassembles SSE lines across TCP chunks
        let mut decloak_buf = String::new();   // holds partial pseudonyms across content deltas
        // Reasoning models stream their chain-of-thought as a SEPARATE delta field
        // (`reasoning`/`reasoning_content`/`thinking`) that quotes the cloaked
        // prompt — it needs its own rolling buffer, or interleaved content/
        // reasoning deltas would corrupt each other's partial-pseudonym state.
        let mut reasoning_buf = String::new();
        // Tool-call arguments also stream as fragments, and a pseudonym can be
        // split across them (`"Term-"` then `"3170"`). Each tool call therefore
        // needs its OWN rolling buffer, keyed by the `index` carried on every
        // `delta.tool_calls[]` entry, so fragments for different calls never
        // corrupt each other's partial-pseudonym state. NOTE: only de-cloaked
        // here — tool-call args are NEVER cloaked on the request side.
        let mut toolarg_bufs: std::collections::HashMap<i64, String> = std::collections::HashMap::new();

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
                    // Backstop for a stream that ended WITHOUT a finish_reason
                    // chunk: flush each tool call's held-back argument tail, keyed
                    // by its index. Normally already empty (the finish chunk
                    // flushed them) — a half-reversed pseudonym is never emitted.
                    for (idx, buf) in toolarg_bufs.iter_mut() {
                        let t_tail = privacy::decloak_stream_finish(&session, buf);
                        if !t_tail.is_empty() {
                            let ev = json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [ { "index": idx, "function": { "arguments": t_tail } } ] }, "finish_reason": Value::Null } ] });
                            yield Ok(Bytes::from(format!("data: {ev}\n\n")));
                        }
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

                        // De-cloak streamed tool-call arguments. The model echoes
                        // literals from a (now un-cloaked) tool RESULT back into
                        // its arguments, so a write path would otherwise ship as
                        // `/Users/Org-46/asgard_Term-3170/...`. A pseudonym can be
                        // split across argument fragments, so each call's args ride
                        // their OWN rolling buffer keyed by the delta's `index` —
                        // the same cross-chunk hold/flush the content buffer uses.
                        // Only ever DE-cloak here; args are NEVER cloaked on the
                        // request side.
                        if let Some(tcs) = choice.get_mut("delta").and_then(|d| d.get_mut("tool_calls")).and_then(|t| t.as_array_mut()) {
                            for tc in tcs.iter_mut() {
                                let idx = tc.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
                                let Some(args) = tc.get("function").and_then(|f| f.get("arguments")).and_then(|a| a.as_str()) else { continue };
                                let buf = toolarg_bufs.entry(idx).or_default();
                                let safe = privacy::decloak_stream_chunk(&session, buf, args);
                                if let Some(func) = tc.get_mut("function").and_then(|f| f.as_object_mut()) {
                                    func.insert("arguments".into(), json!(safe));
                                }
                            }
                        }
                        // On the finishing chunk, flush each held-back argument
                        // tail so the last fragment rides WITH finish_reason and is
                        // never stranded after it (or left half-reversed).
                        if has_finish && !toolarg_bufs.is_empty() {
                            let mut tails: Vec<Value> = Vec::new();
                            for (idx, buf) in toolarg_bufs.iter_mut() {
                                let tail = privacy::decloak_stream_finish(&session, buf);
                                if !tail.is_empty() {
                                    tails.push(json!({ "index": idx, "function": { "arguments": tail } }));
                                }
                            }
                            if !tails.is_empty() {
                                if let Some(delta) = choice.get_mut("delta").and_then(|d| d.as_object_mut()) {
                                    match delta.get_mut("tool_calls").and_then(|t| t.as_array_mut()) {
                                        Some(arr) => arr.extend(tails),
                                        None => { delta.insert("tool_calls".into(), Value::Array(tails)); }
                                    }
                                }
                            }
                        }
                    }
                }
                yield Ok(Bytes::from(format!("data: {v}\n\n")));
            }
        }
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache");
    for (n, v) in relayed {
        builder = builder.header(n, v);
    }
    builder.body(Body::from_stream(out)).unwrap()
}

/// Non-streaming cloak path: forward, then de-cloak each choice's
/// `message.content` in the full JSON response before returning it.
async fn proxy_once_decloaked(
    body: Bytes,
    session: privacy::CloakSession,
    url: String,
    upstream_headers: HeaderMap,
) -> Response {
    let resp = match HTTP
        .post(url)
        .headers(upstream_headers)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(e),
    };
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let relayed = relay_response_headers(resp.headers());
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
            // Also reverse-map tool-call arguments: the model echoes literals
            // from a (now un-cloaked) tool RESULT into `function.arguments`, so a
            // write path would otherwise ship as `/Users/Org-46/asgard_Term-3170/...`
            // (silent file corruption). `decloak` is exact pseudonym→original
            // replacement — safe on the raw JSON args string. Args are NEVER
            // cloaked on the request side; only DE-cloaked here — keep it so.
            if let Some(calls) = choice.get_mut("message").and_then(|m| m.get_mut("tool_calls")).and_then(|c| c.as_array_mut()) {
                for call in calls.iter_mut() {
                    let Some(args) = call.get("function").and_then(|f| f.get("arguments")).and_then(|a| a.as_str()) else { continue };
                    let plain = privacy::decloak(&session, args);
                    if let Some(func) = call.get_mut("function").and_then(|f| f.as_object_mut()) {
                        func.insert("arguments".into(), json!(plain));
                    }
                }
            }
        }
    }
    let mut out = (status, Json(v)).into_response();
    for (n, v) in relayed {
        if n != "content-type" {
            out.headers_mut().insert(n, v);
        }
    }
    out
}

fn upstream_unreachable(e: reqwest::Error) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": { "message": format!("Ollama upstream unreachable: {e}"), "type": "upstream_error" } })),
    )
        .into_response()
}

/// Where a cloakable text sits inside `messages`: the message index and, for the
/// content-parts form (`content: [{ "type": "text", "text": "…" }]`), the part index.
type CloakSlot = (usize, Option<usize>);

/// Every free-text a cloud model would read, in request order. A message's `content`
/// is either a plain string or an array of parts — agent harnesses (pi) send the
/// array form for EVERY message, so skipping it shipped whole turns in plaintext
/// while the caller believed they were cloaked. Non-text parts (images) stay as-is.
fn collect_cloak_texts(messages: &[Value]) -> (Vec<CloakSlot>, Vec<String>) {
    let mut slots: Vec<CloakSlot> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    for (idx, msg) in messages.iter().enumerate() {
        // NEVER cloak tool RESULT messages: their content is verbatim tool
        // output (file listings, paths, IDs) that the model copies straight
        // into its NEXT assistant `tool_calls[].function.arguments`.
        // Pseudonymizing it corrupts those literals — e.g. a write path
        // shipped as `/Users/Org-46/asgard_Term-3170/...` = silent file
        // corruption. (Likewise `tools[]` definitions and `tool_calls`
        // arguments are NEVER cloaked here — they are only DE-cloaked on the
        // response side; keep it that way in any future refactor.)
        if msg.get("role").and_then(|r| r.as_str()) == Some("tool") {
            continue;
        }
        match msg.get("content") {
            Some(Value::String(content)) if !content.is_empty() => {
                slots.push((idx, None));
                plain.push(content.clone());
            }
            Some(Value::Array(parts)) => {
                for (pidx, part) in parts.iter().enumerate() {
                    let Some(text) = part.get("text").and_then(|t| t.as_str()) else { continue };
                    if text.is_empty() {
                        continue;
                    }
                    slots.push((idx, Some(pidx)));
                    plain.push(text.to_string());
                }
            }
            _ => {}
        }
    }
    (slots, plain)
}

/// Write the cloaked texts back to the slots `collect_cloak_texts` reported.
fn write_cloaked_texts(messages: &mut [Value], slots: &[CloakSlot], cloaked: &[String]) {
    for ((idx, part), text) in slots.iter().zip(cloaked) {
        let Some(msg) = messages.get_mut(*idx) else { continue };
        match part {
            None => msg["content"] = json!(text),
            Some(pidx) => {
                if let Some(p) = msg.get_mut("content").and_then(|c| c.get_mut(*pidx)) {
                    p["text"] = json!(text);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn cloak_texts_cover_string_and_content_parts() {
        let mut messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": [
                { "type": "text", "text": "hello Ada" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
                { "type": "text", "text": "" },
                { "type": "text", "text": "mail ada@example.org" },
            ] }),
            json!({ "role": "tool", "content": "/Users/ada/file.txt" }),
            json!({ "role": "tool", "content": [{ "type": "text", "text": "/Users/ada/other.txt" }] }),
            json!({ "role": "assistant", "content": null }),
        ];
        let (slots, plain) = collect_cloak_texts(&messages);
        assert_eq!(slots, vec![(0, None), (1, Some(0)), (1, Some(3))]);
        assert_eq!(plain, vec!["sys", "hello Ada", "mail ada@example.org"]);

        let cloaked: Vec<String> = plain.iter().map(|p| format!("<{p}>")).collect();
        write_cloaked_texts(&mut messages, &slots, &cloaked);
        assert_eq!(messages[0]["content"], "<sys>");
        assert_eq!(messages[1]["content"][0]["text"], "<hello Ada>");
        assert_eq!(messages[1]["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA");
        assert_eq!(messages[1]["content"][2]["text"], "");
        assert_eq!(messages[1]["content"][3]["text"], "<mail ada@example.org>");
        // Tool results stay verbatim in both forms.
        assert_eq!(messages[2]["content"], "/Users/ada/file.txt");
        assert_eq!(messages[3]["content"][0]["text"], "/Users/ada/other.txt");
    }

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

    fn hm(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn upstream_selection_from_header() {
        assert_eq!(upstream_from_headers(&HeaderMap::new()).ok(), Some(Upstream::Ollama));
        assert_eq!(upstream_from_headers(&hm(&[("x-upstream-provider", "")])).ok(), Some(Upstream::Ollama));
        assert_eq!(upstream_from_headers(&hm(&[("x-upstream-provider", "anthropic")])).ok(), Some(Upstream::Anthropic));
        assert_eq!(upstream_from_headers(&hm(&[("x-upstream-provider", "OPENAI")])).ok(), Some(Upstream::OpenAi));
        let err = upstream_from_headers(&hm(&[("x-upstream-provider", "foo")])).err().expect("unknown -> Err");
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn upstream_base_is_pinned_unless_unpinned() {
        for (up, def) in [(Upstream::Anthropic, "https://api.anthropic.com"), (Upstream::OpenAi, "https://api.openai.com")] {
            assert_eq!(upstream_base_from(up, None, false).unwrap(), def);
            assert_eq!(upstream_base_from(up, Some(&format!("{def}/")), false).unwrap(), def);
            assert!(upstream_base_from(up, Some("http://169.254.169.254"), false).is_err());
            assert!(upstream_base_from(up, Some("https://evil.example"), false).is_err());
            assert_eq!(upstream_base_from(up, Some("http://localhost:18434"), true).unwrap(), "http://localhost:18434");
        }
    }

    #[test]
    fn upstream_credential_detection() {
        assert!(has_upstream_credential(&hm(&[("x-api-key", "sk-1")]), true));
        assert!(has_upstream_credential(&hm(&[("authorization", "Bearer sk-1")]), false));
        assert!(!has_upstream_credential(&hm(&[("authorization", "Bearer gctrl")]), true));
        assert!(!has_upstream_credential(&hm(&[("x-api-key", "  ")]), false));
        assert!(!has_upstream_credential(&HeaderMap::new(), false));
    }

    #[test]
    fn forward_headers_is_an_allowlist() {
        let incoming = hm(&[
            ("x-gctrl-token", "t"), ("x-anvil-cloak", "on"), ("x-upstream-provider", "anthropic"),
            ("host", "gw"), ("connection", "keep-alive"), ("cookie", "a=b"), ("content-length", "12"),
            ("accept-encoding", "gzip"), ("x-forwarded-for", "1.2.3.4"), ("x-api-key", "sk-1"),
            ("authorization", "Bearer sk-2"), ("anthropic-beta", "b1"), ("user-agent", "ua"),
            ("x-app", "cli"), ("x-stainless-retry-count", "0"),
        ]);
        let out = forward_headers(&incoming, Upstream::Anthropic, false);
        let mut names: Vec<&str> = out.keys().map(|k| k.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            ["anthropic-beta", "anthropic-version", "authorization", "content-type", "user-agent", "x-api-key", "x-app", "x-stainless-retry-count"]
        );
        assert_eq!(out["anthropic-version"], "2023-06-01");

        let consumed = forward_headers(&incoming, Upstream::Anthropic, true);
        assert!(!consumed.contains_key("authorization"));
        assert!(consumed.contains_key("x-api-key"));

        let openai = forward_headers(&incoming, Upstream::OpenAi, false);
        assert!(!openai.contains_key("anthropic-version"));

        let own = forward_headers(&hm(&[("anthropic-version", "2024-01-01")]), Upstream::Anthropic, false);
        assert_eq!(own["anthropic-version"], "2024-01-01");
    }

    #[test]
    fn relay_response_headers_picks_only_known() {
        let mut up = reqwest::header::HeaderMap::new();
        for (k, v) in [
            ("content-type", "application/json"), ("request-id", "r1"), ("retry-after", "3"),
            ("anthropic-ratelimit-requests-remaining", "9"), ("set-cookie", "x=y"),
            ("content-length", "5"), ("server", "cf"),
        ] {
            up.insert(reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(), reqwest::header::HeaderValue::from_str(v).unwrap());
        }
        let mut names: Vec<String> = relay_response_headers(&up).into_iter().map(|(n, _)| n.to_string()).collect();
        names.sort();
        assert_eq!(names, ["anthropic-ratelimit-requests-remaining", "content-type", "request-id", "retry-after"]);
    }

    #[test]
    fn ollama_base_normalizes_bare_host() {
        // Bare host:port (Ollama's own OLLAMA_HOST convention) gains a scheme.
        std::env::set_var("OLLAMA_HOST", "0.0.0.0:11434");
        assert!(ollama_base().starts_with("http://"));
        std::env::remove_var("OLLAMA_HOST");
    }
}

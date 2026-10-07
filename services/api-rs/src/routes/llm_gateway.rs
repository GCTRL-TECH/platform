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
//! `X-Upstream-Provider: anthropic|openai|chatgpt` (case-insensitive) picks the upstream;
//! absent/empty = local Ollama, byte for byte today's behaviour. This module serves
//! `POST /v1/chat/completions` for Ollama and OpenAI; Anthropic's `/v1/messages`
//! lives in the sibling module `llm_gateway_anthropic`, and the OpenAI Responses
//! API (`/v1/responses`, upstreams `chatgpt` = the ChatGPT subscription via Codex,
//! and `openai`) in `llm_gateway_responses`; both build on the
//! `pub(super)` items here (auth, upstream base, header allowlist, cloak helpers).
//! Bases come from `ANTHROPIC_BASE` / `OPENAI_BASE` / `CHATGPT_BASE` (official host pinned via
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
//! ## What is cloaked (chat completions)
//! Every message's text in one batch, so the model sees ONE mapping: `content`
//! (string or text parts) of every role, tool RESULTS (`role:"tool"`; opt out with
//! `X-Cloak-Tool-Outputs: 0`, never forwarded), and the decoded string values of
//! replayed `assistant.tool_calls[].function.arguments` (keys and numbers untouched,
//! re-serialized as valid JSON). `tools[]` definitions are never cloaked. On the
//! wire every pseudonym is bracketed (`[Place-7]`), and a cloaked request carries a
//! short system note that bracketed terms are placeholders to pass on unchanged.
//! The response side restores content and reasoning with the plain session and
//! tool-call arguments with JSON-escaped originals ([`ChatSseDecloaker`]).
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

use super::llm_gateway_anthropic::{json_escaped_session, set_string_leaves, string_leaves};
use super::llm_gateway_responses::{has_duplicate_keys, tool_outputs_cloaked, write_cloaked_arguments};
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

/// Like [`HTTP`], but never follows redirects: a 3xx from a cloud upstream must
/// not carry `x-api-key` / `authorization` to another host.
pub(super) static HTTP_NOREDIRECT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("reqwest client builds")
});

/// Cloud upstream (OpenAI, ChatGPT) -> no-redirect client; Ollama keeps the plain one.
fn client_for(upstream_name: &str) -> &'static reqwest::Client {
    if matches!(upstream_name, "OpenAI" | "ChatGPT") {
        &HTTP_NOREDIRECT
    } else {
        &HTTP
    }
}

/// Header marking an error response produced by the gateway itself (as opposed
/// to an upstream error relayed verbatim).
pub(super) const GATEWAY_ERROR_HEADER: &str = "x-cloak-gateway-error";

/// Stamp [`GATEWAY_ERROR_HEADER`] on a gateway-generated response.
pub(super) fn mark_gateway_error(mut resp: Response) -> Response {
    resp.headers_mut()
        .insert(GATEWAY_ERROR_HEADER, axum::http::HeaderValue::from_static("1"));
    resp
}

/// OpenAI-style error JSON `{"error":{"message","type"}}` produced by the gateway.
pub(super) fn gateway_error_json(status: StatusCode, kind: &str, message: impl Into<String>) -> Response {
    mark_gateway_error((status, Json(json!({ "error": { "message": message.into(), "type": kind } }))).into_response())
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/cloak/capabilities", get(capabilities))
        .merge(super::llm_gateway_anthropic::router())
        .merge(super::llm_gateway_responses::router())
        // Whitelist: every other /v1/* path is a clear 404, never a silent passthrough.
        // Static routes above win over this wildcard; it only claims /v1/* paths.
        .route("/v1/*rest", axum::routing::any(super::llm_gateway_anthropic::not_proxied))
}

/// Capability probe (no auth): which upstreams this gateway can cloak for.
/// Anvil polls it to decide what to offer; keep the list stable.
pub(super) async fn capabilities() -> Json<Value> {
    Json(json!({
        "upstreams": ["ollama", "anthropic", "openai", "chatgpt"],
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
    /// The ChatGPT subscription (Codex CLI, Responses API on chatgpt.com).
    ChatGpt,
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
        "chatgpt" => Ok(Upstream::ChatGpt),
        other => Err(gateway_error_json(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            format!("unknown X-Upstream-Provider '{other}' (allowed: anthropic, openai, chatgpt; omit for ollama)"),
        )),
    }
}

/// Pure core of [`upstream_base`] (testable without env). `raw` is the env value;
/// `unpinned` skips the official-host pin (dev only).
pub(super) fn upstream_base_from(upstream: Upstream, raw: Option<&str>, unpinned: bool) -> Result<String, String> {
    let (provider, default) = match upstream {
        Upstream::Ollama => return Ok(ollama_base()),
        Upstream::Anthropic => ("anthropic", "https://api.anthropic.com"),
        Upstream::OpenAi => ("openai", "https://api.openai.com"),
        // HOST only: the Codex path lives in `llm_gateway_responses::CHATGPT_CODEX_PATH`.
        Upstream::ChatGpt => ("chatgpt", "https://chatgpt.com"),
    };
    let raw = raw.map(str::trim).filter(|s| !s.is_empty());
    if unpinned {
        static WARN_ONCE: std::sync::Once = std::sync::Once::new();
        WARN_ONCE.call_once(|| {
            tracing::warn!("GCTRL_CLOAK_UPSTREAM_UNPINNED set: {provider} upstream base is NOT pinned to the official host");
        });
        return Ok(raw.unwrap_or(default).trim_end_matches('/').to_string());
    }
    let url = crate::services::llm::validate_llm_base(provider, raw)?;
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Resolve the upstream base URL from env (`ANTHROPIC_BASE` / `OPENAI_BASE` / `CHATGPT_BASE`).
/// An invalid base is an error (-> 500 api_error), never a silent fallback.
pub(super) fn upstream_base(upstream: Upstream) -> Result<String, String> {
    let var = match upstream {
        Upstream::Ollama => return Ok(ollama_base()),
        Upstream::Anthropic => "ANTHROPIC_BASE",
        Upstream::OpenAi => "OPENAI_BASE",
        Upstream::ChatGpt => "CHATGPT_BASE",
    };
    let unpinned = std::env::var("GCTRL_CLOAK_UPSTREAM_UNPINNED")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true"))
        .unwrap_or(false);
    upstream_base_from(upstream, std::env::var(var).ok().as_deref(), unpinned)
}

// ── Header allowlist ─────────────────────────────────────────────────────────

/// Is this credential header value really a gctrl token (a misconfigured caller
/// put it into `x-api-key` / `Authorization`)? Optional `ApiKey ` / `Bearer ` prefix.
fn is_gctrl_credential(value: &axum::http::HeaderValue) -> bool {
    let Ok(raw) = value.to_str() else { return false };
    let raw = raw.trim();
    let bare = ["apikey ", "bearer "]
        .iter()
        .find(|p| raw.len() >= p.len() && raw.is_char_boundary(p.len()) && raw[..p.len()].eq_ignore_ascii_case(p))
        .map(|p| &raw[p.len()..])
        .unwrap_or(raw);
    bare.trim_start().starts_with("gctrl_")
}

/// Build the upstream request headers from the caller's. ALLOWLIST only: anything
/// not listed (host, content-length, accept-encoding, hop-by-hop, cookie,
/// x-forwarded-*, x-gctrl-token, x-anvil-cloak, x-cloak-tool-outputs, x-upstream-provider, ...) is
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
    // OpenAI takes ONLY `authorization` as credential; Anthropic-specific headers
    // and `x-api-key` are never sent to it.
    const ANTHROPIC_ONLY: [&str; 5] = [
        "x-api-key",
        "anthropic-version",
        "anthropic-beta",
        "anthropic-dangerous-direct-browser-access",
        "x-app",
    ];
    // Codex (ChatGPT subscription) session/routing headers: only ever sent to chatgpt.com.
    const CHATGPT_ONLY: [&str; 8] = [
        "chatgpt-account-id",
        "originator",
        "session-id",
        "session_id",
        "thread-id",
        "conversation_id",
        "x-client-request-id",
        "x-openai-subagent",
    ];
    let openai_family = matches!(upstream, Upstream::OpenAi | Upstream::ChatGpt);
    let mut out = HeaderMap::new();
    for (name, value) in incoming.iter() {
        let n = name.as_str();
        if n == "authorization" && consumed_authorization {
            continue;
        }
        if openai_family && ANTHROPIC_ONLY.contains(&n) {
            continue;
        }
        if (n == "authorization" || n == "x-api-key") && is_gctrl_credential(value) {
            continue;
        }
        let chatgpt_extra =
            upstream == Upstream::ChatGpt && (CHATGPT_ONLY.contains(&n) || n.starts_with("x-codex-"));
        let openai_extra = openai_family && n == "openai-beta";
        if ALLOW.contains(&n) || n.starts_with("x-stainless-") || chatgpt_extra || openai_extra {
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
            matches!(
                n,
                "content-type"
                    | "request-id"
                    | "retry-after"
                    | "x-models-etag"
                    | "openai-model"
                    | "x-reasoning-included"
                    | "x-request-id"
            ) || n.starts_with("anthropic-ratelimit-")
                || n.starts_with("x-codex-")
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
/// OpenAI accepts only `authorization`. A gctrl token in either header is no credential.
pub(super) fn has_upstream_credential(headers: &HeaderMap, upstream: Upstream, consumed_authorization: bool) -> bool {
    let usable = |name: &str| {
        headers
            .get(name)
            .map(|v| v.to_str().map(|s| !s.trim().is_empty()).unwrap_or(false) && !is_gctrl_credential(v))
            .unwrap_or(false)
    };
    let auth = !consumed_authorization && usable("authorization");
    match upstream {
        Upstream::OpenAi | Upstream::ChatGpt => auth,
        _ => usable("x-api-key") || auth,
    }
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
        return gateway_error_json(StatusCode::BAD_REQUEST, "invalid_request_error", "use /v1/messages for anthropic");
    }
    if upstream == Upstream::ChatGpt {
        return gateway_error_json(StatusCode::BAD_REQUEST, "invalid_request_error", "use /v1/responses for chatgpt");
    }
    let unauthorized = || {
        gateway_error_json(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid Authorization (use `ApiKey <token>` or `Bearer <token>`)",
        )
    };

    // Auth (manual — this route is not behind the auth middleware).
    let (claims, url, upstream_headers) = if upstream == Upstream::OpenAi {
        let Some(identity) = authenticate_gateway(&state, &headers).await else {
            return unauthorized();
        };
        if !has_upstream_credential(&headers, upstream, identity.consumed_authorization) {
            return gateway_error_json(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "no upstream credential: send Authorization: Bearer <openai key> and the gctrl token in X-GCTRL-Token",
            );
        }
        let base = match upstream_base(upstream) {
            Ok(b) => b,
            Err(e) => {
                return gateway_error_json(StatusCode::INTERNAL_SERVER_ERROR, "api_error", format!("invalid upstream base: {e}"))
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
            return gateway_error_json(StatusCode::BAD_REQUEST, "invalid_request_error", format!("invalid JSON body: {e}"))
        }
    };

    let model = parsed.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let stream = parsed.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    // OpenAI is always a cloud egress (not tag based); Ollama keeps the tag rule.
    let is_cloud = upstream == Upstream::OpenAi || model_targets_cloud(&model);
    let cloak_on = is_cloud && !cloak_disabled(&headers);
    let upstream_name = if upstream == Upstream::OpenAi { "OpenAI" } else { "Ollama" };

    // ── Transparent passthrough: local model, or cloud with cloak explicitly off.
    if !cloak_on {
        return proxy_passthrough(body, stream, url, upstream_headers, upstream_name).await;
    }

    // ── Cloak path (cloud model + toggle on) — FAIL CLOSED from here on. ──
    // Namespace to key the persistent pseudonym registry. No owned compilation →
    // we cannot durably/stably cloak → refuse (never forward plaintext to cloud).
    let Some(namespace) = cloak_namespace(&state, claims.sub).await else {
        return gateway_error_json(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloak_unavailable",
            "cloaking required for a cloud model but this account owns no knowledge base to anchor the cloak map — create one, or send X-Anvil-Cloak: off to route plaintext.",
        );
    };

    // Dictionary of the user's own extracted entities (+ PII regex fallback inside
    // cloak()). Cached per-user for 10 min.
    let candidates = privacy::user_entity_candidates(&state.db, claims.sub).await;

    // Cloak every message's text in ONE pass (user/system/assistant content, tool
    // RESULTS, replayed tool-call arguments), so the same entity maps to the same
    // pseudonym everywhere the model looks AND the registry is read once per
    // request. A tool result in clear next to pseudonymised prose let the model
    // invent a value ("Stuttgart") for a placeholder it could not resolve (E2E
    // 2026-10-07).
    let mut out_body = parsed.clone();
    let ns = [namespace];
    let cloak_tool_outputs = tool_outputs_cloaked(&headers);
    if let Some(messages) = out_body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        normalize_chat_duplicate_argument_keys(messages);
    }
    let (slots, plain) = out_body
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|m| collect_cloak_texts(m, cloak_tool_outputs))
        .unwrap_or_default();
    let refs: Vec<&str> = plain.iter().map(String::as_str).collect();
    let (cloaked, cloak_session) = privacy::cloak_batch(&state.db, &ns, &candidates, &refs).await;
    // write_cloaked_texts zips: a short result would leave plaintext slots.
    if cloaked.len() != slots.len() {
        return gateway_error_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cloak_error",
            "cloak result does not match the request texts",
        );
    }
    if let Some(messages) = out_body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        write_cloaked_texts(messages, &slots, &cloaked, &cloak_session);
        if !cloak_session.is_empty() {
            add_placeholder_note(messages);
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
            return gateway_error_json(StatusCode::INTERNAL_SERVER_ERROR, "cloak_error", format!("cloak encode failed: {e}"))
        }
    };

    if stream {
        proxy_stream_decloaked(out_bytes, cloak_session, url, upstream_headers, upstream_name).await
    } else {
        proxy_once_decloaked(out_bytes, cloak_session, url, upstream_headers, upstream_name).await
    }
}

// ── Transparent passthrough ──────────────────────────────────────────────────

/// Byte-for-byte reverse proxy to Ollama. Streams the upstream body through
/// unchanged; used for local models and for cloud+cloak-off.
async fn proxy_passthrough(body: Bytes, stream: bool, url: String, upstream_headers: HeaderMap, upstream_name: &str) -> Response {
    let resp = match client_for(upstream_name)
        .post(url)
        .headers(upstream_headers)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(upstream_name, e),
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

/// Reassembles SSE lines from raw upstream bytes. Works on bytes so a TCP read
/// boundary inside a multi-byte UTF-8 char loses nothing: only COMPLETE lines are
/// decoded (lossily). Each returned line keeps its trailing `\n`.
#[derive(Default)]
pub(super) struct OpenAiSseLines {
    buf: Vec<u8>,
}

impl OpenAiSseLines {
    pub(super) fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let rest = self.buf.split_off(pos + 1);
            let line = std::mem::replace(&mut self.buf, rest);
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        lines
    }

    /// EOF: the dangling partial line (no trailing newline), if any.
    pub(super) fn finish(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned())
        }
    }
}

/// Pure SSE de-cloaker for OpenAI chat-completions streams (no reqwest/axum, so it
/// is fuzzable). Rewrites each data chunk's `choices[].delta`:
/// * `content` and the reasoning fields (`reasoning`/`reasoning_content`/`thinking`)
///   through their own rolling buffers, plain session;
/// * `tool_calls[].function.arguments` through one rolling buffer PER CALL, keyed by
///   the call's `index` (its position in the array when `index` is missing, so two
///   calls in one chunk never share a buffer), with the JSON-escaped session: the
///   arguments are raw JSON text, and an original containing `"` or `\` must stay
///   valid JSON.
///
/// Held-back tails are flushed on the chunk carrying `finish_reason`, before
/// `[DONE]`, and at EOF. Non-data lines and unparseable data pass through verbatim.
pub(super) struct ChatSseDecloaker {
    session: privacy::CloakSession,
    json_session: privacy::CloakSession,
    lines: OpenAiSseLines,
    content_buf: String,
    reasoning_buf: String,
    toolarg_bufs: std::collections::BTreeMap<i64, String>,
    out: String,
}

impl ChatSseDecloaker {
    pub(super) fn new(session: privacy::CloakSession) -> Self {
        let json_session = json_escaped_session(&session);
        Self {
            session,
            json_session,
            lines: OpenAiSseLines::default(),
            content_buf: String::new(),
            reasoning_buf: String::new(),
            toolarg_bufs: std::collections::BTreeMap::new(),
            out: String::new(),
        }
    }

    /// Feed raw upstream bytes; returns the SSE text that is safe to emit now.
    pub(super) fn feed(&mut self, chunk: &[u8]) -> String {
        for line in self.lines.feed(chunk) {
            self.on_line(line);
        }
        std::mem::take(&mut self.out)
    }

    /// EOF: the dangling partial line, then any held-back tail (a stream that ended
    /// without `[DONE]` must not lose text).
    pub(super) fn finish(&mut self) -> String {
        if let Some(line) = self.lines.finish() {
            self.on_line(line);
        }
        self.flush_tails();
        std::mem::take(&mut self.out)
    }

    fn emit_delta(&mut self, delta: Value) {
        let ev = json!({ "choices": [ { "index": 0, "delta": delta, "finish_reason": Value::Null } ] });
        self.out.push_str(&format!("data: {ev}\n\n"));
    }

    /// Emit every held-back tail as its own delta event.
    fn flush_tails(&mut self) {
        let r_tail = privacy::decloak_stream_finish(&self.session, &mut self.reasoning_buf);
        if !r_tail.is_empty() {
            self.emit_delta(json!({ "reasoning": r_tail }));
        }
        let tail = privacy::decloak_stream_finish(&self.session, &mut self.content_buf);
        if !tail.is_empty() {
            self.emit_delta(json!({ "content": tail }));
        }
        let mut tails = Vec::new();
        for (idx, buf) in self.toolarg_bufs.iter_mut() {
            let t = privacy::decloak_stream_finish(&self.json_session, buf);
            if !t.is_empty() {
                tails.push((*idx, t));
            }
        }
        for (idx, t) in tails {
            self.emit_delta(json!({ "tool_calls": [ { "index": idx, "function": { "arguments": t } } ] }));
        }
    }

    fn on_line(&mut self, raw_line: String) {
        let line = raw_line.trim_end_matches(['\n', '\r']);
        let Some(data) = line.strip_prefix("data:") else {
            // Non-data SSE line (comment/blank/event:): verbatim.
            self.out.push_str(&raw_line);
            return;
        };
        let data = data.trim();
        if data == "[DONE]" {
            self.flush_tails();
            self.out.push_str("data: [DONE]\n\n");
            return;
        }
        let Ok(mut v) = serde_json::from_str::<Value>(data) else {
            self.out.push_str(&raw_line);
            return;
        };
        if let Some(choices) = v.get_mut("choices").and_then(|c| c.as_array_mut()) {
            for choice in choices.iter_mut() {
                self.decloak_choice(choice);
            }
        }
        self.out.push_str(&format!("data: {v}\n\n"));
    }

    fn decloak_choice(&mut self, choice: &mut Value) {
        let has_finish = choice.get("finish_reason").map(|f| !f.is_null()).unwrap_or(false);
        let session = &self.session;

        for field in ["reasoning", "reasoning_content", "thinking"] {
            let Some(text) = choice.get("delta").and_then(|d| d.get(field)).and_then(|c| c.as_str()) else { continue };
            let mut emit = privacy::decloak_stream_chunk(session, &mut self.reasoning_buf, text);
            if has_finish {
                emit.push_str(&privacy::decloak_stream_finish(session, &mut self.reasoning_buf));
            }
            if let Some(delta) = choice.get_mut("delta").and_then(|d| d.as_object_mut()) {
                delta.insert(field.into(), json!(emit));
            }
        }

        let content = choice.get("delta").and_then(|d| d.get("content")).and_then(|c| c.as_str()).unwrap_or("");
        let mut emit = privacy::decloak_stream_chunk(session, &mut self.content_buf, content);
        if has_finish {
            emit.push_str(&privacy::decloak_stream_finish(session, &mut self.content_buf));
        }
        // Only rewrite when there was a content field or text to flush, so
        // role-only preamble deltas stay untouched.
        let had_content = choice.get("delta").and_then(|d| d.get("content")).is_some();
        if had_content || !emit.is_empty() {
            if let Some(delta) = choice.get_mut("delta").and_then(|d| d.as_object_mut()) {
                delta.insert("content".into(), json!(emit));
            }
        }

        // Tool-call arguments: a pseudonym can be split across fragments, so each
        // call rides its own buffer.
        if let Some(tcs) = choice.get_mut("delta").and_then(|d| d.get_mut("tool_calls")).and_then(|t| t.as_array_mut()) {
            for (pos, tc) in tcs.iter_mut().enumerate() {
                let idx = tc.get("index").and_then(|i| i.as_i64()).unwrap_or(pos as i64);
                let Some(args) = tc.get("function").and_then(|f| f.get("arguments")).and_then(|a| a.as_str()) else { continue };
                let buf = self.toolarg_bufs.entry(idx).or_default();
                let safe = privacy::decloak_stream_chunk(&self.json_session, buf, args);
                if let Some(func) = tc.get_mut("function").and_then(|f| f.as_object_mut()) {
                    func.insert("arguments".into(), json!(safe));
                }
            }
        }
        // On the finishing chunk, flush each held-back argument tail so the last
        // fragment rides WITH finish_reason and is never stranded after it.
        if has_finish && !self.toolarg_bufs.is_empty() {
            let mut tails: Vec<Value> = Vec::new();
            for (idx, buf) in self.toolarg_bufs.iter_mut() {
                let tail = privacy::decloak_stream_finish(&self.json_session, buf);
                if !tail.is_empty() {
                    tails.push(json!({ "index": idx, "function": { "arguments": tail } }));
                }
            }
            if !tails.is_empty() {
                if let Some(delta) = choice.get_mut("delta").and_then(|d| d.as_object_mut()) {
                    match delta.get_mut("tool_calls").and_then(|t| t.as_array_mut()) {
                        Some(arr) => arr.extend(tails),
                        None => {
                            delta.insert("tool_calls".into(), Value::Array(tails));
                        }
                    }
                }
            }
        }
    }
}

/// Forward the cloaked body with `stream:true` and re-stream the SSE response
/// through [`ChatSseDecloaker`], so the CALLER receives plaintext. The SSE envelope
/// is preserved; only delta text is rewritten.
async fn proxy_stream_decloaked(
    body: Bytes,
    session: privacy::CloakSession,
    url: String,
    upstream_headers: HeaderMap,
    upstream_name: &str,
) -> Response {
    let resp = match client_for(upstream_name)
        .post(url)
        .headers(upstream_headers)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(upstream_name, e),
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
        let mut dec = ChatSseDecloaker::new(session);
        loop {
            match bytes.next().await {
                Some(Ok(b)) => {
                    let s = dec.feed(&b);
                    if !s.is_empty() {
                        yield Ok::<Bytes, std::io::Error>(Bytes::from(s));
                    }
                }
                Some(Err(e)) => {
                    yield Ok(Bytes::from(format!("data: {{\"error\":\"stream: {e}\"}}\n\n")));
                    break;
                }
                None => {
                    let s = dec.finish();
                    if !s.is_empty() {
                        yield Ok(Bytes::from(s));
                    }
                    break;
                }
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

/// De-cloak a finished chat completion in place: every text field of each
/// `choices[].message` (reasoning models quote the cloaked prompt in
/// `reasoning`/`reasoning_content`/`thinking`) with the plain session, and
/// `tool_calls[].function.arguments` (raw JSON text) with the JSON-escaped session,
/// so an original containing `"` or `\` keeps the arguments valid JSON.
pub(super) fn decloak_chat_completion(session: &privacy::CloakSession, json_session: &privacy::CloakSession, v: &mut Value) {
    let Some(choices) = v.get_mut("choices").and_then(|c| c.as_array_mut()) else { return };
    for choice in choices.iter_mut() {
        let Some(msg) = choice.get_mut("message").and_then(|m| m.as_object_mut()) else { continue };
        for field in ["content", "reasoning", "reasoning_content", "thinking"] {
            if let Some(Value::String(text)) = msg.get_mut(field) {
                *text = privacy::decloak(session, text);
            }
        }
        if let Some(calls) = msg.get_mut("tool_calls").and_then(|c| c.as_array_mut()) {
            for call in calls.iter_mut() {
                if let Some(Value::String(args)) = call.get_mut("function").and_then(|f| f.get_mut("arguments")) {
                    *args = privacy::decloak(json_session, args);
                }
            }
        }
    }
}

/// Non-streaming cloak path: forward, then de-cloak the full JSON response
/// ([`decloak_chat_completion`]) before returning it.
async fn proxy_once_decloaked(
    body: Bytes,
    session: privacy::CloakSession,
    url: String,
    upstream_headers: HeaderMap,
    upstream_name: &str,
) -> Response {
    let resp = match client_for(upstream_name)
        .post(url)
        .headers(upstream_headers)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return upstream_unreachable(upstream_name, e),
    };
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let relayed = relay_response_headers(resp.headers());
    let mut v: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return gateway_error_json(StatusCode::BAD_GATEWAY, "upstream_error", format!("upstream decode: {e}")),
    };
    decloak_chat_completion(&session, &json_escaped_session(&session), &mut v);
    let mut out = (status, Json(v)).into_response();
    for (n, v) in relayed {
        if n != "content-type" {
            out.headers_mut().insert(n, v);
        }
    }
    out
}

/// Message for an unreachable upstream; `name` is "Ollama" / "OpenAI" / "Anthropic".
pub(super) fn upstream_unreachable_message(name: &str, e: &reqwest::Error) -> String {
    format!("{name} upstream unreachable: {e}")
}

fn upstream_unreachable(name: &str, e: reqwest::Error) -> Response {
    gateway_error_json(StatusCode::BAD_GATEWAY, "upstream_error", upstream_unreachable_message(name, &e))
}

/// Where a cloakable text sits inside `messages`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ChatSlot {
    /// `messages[i].content` (string, `None`) or `messages[i].content[j].text`
    /// (content-parts form, `Some(j)`), for every role incl. `tool`.
    Content(usize, Option<usize>),
    /// `messages[i].tool_calls[j].function.arguments` of a replayed assistant call:
    /// one slot per decoded non-empty string VALUE (in `string_leaves` order), or one
    /// slot holding the raw string when it is not valid JSON.
    ToolArguments(usize, usize),
}

/// The system note added to a cloaked request: placeholders are not values.
pub(super) const PLACEHOLDER_NOTE: &str = "Begriffe in eckigen Klammern wie [Place-3] sind Platzhalter für echte Namen. Gib sie unverändert an Werkzeuge weiter und ersetze sie nie durch ausgedachte Werte.\nTerms in square brackets like [Place-3] are placeholders for real names. Pass them to tools unchanged and never replace them with invented values.";

/// Every free text a cloud model would read, in request order: each message's
/// `content` (string or the text of content parts; agent harnesses like pi send
/// the array form for every message), tool RESULTS (`role:"tool"`) unless
/// `cloak_tool_outputs` is off (`X-Cloak-Tool-Outputs: 0`), and the string values
/// of replayed `assistant.tool_calls[].function.arguments`. Tool results and
/// replayed calls must share the batch with the prose: the de-cloaker gave the
/// client the real names, so sending them back in clear next to pseudonymised text
/// both leaks them and reveals the mapping, and the model, seeing a placeholder in
/// prose but a real value in the tool result, invents values. `tools[]`
/// definitions are never cloaked. Non-text parts (images) stay as they are.
fn collect_cloak_texts(messages: &[Value], cloak_tool_outputs: bool) -> (Vec<ChatSlot>, Vec<String>) {
    let mut slots: Vec<ChatSlot> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    for (idx, msg) in messages.iter().enumerate() {
        let is_tool = msg.get("role").and_then(|r| r.as_str()) == Some("tool");
        if !is_tool || cloak_tool_outputs {
            match msg.get("content") {
                Some(Value::String(content)) if !content.is_empty() => {
                    slots.push(ChatSlot::Content(idx, None));
                    plain.push(content.clone());
                }
                Some(Value::Array(parts)) => {
                    for (pidx, part) in parts.iter().enumerate() {
                        let Some(text) = part.get("text").and_then(|t| t.as_str()) else { continue };
                        if text.is_empty() {
                            continue;
                        }
                        slots.push(ChatSlot::Content(idx, Some(pidx)));
                        plain.push(text.to_string());
                    }
                }
                _ => {}
            }
        }
        let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) else { continue };
        for (cidx, call) in calls.iter().enumerate() {
            let mut leaves = Vec::new();
            match call.get("function").and_then(|f| f.get("arguments")) {
                Some(Value::String(raw)) if !raw.is_empty() => match serde_json::from_str::<Value>(raw) {
                    Ok(parsed) => string_leaves(&parsed, &mut leaves),
                    Err(_) => leaves.push(raw.clone()),
                },
                // Some harnesses replay the arguments as an object.
                Some(v @ (Value::Object(_) | Value::Array(_))) => string_leaves(v, &mut leaves),
                _ => {}
            }
            slots.extend(std::iter::repeat_n(ChatSlot::ToolArguments(idx, cidx), leaves.len()));
            plain.extend(leaves);
        }
    }
    (slots, plain)
}

/// Re-serialize replayed `arguments` strings that repeat an object key, so the
/// value an earlier duplicate carried (invisible to the leaf walk) never travels
/// upstream. Runs before collection; serde's last-wins value is kept.
fn normalize_chat_duplicate_argument_keys(messages: &mut [Value]) {
    for msg in messages.iter_mut() {
        let Some(calls) = msg.get_mut("tool_calls").and_then(|c| c.as_array_mut()) else { continue };
        for call in calls.iter_mut() {
            if let Some(Value::String(raw)) = call.get_mut("function").and_then(|f| f.get_mut("arguments")) {
                if has_duplicate_keys(raw) {
                    if let Ok(v) = serde_json::from_str::<Value>(raw) {
                        *raw = v.to_string();
                    }
                }
            }
        }
    }
}

/// Write the cloaked texts back to the slots [`collect_cloak_texts`] reported.
/// Replayed `arguments` strings are rewritten byte-faithfully on the decoded values
/// (keys and numbers untouched, always valid JSON) by `write_cloaked_arguments`.
fn write_cloaked_texts(messages: &mut [Value], slots: &[ChatSlot], cloaked: &[String], session: &privacy::CloakSession) {
    let n = slots.len().min(cloaked.len());
    let mut k = 0;
    while k < n {
        let slot = slots[k];
        match slot {
            ChatSlot::ToolArguments(i, c) => {
                // a run of identical slots = the leaves of one arguments value, in order
                let end = (k..n).find(|&e| slots[e] != slot).unwrap_or(n);
                let target = messages
                    .get_mut(i)
                    .and_then(|m| m.get_mut("tool_calls"))
                    .and_then(|t| t.get_mut(c))
                    .and_then(|t| t.get_mut("function"))
                    .and_then(|f| f.get_mut("arguments"));
                match target {
                    Some(Value::String(raw)) => *raw = write_cloaked_arguments(raw, &cloaked[k..end], session),
                    Some(v) => set_string_leaves(v, &cloaked[k..end]),
                    None => {}
                }
                k = end;
            }
            ChatSlot::Content(i, part) => {
                let text = &cloaked[k];
                k += 1;
                let Some(msg) = messages.get_mut(i) else { continue };
                match part {
                    None => msg["content"] = json!(text),
                    Some(pidx) => {
                        if let Some(p) = msg.get_mut("content").and_then(|c| c.get_mut(pidx)) {
                            p["text"] = json!(text);
                        }
                    }
                }
            }
        }
    }
}

/// Prepend [`PLACEHOLDER_NOTE`] to the first system message (string or parts form),
/// or insert a system message at the top when there is none.
fn add_placeholder_note(messages: &mut Vec<Value>) {
    let first_system = messages
        .iter()
        .position(|m| m.get("role").and_then(|r| r.as_str()) == Some("system"));
    let Some(i) = first_system else {
        messages.insert(0, json!({ "role": "system", "content": PLACEHOLDER_NOTE }));
        return;
    };
    let msg = &mut messages[i];
    match msg.get_mut("content") {
        Some(Value::String(s)) if !s.is_empty() => *s = format!("{PLACEHOLDER_NOTE}\n\n{s}"),
        Some(Value::Array(parts)) => parts.insert(0, json!({ "type": "text", "text": PLACEHOLDER_NOTE })),
        _ => msg["content"] = json!(PLACEHOLDER_NOTE),
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
        // Tool results opted out (`X-Cloak-Tool-Outputs: 0`).
        let (slots, plain) = collect_cloak_texts(&messages, false);
        assert_eq!(slots, vec![ChatSlot::Content(0, None), ChatSlot::Content(1, Some(0)), ChatSlot::Content(1, Some(3))]);
        assert_eq!(plain, vec!["sys", "hello Ada", "mail ada@example.org"]);

        let cloaked: Vec<String> = plain.iter().map(|p| format!("<{p}>")).collect();
        write_cloaked_texts(&mut messages, &slots, &cloaked, &privacy::CloakSession::empty());
        assert_eq!(messages[0]["content"], "<sys>");
        assert_eq!(messages[1]["content"][0]["text"], "<hello Ada>");
        assert_eq!(messages[1]["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA");
        assert_eq!(messages[1]["content"][2]["text"], "");
        assert_eq!(messages[1]["content"][3]["text"], "<mail ada@example.org>");
        // Opted out: tool results stay verbatim in both forms.
        assert_eq!(messages[2]["content"], "/Users/ada/file.txt");
        assert_eq!(messages[3]["content"][0]["text"], "/Users/ada/other.txt");
    }

    // ── request cloak: tool outputs + replayed arguments (E2E 2026-10-07) ──

    /// Wire-form session as `cloak_batch` builds it (bracketed pseudonyms).
    fn wire_session() -> privacy::CloakSession {
        let mut map = std::collections::HashMap::new();
        map.insert("[Place-3]".to_string(), "Berlin Hbf".to_string());
        map.insert("[Person-27]".to_string(), "Tom \"TA\" Arenstam".to_string());
        map.insert("[Term-2]".to_string(), "C:\\Daten".to_string());
        privacy::CloakSession { map }
    }

    /// The PRODUCTION substitution without Postgres (`privacy::apply_batch`, the pure
    /// tail of `cloak_batch`) with the entities of `s` as the resolved registry.
    fn real_cloak(texts: &[String], s: &privacy::CloakSession) -> (Vec<String>, privacy::CloakSession) {
        let mut key_map = std::collections::HashMap::new();
        let mut session = privacy::CloakSession::empty();
        for (p, name) in &s.map {
            key_map.insert(privacy::match_key(name), p.clone());
            session.map.insert(p.clone(), name.clone());
        }
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let out = privacy::apply_batch(&refs, &key_map, &mut session);
        (out, session)
    }

    fn cloak_messages(messages: &mut Vec<Value>, tool_outputs: bool) -> privacy::CloakSession {
        normalize_chat_duplicate_argument_keys(messages);
        let (slots, texts) = collect_cloak_texts(messages, tool_outputs);
        let (cloaked, session) = real_cloak(&texts, &wire_session());
        assert_eq!(cloaked.len(), slots.len());
        write_cloaked_texts(messages, &slots, &cloaked, &session);
        session
    }

    fn agent_messages() -> Vec<Value> {
        let args = json!({ "ref": "e12", "text": "Berlin Hbf", "note": "für Tom \"TA\" Arenstam", "n": 3, "Berlin Hbf": true }).to_string();
        vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": [{ "type": "text", "text": "Zug nach Berlin Hbf" }] }),
            json!({ "role": "assistant", "content": null, "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "browser", "arguments": args } },
                { "id": "c2", "type": "function", "function": { "name": "open", "arguments": "not json Berlin Hbf" } },
                { "id": "c3", "type": "function", "function": { "name": "obj", "arguments": { "path": "C:\\Daten" } } },
            ] }),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "Feld Ziel: Berlin Hbf" }),
            json!({ "role": "tool", "tool_call_id": "c2", "content": [{ "type": "text", "text": "Ziel Berlin Hbf gesetzt" }] }),
        ]
    }

    #[test]
    fn tool_outputs_and_replayed_arguments_share_the_prose_mapping() {
        let mut messages = agent_messages();
        let session = cloak_messages(&mut messages, true);
        assert_eq!(messages[1]["content"][0]["text"], "Zug nach [Place-3]");
        assert_eq!(messages[3]["content"], "Feld Ziel: [Place-3]");
        assert_eq!(messages[4]["content"][0]["text"], "Ziel [Place-3] gesetzt");
        // Replayed arguments: decoded string values cloaked, keys + numbers untouched, valid JSON.
        let raw = messages[2]["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        let v: Value = serde_json::from_str(raw).expect("valid JSON");
        assert_eq!(v["text"], "[Place-3]");
        assert_eq!(v["note"], "für [Person-27]");
        assert_eq!(v["ref"], "e12");
        assert_eq!(v["n"], 3);
        assert_eq!(v["Berlin Hbf"], true, "object keys are never cloaked");
        assert!(!raw.contains("Arenstam"));
        // Non-JSON arguments: the raw string is cloaked; object arguments by leaf.
        assert_eq!(messages[2]["tool_calls"][1]["function"]["arguments"], "not json [Place-3]");
        assert_eq!(messages[2]["tool_calls"][2]["function"]["arguments"]["path"], "[Term-2]");
        // One mapping for everything; it round-trips.
        assert_eq!(privacy::decloak(&session, "[Place-3]"), "Berlin Hbf");
    }

    #[test]
    fn tool_outputs_stay_clear_when_opted_out_but_arguments_are_cloaked() {
        let mut messages = agent_messages();
        cloak_messages(&mut messages, false);
        assert_eq!(messages[3]["content"], "Feld Ziel: Berlin Hbf");
        assert_eq!(messages[4]["content"][0]["text"], "Ziel Berlin Hbf gesetzt");
        assert_eq!(messages[2]["tool_calls"][1]["function"]["arguments"], "not json [Place-3]");
        let mut h = HeaderMap::new();
        assert!(tool_outputs_cloaked(&h));
        h.insert("x-cloak-tool-outputs", HeaderValue::from_static("0"));
        assert!(!tool_outputs_cloaked(&h));
    }

    #[test]
    fn duplicate_argument_keys_never_smuggle_a_clear_value() {
        let mut messages = vec![json!({ "role": "assistant", "tool_calls": [
            { "id": "c", "type": "function", "function": { "name": "f", "arguments": "{\"a\":\"Berlin Hbf\",\"a\":\"x\"}" } }
        ] })];
        cloak_messages(&mut messages, true);
        let raw = messages[0]["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        assert!(!raw.contains("Berlin"), "{raw}");
    }

    #[test]
    fn placeholder_note_goes_into_the_first_system_message_once() {
        let mut m = vec![json!({ "role": "user", "content": "hi" }), json!({ "role": "system", "content": "sys" })];
        add_placeholder_note(&mut m);
        assert_eq!(m[1]["content"], format!("{PLACEHOLDER_NOTE}\n\nsys"));
        assert_eq!(m.len(), 2);
        let mut m = vec![json!({ "role": "system", "content": [{ "type": "text", "text": "sys" }] })];
        add_placeholder_note(&mut m);
        assert_eq!(m[0]["content"][0]["text"], PLACEHOLDER_NOTE);
        assert_eq!(m[0]["content"][1]["text"], "sys");
        let mut m = vec![json!({ "role": "user", "content": "hi" })];
        add_placeholder_note(&mut m);
        assert_eq!(m[0], json!({ "role": "system", "content": PLACEHOLDER_NOTE }));
        assert!(PLACEHOLDER_NOTE.contains("[Place-3]"));
    }

    // ── response side: ChatSseDecloaker + decloak_chat_completion ─────────

    fn chunk(delta: Value, finish: Option<&str>) -> String {
        format!("data: {}\n\n", json!({ "id": "x", "choices": [ { "index": 0, "delta": delta, "finish_reason": finish } ] }))
    }

    fn run(s: privacy::CloakSession, chunks: &[&[u8]]) -> String {
        let mut d = ChatSseDecloaker::new(s);
        let mut out = String::new();
        for c in chunks {
            out.push_str(&d.feed(c));
        }
        out.push_str(&d.finish());
        out
    }

    fn data_events(out: &str) -> Vec<Value> {
        out.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter(|d| *d != "[DONE]")
            .filter_map(|d| serde_json::from_str(d).ok())
            .collect()
    }

    fn content_of(out: &str) -> String {
        data_events(out)
            .iter()
            .filter_map(|e| e["choices"][0]["delta"]["content"].as_str().map(str::to_string))
            .collect()
    }

    /// Concatenated arguments per tool-call index.
    fn args_of(out: &str) -> std::collections::BTreeMap<i64, String> {
        let mut m = std::collections::BTreeMap::new();
        for e in data_events(out) {
            for (pos, tc) in e["choices"][0]["delta"]["tool_calls"].as_array().cloned().unwrap_or_default().into_iter().enumerate() {
                let idx = tc["index"].as_i64().unwrap_or(pos as i64);
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    m.entry(idx).or_insert_with(String::new).push_str(a);
                }
            }
        }
        m
    }

    #[test]
    fn stream_content_decloaks_at_every_byte_split() {
        let input = chunk(json!({ "role": "assistant", "content": "" }), None)
            + &chunk(json!({ "content": "Fahrt nach [Place-3], Grüße [Person-27]" }), None)
            + &chunk(json!({ "content": " und [Pla" }), None)
            + &chunk(json!({ "content": "ce-3] Place-3x" }), Some("stop"))
            + "data: [DONE]\n\n";
        let want = "Fahrt nach Berlin Hbf, Grüße Tom \"TA\" Arenstam und Berlin Hbf Place-3x";
        let bytes = input.as_bytes();
        for split in 0..=bytes.len() {
            let out = run(wire_session(), &[&bytes[..split], &bytes[split..]]);
            assert_eq!(content_of(&out), want, "split {split}");
            assert!(out.trim_end().ends_with("data: [DONE]"), "split {split}");
        }
    }

    #[test]
    fn stream_tool_arguments_restore_escaped_originals_per_index() {
        // Interleaved fragments of two calls, a pseudonym split across fragments.
        let input = chunk(json!({ "tool_calls": [ { "index": 0, "id": "a", "function": { "name": "type", "arguments": "{\"text\":\"[Pla" } } ] }), None)
            + &chunk(json!({ "tool_calls": [ { "index": 1, "id": "b", "function": { "name": "w", "arguments": "{\"who\":\"[Person-" } } ] }), None)
            + &chunk(json!({ "tool_calls": [ { "index": 0, "function": { "arguments": "ce-3]\"}" } } ] }), None)
            + &chunk(json!({ "tool_calls": [ { "index": 1, "function": { "arguments": "27]\",\"p\":\"[Term-2]\"}" } } ] }), Some("tool_calls"))
            + "data: [DONE]\n\n";
        let bytes = input.as_bytes();
        for split in 0..=bytes.len() {
            let out = run(wire_session(), &[&bytes[..split], &bytes[split..]]);
            let args = args_of(&out);
            let a: Value = serde_json::from_str(&args[&0]).unwrap_or_else(|e| panic!("split {split}: {e} {}", args[&0]));
            let b: Value = serde_json::from_str(&args[&1]).unwrap_or_else(|e| panic!("split {split}: {e} {}", args[&1]));
            assert_eq!(a["text"], "Berlin Hbf", "split {split}");
            assert_eq!(b["who"], "Tom \"TA\" Arenstam", "split {split}");
            assert_eq!(b["p"], "C:\\Daten", "split {split}");
        }
    }

    #[test]
    fn stream_calls_without_index_do_not_share_a_buffer() {
        let input = chunk(
            json!({ "tool_calls": [
                { "id": "a", "function": { "name": "x", "arguments": "{\"t\":\"[Place-" } },
                { "id": "b", "function": { "name": "y", "arguments": "{\"t\":\"[Person-27]\"}" } }
            ] }),
            None,
        ) + &chunk(
            json!({ "tool_calls": [ { "function": { "arguments": "3]\"}" } } ] }),
            Some("tool_calls"),
        );
        let out = run(wire_session(), &[input.as_bytes()]);
        let args = args_of(&out);
        assert_eq!(serde_json::from_str::<Value>(&args[&0]).unwrap()["t"], "Berlin Hbf");
        assert_eq!(serde_json::from_str::<Value>(&args[&1]).unwrap()["t"], "Tom \"TA\" Arenstam");
    }

    #[test]
    fn stream_without_done_flushes_tails_at_eof_and_passes_other_lines() {
        let input = String::from(": keepalive\n\n") + &chunk(json!({ "content": "nach [Place-3" }), None) + "data: not-json\n\n";
        let out = run(wire_session(), &[input.as_bytes(), b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"]\"}}]}"]);
        assert!(out.starts_with(": keepalive\n"));
        assert!(out.contains("data: not-json\n"));
        assert_eq!(content_of(&out), "nach Berlin Hbf");
    }

    #[test]
    fn stream_never_restores_a_prefix_of_a_longer_index() {
        let mut map = std::collections::HashMap::new();
        map.insert("Term-2".to_string(), "Ursache".to_string());
        map.insert("[Term-27]".to_string(), "REST API".to_string());
        let s = privacy::CloakSession { map };
        let input = chunk(json!({ "content": "Term-2" }), None) + &chunk(json!({ "content": "7 und Term-2" }), None) + &chunk(json!({ "content": "3 Term-4040, Term-2." }), Some("stop"));
        let out = run(s, &[input.as_bytes()]);
        assert_eq!(content_of(&out), "REST API und Term-23 Term-4040, Ursache.");
    }

    #[test]
    fn non_stream_decloak_keeps_arguments_valid_json() {
        let s = wire_session();
        let mut v = json!({ "choices": [ { "index": 0, "message": {
            "role": "assistant",
            "content": "Ich tippe [Place-3] für [Person-27]",
            "reasoning": "Person-27 will nach Place-3",
            "tool_calls": [ { "id": "a", "type": "function", "function": { "name": "type", "arguments": "{\"text\":\"[Place-3]\",\"who\":\"[Person-27]\",\"p\":\"[Term-2]\"}" } } ]
        } } ] });
        decloak_chat_completion(&s, &json_escaped_session(&s), &mut v);
        let m = &v["choices"][0]["message"];
        assert_eq!(m["content"], "Ich tippe Berlin Hbf für Tom \"TA\" Arenstam");
        assert_eq!(m["reasoning"], "Tom \"TA\" Arenstam will nach Berlin Hbf");
        let a: Value = serde_json::from_str(m["tool_calls"][0]["function"]["arguments"].as_str().unwrap()).expect("valid JSON");
        assert_eq!(a, json!({ "text": "Berlin Hbf", "who": "Tom \"TA\" Arenstam", "p": "C:\\Daten" }));
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
        use Upstream::{Anthropic, OpenAi};
        assert!(has_upstream_credential(&hm(&[("x-api-key", "sk-1")]), Anthropic, true));
        assert!(has_upstream_credential(&hm(&[("authorization", "Bearer sk-1")]), Anthropic, false));
        assert!(!has_upstream_credential(&hm(&[("authorization", "Bearer gctrl")]), Anthropic, true));
        assert!(!has_upstream_credential(&hm(&[("x-api-key", "  ")]), Anthropic, false));
        assert!(!has_upstream_credential(&HeaderMap::new(), Anthropic, false));
        // OpenAI: only an unconsumed `authorization` counts; x-api-key does not.
        assert!(has_upstream_credential(&hm(&[("authorization", "Bearer sk-1")]), OpenAi, false));
        assert!(!has_upstream_credential(&hm(&[("authorization", "Bearer sk-1")]), OpenAi, true));
        assert!(!has_upstream_credential(&hm(&[("x-api-key", "sk-1")]), OpenAi, false));
        assert!(!has_upstream_credential(&hm(&[("x-api-key", "sk-1")]), OpenAi, true));
        // A gctrl token in a credential header is no credential.
        assert!(!has_upstream_credential(&hm(&[("x-api-key", "gctrl_abc")]), Anthropic, false));
        assert!(!has_upstream_credential(&hm(&[("authorization", "Bearer gctrl_abc")]), OpenAi, false));
    }

    #[test]
    fn gctrl_token_in_credential_header_is_never_forwarded() {
        let incoming = hm(&[
            ("x-api-key", "gctrl_secret"),
            ("authorization", "Bearer gctrl_secret2"),
            ("user-agent", "ua"),
        ]);
        for up in [Upstream::Anthropic, Upstream::OpenAi] {
            let out = forward_headers(&incoming, up, false);
            assert!(!out.contains_key("x-api-key"), "{up:?}");
            assert!(!out.contains_key("authorization"), "{up:?}");
            assert!(out.contains_key("user-agent"));
        }
        for v in ["ApiKey gctrl_x", "apikey gctrl_x", "Bearer gctrl_x", "gctrl_x", " Bearer  gctrl_x "] {
            let out = forward_headers(&hm(&[("authorization", v)]), Upstream::Anthropic, false);
            assert!(!out.contains_key("authorization"), "{v}");
        }
        // A real vendor key survives.
        let out = forward_headers(&hm(&[("x-api-key", "sk-ant-1"), ("authorization", "Bearer sk-1")]), Upstream::Anthropic, false);
        assert_eq!(out["x-api-key"], "sk-ant-1");
        assert_eq!(out["authorization"], "Bearer sk-1");
    }

    #[test]
    fn openai_forwards_only_authorization_as_credential() {
        let incoming = hm(&[
            ("x-api-key", "sk-ant-1"), ("authorization", "Bearer sk-oa"), ("anthropic-version", "2023-06-01"),
            ("anthropic-beta", "b"), ("anthropic-dangerous-direct-browser-access", "true"), ("x-app", "cli"),
            ("user-agent", "ua"), ("accept", "text/event-stream"), ("x-stainless-lang", "js"),
        ]);
        let out = forward_headers(&incoming, Upstream::OpenAi, false);
        let mut names: Vec<&str> = out.keys().map(|k| k.as_str()).collect();
        names.sort();
        assert_eq!(names, ["accept", "authorization", "content-type", "user-agent", "x-stainless-lang"]);
        // Anthropic keeps its allowlist.
        let a = forward_headers(&incoming, Upstream::Anthropic, false);
        for k in ["x-api-key", "authorization", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access", "x-app"] {
            assert!(a.contains_key(k), "{k}");
        }
    }

    #[test]
    fn openai_sse_lines_survive_a_split_inside_a_multibyte_char() {
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"Müller\"}}]}\n";
        let bytes = line.as_bytes();
        let split = line.find('ü').unwrap() + 1; // between the two bytes of ü
        assert!(!line.is_char_boundary(split));
        let mut l = OpenAiSseLines::default();
        assert!(l.feed(&bytes[..split]).is_empty());
        let got = l.feed(&bytes[split..]);
        assert_eq!(got, vec![line.to_string()]);
        assert!(l.finish().is_none());
        // Multiple lines in one chunk + dangling tail at EOF.
        let mut l = OpenAiSseLines::default();
        assert_eq!(l.feed(b"a\nb\nc"), vec!["a\n".to_string(), "b\n".to_string()]);
        assert_eq!(l.finish().as_deref(), Some("c"));
    }

    #[tokio::test]
    async fn gateway_error_json_is_marked_and_shaped() {
        let r = gateway_error_json(StatusCode::UNPROCESSABLE_ENTITY, "cloak_unavailable", "nope");
        assert_eq!(r.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(r.headers()[GATEWAY_ERROR_HEADER], "1");
        let bytes = axum::body::to_bytes(r.into_body(), 4096).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v, json!({ "error": { "message": "nope", "type": "cloak_unavailable" } }));
    }

    #[tokio::test]
    async fn gateway_routes_without_state() {
        use axum::routing::any;
        use tower::util::ServiceExt;
        // Same handlers/paths as `router()` (which needs an AppState with live
        // Postgres/Neo4j/Redis handles); none of these two touch state.
        let app: Router = Router::new()
            .route("/v1/cloak/capabilities", get(capabilities))
            .route("/v1/*rest", any(super::super::llm_gateway_anthropic::not_proxied));
        let res = app
            .clone()
            .oneshot(axum::http::Request::builder().uri("/v1/cloak/capabilities").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(v["upstreams"], json!(["ollama", "anthropic", "openai", "chatgpt"]));
        let res = app
            .oneshot(axum::http::Request::builder().uri("/v1/does-not-exist").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(res.headers()[GATEWAY_ERROR_HEADER], "1");
        let v: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(v["error"]["type"], "not_found_error");
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

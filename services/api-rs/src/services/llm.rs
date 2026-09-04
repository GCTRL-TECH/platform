//! Provider-agnostic LLM chat layer for the Pi agent (SSE streaming) and the
//! Talk-to-Graph RAG endpoint (one-shot).
//!
//! Four providers are supported, each resolved per-user from `user_llm_providers`:
//!
//! | provider   | endpoint                          | auth                         | stream wire format                    |
//! |------------|-----------------------------------|------------------------------|---------------------------------------|
//! | ollama     | `{base}/api/chat`                 | none (local)                 | newline-delimited JSON, `.message.content`, done at `.done` |
//! | openai     | `{base}/v1/chat/completions`      | `Authorization: Bearer`      | SSE `data:`, `.choices[0].delta.content`, end `[DONE]` |
//! | openrouter | `{base}/v1/chat/completions`      | `Authorization: Bearer`      | same as openai                        |
//! | anthropic  | `{base}/v1/messages`              | `x-api-key` + version header | SSE `content_block_delta` → `.delta.text` |
//!
//! Keys arrive here already decrypted (callers use `crypto::open`). This module
//! never touches the DB except via [`resolve_for_user`].

use std::time::Duration;

use futures::stream::{Stream, StreamExt};
use serde_json::{json, Value};

// ── Global runtime config ─────────────────────────────────────────────────────

/// Load the global (operator-level) runtime configuration from the singleton
/// `runtime_config` table.  Returns `(provider, base_url, model, api_key_opened)`
/// only when a row exists **and** `provider` is non-NULL and non-empty — anything
/// else means "unset" and returns `None`, keeping today's Ollama default.
async fn active_runtime_config(
    db: &sqlx::PgPool,
) -> Option<(String, Option<String>, Option<String>, Option<String>)> {
    let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT provider, base_url, model, api_key FROM runtime_config WHERE id = 1",
        )
        .fetch_optional(db)
        .await
        .ok()
        .flatten();

    let (provider, base_url, model, api_key) = row?;
    let provider = provider.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
    let api_key_opened = api_key
        .map(|k| crate::services::crypto::open(&k))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some((provider, base_url, model, api_key_opened))
}

/// Pure helper: given an optional global runtime config tuple and an optional
/// requested model override, return the `LlmTarget` that the resolution chain
/// should use as a final fallback (after per-user rows).
///
/// Extracted as a pure function (no async, no DB) so it can be unit-tested
/// without a live database.
pub fn choose_fallback_target(
    global: Option<(String, Option<String>, Option<String>, Option<String>)>,
    requested_model: Option<&str>,
) -> LlmTarget {
    match global {
        Some((provider, base_url, config_model, api_key)) => {
            // Validate the stored base_url through the SSRF guard; an invalid
            // value is silently dropped so it can never be used as an attack
            // vector even if it somehow entered the DB without write-time checks.
            let validated_base = base_url.as_deref().and_then(|b| {
                let b = b.trim();
                if b.is_empty() {
                    return None;
                }
                validate_llm_base(&provider, Some(b)).ok().map(|u| {
                    containerize_ollama_base(u.as_str().trim_end_matches('/'))
                })
            });
            let model = requested_model
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| config_model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
                .unwrap_or_else(|| LlmTarget::default_model_for(&provider).to_string());
            LlmTarget { provider, model, base_url: validated_base, api_key }
        }
        // No global config set → bundled Ollama default (identical to today).
        None => LlmTarget {
            provider: "ollama".into(),
            model: requested_model
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("llama3.2")
                .to_string(),
            base_url: None,
            api_key: None,
        },
    }
}

/// Canonical root of an OpenAI-compatible server: trailing `/` trimmed and ONE
/// trailing `/v1` stripped. Operators paste both `http://host:8020` and
/// `http://host:8020/v1` (oMLX prints the latter); every caller appends its own
/// `/v1/...` path. Before this helper only `ChatMessages::build` stripped, so a
/// `/v1` base chatted fine but probed `/v1/v1/models` (measured on Asgard, spec
/// D4). The Python workers mirror this as `_v1_root()`.
pub fn openai_compat_root(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    let b = b.strip_suffix("/v1").unwrap_or(b);
    b.trim_end_matches('/').to_string()
}

/// True when two bases name the same OpenAI-compatible server after
/// canonicalisation (`/v1`, trailing slash, and the in-container loopback
/// rewrite all folded). Used to decide whether the STORED runtime key belongs to
/// a target (workers only ever get the key for the runtime it was entered for).
pub fn same_openai_root(a: &str, b: &str) -> bool {
    let ca = openai_compat_root(&containerize_ollama_base(a));
    let cb = openai_compat_root(&containerize_ollama_base(b));
    !ca.is_empty() && ca.eq_ignore_ascii_case(&cb)
}

/// Reachability probe with the REASON, so the UI/agent can say "401: api key
/// missing or wrong" instead of a bare `healthy:false` (Asgard failure #1: the
/// probe omitted the stored key and reported a working oMLX as dead).
///
/// - `openai_compatible` → `GET {root}/v1/models`, `Authorization: Bearer` when
///   the target carries a key
/// - all others (ollama) → `GET {base}/api/tags`
///
/// 3-second timeout. Errors: `unreachable: <e>`, `401 unauthorized (api key
/// missing or wrong)`, `HTTP <code>`.
pub async fn runtime_health_detail(client: &reqwest::Client, target: &LlmTarget) -> Result<(), String> {
    let base = target.base();
    let is_openai = target.provider == "openai_compatible";
    let url = if is_openai {
        format!("{}/v1/models", openai_compat_root(&base))
    } else {
        format!("{}/api/tags", base.trim_end_matches('/'))
    };
    let mut req = client.get(&url).timeout(Duration::from_secs(3));
    if is_openai {
        if let Some(k) = target.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            req = req.header("authorization", format!("Bearer {k}"));
        }
    }
    match req.send().await {
        Ok(r) if r.status().is_success() => Ok(()),
        Ok(r) if r.status().as_u16() == 401 => {
            Err("401 unauthorized (api key missing or wrong)".to_string())
        }
        Ok(r) => Err(format!("HTTP {}", r.status().as_u16())),
        Err(e) => Err(format!("unreachable: {e}")),
    }
}

/// Boolean wrapper over [`runtime_health_detail`] for callers that only need
/// up/down.
pub async fn runtime_health(client: &reqwest::Client, target: &LlmTarget) -> bool {
    runtime_health_detail(client, target).await.is_ok()
}

/// The decrypted API key stored on the global runtime (`runtime_config.api_key`),
/// `None` when unset/empty. Every probe target must carry this instead of
/// `api_key: None` — a keyed runtime (oMLX) answers 401 to an anonymous
/// `/v1/models` even though chat (which sends the key) works.
pub async fn stored_runtime_key(db: &sqlx::PgPool) -> Option<String> {
    stored_runtime_base_and_key(db).await.1
}

/// Pure half of [`stored_key_for_base`]: the stored key is returned ONLY when
/// `base` is the same server the key was entered for. An operator who changes the
/// base URL without supplying a key must not have the old credential presented
/// to the new host (credential misdirection, flagged by the push security review).
pub fn key_for_base(stored_base: Option<&str>, stored_key: Option<String>, base: Option<&str>) -> Option<String> {
    match (stored_base, base) {
        (Some(sb), Some(nb)) if same_openai_root(sb, nb) => stored_key,
        _ => None,
    }
}

/// The stored runtime key, but only for a probe/request against the stored base.
pub async fn stored_key_for_base(db: &sqlx::PgPool, base: Option<&str>) -> Option<String> {
    let (stored_base, stored_key) = stored_runtime_base_and_key(db).await;
    key_for_base(stored_base.as_deref(), stored_key, base)
}

/// `(base_url, decrypted api_key)` of the global runtime, each `None` when
/// unset/empty. One query for the callers that must decide whether a key belongs
/// to a given base (credential route, model listing, worker overrides).
pub async fn stored_runtime_base_and_key(db: &sqlx::PgPool) -> (Option<String>, Option<String>) {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT base_url, api_key FROM runtime_config WHERE id = 1")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    let (base, key) = row.unwrap_or((None, None));
    let nz = |s: String| {
        let s = s.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    };
    (
        base.and_then(nz),
        key.map(|k| crate::services::crypto::open(&k)).and_then(nz),
    )
}

/// `runtime_config.max_concurrency` (migration 082), default 4 when the row is
/// missing. Read per call — one indexed singleton-row SELECT is cheaper than a
/// cache-invalidation story and lets an operator change it without a restart.
pub async fn runtime_max_concurrency(db: &sqlx::PgPool) -> i64 {
    let v: Option<i32> = sqlx::query_scalar("SELECT max_concurrency FROM runtime_config WHERE id = 1")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    v.map(i64::from).filter(|n| *n >= 1).unwrap_or(4)
}

// ── Transient-error contract (spec D1) ────────────────────────────────────────

/// Statuses a local inference server returns while it is alive but cannot take
/// the request RIGHT NOW: oMLX answers `507` under memory pressure and `409`
/// ("model busy; unload pending") while swapping, vLLM/llama.cpp `503` while
/// loading, proxies `502/504`, everything `429`. These must be retried, not
/// treated as a dead runtime (the guardrail reverted Asgard to bundled Ollama
/// after three of them). Non-transient statuses (400/401/403/404/422/500…) fail
/// immediately as before.
pub fn is_transient_status(code: u16) -> bool {
    matches!(code, 408 | 409 | 425 | 429 | 502 | 503 | 504 | 507)
}

/// Retry ladder knobs. Defaults give `1, 2, 4, 8, 16 s` (5 retries).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_ms: u64,
}

/// Pure: parse the two env knobs (`GCTRL_LLM_RETRY_MAX`, `GCTRL_LLM_RETRY_BASE_MS`).
/// Unparseable or absent → defaults; `max` is capped at 10 so a typo cannot
/// turn one request into minutes of sleeping.
pub fn retry_policy(max: Option<&str>, base_ms: Option<&str>) -> RetryPolicy {
    let max_retries = max
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(5)
        .min(10);
    let base_ms = base_ms
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(1000);
    RetryPolicy { max_retries, base_ms }
}

impl RetryPolicy {
    pub fn from_env() -> Self {
        retry_policy(
            std::env::var("GCTRL_LLM_RETRY_MAX").ok().as_deref(),
            std::env::var("GCTRL_LLM_RETRY_BASE_MS").ok().as_deref(),
        )
    }
}

/// Hard cap on a single retry sleep. A server's `Retry-After: 3600` must not
/// park an interactive chat for an hour.
const RETRY_SLEEP_CAP_MS: u64 = 30_000;

/// Pure: how long to sleep before retry number `attempt` (0-based). A
/// `Retry-After` (seconds) from the server wins over the exponential ladder;
/// either way the sleep is capped at 30 s.
pub fn retry_delay(attempt: u32, base_ms: u64, retry_after_secs: Option<u64>) -> Duration {
    let ms = match retry_after_secs {
        Some(s) => s.saturating_mul(1000),
        None => base_ms.saturating_mul(1u64 << attempt.min(20)),
    };
    Duration::from_millis(ms.min(RETRY_SLEEP_CAP_MS))
}

/// `Retry-After` as integer seconds; the HTTP-date form is ignored (no local
/// server sends it, and a wrong parse would only shorten the sleep).
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// A send error worth retrying: the connection never got established (refused,
/// reset during handshake). A TIMEOUT on a started request is NOT retried — the
/// model is genuinely slow/stuck and a retry would just double the wait.
fn is_transient_send_error(e: &reqwest::Error) -> bool {
    if e.is_timeout() {
        return false;
    }
    if e.is_connect() {
        return true;
    }
    let msg = e.to_string().to_ascii_lowercase();
    msg.contains("connection reset") || msg.contains("broken pipe")
}

/// POST `body` to `url`, retrying transient failures per [`RetryPolicy`]. Returns
/// the successful response, or the usual `LLM error {code}: …` /
/// `LLM unreachable: …` string once retries are exhausted or the failure is
/// non-transient. Shared by the one-shot and streaming chat paths.
async fn send_with_retry(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    body: &Value,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    let policy = RetryPolicy::from_env();
    let mut attempt = 0u32;
    loop {
        let res = apply_headers(client.post(url), headers)
            .json(body)
            .timeout(timeout)
            .send()
            .await;
        let (msg, retry_after, transient) = match res {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                let code = resp.status();
                let retry_after = parse_retry_after(resp.headers());
                let text = resp.text().await.unwrap_or_default();
                let msg = format!("LLM error {code}: {}", text.chars().take(300).collect::<String>());
                (msg, retry_after, is_transient_status(code.as_u16()))
            }
            Err(e) => (format!("LLM unreachable: {e}"), None, is_transient_send_error(&e)),
        };
        if !transient || attempt >= policy.max_retries {
            return Err(msg);
        }
        let delay = retry_delay(attempt, policy.base_ms, retry_after);
        tracing::info!(
            "llm: transient failure, retry {}/{} in {:?}: {}",
            attempt + 1, policy.max_retries, delay, msg.chars().take(160).collect::<String>()
        );
        tokio::time::sleep(delay).await;
        attempt += 1;
    }
}

// ── Per-runtime concurrency gate (spec D2) ────────────────────────────────────

/// Take one of `runtime_config.max_concurrency` generation slots against the
/// active `openai_compatible` runtime. Returns `None` (no gating) for every
/// other provider: Ollama queues internally and cloud APIs have no local memory
/// pressure; the gate exists to stop THIS process from fanning N windows into a
/// 21 GB model on a 48 GB box. The semaphore is rebuilt when the configured size
/// changes, so an operator edit applies to the next request without a restart.
/// Hold the returned permit across the LLM call; dropping it frees the slot.
pub async fn acquire_slot(
    state: &crate::models::AppState,
    target: &LlmTarget,
) -> Option<tokio::sync::OwnedSemaphorePermit> {
    if target.provider != "openai_compatible" {
        return None;
    }
    let want = runtime_max_concurrency(&state.db).await.clamp(1, 64) as usize;
    let sem = {
        let mut gate = state.llm_gate.lock().await;
        if gate.0 != want {
            *gate = (want, std::sync::Arc::new(tokio::sync::Semaphore::new(want)));
        }
        gate.1.clone()
    };
    sem.acquire_owned().await.ok()
}

/// A fully-resolved chat target: which provider/model to hit, where, and with
/// which (already-decrypted) key. Build via [`resolve_for_user`].
#[derive(Clone, Debug)]
pub struct LlmTarget {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

/// Default API base for a cloud provider when the user didn't override `base_url`.
/// Ollama's default comes from `OLLAMA_BASE` (see [`ollama_default_base`]).
fn default_base(provider: &str) -> String {
    match provider {
        "openai" => "https://api.openai.com".into(),
        "openrouter" => "https://openrouter.ai/api".into(),
        "anthropic" => "https://api.anthropic.com".into(),
        _ => ollama_default_base(),
    }
}

pub fn ollama_default_base() -> String {
    std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://localhost:11434".into())
}

/// Official, pinned base URL host for each cloud provider. A user-supplied
/// `base_url` for these providers is an SSRF vector (the server fetches it), so
/// we never honor an arbitrary URL — only the official host over `https`.
fn official_cloud_host(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("api.openai.com"),
        "anthropic" => Some("api.anthropic.com"),
        "openrouter" => Some("openrouter.ai"),
        _ => None,
    }
}

/// Check whether a host string refers to a cloud-metadata endpoint that must
/// never be reached server-side (SSRF denylist).
///
/// Blocked:
///   - `169.254.169.254` and the whole `169.254.0.0/16` link-local range
///     (AWS, GCP, Azure, DigitalOcean metadata)
///   - `100.100.100.200` (Alibaba Cloud ECS metadata)
///   - `fd00:ec2::254` (AWS EC2 IPv6 metadata)
///
/// Intentionally NOT blocked (these are normal local/LAN use-cases):
///   - `127.x.x.x` loopback, `localhost`
///   - `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x` RFC1918
///   - Docker service names (`gctrl-*`, `host.docker.internal`, etc.)
fn is_metadata_host(host: &str) -> bool {
    // Exact well-known metadata IPs.
    if host == "169.254.169.254" || host == "100.100.100.200" {
        return true;
    }
    // Whole 169.254.0.0/16 link-local range (covers all cloud IMDSv1/v2 variants:
    // AWS/GCP/Azure/DigitalOcean). Parse as IPv4 and check the first two octets.
    if let Ok(addr) = host.parse::<std::net::Ipv4Addr>() {
        let octets = addr.octets();
        if octets[0] == 169 && octets[1] == 254 {
            return true;
        }
    }
    // AWS EC2 IPv6 metadata address fd00:ec2::254.
    // url::Url::host_str() returns IPv6 addresses WITH brackets (e.g. "[fd00:ec2::254]"),
    // so strip the brackets before parsing. We match on the parsed Ipv6Addr so we're
    // robust to abbreviation differences (fd00:ec2::254 vs fd00:0ec2:0:0:0:0:0:254).
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(addr) = bare.parse::<std::net::Ipv6Addr>() {
        // fd00:ec2::254 = fd00:0ec2:0000:0000:0000:0000:0000:0254
        let target: std::net::Ipv6Addr =
            "fd00:ec2::254".parse().expect("fd00:ec2::254 is a valid IPv6 address");
        if addr == target {
            return true;
        }
    }
    false
}

/// SSRF guard for user-supplied LLM `base_url`s. Centralized so the PUT upsert
/// (write time) and every server-side fetch (request time) enforce identical
/// rules — a row that somehow bypassed write validation still can't be used.
///
/// Returns the canonical base `Url` to actually use:
///
/// - **Cloud providers** (openai / anthropic / openrouter): the user does NOT
///   get to point us at an arbitrary host. We pin to the official base. If a
///   `base` is supplied it must exactly match the official host over `https`,
///   otherwise we reject with `400` — this removes the arbitrary-URL SSRF
///   (e.g. `http://169.254.169.254` cloud-metadata) for cloud entirely.
/// - **Ollama**: inherently a local/LAN endpoint (`http://localhost:11434`, a
///   LAN IP, or a Docker service name), so blocking loopback/RFC1918 would break
///   the primary use case. We therefore only enforce that the scheme is
///   `http`/`https`, the host parses, and the URL carries no embedded
///   credentials (`user:pass@`). ACCEPTED RESIDUAL RISK: the Ollama base is a
///   trusted, per-user, authenticated (JWT), self-scoped endpoint; a user can
///   only make the server reach a host *they* chose for *their own* inference.
pub fn validate_llm_base(provider: &str, base: Option<&str>) -> Result<url::Url, String> {
    let provider = provider.trim().to_lowercase();

    if let Some(official) = official_cloud_host(&provider) {
        // Cloud: pin to the official host. No base, or a base whose host matches
        // the official host over https, is accepted; anything else is rejected.
        let official_url = url::Url::parse(&format!("https://{official}"))
            .expect("official base is a valid URL");
        match base.map(str::trim).filter(|s| !s.is_empty()) {
            None => Ok(official_url),
            Some(raw) => {
                let u = url::Url::parse(raw)
                    .map_err(|_| format!("Invalid base_url for {provider}"))?;
                if u.scheme() == "https"
                    && u.host_str().map(|h| h.eq_ignore_ascii_case(official)) == Some(true)
                {
                    Ok(official_url)
                } else {
                    Err(format!(
                        "base_url for {provider} must be https://{official} (arbitrary URLs are not allowed)"
                    ))
                }
            }
        }
    } else {
        // Ollama (and any non-cloud provider): allow local/LAN, but constrain the
        // scheme and reject embedded credentials / unparseable hosts.
        let raw = base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(ollama_default_base);
        let u = url::Url::parse(&raw)
            .map_err(|_| "Invalid base_url".to_string())?;
        match u.scheme() {
            "http" | "https" => {}
            other => return Err(format!("base_url scheme '{other}' not allowed (use http/https)")),
        }
        if u.host_str().map(|h| h.is_empty()).unwrap_or(true) {
            return Err("base_url must have a host".to_string());
        }
        if !u.username().is_empty() || u.password().is_some() {
            return Err("base_url must not contain embedded credentials".to_string());
        }
        // SSRF denylist: block cloud-metadata endpoints.
        // 169.254.0.0/16 (link-local, covers AWS/GCP/Azure 169.254.169.254),
        // 100.100.100.200 (Alibaba Cloud metadata), fd00:ec2::254 (AWS IPv6 metadata).
        // Normal localhost/LAN (127.x, 192.168.x, 10.x, service names) are ALLOWED.
        if let Some(host) = u.host_str() {
            if is_metadata_host(host) {
                return Err("metadata endpoint not allowed".to_string());
            }
        }
        Ok(u)
    }
}

/// When the API runs inside a container, an Ollama base pointing at
/// localhost/127.0.0.1/0.0.0.0 refers to the *container itself*, not the host
/// where a user's NATIVE Ollama (the GPU one) listens. Rewrite the host to
/// `host.docker.internal` so a user can paste the natural `http://localhost:11434`
/// and it just reaches their host. Outside a container (dev, `cargo run`) this is
/// a no-op so localhost keeps meaning the dev box. Cloud providers never use a
/// loopback host, so this only ever affects Ollama.
pub fn containerize_ollama_base(base: &str) -> String {
    if !std::path::Path::new("/.dockerenv").exists() {
        return base.to_string();
    }
    match url::Url::parse(base) {
        Ok(mut u) => {
            let loopback = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "0.0.0.0"));
            if loopback && u.set_host(Some("host.docker.internal")).is_ok() {
                u.as_str().trim_end_matches('/').to_string()
            } else {
                base.to_string()
            }
        }
        Err(_) => base.to_string(),
    }
}

impl LlmTarget {
    /// Resolve the base URL to actually hit, re-validating the stored `base_url`
    /// against [`validate_llm_base`] at REQUEST time. This is the second line of
    /// defense: even if a malicious `base_url` row somehow bypassed write-time
    /// validation, cloud providers are forced back to their official host and an
    /// invalid Ollama base falls back to the default — so the server never
    /// performs an attacker-chosen fetch for cloud providers.
    pub fn base(&self) -> String {
        let candidate = self
            .base_url
            .clone()
            .filter(|s| !s.trim().is_empty());
        match validate_llm_base(&self.provider, candidate.as_deref()) {
            Ok(u) => containerize_ollama_base(u.as_str().trim_end_matches('/')),
            // Validation failed (e.g. a bad cloud host snuck into the DB): fall
            // back to the provider's safe canonical base rather than the
            // attacker-supplied value.
            Err(_) => default_base(&self.provider),
        }
    }

    /// A sane default model for a provider when none was requested/stored.
    pub fn default_model_for(provider: &str) -> &'static str {
        match provider {
            "openai" => "gpt-4o-mini",
            "anthropic" => "claude-3-5-sonnet-20241022",
            "openrouter" => "meta-llama/llama-3.3-70b-instruct",
            _ => "llama3.2",
        }
    }
}

/// Resolve the LLM target for a user.
///
/// Precedence:
/// 1. `requested_provider` if the user has a row for it that `is_active`.
/// 2. Otherwise the user's active provider (most recently created wins).
/// 3. Otherwise the global `runtime_config` operator default (if set).
/// 4. Otherwise the local Ollama default (no key).
///
/// The model is `requested_model` if given, else the row's `default_model`, else
/// a provider default. The stored key is decrypted via `crypto::open`.
pub async fn resolve_for_user(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    requested_provider: Option<&str>,
    requested_model: Option<&str>,
) -> LlmTarget {
    // (provider, api_key, base_url, default_model)
    type Row = (String, Option<String>, Option<String>, Option<String>);

    let requested = requested_provider.map(|s| s.trim()).filter(|s| !s.is_empty());

    // Never chat with an embedding model: if a stale/bad selection (e.g.
    // `nomic-embed-text`) reaches here, drop it so resolution falls back to the
    // provider/Ollama chat default instead of 400-ing on every message.
    let requested_model = requested_model.filter(|m| !crate::routes::llm::is_embedding_model(m));

    // Ollama is local and always available — an explicit ollama request is honoured
    // even without a stored row (we still pick up a custom base_url + optional key).
    // `ollama_cloud` is a logical provider: it reuses the stored Ollama API key but
    // pins the base to ollama.com, so a user can run BOTH their local models and
    // Ollama's hosted cloud models from one connection.
    if requested == Some("ollama") || requested == Some("ollama_cloud") {
        let is_cloud = requested == Some("ollama_cloud");
        let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT base_url, default_model, api_key FROM user_llm_providers
             WHERE user_id = $1 AND provider = 'ollama'",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
        let (stored_base, default_model, stored_key) = row.unwrap_or((None, None, None));
        let api_key = stored_key
            .map(|k| crate::services::crypto::open(&k))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        // Cloud routes to ollama.com (ignoring any local base); local uses the
        // stored base (or the bundled default).
        let base_url = if is_cloud { Some("https://ollama.com".to_string()) } else { stored_base };
        let model = requested_model
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| default_model.filter(|s| !s.trim().is_empty()))
            .unwrap_or_else(|| "llama3.2".to_string());
        // Provider stays "ollama" so build() uses the native /api/chat format; the
        // bearer key (when present) is what unlocks a protected/cloud endpoint.
        return LlmTarget { provider: "ollama".into(), model, base_url, api_key };
    }

    let row: Option<Row> = if let Some(p) = requested {
        sqlx::query_as(
            "SELECT provider, api_key, base_url, default_model
             FROM user_llm_providers
             WHERE user_id = $1 AND provider = $2 AND is_active = true",
        )
        .bind(user_id)
        .bind(p)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
    } else {
        None
    };

    // Fall back to the user's active provider if the requested one wasn't found.
    let row = match row {
        Some(r) => Some(r),
        None => sqlx::query_as(
            "SELECT provider, api_key, base_url, default_model
             FROM user_llm_providers
             WHERE user_id = $1 AND is_active = true
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten(),
    };

    match row {
        Some((provider, api_key, base_url, default_model)) => {
            let model = requested_model
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| default_model.filter(|s| !s.trim().is_empty()))
                .unwrap_or_else(|| LlmTarget::default_model_for(&provider).to_string());
            LlmTarget {
                provider,
                model,
                base_url,
                api_key: api_key.map(|k| crate::services::crypto::open(&k)),
            }
        }
        // No connected per-user provider — check the global runtime config, then
        // fall back to the bundled Ollama default (identical behaviour to today
        // when no global config is set).
        None => {
            let global = active_runtime_config(db).await;
            choose_fallback_target(global, requested_model)
        }
    }
}

/// Resolve the owner's runtime-configured Ollama base URL (Settings →
/// Infrastructure writes it into `user_llm_providers.base_url` for
/// `provider='ollama'`). Returns the validated base only when the user has
/// actually set a non-empty override; `None` otherwise (so callers fall back to
/// the worker's env defaults — keeping the default install unchanged).
///
/// The value is run through [`validate_llm_base`] so a malformed / unsafe base in
/// the DB is rejected here rather than handed to the KEX worker.
pub async fn resolve_ollama_base_for_user(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
) -> Option<String> {
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT base_url FROM user_llm_providers
         WHERE user_id = $1 AND provider = 'ollama'",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    let raw = stored.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
    match validate_llm_base("ollama", Some(&raw)) {
        Ok(u) => Some(containerize_ollama_base(u.as_str().trim_end_matches('/'))),
        Err(_) => None,
    }
}

/// Pure helper: given a resolved `LlmTarget`, decide whether to inject
/// `generation_*` fields into a worker payload map for KEX/FUSE.
///
/// Injects ONLY when `target.provider == "openai_compatible"`:
///   - generation_kind = "openai_compatible"
///   - generation_base = openai_compat_root(target.base()) (canonical, no /v1)
///   - generation_model = target.model
///   - generation_max_concurrency = `max_concurrency` (spec D2: the worker sizes
///     its per-base semaphore from this)
///
/// `generation_api_key` is intentionally NOT injected: the payload goes through
/// Redis and no plaintext secret belongs there. Workers that need a key fetch it
/// over the internal HTTP hop (`GET /api/internal/generation-credential`, spec
/// D7) instead.
///
/// For all other providers (ollama, cloud, anthropic) — does nothing, so
/// generation stays on Ollama as today (backward compatible).
pub fn apply_generation_overrides(
    target: &LlmTarget,
    max_concurrency: i64,
    map: &mut serde_json::Map<String, Value>,
) {
    if target.provider != "openai_compatible" {
        return;
    }
    map.insert("generation_kind".into(), json!("openai_compatible"));
    map.insert("generation_base".into(), json!(openai_compat_root(&target.base())));
    map.insert("generation_model".into(), json!(target.model));
    map.insert("generation_max_concurrency".into(), json!(max_concurrency.max(1)));
    // generation_api_key is NOT inserted — no plaintext secret in Redis.
}

/// Pure: which key a worker may present to `target`. The stored GLOBAL runtime
/// key belongs to the global runtime's server only — it is handed out when the
/// target resolves to that same server (after `/v1` + loopback canonicalisation);
/// a per-purpose override pointing elsewhere gets its own key (usually none).
pub fn pick_worker_key(
    target_base: &str,
    target_key: Option<&str>,
    runtime_base: Option<&str>,
    runtime_key: Option<&str>,
) -> Option<String> {
    let nz = |k: Option<&str>| k.map(str::trim).filter(|k| !k.is_empty()).map(str::to_string);
    match runtime_base {
        Some(rb) if same_openai_root(rb, target_base) => nz(runtime_key).or_else(|| nz(target_key)),
        _ => nz(target_key),
    }
}

/// Resolve `purpose`'s generation runtime and build the `generation_*` payload
/// fields the KEX/FUSE workers understand (empty map for non-openai_compatible
/// targets). `include_key: false` for anything that travels through Redis;
/// `include_key: true` ONLY for a direct internal HTTP hop to a worker (the
/// dossier/profile builds, spec D8). Returns the resolved target too, since the
/// Ollama path still needs its `model` for the worker's own model field.
pub async fn worker_generation_overrides(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    purpose: &str,
    include_key: bool,
) -> (LlmTarget, serde_json::Map<String, Value>) {
    let target = resolve_purpose(db, user_id, purpose).await;
    let mut map = serde_json::Map::new();
    if target.provider != "openai_compatible" {
        return (target, map);
    }
    let max_concurrency = runtime_max_concurrency(db).await;
    apply_generation_overrides(&target, max_concurrency, &mut map);
    if include_key {
        let (runtime_base, runtime_key) = stored_runtime_base_and_key(db).await;
        if let Some(k) = pick_worker_key(
            &target.base(),
            target.api_key.as_deref(),
            runtime_base.as_deref(),
            runtime_key.as_deref(),
        ) {
            map.insert("generation_api_key".into(), json!(k));
        }
    }
    (target, map)
}

/// P2 per-purpose runtime resolver. A purpose can override its own
/// `{provider, base_url, model}`; with the provider override unset it INHERITS
/// the normal chain (per-user provider → global runtime → bundled Ollama).
///
/// Mismatch fix: when inheriting a NON-ollama runtime, a purpose-level model
/// (typically an Ollama tag) does NOT apply — we follow the runtime's own model,
/// so a purpose inheriting a vLLM runtime no longer receives an Ollama tag as its
/// model string. To force a specific model on a specific runtime, set a
/// per-purpose provider override.
///
/// `purpose` ∈ `"agent" | "rag" | "relation" | "distill" | "embedding"`.
/// No per-purpose key column yet: keyless local/bundled runtimes are the target;
/// authed-cloud per-purpose for the batch workers is a follow-up.
pub async fn resolve_purpose(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    purpose: &str,
) -> LlmTarget {
    let (prov_col, base_col, model_col) = match purpose {
        "relation"  => ("relation_provider", "relation_base_url", "relation_model"),
        "distill"   => ("distill_provider",  "distill_base_url",  "distill_model"),
        "agent"     => ("agent_provider",    "agent_base_url",    "agent_model"),
        "rag"       => ("rag_provider",      "rag_base_url",      "rag_model"),
        "embedding" => ("embedding_provider","embedding_base_url","embedding_model"),
        _           => ("", "", ""),
    };

    // Column names come from the static allowlist above (never user input), so the
    // formatted query is safe from injection.
    let (ov_provider, ov_base, ov_model): (Option<String>, Option<String>, Option<String>) =
        if prov_col.is_empty() {
            (None, None, None)
        } else {
            let sql = format!(
                "SELECT {prov_col}, {base_col}, {model_col} FROM user_model_prefs WHERE user_id = $1"
            );
            sqlx::query_as(&sql)
                .bind(user_id)
                .fetch_optional(db)
                .await
                .ok()
                .flatten()
                .unwrap_or((None, None, None))
        };

    let nz = |o: &Option<String>| {
        o.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    };

    // The inherit chain (per-user provider → global runtime → bundled Ollama).
    let inherited = resolve_for_user(db, user_id, None, None).await;

    match nz(&ov_provider) {
        // `ollama_cloud` is a logical provider (ollama.com + the stored Ollama
        // key). The generic branch below would build a keyless target with the
        // wrong wire provider, so delegate to resolve_for_user, which pins the
        // base, loads the key and normalizes the provider for the chat layer.
        // The per-purpose base_url is deliberately ignored (cloud is pinned).
        Some(provider) if provider == "ollama_cloud" => {
            let model = nz(&ov_model);
            resolve_for_user(db, user_id, Some("ollama_cloud"), model.as_deref()).await
        }
        // Explicit per-purpose override: target from the stored provider/base
        // (SSRF-validated); model = purpose model else the inherited runtime's.
        Some(provider) => {
            let base = nz(&ov_base).and_then(|b| {
                validate_llm_base(&provider, Some(&b))
                    .ok()
                    .map(|u| containerize_ollama_base(u.as_str().trim_end_matches('/')))
            });
            let model = nz(&ov_model).unwrap_or_else(|| inherited.model.clone());
            LlmTarget { provider, model, base_url: base, api_key: None }
        }
        // Inherit the whole chain. A purpose-level model applies ONLY when the
        // inherited runtime is Ollama (tags interchangeable); otherwise follow the
        // runtime's model to avoid a provider/model mismatch.
        None => {
            let mut t = inherited;
            if let Some(m) = nz(&ov_model) {
                if t.provider == "ollama" {
                    t.model = m;
                }
            } else if t.provider == "ollama" && purpose == "relation" {
                // No explicit per-purpose relation model: inheriting the GLOBAL
                // chat default (llama3.2) is wrong for relation extraction and
                // shadows KEX's `RELEX_MODEL` env, so the relex call blocks on an
                // unloaded chat model. Use the relation purpose's OWN default —
                // the SAME value Settings → AI Models shows (qwen2.5:7b) — so
                // extraction runs on the intended model. Scoped to "relation"
                // only: agent/rag are chat purposes and must keep inheriting the
                // user's chat model (which they may have deliberately changed).
                t.model = crate::routes::llm::default_model_for(purpose).to_string();
            }
            t
        }
    }
}

/// Inject the owner's runtime Ollama endpoint into a KEX `kex:jobs` payload so the
/// extraction worker honors the Settings → Infrastructure base URL for THIS job
/// (relation extraction + embedding) instead of its container-baked env defaults.
///
/// Adds `ollama_base` AND `embedding_base_url` (both point at the same Ollama
/// instance — KEX's embedding default is also Ollama) ONLY when a non-empty
/// configured value exists. Backward compatible: with no override configured the
/// payload is untouched, so the worker uses its env-based config exactly as today.
pub async fn inject_ollama_overrides(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    payload: &mut Value,
) {
    let ollama_base = resolve_ollama_base_for_user(db, user_id).await;

    // Per-purpose model selection (Settings → AI Models → Models). NULLs mean
    // "use the engine's env defaults", so existing installs are untouched.
    let prefs: Option<(Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT embedding_model, embedding_provider, embedding_base_url
             FROM user_model_prefs WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    let (emb_model, emb_provider, emb_base_pref) =
        prefs.unwrap_or((None, None, None));
    let nz = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    if let Some(map) = payload.as_object_mut() {
        if let Some(ref base) = ollama_base {
            map.insert("ollama_base".into(), json!(base));
            // Point embeddings at the same Ollama by default (a native-Ollama
            // switch covers embeddings too). A per-user embedding base below wins.
            map.insert("embedding_base_url".into(), json!(base));
        }
        // Explicit embedding base override (e.g. a deliberate cloud embedder).
        // Defense in depth: re-validate before injecting so a row that somehow
        // bypassed write-time validation can never steer the KEX worker at an
        // SSRF target (e.g. a cloud-metadata IP). Invalid → drop the override and
        // fall back to the (already validated) Ollama base above.
        if let Some(b) = nz(emb_base_pref) {
            let prov = emb_provider.as_deref().unwrap_or("ollama");
            if let Ok(u) = validate_llm_base(prov, Some(&b)) {
                map.insert("embedding_base_url".into(), json!(u.as_str().trim_end_matches('/')));
            }
        }
        // The actual model choices the worker should use for THIS job.
        if let Some(m) = nz(emb_model) {
            map.insert("embedding_model".into(), json!(m));
        }
        if let Some(p) = nz(emb_provider) {
            map.insert("embedding_provider".into(), json!(p));
        }
        // ── Relation extraction runtime (P2 per-purpose) ──────────────────────
        // RELATION resolves independently: it can point at its own runtime
        // (vLLM/llama.cpp/external/ollama) or inherit the global one. Always send
        // the resolved model as relex_model (fixes the old mismatch where a vLLM
        // runtime still received an Ollama relex tag); inject generation_* when
        // that runtime is openai_compatible.
        let (rel, gen) = worker_generation_overrides(db, user_id, "relation", false).await;
        map.insert("relex_model".into(), json!(rel.model));
        map.extend(gen);

        // ── Part 6.1: Pinned embedding override ───────────────────────────────
        // When the active runtime is the bundled llama.cpp (gctrl-llamacpp:8080)
        // in 'pinned' mode, redirect embeddings to its embed sidecar (port 8081,
        // nomic-embed-text, dim 768). This keeps existing vectors valid — no
        // reindex needed. For external openai_compatible endpoints: do nothing
        // (we can't assume they serve nomic; safe fallback keeps Ollama).
        // For ollama / advanced mode: do nothing either.
        let runtime_row: Option<(Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "SELECT provider, base_url, embedding_mode FROM runtime_config WHERE id = 1",
            )
            .fetch_optional(db)
            .await
            .ok()
            .flatten();

        if let Some((Some(rt_provider), Some(rt_base), em)) = runtime_row {
            let emb_mode = em.as_deref().unwrap_or("pinned");
            if let Some((embed_prov, embed_base, embed_model)) =
                pinned_embedding_override(&rt_provider, &rt_base, emb_mode)
            {
                // Override embeddings to sidecar — only if the caller didn't
                // already set a per-user embedding override (respect explicit prefs).
                // We insert AFTER the prefs block so per-user base/model/provider
                // always win over the runtime-level pinned sidecar default.
                // But ONLY inject when the map does NOT already have an
                // embedding_provider that differs from "ollama" — meaning no
                // explicit per-user embedding pref was set above.
                let already_has_pref = map.get("embedding_provider")
                    .and_then(|v| v.as_str())
                    .map(|p| !p.is_empty() && p != "ollama")
                    .unwrap_or(false);
                if !already_has_pref {
                    map.insert("embedding_provider".into(), json!(embed_prov));
                    map.insert("embedding_base_url".into(), json!(embed_base));
                    map.insert("embedding_model".into(), json!(embed_model));
                }
            }
        }
    }
}

/// Resolve a user's per-purpose model preference (Cookbook / Settings → AI
/// Models), for purposes that pick a CHAT model rather than an engine-side
/// worker model: `"agent"` (Pi agent chat) or `"rag"` (Talk-to-Graph). Returns
/// `None` when unset (or for any other purpose) so callers fall back to their
/// existing resolution chain unchanged — this is purely additive.
pub async fn resolve_purpose_model(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    purpose: &str,
) -> Option<String> {
    let col = match purpose {
        "agent" => "agent_model",
        "rag" => "rag_model",
        _ => return None,
    };
    let sql = format!("SELECT {col} FROM user_model_prefs WHERE user_id = $1");
    let row: Option<Option<String>> = sqlx::query_scalar(&sql)
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    row.flatten()
        .map(|s: String| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Build the FUSE distill payload fields for a user: `distill_model` (the DISTILL
/// purpose's resolved model — an explicit per-purpose model, else the inherited
/// runtime's; bundled-Ollama-unset resolves to "llama3.2", identical to the old
/// env default), `ollama_base` (the user's runtime Ollama override, `None` when
/// unset so FUSE keeps `OLLAMA_BASE`), plus the `generation_*` fields when the
/// distill runtime is openai_compatible. `include_key` follows
/// [`worker_generation_overrides`]: false for Redis, true only for a direct
/// internal HTTP hop.
pub async fn distill_payload_fields(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    include_key: bool,
) -> serde_json::Map<String, Value> {
    let ollama_base = resolve_ollama_base_for_user(db, user_id).await;
    let (target, mut map) = worker_generation_overrides(db, user_id, "distill", include_key).await;
    map.insert("distill_model".into(), json!(target.model));
    map.insert("ollama_base".into(), json!(ollama_base));
    map
}

// ── Request building ──────────────────────────────────────────────────────────

/// A single chat turn. Anthropic splits `system` out of the messages array, so we
/// keep messages provider-neutral and pull the system prompt separately.
pub struct ChatMessages<'a> {
    pub system: &'a str,
    /// Provider-neutral message list: `[{role, content}, ...]` WITHOUT the system
    /// message (it's threaded in per-provider). Roles: user/assistant/tool.
    pub messages: Vec<Value>,
}

/// Pure: the truthy spelling shared by every GCTRL boolean env knob
/// (`1|true|yes|on`, case-insensitive).
pub fn env_truthy(v: Option<&str>) -> bool {
    v.map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

/// Whether `/v1` runtimes may reason before answering. OFF unless
/// `GCTRL_LLM_THINK` is truthy (spec D3): qwen3.6 on oMLX spends 1-4k thinking
/// tokens (30-60 s) per call otherwise, which is the whole latency budget of an
/// extraction window. Mirrors `KEX_THINK` / `FUSE_THINK` on the workers.
fn think_enabled() -> bool {
    env_truthy(std::env::var("GCTRL_LLM_THINK").ok().as_deref())
}

impl<'a> ChatMessages<'a> {
    /// Build the request URL, headers, and JSON body for `target`, with `stream`.
    fn build(&self, target: &LlmTarget, stream: bool) -> (String, Vec<(String, String)>, Value) {
        self.build_with_think(target, stream, think_enabled())
    }

    /// [`build`](Self::build) with the thinking switch passed explicitly, so the
    /// request shape can be unit-tested without touching process env.
    fn build_with_think(
        &self,
        target: &LlmTarget,
        stream: bool,
        think: bool,
    ) -> (String, Vec<(String, String)>, Value) {
        let base = target.base();
        let key = target.api_key.clone().unwrap_or_default();
        match target.provider.as_str() {
            "anthropic" => {
                let url = format!("{}/v1/messages", base.trim_end_matches('/'));
                let headers = vec![
                    ("x-api-key".into(), key),
                    ("anthropic-version".into(), "2023-06-01".into()),
                ];
                // Anthropic requires a non-system role for every message and a
                // top-level `system`. `tool` role isn't accepted — fold into user.
                let messages: Vec<Value> = self
                    .messages
                    .iter()
                    .map(|m| {
                        let role = match m["role"].as_str().unwrap_or("user") {
                            "assistant" => "assistant",
                            _ => "user",
                        };
                        json!({ "role": role, "content": m["content"].clone() })
                    })
                    .collect();
                let body = json!({
                    "model": target.model,
                    // Generous cap so thorough/deep answers aren't truncated.
                    "max_tokens": 4096,
                    "system": self.system,
                    "messages": messages,
                    "stream": stream,
                });
                (url, headers, body)
            }
            "openai" | "openrouter" => {
                let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
                let headers = vec![("authorization".into(), format!("Bearer {key}"))];
                let mut messages = vec![json!({ "role": "system", "content": self.system })];
                messages.extend(self.messages.iter().cloned());
                let body = json!({
                    "model": target.model,
                    "messages": messages,
                    "stream": stream,
                });
                (url, headers, body)
            }
            // openai_compatible: same wire format as openai/openrouter but local/LAN
            // SSRF rules (Ollama-style). Authorization header is optional — many
            // local servers (llama.cpp, vLLM, LM Studio, LocalAI) need no key.
            //
            // Users commonly supply base_url with a trailing `/v1` (e.g.
            // `http://localhost:8080/v1`); `openai_compat_root` folds it so both
            // spellings produce `http://host:port/v1/chat/completions`.
            //
            // `chat_template_kwargs.enable_thinking` is the vLLM/SGLang/oMLX/
            // mlx-lm convention for the Qwen3 thinking switch; servers that don't
            // know it ignore the extra field.
            "openai_compatible" => {
                let url = format!("{}/v1/chat/completions", openai_compat_root(&base));
                let mut messages = vec![json!({ "role": "system", "content": self.system })];
                messages.extend(self.messages.iter().cloned());
                let body = json!({
                    "model": target.model,
                    "messages": messages,
                    "stream": stream,
                    "chat_template_kwargs": { "enable_thinking": think },
                });
                // Only send Bearer when a key is actually configured.
                let headers = match target.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                    Some(k) => vec![("authorization".into(), format!("Bearer {k}"))],
                    None => Vec::new(),
                };
                (url, headers, body)
            }
            // ollama (default)
            _ => {
                let url = format!("{}/api/chat", base.trim_end_matches('/'));
                let mut messages = vec![json!({ "role": "system", "content": self.system })];
                messages.extend(self.messages.iter().cloned());
                let body = json!({
                    "model": target.model,
                    "messages": messages,
                    "stream": stream,
                });
                // Optional bearer for a remote/cloud Ollama (e.g. ollama.com or an
                // auth-protected proxy). Local Ollama needs none.
                let headers = match target.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                    Some(k) => vec![("authorization".into(), format!("Bearer {k}"))],
                    None => Vec::new(),
                };
                (url, headers, body)
            }
        }
    }
}

fn apply_headers(
    mut req: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> reqwest::RequestBuilder {
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req
}

// ── One-shot chat (RAG) ───────────────────────────────────────────────────────

/// Non-streaming chat: send `system` + `user`, return the full assistant text.
/// Used by the RAG endpoint, which assembles one answer.
pub async fn chat_once(
    client: &reqwest::Client,
    target: &LlmTarget,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let cm = ChatMessages {
        system,
        messages: vec![json!({ "role": "user", "content": user })],
    };
    chat_messages_once(client, target, &cm).await
}

/// Non-streaming chat over a full multi-turn `ChatMessages` (system + a list of
/// user/assistant/tool turns), returning the complete assistant text. This is the
/// one-shot counterpart of [`chat_stream`] and is used by the agentic ("deep")
/// RAG loop, which threads tool results back into the conversation across
/// iterations and needs the whole answer (not a token stream) each turn.
pub async fn chat_messages_once(
    client: &reqwest::Client,
    target: &LlmTarget,
    messages: &ChatMessages<'_>,
) -> Result<String, String> {
    let (url, headers, body) = messages.build(target, false);

    // Transient statuses / connect failures are retried here (spec D1); a
    // non-transient failure or an exhausted ladder surfaces as the usual
    // `LLM error {code}: …` / `LLM unreachable: …` string.
    let resp = send_with_retry(client, &url, &headers, &body, Duration::from_secs(120)).await?;
    let v: Value = resp.json().await.map_err(|e| format!("LLM parse error: {e}"))?;

    let answer = match target.provider.as_str() {
        "anthropic" => v["content"]
            .as_array()
            .and_then(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
                    .into()
            })
            .unwrap_or_default(),
        "openai" | "openrouter" | "openai_compatible" => v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        _ => v["message"]["content"].as_str().unwrap_or("").to_string(),
    };
    Ok(answer)
}

// ── Streaming chat (agent SSE) ────────────────────────────────────────────────

/// Open a streaming chat and return a stream of text deltas (tokens). Each item
/// is either `Ok(token)` or `Err(message)`; the caller maps these onto its own
/// SSE event shape. The stream ends when the provider signals completion.
pub async fn chat_stream(
    client: &reqwest::Client,
    target: &LlmTarget,
    messages: &ChatMessages<'_>,
) -> impl Stream<Item = Result<String, String>> {
    let (url, headers, body) = messages.build(target, true);
    let provider = target.provider.clone();

    // Only the INITIAL send is retried (spec D1): once bytes are flowing a
    // mid-stream failure cannot be replayed without duplicating tokens.
    let resp_result = send_with_retry(client, &url, &headers, &body, Duration::from_secs(120)).await;

    async_stream::stream! {
        let resp = match resp_result {
            Ok(r) => r,
            Err(e) => { yield Err(e); return; }
        };

        let mut bytes = resp.bytes_stream();
        // Buffer across chunk boundaries: provider lines can split mid-line.
        let mut buf = String::new();

        while let Some(chunk) = bytes.next().await {
            let chunk = match chunk {
                Ok(b) => b,
                Err(e) => { yield Err(format!("Stream error: {e}")); return; }
            };
            let Ok(text) = std::str::from_utf8(&chunk) else { continue };
            buf.push_str(text);

            // Process complete lines; keep the trailing partial in `buf`.
            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim().to_string();
                buf.drain(..=nl);
                if line.is_empty() { continue; }

                match provider.as_str() {
                    "anthropic" | "openai" | "openrouter" | "openai_compatible" => {
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let data = data.trim();
                        if data == "[DONE]" { return; }
                        let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                        if provider == "anthropic" {
                            if v["type"].as_str() == Some("content_block_delta") {
                                if let Some(t) = v["delta"]["text"].as_str() {
                                    if !t.is_empty() { yield Ok(t.to_string()); }
                                }
                            }
                            if v["type"].as_str() == Some("message_stop") { return; }
                        } else {
                            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                                if !t.is_empty() { yield Ok(t.to_string()); }
                            }
                            if v["choices"][0]["finish_reason"].is_string() { return; }
                        }
                    }
                    // ollama: newline-delimited JSON objects.
                    _ => {
                        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                        if let Some(t) = v["message"]["content"].as_str() {
                            if !t.is_empty() { yield Ok(t.to_string()); }
                        }
                        if v["done"].as_bool().unwrap_or(false) { return; }
                    }
                }
            }
        }
    }
}

/// Pure helper: given the active runtime's provider, base URL, and the configured
/// embedding mode, decide whether to redirect embeddings to the bundled llama.cpp
/// embed sidecar.
///
/// Returns `Some((provider, base_url, model))` ONLY when:
///   - runtime is `openai_compatible`
///   - the runtime base points at the bundled `gctrl-llamacpp` (host `gctrl-llamacpp`)
///   - embedding_mode is `"pinned"`
///
/// In that case embeddings are redirected to the embed sidecar at port 8081
/// (nomic-embed-text, dim 768 — same as the Ollama default, so existing vectors
/// remain valid and no reindex is needed).
///
/// Returns `None` for all other cases:
///   - external openai_compatible endpoints: no guarantee they serve nomic-embed-text
///   - ollama runtime: embeddings stay on Ollama as today
///   - advanced mode: caller handles this via the admin reindex path
pub fn pinned_embedding_override(
    runtime_provider: &str,
    runtime_base: &str,
    embedding_mode: &str,
) -> Option<(&'static str, &'static str, &'static str)> {
    if embedding_mode != "pinned" {
        return None;
    }
    if runtime_provider != "openai_compatible" {
        return None;
    }
    // Detect the bundled llama.cpp by hostname: the base must be
    // http://gctrl-llamacpp:8080 (exact host, any trailing slash).
    let base = runtime_base.trim_end_matches('/');
    let is_bundled = url::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h == "gctrl-llamacpp"))
        .unwrap_or(false);
    if !is_bundled {
        return None;
    }
    Some(("openai_compatible", "http://gctrl-llamacpp-embed:8081", "nomic-embed-text"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_base_per_provider() {
        assert_eq!(default_base("openai"), "https://api.openai.com");
        assert_eq!(default_base("openrouter"), "https://openrouter.ai/api");
        assert_eq!(default_base("anthropic"), "https://api.anthropic.com");
    }

    #[test]
    fn openai_body_has_bearer_and_system() {
        let t = LlmTarget {
            provider: "openai".into(),
            model: "gpt-4o-mini".into(),
            base_url: None,
            api_key: Some("sk-x".into()),
        };
        let cm = ChatMessages { system: "sys", messages: vec![json!({"role":"user","content":"hi"})] };
        let (url, headers, body) = cm.build(&t, true);
        assert_eq!(url, "https://api.openai.com/v1/chat/completions");
        assert!(headers.iter().any(|(k, v)| k == "authorization" && v == "Bearer sk-x"));
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn anthropic_splits_system_and_sets_headers() {
        let t = LlmTarget {
            provider: "anthropic".into(),
            model: "claude-3-5-sonnet".into(),
            base_url: None,
            api_key: Some("k".into()),
        };
        let cm = ChatMessages { system: "sys", messages: vec![json!({"role":"user","content":"hi"})] };
        let (url, headers, body) = cm.build(&t, false);
        assert_eq!(url, "https://api.anthropic.com/v1/messages");
        assert!(headers.iter().any(|(k, _)| k == "x-api-key"));
        assert!(headers.iter().any(|(k, v)| k == "anthropic-version" && v == "2023-06-01"));
        assert_eq!(body["system"], "sys");
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body["max_tokens"].is_number());
    }

    #[test]
    fn validate_cloud_rejects_arbitrary_base() {
        // SSRF: arbitrary host (e.g. cloud metadata IP) must be rejected for cloud.
        assert!(validate_llm_base("openai", Some("http://169.254.169.254")).is_err());
        assert!(validate_llm_base("anthropic", Some("https://evil.example.com")).is_err());
        // file://, gopher:// etc → rejected.
        assert!(validate_llm_base("openai", Some("file:///etc/passwd")).is_err());
    }

    #[test]
    fn validate_cloud_pins_official_host() {
        // No base → official base.
        assert_eq!(
            validate_llm_base("openai", None).unwrap().as_str(),
            "https://api.openai.com/"
        );
        // Official host over https is accepted and canonicalized.
        assert_eq!(
            validate_llm_base("anthropic", Some("https://api.anthropic.com")).unwrap().host_str(),
            Some("api.anthropic.com")
        );
        assert_eq!(
            validate_llm_base("openrouter", None).unwrap().host_str(),
            Some("openrouter.ai")
        );
    }

    #[test]
    fn validate_ollama_allows_local_lan() {
        // The whole point of Ollama: loopback + LAN must work.
        assert!(validate_llm_base("ollama", Some("http://localhost:11434")).is_ok());
        assert!(validate_llm_base("ollama", Some("http://10.0.0.5:11434")).is_ok());
        assert!(validate_llm_base("ollama", Some("http://ollama:11434")).is_ok());
        // No base → OLLAMA_BASE default.
        assert!(validate_llm_base("ollama", None).is_ok());
    }

    #[test]
    fn validate_ollama_rejects_dangerous() {
        // Non-http(s) schemes and embedded credentials are rejected even for ollama.
        assert!(validate_llm_base("ollama", Some("file:///etc/passwd")).is_err());
        assert!(validate_llm_base("ollama", Some("gopher://localhost")).is_err());
        assert!(validate_llm_base("ollama", Some("http://user:pass@localhost:11434")).is_err());
        assert!(validate_llm_base("ollama", Some("not a url")).is_err());
    }

    #[test]
    fn custom_base_url_overrides_default() {
        let t = LlmTarget {
            provider: "ollama".into(),
            model: "llama3.2".into(),
            base_url: Some("http://ollama:11434".into()),
            api_key: None,
        };
        let cm = ChatMessages { system: "s", messages: vec![] };
        let (url, _, _) = cm.build(&t, true);
        assert_eq!(url, "http://ollama:11434/api/chat");
    }

    // ── openai_compatible tests ───────────────────────────────────────────────

    /// Local and LAN bases must be accepted (same rules as Ollama).
    #[test]
    fn validate_openai_compatible_allows_local_lan() {
        assert!(validate_llm_base("openai_compatible", Some("http://localhost:8080/v1")).is_ok());
        assert!(validate_llm_base("openai_compatible", Some("http://127.0.0.1:8080")).is_ok());
        assert!(validate_llm_base("openai_compatible", Some("http://10.0.0.5:8080")).is_ok());
        assert!(validate_llm_base("openai_compatible", Some("http://llama:8080")).is_ok());
        assert!(validate_llm_base("openai_compatible", Some("https://myserver.internal:8443")).is_ok());
    }

    /// Embedded credentials must be rejected (Ollama-style SSRF rule).
    #[test]
    fn validate_openai_compatible_rejects_embedded_creds() {
        assert!(validate_llm_base("openai_compatible", Some("http://u:p@host/v1")).is_err());
        assert!(validate_llm_base("openai_compatible", Some("http://user:pass@localhost:8080")).is_err());
    }

    /// Non-http(s) schemes must be rejected.
    #[test]
    fn validate_openai_compatible_rejects_bad_scheme() {
        assert!(validate_llm_base("openai_compatible", Some("file:///etc/passwd")).is_err());
        assert!(validate_llm_base("openai_compatible", Some("gopher://localhost")).is_err());
    }

    // ── SSRF metadata denylist tests ─────────────────────────────────────────

    /// 169.254.169.254 (AWS/GCP/Azure metadata) must be blocked for openai_compatible.
    #[test]
    fn validate_metadata_ip_blocked_openai_compatible() {
        assert!(
            validate_llm_base("openai_compatible", Some("http://169.254.169.254")).is_err(),
            "169.254.169.254 must be blocked"
        );
    }

    /// Any address in 169.254.0.0/16 link-local range must be blocked.
    #[test]
    fn validate_metadata_link_local_range_blocked() {
        assert!(
            validate_llm_base("openai_compatible", Some("http://169.254.10.5")).is_err(),
            "169.254.10.5 (link-local range) must be blocked"
        );
        assert!(
            validate_llm_base("openai_compatible", Some("http://169.254.0.1")).is_err(),
            "169.254.0.1 (link-local range) must be blocked"
        );
    }

    /// 100.100.100.200 (Alibaba Cloud metadata) must be blocked.
    #[test]
    fn validate_metadata_alibaba_blocked() {
        assert!(
            validate_llm_base("openai_compatible", Some("http://100.100.100.200")).is_err(),
            "100.100.100.200 (Alibaba metadata) must be blocked"
        );
    }

    /// IPv6 AWS metadata endpoint must be blocked.
    #[test]
    fn validate_metadata_ipv6_aws_blocked() {
        // URL parsing of bare IPv6 requires brackets per RFC 2732.
        // Note: url::Url::host_str() returns IPv6 with brackets ("[fd00:ec2::254]")
        // which is handled by is_metadata_host stripping them before Ipv6Addr parsing.
        assert!(
            validate_llm_base("openai_compatible", Some("http://[fd00:ec2::254]")).is_err(),
            "fd00:ec2::254 (AWS IPv6 metadata) must be blocked"
        );
    }

    /// Normal localhost and LAN addresses must continue to work (not blocked by denylist).
    #[test]
    fn validate_metadata_allows_normal_local_lan() {
        assert!(
            validate_llm_base("openai_compatible", Some("http://localhost:8080/v1")).is_ok(),
            "localhost must be allowed"
        );
        assert!(
            validate_llm_base("openai_compatible", Some("http://192.168.1.50:11434")).is_ok(),
            "192.168.x (LAN) must be allowed"
        );
        assert!(
            validate_llm_base("ollama", Some("http://192.168.1.50:11434")).is_ok(),
            "ollama on LAN must be allowed"
        );
        // Also test same for ollama provider
        assert!(
            validate_llm_base("ollama", Some("http://169.254.169.254")).is_err(),
            "ollama provider must also block 169.254.169.254"
        );
    }

    /// build() for openai_compatible must POST to {base}/v1/chat/completions.
    /// When an api_key is set, it must send Authorization: Bearer.
    /// When api_key is absent/empty, no Authorization header.
    #[test]
    fn openai_compatible_build_with_key() {
        let t = LlmTarget {
            provider: "openai_compatible".into(),
            model: "m".into(),
            base_url: Some("http://x:9/v1".into()),
            api_key: Some("mykey".into()),
        };
        let cm = ChatMessages {
            system: "sys",
            messages: vec![json!({"role": "user", "content": "hi"})],
        };
        let (url, headers, body) = cm.build(&t, false);
        assert_eq!(url, "http://x:9/v1/chat/completions");
        assert!(
            headers.iter().any(|(k, v)| k == "authorization" && v == "Bearer mykey"),
            "expected Bearer header when api_key is set; got: {:?}", headers
        );
        assert_eq!(body["model"], "m");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn openai_compatible_build_no_key_omits_auth_header() {
        let t = LlmTarget {
            provider: "openai_compatible".into(),
            model: "m".into(),
            base_url: Some("http://x:9/v1".into()),
            api_key: None,
        };
        let cm = ChatMessages { system: "s", messages: vec![] };
        let (url, headers, body) = cm.build(&t, true);
        assert_eq!(url, "http://x:9/v1/chat/completions");
        assert!(
            !headers.iter().any(|(k, _)| k == "authorization"),
            "no Authorization header expected when api_key is None; got: {:?}", headers
        );
        assert_eq!(body["stream"], true);
    }

    /// Empty string api_key must also omit the header (treat same as None).
    #[test]
    fn openai_compatible_build_empty_key_omits_auth_header() {
        let t = LlmTarget {
            provider: "openai_compatible".into(),
            model: "m".into(),
            base_url: Some("http://x:9/v1".into()),
            api_key: Some("".into()),
        };
        let cm = ChatMessages { system: "s", messages: vec![] };
        let (_, headers, _) = cm.build(&t, false);
        assert!(
            !headers.iter().any(|(k, _)| k == "authorization"),
            "no Authorization header expected for empty api_key; got: {:?}", headers
        );
    }

    /// Container host rewrite: localhost → host.docker.internal inside Docker.
    /// Outside Docker (no /.dockerenv) this is a no-op — just confirm the function
    /// passes through the URL unchanged in the test environment.
    #[test]
    fn containerize_passthrough_outside_docker() {
        // In CI/dev (no /.dockerenv) the rewrite is skipped — just verify it
        // doesn't corrupt the URL.
        let out = containerize_ollama_base("http://localhost:8080/v1");
        assert!(out == "http://localhost:8080/v1" || out == "http://host.docker.internal:8080/v1",
            "unexpected result: {out}");
    }

    /// official_cloud_host must return None for openai_compatible so it falls into
    /// the local/LAN branch in validate_llm_base (not the cloud-pinned branch).
    #[test]
    fn openai_compatible_not_a_cloud_host() {
        assert!(official_cloud_host("openai_compatible").is_none());
    }

    /// When base_url is None for openai_compatible, validate_llm_base falls through
    /// to ollama_default_base() — that's the existing code path for unknown providers.
    /// We document this here: the API layer (routes/llm.rs upsert_provider) does NOT
    /// enforce a non-null base for openai_compatible at DB write time (it simply
    /// stores NULL when none is supplied), so a NULL-base openai_compatible row would
    /// resolve to the Ollama default at runtime. This is accepted behaviour — the
    /// Settings UI must require a base_url for openai_compatible. The test confirms
    /// the function doesn't panic or error on a None base.
    #[test]
    fn openai_compatible_none_base_falls_back_to_ollama_default() {
        let result = validate_llm_base("openai_compatible", None);
        assert!(result.is_ok(), "should not error; got: {:?}", result);
    }

    // ── choose_fallback_target (pure, no DB) ─────────────────────────────────

    /// When no global config is set, the fallback is the bundled Ollama default.
    #[test]
    fn fallback_none_global_gives_ollama_default() {
        let t = choose_fallback_target(None, None);
        assert_eq!(t.provider, "ollama");
        assert_eq!(t.model, "llama3.2");
        assert!(t.base_url.is_none());
        assert!(t.api_key.is_none());
    }

    /// A global config with a provider overrides the Ollama default.
    #[test]
    fn fallback_global_config_beats_ollama_default() {
        let global = Some((
            "openai_compatible".to_string(),
            Some("http://localhost:8080".to_string()),
            Some("qwen2.5:7b".to_string()),
            None,
        ));
        let t = choose_fallback_target(global, None);
        assert_eq!(t.provider, "openai_compatible");
        assert_eq!(t.model, "qwen2.5:7b");
        assert_eq!(t.base_url.as_deref(), Some("http://localhost:8080"));
    }

    /// A requested_model overrides the model stored in the global config.
    #[test]
    fn fallback_requested_model_overrides_config_model() {
        let global = Some((
            "openai_compatible".to_string(),
            Some("http://localhost:8080".to_string()),
            Some("qwen2.5:7b".to_string()),
            None,
        ));
        let t = choose_fallback_target(global, Some("mistral:latest"));
        assert_eq!(t.model, "mistral:latest");
    }

    /// When global config has no model, the provider default is used.
    #[test]
    fn fallback_global_no_model_uses_provider_default() {
        let global = Some((
            "openai_compatible".to_string(),
            Some("http://localhost:8080".to_string()),
            None, // no model stored
            None,
        ));
        let t = choose_fallback_target(global, None);
        // openai_compatible falls to the ollama-path default_model_for → "llama3.2"
        assert!(!t.model.is_empty());
    }

    /// requested_model override on the None-global path (Ollama).
    #[test]
    fn fallback_none_global_with_requested_model() {
        let t = choose_fallback_target(None, Some("codellama:13b"));
        assert_eq!(t.provider, "ollama");
        assert_eq!(t.model, "codellama:13b");
    }

    /// A global config with an invalid base_url (SSRF guard) silently drops the
    /// base so the resolved target has None rather than an unsafe URL.
    #[test]
    fn fallback_invalid_base_is_dropped() {
        let global = Some((
            "openai_compatible".to_string(),
            Some("not-a-url!!".to_string()),
            Some("m".to_string()),
            None,
        ));
        let t = choose_fallback_target(global, None);
        assert!(
            t.base_url.is_none(),
            "invalid base should be dropped; got: {:?}",
            t.base_url
        );
    }

    // ── openai_compat_root / same_openai_root (spec D4) ───────────────────────

    /// The probe, chat and worker URLs are all built from this root, so both
    /// operator spellings must fold to the same value (Asgard: `…:8020/v1`
    /// probed `/v1/v1/models`).
    #[test]
    fn openai_compat_root_folds_v1_and_trailing_slash() {
        assert_eq!(openai_compat_root("http://x:8020"), "http://x:8020");
        assert_eq!(openai_compat_root("http://x:8020/"), "http://x:8020");
        assert_eq!(openai_compat_root("http://x:8020/v1"), "http://x:8020");
        assert_eq!(openai_compat_root("http://x:8020/v1/"), "http://x:8020");
        assert_eq!(openai_compat_root("  http://x:8020/v1  "), "http://x:8020");
    }

    /// Exactly ONE `/v1` is stripped: a deliberately nested prefix survives.
    #[test]
    fn openai_compat_root_strips_only_one_v1() {
        assert_eq!(openai_compat_root("http://x/v1/v1"), "http://x/v1");
        assert_eq!(openai_compat_root("http://x/api/v1"), "http://x/api");
        // `/v10` is not `/v1`.
        assert_eq!(openai_compat_root("http://x/v10"), "http://x/v10");
    }

    #[test]
    fn same_openai_root_matches_across_spellings() {
        assert!(same_openai_root("http://mac:8020", "http://mac:8020/v1"));
        assert!(same_openai_root("http://mac:8020/v1/", "http://MAC:8020"));
        assert!(!same_openai_root("http://mac:8020", "http://mac:8021"));
        assert!(!same_openai_root("http://mac:8020", "http://other:8020/v1"));
        assert!(!same_openai_root("", ""));
    }

    // ── transient contract (spec D1) ─────────────────────────────────────────

    #[test]
    fn transient_statuses_are_the_spec_set() {
        for c in [408u16, 409, 425, 429, 502, 503, 504, 507] {
            assert!(is_transient_status(c), "{c} must be transient");
        }
        for c in [200u16, 400, 401, 403, 404, 422, 500, 501] {
            assert!(!is_transient_status(c), "{c} must NOT be transient");
        }
    }

    #[test]
    fn retry_policy_defaults_and_parsing() {
        assert_eq!(retry_policy(None, None), RetryPolicy { max_retries: 5, base_ms: 1000 });
        assert_eq!(retry_policy(Some("3"), Some("250")), RetryPolicy { max_retries: 3, base_ms: 250 });
        // Garbage / zero → defaults; a huge max is capped at 10.
        assert_eq!(retry_policy(Some("x"), Some("0")), RetryPolicy { max_retries: 5, base_ms: 1000 });
        assert_eq!(retry_policy(Some("99"), None).max_retries, 10);
        assert_eq!(retry_policy(Some("0"), None).max_retries, 0);
    }

    /// Ladder `1, 2, 4, 8, 16 s`, `Retry-After` wins, everything capped at 30 s.
    #[test]
    fn retry_delay_ladder_retry_after_and_cap() {
        let secs: Vec<u64> = (0..5).map(|a| retry_delay(a, 1000, None).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16]);
        assert_eq!(retry_delay(0, 1000, Some(7)).as_secs(), 7);
        assert_eq!(retry_delay(9, 1000, None).as_secs(), 30, "ladder capped at 30 s");
        assert_eq!(retry_delay(0, 1000, Some(3600)).as_secs(), 30, "Retry-After capped at 30 s");
        assert_eq!(retry_delay(0, 250, None).as_millis(), 250);
        // No overflow on absurd attempt counts.
        assert_eq!(retry_delay(u32::MAX, 1000, None).as_secs(), 30);
    }

    // ── thinking switch (spec D3) ────────────────────────────────────────────

    #[test]
    fn env_truthy_spellings() {
        for v in ["1", "true", "TRUE", "yes", " on "] {
            assert!(env_truthy(Some(v)), "{v:?} must be truthy");
        }
        for v in ["0", "false", "", "no", "off", "maybe"] {
            assert!(!env_truthy(Some(v)), "{v:?} must be falsy");
        }
        assert!(!env_truthy(None));
    }

    fn compat_target() -> LlmTarget {
        LlmTarget {
            provider: "openai_compatible".into(),
            model: "qwen3.6-35b-a3b".into(),
            base_url: Some("http://mac:8020/v1".into()),
            api_key: Some("k".into()),
        }
    }

    #[test]
    fn openai_compatible_body_disables_thinking_by_default() {
        let cm = ChatMessages { system: "s", messages: vec![] };
        let (url, _, body) = cm.build_with_think(&compat_target(), false, false);
        assert_eq!(url, "http://mac:8020/v1/chat/completions");
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], json!(false));
    }

    #[test]
    fn openai_compatible_body_enables_thinking_when_asked() {
        let cm = ChatMessages { system: "s", messages: vec![] };
        let (_, _, body) = cm.build_with_think(&compat_target(), true, true);
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], json!(true));
        assert_eq!(body["stream"], true);
    }

    /// Only the `/v1` dialect carries the kwarg — Ollama has its own `think`
    /// field and cloud APIs reject unknown top-level keys.
    #[test]
    fn thinking_kwarg_is_openai_compatible_only() {
        let cm = ChatMessages { system: "s", messages: vec![] };
        for provider in ["ollama", "openai", "anthropic", "openrouter"] {
            let t = LlmTarget { provider: provider.into(), model: "m".into(), base_url: None, api_key: Some("k".into()) };
            let (_, _, body) = cm.build_with_think(&t, false, false);
            assert!(body.get("chat_template_kwargs").is_none(), "{provider} must not carry chat_template_kwargs");
        }
    }

    // ── worker key selection (spec D7/D8) ────────────────────────────────────

    #[test]
    fn pick_worker_key_prefers_runtime_key_on_same_server() {
        let k = pick_worker_key("http://mac:8020", None, Some("http://mac:8020/v1"), Some("rt-key"));
        assert_eq!(k.as_deref(), Some("rt-key"));
        // Same server but the target has its own key and the runtime none → target's.
        let k = pick_worker_key("http://mac:8020", Some("own"), Some("http://mac:8020"), None);
        assert_eq!(k.as_deref(), Some("own"));
    }

    #[test]
    fn pick_worker_key_never_leaks_runtime_key_to_another_server() {
        let k = pick_worker_key("http://other:9000", None, Some("http://mac:8020"), Some("rt-key"));
        assert!(k.is_none(), "runtime key must not travel to a different server; got {k:?}");
        let k = pick_worker_key("http://other:9000", Some(" "), None, Some("rt-key"));
        assert!(k.is_none());
        let k = pick_worker_key("http://other:9000", Some("own"), Some("http://mac:8020"), Some("rt-key"));
        assert_eq!(k.as_deref(), Some("own"));
    }

    /// `generation_base` is the canonical root and `generation_max_concurrency`
    /// rides along (spec D2) — the key still never does.
    #[test]
    fn apply_gen_overrides_canonical_base_and_max_concurrency() {
        let mut map = serde_json::Map::new();
        apply_generation_overrides(&compat_target(), 2, &mut map);
        assert_eq!(map["generation_base"], json!("http://mac:8020"));
        assert_eq!(map["generation_max_concurrency"], json!(2));
        assert!(!map.contains_key("generation_api_key"));
        // A nonsensical value is floored at 1 so a worker never builds a 0-slot semaphore.
        let mut map = serde_json::Map::new();
        apply_generation_overrides(&compat_target(), 0, &mut map);
        assert_eq!(map["generation_max_concurrency"], json!(1));
    }

    // ── apply_generation_overrides (pure, no DB) ─────────────────────────────

    /// openai_compatible → generation_kind, generation_base, generation_model injected;
    /// generation_api_key must NOT be present (no plaintext secrets in Redis).
    #[test]
    fn apply_gen_overrides_injects_for_openai_compatible() {
        let t = LlmTarget {
            provider: "openai_compatible".into(),
            model: "qwen2.5:7b".into(),
            base_url: Some("http://localhost:8080".into()),
            api_key: Some("mykey".into()),
        };
        let mut map = serde_json::Map::new();
        apply_generation_overrides(&t, 4, &mut map);
        assert_eq!(map["generation_kind"], json!("openai_compatible"));
        assert_eq!(map["generation_model"], json!("qwen2.5:7b"));
        assert!(map.contains_key("generation_base"), "generation_base must be set");
        // Security: decrypted API key must never enter the Redis worker payload.
        assert!(
            !map.contains_key("generation_api_key"),
            "generation_api_key must NOT be in worker payload; got: {:?}", map.get("generation_api_key")
        );
    }

    /// ollama → no generation_* fields injected (backward compatible).
    #[test]
    fn apply_gen_overrides_noop_for_ollama() {
        let t = LlmTarget {
            provider: "ollama".into(),
            model: "llama3.2".into(),
            base_url: None,
            api_key: None,
        };
        let mut map = serde_json::Map::new();
        map.insert("ollama_base".into(), json!("http://ollama:11434"));
        apply_generation_overrides(&t, 4, &mut map);
        assert!(!map.contains_key("generation_kind"), "ollama must not inject generation_kind");
        assert!(!map.contains_key("generation_base"));
        assert!(!map.contains_key("generation_model"));
        assert!(!map.contains_key("generation_api_key"));
        // ollama_base untouched
        assert_eq!(map["ollama_base"], json!("http://ollama:11434"));
    }

    /// openai provider → no generation_* injected (cloud out of scope).
    #[test]
    fn apply_gen_overrides_noop_for_openai() {
        let t = LlmTarget {
            provider: "openai".into(),
            model: "gpt-4o-mini".into(),
            base_url: None,
            api_key: Some("sk-x".into()),
        };
        let mut map = serde_json::Map::new();
        apply_generation_overrides(&t, 4, &mut map);
        assert!(!map.contains_key("generation_kind"));
    }

    /// anthropic provider → no generation_* injected (cloud out of scope).
    #[test]
    fn apply_gen_overrides_noop_for_anthropic() {
        let t = LlmTarget {
            provider: "anthropic".into(),
            model: "claude-3-5-sonnet-20241022".into(),
            base_url: None,
            api_key: Some("k".into()),
        };
        let mut map = serde_json::Map::new();
        apply_generation_overrides(&t, 4, &mut map);
        assert!(!map.contains_key("generation_kind"));
    }

    /// generation_api_key is never injected regardless of the key value —
    /// security policy: no plaintext secret in Redis worker payload.
    #[test]
    fn apply_gen_overrides_never_injects_api_key_even_when_set() {
        let t = LlmTarget {
            provider: "openai_compatible".into(),
            model: "m".into(),
            base_url: Some("http://x:9".into()),
            api_key: Some("real-key".into()),
        };
        let mut map = serde_json::Map::new();
        apply_generation_overrides(&t, 4, &mut map);
        assert!(
            !map.contains_key("generation_api_key"),
            "generation_api_key must NEVER enter the Redis payload; got: {:?}", map.get("generation_api_key")
        );
        // The non-secret fields ARE there.
        assert!(map.contains_key("generation_kind"));
        assert!(map.contains_key("generation_base"));
        assert!(map.contains_key("generation_model"));
    }

    /// generation_api_key is never injected when api_key is None.
    #[test]
    fn apply_gen_overrides_omits_none_api_key() {
        let t = LlmTarget {
            provider: "openai_compatible".into(),
            model: "m".into(),
            base_url: Some("http://x:9".into()),
            api_key: None,
        };
        let mut map = serde_json::Map::new();
        apply_generation_overrides(&t, 4, &mut map);
        assert!(!map.contains_key("generation_api_key"));
    }

    // ── pinned_embedding_override ────────────────────────────────────────────

    #[test]
    fn pinned_embed_bundled_llamacpp_returns_sidecar() {
        let result = pinned_embedding_override(
            "openai_compatible",
            "http://gctrl-llamacpp:8080",
            "pinned",
        );
        assert!(result.is_some(), "bundled llamacpp should redirect embeddings to sidecar");
        let (prov, base, model) = result.unwrap();
        // Provider string is "openai_compatible" for consistency with the LLM runtime.
        assert_eq!(prov, "openai_compatible");
        assert_eq!(base, "http://gctrl-llamacpp-embed:8081");
        assert_eq!(model, "nomic-embed-text");
    }

    #[test]
    fn pinned_embed_external_endpoint_returns_none() {
        // External openai_compatible endpoint: don't assume it serves nomic-embed-text
        let result = pinned_embedding_override(
            "openai_compatible",
            "http://myserver.example.com:8080",
            "pinned",
        );
        assert!(result.is_none(), "external endpoint must return None (safe fallback)");
    }

    #[test]
    fn pinned_embed_ollama_runtime_returns_none() {
        let result = pinned_embedding_override("ollama", "http://ollama:11434", "pinned");
        assert!(result.is_none(), "ollama runtime never redirects embeddings");
    }

    #[test]
    fn pinned_embed_advanced_mode_returns_none() {
        // advanced mode is handled by the admin re-index path, not this helper
        let result = pinned_embedding_override(
            "openai_compatible",
            "http://gctrl-llamacpp:8080",
            "advanced",
        );
        assert!(result.is_none(), "advanced mode must return None from this helper");
    }

    #[test]
    fn pinned_embed_llamacpp_trailing_slash_also_matches() {
        // base may arrive with trailing slash from DB
        let result = pinned_embedding_override(
            "openai_compatible",
            "http://gctrl-llamacpp:8080/",
            "pinned",
        );
        assert!(result.is_some(), "trailing slash should still match bundled llamacpp");
    }

    #[test]
    fn key_for_base_only_for_same_server() {
        let key = || Some("k".to_string());
        assert_eq!(key_for_base(Some("http://mac:8020/v1"), key(), Some("http://mac:8020")), key());
        assert_eq!(key_for_base(Some("http://mac:8020"), key(), Some("http://MAC:8020/v1/")), key());
        assert_eq!(key_for_base(Some("http://mac:8020"), key(), Some("http://other:8020")), None);
        assert_eq!(key_for_base(None, key(), Some("http://mac:8020")), None);
        assert_eq!(key_for_base(Some("http://mac:8020"), key(), None), None);
        assert_eq!(key_for_base(Some("http://mac:8020"), None, Some("http://mac:8020")), None);
    }
}

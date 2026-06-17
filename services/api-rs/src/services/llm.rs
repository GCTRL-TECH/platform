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
        Ok(u)
    }
}

impl LlmTarget {
    /// Resolve the base URL to actually hit, re-validating the stored `base_url`
    /// against [`validate_llm_base`] at REQUEST time. This is the second line of
    /// defense: even if a malicious `base_url` row somehow bypassed write-time
    /// validation, cloud providers are forced back to their official host and an
    /// invalid Ollama base falls back to the default — so the server never
    /// performs an attacker-chosen fetch for cloud providers.
    fn base(&self) -> String {
        let candidate = self
            .base_url
            .clone()
            .filter(|s| !s.trim().is_empty());
        match validate_llm_base(&self.provider, candidate.as_deref()) {
            Ok(u) => u.as_str().trim_end_matches('/').to_string(),
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
/// 3. Otherwise the local Ollama default (no key).
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
        // No connected provider — local Ollama default.
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
        Ok(u) => Some(u.as_str().trim_end_matches('/').to_string()),
        Err(_) => None,
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
    let prefs: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT embedding_model, embedding_provider, embedding_base_url, relation_model
             FROM user_model_prefs WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    let (emb_model, emb_provider, emb_base_pref, rel_model) =
        prefs.unwrap_or((None, None, None, None));
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
        if let Some(m) = nz(rel_model) {
            map.insert("relex_model".into(), json!(m));
        }
    }
}

/// Resolve the wiki-distillation overrides for a user: the chosen distill model
/// (Settings → AI Models → Models, `user_model_prefs.distill_model`) and the
/// runtime Ollama base. Either is `None` when unset, so the FUSE distiller falls
/// back to its env defaults (`GCTRL_DISTILL_MODEL` / `OLLAMA_BASE`) and existing
/// installs are untouched.
pub async fn resolve_distill_overrides(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
) -> (Option<String>, Option<String>) {
    let distill_model: Option<String> = sqlx::query_scalar(
        "SELECT distill_model FROM user_model_prefs WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .map(|s: String| s.trim().to_string())
    .filter(|s| !s.is_empty());

    let ollama_base = resolve_ollama_base_for_user(db, user_id).await;
    (distill_model, ollama_base)
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

impl<'a> ChatMessages<'a> {
    /// Build the request URL, headers, and JSON body for `target`, with `stream`.
    fn build(&self, target: &LlmTarget, stream: bool) -> (String, Vec<(String, String)>, Value) {
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

    let req = apply_headers(client.post(&url), &headers)
        .json(&body)
        .timeout(Duration::from_secs(120));

    let resp = req.send().await.map_err(|e| format!("LLM unreachable: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM error {code}: {}", text.chars().take(300).collect::<String>()));
    }
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
        "openai" | "openrouter" => v["choices"][0]["message"]["content"]
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

    let resp_result = apply_headers(client.post(&url), &headers)
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await;

    async_stream::stream! {
        let resp = match resp_result {
            Ok(r) => r,
            Err(e) => { yield Err(format!("LLM unreachable: {e}")); return; }
        };
        if !resp.status().is_success() {
            let code = resp.status();
            let text = resp.text().await.unwrap_or_default();
            yield Err(format!("LLM error {code}: {}", text.chars().take(300).collect::<String>()));
            return;
        }

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
                    "anthropic" | "openai" | "openrouter" => {
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
}

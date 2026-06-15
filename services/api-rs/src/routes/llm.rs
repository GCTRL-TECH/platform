//! Per-user LLM provider management (`/api/llm`).
//!
//! Lets each user connect their own Ollama / OpenAI / Anthropic / OpenRouter
//! credentials. Cloud keys are encrypted at rest via `services/crypto.rs` and are
//! never returned to the client (masked/omitted on read). The Pi agent and the
//! Talk-to-Graph RAG endpoint resolve a target from these rows at request time
//! (see `services::llm::resolve_for_user`).
//!
//! ## Routes (mounted under `/api/llm`)
//!
//! - `GET    /providers`              → list the user's connections (key omitted/masked)
//! - `PUT    /providers`              → upsert `{ provider, apiKey?, baseUrl?, defaultModel?, isActive? }`
//! - `DELETE /providers/:provider`    → disconnect a provider
//! - `POST   /providers/:provider/test` → make a tiny real call, return ok/error
//! - `GET    /models`                 → Ollama tags + curated cloud models for connected providers

use axum::{
    extract::{Extension, Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
};

const PROVIDERS: &[&str] = &["ollama", "openai", "anthropic", "openrouter"];

/// Curated model lists surfaced for a connected cloud provider. (We avoid live
/// `/models` calls here to keep `GET /models` fast and key-safe; the picker only
/// needs sensible defaults, and users can still type any model server-side.)
fn curated_models(provider: &str) -> &'static [&'static str] {
    match provider {
        "openai" => &["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
        "anthropic" => &[
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
        ],
        "openrouter" => &[
            "meta-llama/llama-3.3-70b-instruct",
            "qwen/qwen-2.5-72b-instruct",
            "google/gemini-2.0-flash-001",
            "anthropic/claude-3.5-sonnet",
        ],
        _ => &[],
    }
}

fn is_valid_provider(p: &str) -> bool {
    PROVIDERS.contains(&p)
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/providers", get(list_providers).put(upsert_provider))
        .route("/providers/:provider", axum::routing::delete(delete_provider))
        .route("/providers/:provider/test", post(test_provider))
        .route("/models", get(list_models))
}

// ── GET /providers ────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ProviderRow {
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
    default_model: Option<String>,
    is_active: bool,
}

/// List the user's provider connections. The stored key is never returned — we
/// only expose a `connected` flag (true when a non-empty key is present, or for
/// Ollama which needs no key).
async fn list_providers(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows: Vec<ProviderRow> = sqlx::query_as(
        "SELECT provider, api_key, base_url, default_model, is_active
         FROM user_llm_providers WHERE user_id = $1",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let providers: Vec<Value> = PROVIDERS
        .iter()
        .map(|id| {
            let row = rows.iter().find(|r| r.provider == *id);
            let has_key = row
                .and_then(|r| r.api_key.as_deref())
                .map(|k| !crate::services::crypto::open(k).trim().is_empty())
                .unwrap_or(false);
            // Ollama is "connected" whenever a row exists and is active (no key needed).
            let connected = match *id {
                "ollama" => row.is_some_and(|r| r.is_active),
                _ => has_key && row.is_some_and(|r| r.is_active),
            };
            json!({
                "provider":     id,
                "connected":    connected,
                "isActive":     row.is_some_and(|r| r.is_active),
                "baseUrl":      row.and_then(|r| r.base_url.clone()),
                "defaultModel": row.and_then(|r| r.default_model.clone()),
                "hasKey":       has_key,
            })
        })
        .collect();

    Ok(Json(json!({ "providers": providers })))
}

// ── PUT /providers ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct UpsertReq {
    provider: String,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    #[serde(rename = "defaultModel")]
    default_model: Option<String>,
    #[serde(rename = "isActive")]
    is_active: Option<bool>,
}

/// Upsert a provider connection. The `apiKey`, if present and non-empty, is sealed
/// via `crypto::seal`; if omitted the existing stored key is preserved (so a user
/// can change base_url/model without re-entering the key).
async fn upsert_provider(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<UpsertReq>,
) -> Result<Json<Value>> {
    let provider = req.provider.trim().to_lowercase();
    if !is_valid_provider(&provider) {
        return Err(AppError::BadRequest(format!("Unsupported provider '{provider}'")));
    }

    let sealed_key: Option<String> = req
        .api_key
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(crate::services::crypto::seal);

    // SSRF guard (SEC-1): validate any user-supplied base_url at write time.
    // For cloud providers an arbitrary base_url is rejected/ignored (pinned to the
    // official host); for Ollama we allow local/LAN but constrain scheme/host and
    // reject embedded credentials. We persist the CANONICAL base returned by the
    // validator so a cloud row can never carry an attacker IP as metadata.
    let raw_base = req.base_url.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let canonical_base: Option<String> = match raw_base {
        Some(_) => {
            let url = crate::services::llm::validate_llm_base(&provider, raw_base)
                .map_err(AppError::BadRequest)?;
            Some(url.as_str().trim_end_matches('/').to_string())
        }
        // No base supplied → leave it NULL so resolve_for_user uses the default.
        None => None,
    };
    let base_url = canonical_base.as_deref();
    let default_model = req.default_model.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let is_active = req.is_active.unwrap_or(true);

    // COALESCE on api_key so omitting it preserves the stored key on update.
    sqlx::query(
        "INSERT INTO user_llm_providers (user_id, provider, api_key, base_url, default_model, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, provider) DO UPDATE SET
            api_key       = COALESCE($3, user_llm_providers.api_key),
            base_url      = COALESCE($4, user_llm_providers.base_url),
            default_model = COALESCE($5, user_llm_providers.default_model),
            is_active     = $6",
    )
    .bind(claims.sub)
    .bind(&provider)
    .bind(sealed_key)
    .bind(base_url)
    .bind(default_model)
    .bind(is_active)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true, "provider": provider })))
}

// ── DELETE /providers/:provider ───────────────────────────────────────────────

async fn delete_provider(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(provider): Path<String>,
) -> Result<Json<Value>> {
    let provider = provider.trim().to_lowercase();
    if !is_valid_provider(&provider) {
        return Err(AppError::BadRequest(format!("Unsupported provider '{provider}'")));
    }
    let res = sqlx::query("DELETE FROM user_llm_providers WHERE user_id = $1 AND provider = $2")
        .bind(claims.sub)
        .bind(&provider)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true, "deleted": res.rows_affected() })))
}

// ── POST /providers/:provider/test ────────────────────────────────────────────

/// Do a tiny real call to verify the connection. For Ollama we hit `/api/tags`;
/// for cloud providers we do a 1-token chat so the key + base_url are exercised.
async fn test_provider(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(provider): Path<String>,
) -> Result<Json<Value>> {
    let provider = provider.trim().to_lowercase();
    if !is_valid_provider(&provider) {
        return Err(AppError::BadRequest(format!("Unsupported provider '{provider}'")));
    }

    let target = crate::services::llm::resolve_for_user(&state.db, claims.sub, Some(&provider), None).await;
    let client = reqwest::Client::new();

    if provider == "ollama" {
        // The base URL actually persisted for this user (Settings → LLM / Infra).
        // Surfaced back so the UI can confirm "Connected — using <this exact URL>",
        // proving the value the user typed is what we stored and tested.
        let persisted_base: Option<String> = sqlx::query_scalar(
            "SELECT base_url FROM user_llm_providers WHERE user_id = $1 AND provider = 'ollama'",
        )
        .bind(claims.sub)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .filter(|s: &String| !s.trim().is_empty());

        // Re-validate the stored base at request time (SEC-1); fall back to the
        // default if a bad row slipped through write-time validation. This is the
        // base we ACTUALLY hit (host.docker.internal / LAN / loopback all allowed
        // for ollama; only cloud providers are pinned to their official host).
        let resolved_base = crate::services::llm::validate_llm_base("ollama", target.base_url.as_deref())
            .map(|u| u.as_str().trim_end_matches('/').to_string())
            .unwrap_or_else(|_| crate::services::llm::ollama_default_base());
        let mut rb = client
            .get(format!("{}/api/tags", resolved_base.trim_end_matches('/')))
            .timeout(Duration::from_secs(5));
        // Optional bearer for a remote/cloud Ollama.
        if let Some(k) = target.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            rb = rb.bearer_auth(k);
        }
        // A 2xx from /api/tags means the endpoint (and key, if any) is valid.
        // Surface the persisted + resolved base and the model count so the UI can
        // render "Connected — using <resolvedBase>, N models".
        return Ok(Json(match rb.send().await {
            Ok(r) if r.status().is_success() => {
                let count = r.json::<Value>().await.ok()
                    .and_then(|v| v["models"].as_array().map(|a| a.len()))
                    .unwrap_or(0);
                json!({
                    "ok": true,
                    "provider": provider,
                    "models": count,
                    "baseUrl": persisted_base,
                    "resolvedBase": resolved_base,
                })
            }
            Ok(r)  => json!({
                "ok": false, "provider": provider,
                "error": format!("Ollama returned {}", r.status()),
                "baseUrl": persisted_base, "resolvedBase": resolved_base,
            }),
            Err(e) => json!({
                "ok": false, "provider": provider,
                "error": format!("unreachable: {e}"),
                "baseUrl": persisted_base, "resolvedBase": resolved_base,
            }),
        }));
    }

    // Cloud: must have a key (resolve_for_user only returns the requested provider
    // if a row exists; if it fell back to ollama, there was no connection).
    if target.provider != provider || target.api_key.as_deref().unwrap_or("").is_empty() {
        return Ok(Json(json!({ "ok": false, "provider": provider, "error": "not connected (no API key saved)" })));
    }

    match crate::services::llm::chat_once(&client, &target, "You are a test.", "ping").await {
        Ok(_) => Ok(Json(json!({ "ok": true, "provider": provider }))),
        Err(e) => Ok(Json(json!({ "ok": false, "provider": provider, "error": e }))),
    }
}

// ── GET /models ───────────────────────────────────────────────────────────────

/// Flat model list for the pickers (Pi console + Talk-to-Graph). Always includes
/// local Ollama tags; adds curated cloud models for each connected provider.
/// True for Ollama models that are embedding-only (no chat). These must NOT
/// appear in the chat model dropdowns — selecting one breaks Talk-to-Graph /
/// Agent (e.g. `nomic-embed-text`, KEX's embedding model, would 400 on chat).
pub(crate) fn is_embedding_model(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("embed")
        || n.contains("all-minilm")
        || n.starts_with("bge-")
        || n.starts_with("gte-")
        || n.contains("/bge-")
        || n.contains("/gte-")
}

async fn list_models(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Json<Value> {
    let client = reqwest::Client::new();
    let mut models: Vec<Value> = Vec::new();

    // ── Ollama: live tags. Honour the user's custom base_url + optional key. ──
    let ollama_row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT base_url, api_key FROM user_llm_providers WHERE user_id = $1 AND provider = 'ollama'",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    // Re-validate the stored Ollama base at request time (SEC-1); on any
    // violation fall back to the default rather than fetching a bad URL.
    let stored_base = ollama_row.as_ref().and_then(|(b, _)| b.clone()).filter(|s| !s.trim().is_empty());
    let ollama_key = ollama_row
        .and_then(|(_, k)| k)
        .map(|c| crate::services::crypto::open(&c))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let ollama_base = crate::services::llm::validate_llm_base("ollama", stored_base.as_deref())
        .map(|u| u.as_str().trim_end_matches('/').to_string())
        .unwrap_or_else(|_| crate::services::llm::ollama_default_base());

    let mut tags_rb = client
        .get(format!("{}/api/tags", ollama_base.trim_end_matches('/')))
        .timeout(Duration::from_secs(3));
    if let Some(ref k) = ollama_key {
        tags_rb = tags_rb.bearer_auth(k);
    }
    if let Ok(resp) = tags_rb
        .send()
        .await
    {
        if let Ok(v) = resp.json::<Value>().await {
            if let Some(arr) = v["models"].as_array() {
                for m in arr {
                    if let Some(name) = m["name"].as_str() {
                        if is_embedding_model(name) { continue; } // embedding-only, not chat
                        models.push(json!({
                            "provider":  "ollama",
                            "model":     name,
                            "name":      name,
                            "available": true,
                            "requiresKey": false,
                        }));
                    }
                }
            }
        }
    }

    // ── Ollama Cloud: when an Ollama API key is set, also list ollama.com's
    //    hosted models so local + cloud both appear. These run via ollama.com
    //    using the same key (logical provider `ollama_cloud`). ──
    if let Some(ref k) = ollama_key {
        if let Ok(resp) = client
            .get("https://ollama.com/api/tags")
            .bearer_auth(k)
            .timeout(Duration::from_secs(5))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(v) = resp.json::<Value>().await {
                    if let Some(arr) = v["models"].as_array() {
                        for m in arr {
                            if let Some(name) = m["name"].as_str() {
                                if is_embedding_model(name) { continue; } // embedding-only, not chat
                                models.push(json!({
                                    "provider":    "ollama_cloud",
                                    "model":       name,
                                    "name":        format!("ollama cloud · {name}"),
                                    "available":   true,
                                    // Key is already stored (these only list when a key is set),
                                    // so the UI must NOT prompt for one again.
                                    "requiresKey": false,
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Cloud providers the user has connected (active + key present). ──
    let rows: Vec<ProviderRow> = sqlx::query_as(
        "SELECT provider, api_key, base_url, default_model, is_active
         FROM user_llm_providers WHERE user_id = $1 AND is_active = true",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    for row in &rows {
        if row.provider == "ollama" {
            continue;
        }
        let connected = row
            .api_key
            .as_deref()
            .map(|k| !crate::services::crypto::open(k).trim().is_empty())
            .unwrap_or(false);
        if !connected {
            continue;
        }
        for m in curated_models(&row.provider) {
            models.push(json!({
                "provider":    row.provider,
                "model":       m,
                "name":        format!("{} · {}", row.provider, m),
                "available":   true,
                // Connected providers only reach this loop, so the key is stored —
                // the UI shouldn't ask for it again at query time.
                "requiresKey": false,
            }));
        }
    }

    Json(json!({ "models": models }))
}

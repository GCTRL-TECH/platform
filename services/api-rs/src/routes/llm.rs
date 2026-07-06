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

const PROVIDERS: &[&str] = &["ollama", "openai", "anthropic", "openrouter", "openai_compatible"];

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
        // Model configurator: per-purpose model selection (embedding/relation/distill)
        // + a recommended catalog with local-Ollama install state, and a one-click pull.
        .route("/model-prefs", get(get_model_prefs).put(set_model_prefs))
        .route("/ollama/catalog", get(ollama_catalog))
        .route("/ollama/pull", post(ollama_pull))
        // P2: models installed on a specific runtime INSTANCE (per-purpose picker).
        .route("/instance-models", get(instance_models))
}

#[derive(Deserialize)]
struct InstanceModelsQuery {
    provider: Option<String>,
    base: Option<String>,
}

/// GET /api/llm/instance-models?provider=&base= — list the models available on a
/// specific runtime INSTANCE, so the per-purpose picker can show what THAT
/// instance (bundled Ollama, native Ollama, or a custom /v1 endpoint) actually
/// serves. Empty base → the user's configured/bundled Ollama. SSRF-guarded.
async fn instance_models(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    axum::extract::Query(q): axum::extract::Query<InstanceModelsQuery>,
) -> Result<Json<Value>> {
    let provider = q.provider.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("ollama").to_string();
    // Resolve the base: explicit (validated) or the user's bundled/configured Ollama.
    let base = match q.base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => {
            let v = crate::services::llm::validate_llm_base(&provider, Some(b))
                .map_err(|e| AppError::BadRequest(format!("Invalid base URL: {e}")))?;
            crate::services::llm::containerize_ollama_base(v.as_str().trim_end_matches('/'))
        }
        None => resolve_user_ollama(&state.db, claims.sub).await.0,
    };

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();

    let is_openai = matches!(provider.as_str(), "openai_compatible" | "openai" | "openrouter");
    let url = if is_openai {
        format!("{}/v1/models", base.trim_end_matches('/'))
    } else {
        format!("{}/api/tags", base.trim_end_matches('/'))
    };

    let mut models: Vec<String> = Vec::new();
    let mut reachable = false;
    if let Ok(resp) = client.get(&url).timeout(Duration::from_secs(5)).send().await {
        if resp.status().is_success() {
            reachable = true;
            if let Ok(j) = resp.json::<Value>().await {
                let arr = if is_openai { j["data"].as_array() } else { j["models"].as_array() };
                if let Some(list) = arr {
                    for m in list {
                        let name = if is_openai { m["id"].as_str() } else { m["name"].as_str() };
                        if let Some(n) = name { models.push(n.to_string()); }
                    }
                }
            }
        }
    }

    Ok(Json(json!({ "provider": provider, "base": base, "reachable": reachable, "models": models })))
}

// ── Recommended model catalog ───────────────────────────────────────────────
// The curated, shippable defaults. Kept LOCAL-first so a fresh install runs with
// no cloud token spend. Each entry carries enough metadata for the UI to show
// "runs on your system?" (ram_gb) + a speed/quality hint, and to flag the
// recommended pick per purpose. `purpose`: embedding | relation | distill.

struct RecModel {
    name: &'static str,
    purpose: &'static str,
    size_gb: f64,   // download size
    ram_gb: f64,    // rough resident RAM to run it
    speed: u8,      // 1..5 (5 = fastest)
    quality: u8,    // 1..5 (5 = best)
    recommended: bool,
    note: &'static str,
}

const CATALOG: &[RecModel] = &[
    // ── Embedding (must be able to run LOCAL — cloud embeddings burn tokens) ──
    RecModel { name: "nomic-embed-text", purpose: "embedding", size_gb: 0.27, ram_gb: 1.0, speed: 5, quality: 4, recommended: true,  note: "Default. Fast, strong general-purpose embeddings. Low RAM." },
    RecModel { name: "mxbai-embed-large", purpose: "embedding", size_gb: 0.67, ram_gb: 1.5, speed: 4, quality: 5, recommended: false, note: "Higher retrieval quality, a bit larger/slower." },
    RecModel { name: "all-minilm",        purpose: "embedding", size_gb: 0.05, ram_gb: 0.5, speed: 5, quality: 3, recommended: false, note: "Tiny + fastest; lower quality. Good for weak hardware." },
    // ── Relation extraction (chat-style; quality matters for relation F1) ──
    RecModel { name: "qwen2.5:7b",  purpose: "relation", size_gb: 4.7, ram_gb: 6.0, speed: 3, quality: 5, recommended: true,  note: "Default. Strong local relation quality. Needs ~6GB free RAM." },
    RecModel { name: "qwen2.5:14b", purpose: "relation", size_gb: 9.0, ram_gb: 12.0, speed: 2, quality: 5, recommended: false, note: "Quality upgrade: +10% relation F1 on our 32-doc business-document benchmark vs the pre-tuning baseline (measured). Slower on CPU; ideal with GPU. Needs ~12GB RAM." },
    RecModel { name: "qwen2.5:3b",  purpose: "relation", size_gb: 1.9, ram_gb: 3.0, speed: 4, quality: 4, recommended: false, note: "Lighter; good relations on ~4GB RAM." },
    RecModel { name: "llama3.2:3b", purpose: "relation", size_gb: 2.0, ram_gb: 3.0, speed: 4, quality: 3, recommended: false, note: "Fast, modest quality. Low-RAM fallback." },
    // ── Distillation (wiki prose; instruction-following + fluency) ──
    RecModel { name: "llama3.2",   purpose: "distill", size_gb: 2.0, ram_gb: 3.0, speed: 4, quality: 3, recommended: true,  note: "Default. Light, fast wiki prose; runs on ~3GB RAM." },
    RecModel { name: "qwen2.5:7b", purpose: "distill", size_gb: 4.7, ram_gb: 6.0, speed: 3, quality: 5, recommended: false, note: "More coherent prose for richer wikis. Needs ~6GB RAM." },
    // ── Pi agent chat (tool-calling; needs reliable JSON + reasoning) ──
    RecModel { name: "llama3.2",    purpose: "agent", size_gb: 2.0, ram_gb: 3.0,  speed: 4, quality: 3, recommended: true,  note: "Default. Fast, low-RAM chat for the Pi agent." },
    RecModel { name: "qwen2.5:7b",  purpose: "agent", size_gb: 4.7, ram_gb: 6.0,  speed: 3, quality: 5, recommended: false, note: "Stronger tool-calling + reasoning. Needs ~6GB RAM." },
    RecModel { name: "qwen2.5:14b", purpose: "agent", size_gb: 9.0, ram_gb: 12.0, speed: 2, quality: 5, recommended: false, note: "Best quality for complex multi-tool agent tasks. Needs ~12GB RAM." },
    // ── Talk-to-Graph RAG (grounded Q&A over your knowledge graph) ──
    RecModel { name: "llama3.2",    purpose: "rag", size_gb: 2.0, ram_gb: 3.0,  speed: 4, quality: 3, recommended: true,  note: "Default. Fast, low-RAM answers grounded in your graph." },
    RecModel { name: "qwen2.5:7b",  purpose: "rag", size_gb: 4.7, ram_gb: 6.0,  speed: 3, quality: 5, recommended: false, note: "More coherent multi-hop answers. Needs ~6GB RAM." },
    RecModel { name: "qwen2.5:14b", purpose: "rag", size_gb: 9.0, ram_gb: 12.0, speed: 2, quality: 5, recommended: false, note: "Best answer quality for deep/agentic RAG. Needs ~12GB RAM." },
];

/// Recommended default model per purpose (mirrors the kex/fuse env defaults so the
/// UI shows the same baseline the engine actually uses when nothing is configured).
pub(crate) fn default_model_for(purpose: &str) -> &'static str {
    match purpose {
        "embedding" => "nomic-embed-text",
        "relation"  => "qwen2.5:7b",
        "distill"   => "llama3.2",
        "agent"     => "llama3.2",
        "rag"       => "llama3.2",
        _ => "",
    }
}

/// Total system RAM in GB (best-effort, Linux /proc/meminfo). 0.0 when unknown
/// (e.g. non-Linux) — the UI then just hides the "won't fit" warnings.
fn system_ram_gb() -> f64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<f64>().ok())
                .map(|kb| kb / 1_048_576.0) // kB → GB
        })
        .unwrap_or(0.0)
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

// ── Model preferences (per-purpose) ─────────────────────────────────────────

#[derive(sqlx::FromRow, Default)]
struct ModelPrefsRow {
    embedding_model: Option<String>,
    embedding_provider: Option<String>,
    embedding_base_url: Option<String>,
    relation_model: Option<String>,
    distill_model: Option<String>,
    agent_model: Option<String>,
    rag_model: Option<String>,
    // P2 per-purpose runtime: provider + base_url per purpose (NULL = inherit).
    relation_provider: Option<String>,
    relation_base_url: Option<String>,
    distill_provider: Option<String>,
    distill_base_url: Option<String>,
    agent_provider: Option<String>,
    agent_base_url: Option<String>,
    rag_provider: Option<String>,
    rag_base_url: Option<String>,
}

/// GET /api/llm/model-prefs — the user's per-purpose model choices, with the
/// recommended defaults applied for anything unset (so the UI always shows the
/// model the engine will actually use).
async fn get_model_prefs(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let row: ModelPrefsRow = sqlx::query_as(
        "SELECT embedding_model, embedding_provider, embedding_base_url, relation_model, distill_model,
                agent_model, rag_model,
                relation_provider, relation_base_url, distill_provider, distill_base_url,
                agent_provider, agent_base_url, rag_provider, rag_base_url
         FROM user_model_prefs WHERE user_id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or_default();

    Ok(Json(json!({
        "embeddingModel":   row.embedding_model.unwrap_or_else(|| default_model_for("embedding").into()),
        "embeddingProvider": row.embedding_provider.unwrap_or_else(|| "ollama".into()),
        "embeddingBaseUrl": row.embedding_base_url,
        "relationModel":    row.relation_model.unwrap_or_else(|| default_model_for("relation").into()),
        "distillModel":     row.distill_model.unwrap_or_else(|| default_model_for("distill").into()),
        "agentModel":       row.agent_model.unwrap_or_else(|| default_model_for("agent").into()),
        "ragModel":         row.rag_model.unwrap_or_else(|| default_model_for("rag").into()),
        // Per-purpose runtime overrides. NULL provider = "inherit global runtime"
        // — the UI renders that as the default; a set value re-points the purpose.
        "relationProvider": row.relation_provider,
        "relationBaseUrl":  row.relation_base_url,
        "distillProvider":  row.distill_provider,
        "distillBaseUrl":   row.distill_base_url,
        "agentProvider":    row.agent_provider,
        "agentBaseUrl":     row.agent_base_url,
        "ragProvider":      row.rag_provider,
        "ragBaseUrl":       row.rag_base_url,
    })))
}

#[derive(Deserialize)]
struct SetPrefsReq {
    #[serde(rename = "embeddingModel")]    embedding_model:    Option<String>,
    #[serde(rename = "embeddingProvider")] embedding_provider: Option<String>,
    #[serde(rename = "embeddingBaseUrl")]  embedding_base_url: Option<String>,
    #[serde(rename = "relationModel")]     relation_model:     Option<String>,
    #[serde(rename = "distillModel")]      distill_model:      Option<String>,
    #[serde(rename = "agentModel")]        agent_model:        Option<String>,
    #[serde(rename = "ragModel")]          rag_model:          Option<String>,
    // P2 per-purpose runtime overrides (NULL/empty = inherit global runtime).
    #[serde(rename = "relationProvider")]  relation_provider:  Option<String>,
    #[serde(rename = "relationBaseUrl")]   relation_base_url:  Option<String>,
    #[serde(rename = "distillProvider")]   distill_provider:   Option<String>,
    #[serde(rename = "distillBaseUrl")]    distill_base_url:   Option<String>,
    #[serde(rename = "agentProvider")]     agent_provider:     Option<String>,
    #[serde(rename = "agentBaseUrl")]      agent_base_url:     Option<String>,
    #[serde(rename = "ragProvider")]       rag_provider:       Option<String>,
    #[serde(rename = "ragBaseUrl")]        rag_base_url:       Option<String>,
}

/// SSRF-validate an optional per-purpose base URL against its provider. Empty →
/// None. Cloud providers are pinned to their official host; an arbitrary host
/// (e.g. a cloud-metadata IP) is rejected with 400. Returns the normalized
/// (trailing-slash-stripped) URL. Unset provider defaults to openai_compatible.
fn validate_opt_base(provider: Option<&str>, base: Option<String>) -> Result<Option<String>> {
    match base.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(b) => {
            let prov = provider.unwrap_or("openai_compatible");
            let v = crate::services::llm::validate_llm_base(prov, Some(&b))
                .map_err(|e| AppError::BadRequest(format!("Invalid base URL: {e}")))?;
            Ok(Some(v.as_str().trim_end_matches('/').to_string()))
        }
        None => Ok(None),
    }
}

/// PUT /api/llm/model-prefs — upsert the per-purpose model choices. Empty string
/// → NULL (reset that purpose to the recommended default).
async fn set_model_prefs(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SetPrefsReq>,
) -> Result<Json<Value>> {
    let norm = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    // Providers per purpose (NULL = inherit the global runtime).
    let emb_provider = norm(req.embedding_provider);
    let rel_provider = norm(req.relation_provider);
    let dis_provider = norm(req.distill_provider);
    let agt_provider = norm(req.agent_provider);
    let rag_provider = norm(req.rag_provider);

    // SSRF guard on every per-purpose base URL: these are fetched server-side by
    // the workers / chat layer, so validate through the same defense as the Ollama
    // base BEFORE persisting. Empty → NULL. (Embedding keeps its ollama default
    // for back-compat; the rest default to openai_compatible when a base is given.)
    let emb_base = match norm(req.embedding_base_url) {
        Some(b) => {
            let prov = emb_provider.as_deref().unwrap_or("ollama");
            let validated = crate::services::llm::validate_llm_base(prov, Some(&b))
                .map_err(|e| AppError::BadRequest(format!("Invalid embedding base URL: {e}")))?;
            Some(validated.as_str().trim_end_matches('/').to_string())
        }
        None => None,
    };
    let rel_base = validate_opt_base(rel_provider.as_deref(), req.relation_base_url)?;
    let dis_base = validate_opt_base(dis_provider.as_deref(), req.distill_base_url)?;
    let agt_base = validate_opt_base(agt_provider.as_deref(), req.agent_base_url)?;
    let rag_base = validate_opt_base(rag_provider.as_deref(), req.rag_base_url)?;

    sqlx::query(
        "INSERT INTO user_model_prefs
            (user_id, embedding_model, embedding_provider, embedding_base_url,
             relation_model, distill_model, agent_model, rag_model,
             relation_provider, relation_base_url, distill_provider, distill_base_url,
             agent_provider, agent_base_url, rag_provider, rag_base_url, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
         ON CONFLICT (user_id) DO UPDATE SET
            embedding_model    = $2,
            embedding_provider = $3,
            embedding_base_url = $4,
            relation_model     = $5,
            distill_model      = $6,
            agent_model        = $7,
            rag_model          = $8,
            relation_provider  = $9,
            relation_base_url  = $10,
            distill_provider   = $11,
            distill_base_url   = $12,
            agent_provider     = $13,
            agent_base_url     = $14,
            rag_provider       = $15,
            rag_base_url       = $16,
            updated_at         = now()",
    )
    .bind(claims.sub)
    .bind(norm(req.embedding_model))
    .bind(emb_provider)
    .bind(emb_base)
    .bind(norm(req.relation_model))
    .bind(norm(req.distill_model))
    .bind(norm(req.agent_model))
    .bind(norm(req.rag_model))
    .bind(rel_provider)
    .bind(rel_base)
    .bind(dis_provider)
    .bind(dis_base)
    .bind(agt_provider)
    .bind(agt_base)
    .bind(rag_provider)
    .bind(rag_base)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true })))
}

// ── Ollama model catalog + install ──────────────────────────────────────────

/// Resolve the user's effective Ollama base + (decrypted) key, re-validated.
async fn resolve_user_ollama(db: &sqlx::PgPool, user_id: uuid::Uuid) -> (String, Option<String>) {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT base_url, api_key FROM user_llm_providers WHERE user_id = $1 AND provider = 'ollama'",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    let stored_base = row.as_ref().and_then(|(b, _)| b.clone()).filter(|s| !s.trim().is_empty());
    let key = row
        .and_then(|(_, k)| k)
        .map(|c| crate::services::crypto::open(&c))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let base = crate::services::llm::validate_llm_base("ollama", stored_base.as_deref())
        .map(|u| crate::services::llm::containerize_ollama_base(u.as_str().trim_end_matches('/')))
        .unwrap_or_else(|_| crate::services::llm::ollama_default_base());
    (base, key)
}

/// GET /api/llm/ollama/catalog — the recommended model catalog enriched with
/// local install state + whether each model fits this machine's RAM, plus the
/// list of every model already installed locally. Drives the Settings chooser.
async fn ollama_catalog(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Json<Value> {
    let (base, key) = resolve_user_ollama(&state.db, claims.sub).await;
    // No-redirect client: a validated base must not be able to 302 onward (SSRF).
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();

    // Which models are installed locally right now.
    let mut installed: Vec<String> = Vec::new();
    let mut rb = client.get(format!("{base}/api/tags")).timeout(Duration::from_secs(4));
    if let Some(ref k) = key { rb = rb.bearer_auth(k); }
    if let Ok(resp) = rb.send().await {
        if let Ok(v) = resp.json::<Value>().await {
            if let Some(arr) = v["models"].as_array() {
                for m in arr {
                    if let Some(n) = m["name"].as_str() { installed.push(n.to_string()); }
                }
            }
        }
    }
    // Match installed loosely: ollama tags often carry a `:latest`/`:tag` suffix.
    let is_installed = |name: &str| {
        installed.iter().any(|i| i == name || i.split(':').next() == Some(name) || name.split(':').next() == i.split(':').next())
    };

    let ram = system_ram_gb();
    let catalog: Vec<Value> = CATALOG
        .iter()
        .map(|m| json!({
            "name": m.name, "purpose": m.purpose,
            "sizeGb": m.size_gb, "ramGb": m.ram_gb,
            "speed": m.speed, "quality": m.quality,
            "recommended": m.recommended, "note": m.note,
            "installed": is_installed(m.name),
            // 0.0 RAM = unknown → don't warn. Else flag if it needs more than we have.
            "fitsRam": ram == 0.0 || m.ram_gb <= ram,
        }))
        .collect();

    Json(json!({
        "systemRamGb": (ram * 10.0).round() / 10.0,
        "ollamaBase": base,
        "ollamaReachable": !installed.is_empty(),
        "installed": installed,
        "catalog": catalog,
    }))
}

#[derive(Deserialize)]
struct PullReq { model: String }

/// POST /api/llm/ollama/pull — install a model into the user's local Ollama
/// (`/api/pull`, blocking until done). One-click for the recommended models
/// (e.g. nomic-embed-text) so the user never has to drop to a shell.
async fn ollama_pull(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<PullReq>,
) -> Result<Json<Value>> {
    let model = req.model.trim().to_string();
    if model.is_empty() || model.len() > 128 || model.contains(char::is_whitespace) {
        return Err(AppError::BadRequest("invalid model name".into()));
    }
    let (base, key) = resolve_user_ollama(&state.db, claims.sub).await;
    // No-redirect client: a validated base must not be able to 302 onward (SSRF).
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();
    let mut rb = client
        .post(format!("{base}/api/pull"))
        .json(&json!({ "name": model, "stream": false }))
        // Model pulls can be large; allow generous time.
        .timeout(Duration::from_secs(1800));
    if let Some(ref k) = key { rb = rb.bearer_auth(k); }

    match rb.send().await {
        Ok(r) if r.status().is_success() => {
            // Ollama returns {"status":"success"} on completion.
            let body: Value = r.json().await.unwrap_or(json!({}));
            let ok = body["status"].as_str() == Some("success") || body.get("error").is_none();
            if ok {
                Ok(Json(json!({ "ok": true, "model": model })))
            } else {
                Ok(Json(json!({ "ok": false, "model": model, "error": body["error"] })))
            }
        }
        Ok(r) => Ok(Json(json!({ "ok": false, "model": model, "error": format!("Ollama returned {}", r.status()) }))),
        Err(e) => Ok(Json(json!({ "ok": false, "model": model, "error": format!("pull failed: {e}") }))),
    }
}

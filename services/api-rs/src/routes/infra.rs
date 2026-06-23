//! External infrastructure overrides (`/api/infra`).
//!
//! GCTRL bundles its own stack (Neo4j, Qdrant, Ollama, Postgres, Redis). This
//! module lets an operator point GCTRL at an EXTERNAL instance of a *swappable*
//! service (Neo4j, Qdrant, Ollama, Postgres) and health-check the target before
//! committing.
//!
//! The `secret` (password / token) is sealed at rest via `services/crypto.rs`
//! and never returned to the client — reads surface only a `hasSecret` boolean.
//!
//! ## Honest apply semantics
//!
//! - **ollama / qdrant** — resolved per outbound HTTP request, so a saved
//!   override can take effect for new requests without a restart.
//! - **postgres / neo4j** — connection pools are built once at boot, so a saved
//!   override is persisted but needs a GCTRL **restart** to take effect. The
//!   `PUT` response carries `appliesImmediately: false` + a `note` so the UI can
//!   be truthful instead of pretending it hot-swaps.
//!
//! ## Routes (mounted under `/api/infra`)
//!
//! - `GET    /overrides`              → list saved overrides (secret omitted)
//! - `PUT    /overrides/:service`     → upsert `{ url, username?, secret? }`
//! - `POST   /overrides/:service/test`→ connectivity check to the given target

use axum::{
    extract::{Extension, Path, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::error::{AppError, Result};
use crate::middleware::auth::{require_role, JwtClaims};

/// Services that can be swapped for an external instance.
const SWAPPABLE: &[&str] = &["neo4j", "qdrant", "ollama", "postgres"];

/// Honest apply semantics: every service either pools its connection at boot
/// (postgres, neo4j) or is read at startup by the worker services (qdrant,
/// ollama are used by KEX/FUSE). So a saved override is applied reliably across
/// the whole stack only after a GCTRL restart. We no longer pretend any swap
/// hot-applies mid-flight.
fn apply_note(_service: &str) -> &'static str {
    "Saved — restart GCTRL so every service uses it. Reset any time to return to the bundled default."
}

fn is_swappable(s: &str) -> bool {
    SWAPPABLE.contains(&s)
}

// ── Model catalog ─────────────────────────────────────────────────────────────

/// Per-runtime generation model catalog.
/// Each entry: (id, label, ollama_tag, llamacpp_hf_arg, vllm_repo, ram_gb)
struct GenModelEntry {
    id: &'static str,
    label: &'static str,
    ollama: &'static str,
    llamacpp: &'static str,
    vllm: &'static str,
    ram_gb: f32,
}

const RUNTIME_GEN_MODELS: &[GenModelEntry] = &[
    GenModelEntry {
        id: "qwen2.5-3b",
        label: "Qwen 2.5 3B Instruct",
        ollama: "qwen2.5:3b",
        llamacpp: "bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M",
        vllm: "Qwen/Qwen2.5-3B-Instruct",
        ram_gb: 3.0,
    },
    GenModelEntry {
        id: "qwen2.5-7b",
        label: "Qwen 2.5 7B Instruct",
        ollama: "qwen2.5:7b",
        llamacpp: "bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
        vllm: "Qwen/Qwen2.5-7B-Instruct",
        ram_gb: 6.0,
    },
    GenModelEntry {
        id: "llama-3.2-3b",
        label: "Llama 3.2 3B Instruct",
        ollama: "llama3.2",
        llamacpp: "bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M",
        vllm: "meta-llama/Llama-3.2-3B-Instruct",
        ram_gb: 3.0,
    },
];

/// Resolve the per-runtime argument for a given model ID.
/// Returns `None` for unknown model IDs.
/// runtime: "ollama" | "llamacpp" | "vllm"
pub fn resolve_model_arg(model_id: &str, runtime: &str) -> Option<String> {
    let entry = RUNTIME_GEN_MODELS.iter().find(|e| e.id == model_id)?;
    let arg = match runtime {
        "ollama"   => entry.ollama,
        "llamacpp" => entry.llamacpp,
        "vllm"     => entry.vllm,
        _          => return None,
    };
    Some(arg.to_string())
}

// ── Shared persist_runtime helper ─────────────────────────────────────────────

/// Shared helper: UPSERT `runtime_config` row (id=1).
/// Seals `api_key` when provided; COALESCE preserves existing key otherwise.
async fn persist_runtime(
    db: &sqlx::PgPool,
    provider: &str,
    base_url: Option<&str>,
    model: Option<&str>,
    api_key: Option<&str>,
) -> crate::error::Result<()> {
    let sealed_key: Option<String> = api_key
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .map(crate::services::crypto::seal);

    sqlx::query(
        "INSERT INTO runtime_config (id, provider, base_url, model, api_key, updated_at)
         VALUES (1, $1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET
             provider   = $1,
             base_url   = $2,
             model      = $3,
             api_key    = COALESCE($4, runtime_config.api_key),
             updated_at = now()",
    )
    .bind(provider)
    .bind(base_url)
    .bind(model)
    .bind(sealed_key)
    .execute(db)
    .await?;
    Ok(())
}

/// The bundled (onboard) default endpoint for a swappable service — what GCTRL
/// uses out of the box. Credentials live separately (never in these URLs).
pub(crate) fn default_service_url(cfg: &crate::config::Config, service: &str) -> String {
    match service {
        "neo4j" => cfg.neo4j_uri.clone(),
        "qdrant" => cfg.qdrant_url.clone(),
        "postgres" => "postgres (bundled)".to_string(), // creds in DATABASE_URL — never surfaced
        // Bundled Ollama lives on the compose network as `gctrl-ollama`. Prefer the
        // explicit OLLAMA_BASE env (compose sets it), then fall back to the compose
        // service name — NOT `localhost`, which from inside the api container points
        // at the api container itself and always reads as "offline".
        "ollama" => std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://gctrl-ollama:11434".into()),
        _ => String::new(),
    }
}

/// Effective endpoint for a service: the saved override URL if present, else the
/// bundled default. (Used to PROBE the right target in the status view.)
pub(crate) async fn effective_service_url(
    db: &sqlx::PgPool,
    cfg: &crate::config::Config,
    service: &str,
) -> String {
    if let Ok(Some(Some(u))) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT url FROM service_overrides WHERE service = $1",
    ).bind(service).fetch_optional(db).await {
        if !u.trim().is_empty() { return u; }
    }
    default_service_url(cfg, service)
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/overrides", get(list_overrides))
        .route(
            "/overrides/:service",
            axum::routing::put(upsert_override).delete(delete_override),
        )
        .route("/overrides/:service/test", axum::routing::post(test_override))
        // ── Global runtime (active LLM generation runtime) ─────────────────
        .route("/active-runtime", get(get_active_runtime))
        .route("/runtimes", get(list_runtimes))
        .route("/runtime", post(set_runtime))
        // ── Runtime-aware model catalog ──────────────────────────────────────
        .route("/models", get(list_gen_models))
        // ── Runtime switch (SSE, admin-only) ────────────────────────────────
        .route("/switch-runtime", post(switch_runtime))
}

// ── GET /overrides ──────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct OverrideRow {
    service: String,
    url: Option<String>,
    username: Option<String>,
    secret: Option<String>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

/// List the saved overrides for all swappable services. The sealed secret is
/// never returned — only a `hasSecret` flag. Services with no override row are
/// returned with `url: null` so the UI can render an empty swap form per service.
async fn list_overrides(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // Infrastructure config is admin-only (reveals service endpoints/usernames).
    require_role(&claims, "admin")?;
    let rows: Vec<OverrideRow> = sqlx::query_as(
        "SELECT service, url, username, secret, updated_at FROM service_overrides",
    )
    .fetch_all(&state.db)
    .await?;

    let overrides: Vec<Value> = SWAPPABLE
        .iter()
        .map(|svc| {
            let row = rows.iter().find(|r| r.service == *svc);
            let has_override = row.and_then(|r| r.url.as_deref()).map(|u| !u.trim().is_empty()).unwrap_or(false);
            json!({
                "service":     svc,
                "url":         row.and_then(|r| r.url.clone()),
                "username":    row.and_then(|r| r.username.clone()),
                "hasSecret":   row.and_then(|r| r.secret.as_deref()).map(|s| !s.trim().is_empty()).unwrap_or(false),
                "updatedAt":   row.map(|r| r.updated_at.to_rfc3339()),
                // Where the service currently points: the bundled onboard default,
                // or an external override the operator saved.
                "source":      if has_override { "override" } else { "default" },
                "defaultUrl":  default_service_url(&state.cfg, svc),
                "note":        apply_note(svc),
            })
        })
        .collect();

    Ok(Json(json!({ "overrides": overrides })))
}

// ── DELETE /overrides/:service — reset to the bundled onboard default ─────────

/// Remove a saved override so the service falls back to its bundled default.
/// (Pooled services apply the reset on the next GCTRL restart.)
async fn delete_override(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(service): Path<String>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let service = service.trim().to_lowercase();
    if !is_swappable(&service) {
        return Err(AppError::BadRequest(format!("Service '{service}' is not swappable")));
    }
    sqlx::query("DELETE FROM service_overrides WHERE service = $1")
        .bind(&service)
        .execute(&state.db)
        .await?;
    crate::services::audit::log_access(
        &state.db, &claims, "infra.override.reset", "service_override", &service,
        0, None, true, None,
    ).await;
    Ok(Json(json!({
        "ok": true, "service": service, "source": "default",
        "defaultUrl": default_service_url(&state.cfg, &service),
        "note": "Reset to the bundled default — restart GCTRL to apply across services.",
    })))
}

// ── PUT /overrides/:service ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct UpsertReq {
    url: Option<String>,
    username: Option<String>,
    secret: Option<String>,
}

/// Upsert an external override. `secret`, if present and non-empty, is sealed via
/// `crypto::seal`; if omitted the existing stored secret is preserved (COALESCE),
/// so the URL/username can be changed without re-entering the secret.
async fn upsert_override(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(service): Path<String>,
    Json(req): Json<UpsertReq>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let service = service.trim().to_lowercase();
    if !is_swappable(&service) {
        return Err(AppError::BadRequest(format!("Service '{service}' is not swappable")));
    }

    let url = req.url.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    if url.is_none() {
        return Err(AppError::BadRequest("url is required".into()));
    }
    let username = req.username.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let sealed_secret: Option<String> = req
        .secret
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(crate::services::crypto::seal);

    // COALESCE on secret so omitting it preserves the stored value on update.
    sqlx::query(
        "INSERT INTO service_overrides (service, url, username, secret, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (service) DO UPDATE SET
            url        = $2,
            username   = $3,
            secret     = COALESCE($4, service_overrides.secret),
            updated_at = now()",
    )
    .bind(&service)
    .bind(url)
    .bind(username)
    .bind(sealed_secret)
    .execute(&state.db)
    .await?;

    crate::services::audit::log_access(
        &state.db, &claims, "infra.override.set", "service_override", &service,
        0, None, true, None,
    ).await;

    Ok(Json(json!({
        "ok": true,
        "service": service,
        "source": "override",
        "note": apply_note(&service),
    })))
}

// ── POST /overrides/:service/test ───────────────────────────────────────────

/// Connectivity check against the saved override target (or, if a fresh `url` is
/// supplied in the body, against that — so Test works before Save). Each service
/// uses its cheapest reachability probe:
///   - ollama  → GET {url}/api/tags
///   - qdrant  → GET {url}/healthz
///   - neo4j   → TCP connect to the bolt host:port
///   - postgres→ TCP connect to host:port
async fn test_override(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(service): Path<String>,
    Json(req): Json<UpsertReq>,
) -> Result<Json<Value>> {
    // Admin-only: the probe targets an admin-supplied URL. Admins already control
    // the deployment's network, so this is not a privilege escalation; the host
    // guard below still blocks the one class of target that is never legitimate
    // infrastructure (cloud-metadata / unspecified).
    require_role(&claims, "admin")?;
    let service = service.trim().to_lowercase();
    if !is_swappable(&service) {
        return Err(AppError::BadRequest(format!("Service '{service}' is not swappable")));
    }

    // Prefer a URL supplied in the request (Test-before-Save); else the saved one.
    let body_url = req.url.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
    let url = match body_url {
        Some(u) => Some(u),
        None => sqlx::query_scalar::<_, Option<String>>(
            "SELECT url FROM service_overrides WHERE service = $1",
        )
        .bind(&service)
        .fetch_optional(&state.db)
        .await?
        .flatten(),
    };

    let Some(url) = url else {
        return Ok(Json(json!({ "ok": false, "service": service, "error": "no target URL configured" })));
    };

    // No redirects: a 3xx reply must not bounce a validated hop to a new host.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();
    let result = match service.as_str() {
        "ollama" | "qdrant" => {
            // Validate the resolved host before any request (blind-SSRF guard).
            let parsed = url::Url::parse(&url).map_err(|_| AppError::BadRequest("invalid url".into()))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(AppError::BadRequest("url must be http(s)".into()));
            }
            let host = parsed.host_str().unwrap_or("").to_string();
            let port = parsed.port_or_known_default().unwrap_or(80);
            match guard_probe_host(&host, port).await {
                Ok(()) => {
                    let path = if service == "ollama" { "/api/tags" } else { "/healthz" };
                    probe_http_ok(&client, &format!("{}{}", url.trim_end_matches('/'), path)).await
                }
                Err(e) => Err(e),
            }
        }
        "neo4j" | "postgres" => {
            match parse_host_port(&url) {
                Ok((host, port)) => match guard_probe_host(&host, port).await {
                    Ok(()) => probe_tcp_url(&url).await,
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            }
        }
        _ => Err("unsupported service".into()),
    };

    match result {
        Ok(latency) => Ok(Json(json!({ "ok": true, "service": service, "latencyMs": latency }))),
        Err(e) => Ok(Json(json!({ "ok": false, "service": service, "error": e }))),
    }
}

/// Resolve `host` and reject targets that are never legitimate infrastructure:
/// cloud-metadata / link-local (169.254.0.0/16, fe80::/10) and unspecified
/// (0.0.0.0, ::). Private/LAN/loopback are INTENTIONALLY allowed — this admin-only
/// feature exists to point GCTRL at infra that commonly lives on a private network
/// (the bundled stack itself runs on the docker private net).
async fn guard_probe_host(host: &str, port: u16) -> std::result::Result<(), String> {
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "host did not resolve".to_string())?
        .collect();
    if addrs.is_empty() {
        return Err("host did not resolve".into());
    }
    for addr in &addrs {
        let blocked = match addr.ip() {
            std::net::IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast(),
            // link-local fe80::/10 or unspecified ::
            std::net::IpAddr::V6(v6) => v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80,
        };
        if blocked {
            return Err("target resolves to a blocked address (metadata/link-local/unspecified)".into());
        }
    }
    Ok(())
}

/// GET probe: success on any non-5xx HTTP response (reachable + serving).
async fn probe_http_ok(client: &reqwest::Client, url: &str) -> std::result::Result<u128, String> {
    let start = std::time::Instant::now();
    let resp = timeout(Duration::from_secs(5), client.get(url).send())
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.to_string())?;
    if resp.status().as_u16() < 500 {
        Ok(start.elapsed().as_millis())
    } else {
        Err(format!("HTTP {}", resp.status().as_u16()))
    }
}

/// TCP probe for a connection-URL like `bolt://host:7687` or
/// `postgres://user:pass@host:5432/db`. Extracts host:port and connects.
async fn probe_tcp_url(url: &str) -> std::result::Result<u128, String> {
    let (host, port) = parse_host_port(url)?;
    let start = std::time::Instant::now();
    timeout(Duration::from_secs(5), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(start.elapsed().as_millis())
}

/// Pull host + port out of a connection URL. Defaults: bolt→7687, postgres→5432.
fn parse_host_port(url: &str) -> std::result::Result<(String, u16), String> {
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (s.to_lowercase(), r),
        None => (String::new(), url),
    };
    // Strip any user:pass@ credentials and any trailing /path.
    let authority = rest.rsplit_once('@').map(|(_, a)| a).unwrap_or(rest);
    let authority = authority.split('/').next().unwrap_or(authority);
    let default_port: u16 = match scheme.as_str() {
        "postgres" | "postgresql" => 5432,
        "bolt" | "neo4j" | "neo4j+s" | "bolt+s" => 7687,
        _ => 0,
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "invalid port".to_string())?),
        None => (authority.to_string(), default_port),
    };
    if host.is_empty() {
        return Err("missing host".into());
    }
    if port == 0 {
        return Err("missing port (include it in the URL, e.g. host:7687)".into());
    }
    Ok((host, port))
}

// ── Global runtime config endpoints ─────────────────────────────────────────
//
// These three endpoints manage the operator-level "active runtime" — the
// default generation backend used when no per-user provider is configured.
// The singleton row in `runtime_config` (id=1) stores the choice; absence
// means "unset → bundled Ollama default".

// ── Validate runtime input (pure, testable) ──────────────────────────────────

/// Validate the body fields for `POST /runtime` without touching the DB.
///
/// - `provider` must be one of `{"ollama","openai_compatible"}`.
/// - `openai_compatible` requires a non-empty `base_url`.
/// - When `base_url` is present it is run through the SSRF guard.
///
/// Returns `Ok(validated_base)` — the validated base URL string for
/// `openai_compatible`, or `None` for `ollama` (the base is optional and
/// validated later at request time via `containerize_ollama_base`).
pub fn validate_runtime_input(
    provider: &str,
    base_url: Option<&str>,
) -> std::result::Result<Option<String>, String> {
    match provider {
        "ollama" => {
            // Base is optional for Ollama (falls back to OLLAMA_BASE / bundled default).
            // Validate it when provided so bad values are rejected at write time.
            if let Some(b) = base_url.map(str::trim).filter(|s| !s.is_empty()) {
                crate::services::llm::validate_llm_base("ollama", Some(b))
                    .map(|_| Some(b.to_string()))
                    .map_err(|e| e)
            } else {
                Ok(None)
            }
        }
        "openai_compatible" => {
            let b = base_url
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "base_url is required for openai_compatible".to_string())?;
            crate::services::llm::validate_llm_base("openai_compatible", Some(b))
                .map(|u| Some(u.as_str().trim_end_matches('/').to_string()))
                .map_err(|e| e)
        }
        other => Err(format!(
            "Unknown provider '{other}'. Valid values: ollama, openai_compatible"
        )),
    }
}

// ── GET /api/infra/active-runtime ────────────────────────────────────────────

/// Return the current global runtime — provider, endpoint, model, and a live
/// health probe result. The `api_key` is NEVER returned; `configured` is true
/// when a provider row exists and the provider field is non-empty.
async fn get_active_runtime(
    Extension(_claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // Any authenticated user may read (not admin-only — the UI shows this in
    // the Settings summary for all users to understand the active backend).
    let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT provider, base_url, model, embedding_mode
             FROM runtime_config WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await?;

    let (provider, base_url, model, embedding_mode, configured) = match row {
        Some((Some(p), b, m, em)) if !p.trim().is_empty() => {
            (p.trim().to_string(), b, m, em, true)
        }
        Some((_, b, m, em)) => ("ollama".to_string(), b, m, em, false),
        None => ("ollama".to_string(), None, None, None, false),
    };

    // Build a temporary target for the health probe — no key needed for probing.
    let health_client = reqwest::Client::new();
    let target = crate::services::llm::LlmTarget {
        provider: provider.clone(),
        model: model.clone().unwrap_or_else(|| "llama3.2".to_string()),
        base_url: base_url.clone(),
        api_key: None,
    };
    let healthy = crate::services::llm::runtime_health(&health_client, &target).await;

    Ok(Json(json!({
        "provider":       provider,
        "base_url":       base_url,
        "model":          model,
        "embedding_mode": embedding_mode.unwrap_or_else(|| "pinned".to_string()),
        "configured":     configured,
        "healthy":        healthy,
    })))
}

// ── GET /api/infra/runtimes ───────────────────────────────────────────────────

/// Return the static catalog of selectable runtime kinds for the UI.
/// Only `ollama` and `openai_compatible` are offered in this phase.
async fn list_runtimes(
    Extension(_claims): Extension<JwtClaims>,
) -> Result<Json<Value>> {
    Ok(Json(json!({
        "runtimes": [
            {
                "id":           "ollama",
                "label":        "Bundled Ollama",
                "kind":         "ollama",
                "needs_base_url": false,
                "description":  "Local Ollama bundled with GCTRL. No key required. Default when nothing is configured.",
            },
            {
                "id":           "openai_compatible",
                "label":        "OpenAI-compatible endpoint",
                "kind":         "openai_compatible",
                "needs_base_url": true,
                "description":  "Any /v1-compatible server: LM Studio, llama.cpp, vLLM, LocalAI, or a hosted API.",
            },
        ]
    })))
}

// ── POST /api/infra/runtime ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct SetRuntimeReq {
    provider: String,
    base_url: Option<String>,
    api_key:  Option<String>,
    model:    Option<String>,
}

/// Set (UPSERT) the global active runtime. Admin-only.
///
/// Steps:
///   1. Validate provider and base_url (SSRF guard via validate_runtime_input).
///   2. Build a temporary LlmTarget and probe health — still saves even if unhealthy.
///   3. UPSERT the singleton row; seal api_key when provided; preserve existing
///      key when omitted (mirrors routes/llm.rs preserve-on-omit behaviour).
async fn set_runtime(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SetRuntimeReq>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;

    let provider = req.provider.trim().to_string();
    let base_url_raw = req.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let model = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

    // (a)+(b) Validate provider + base_url with SSRF guard.
    let validated_base: Option<String> = validate_runtime_input(&provider, base_url_raw)
        .map_err(|e| AppError::BadRequest(e))?;

    // (c) Health probe — save regardless of result but signal the caller.
    let health_client = reqwest::Client::new();
    let target = crate::services::llm::LlmTarget {
        provider: provider.clone(),
        model: model.clone().unwrap_or_else(|| "llama3.2".to_string()),
        base_url: validated_base.clone(),
        api_key: None, // health probe doesn't need the key
    };
    let healthy = crate::services::llm::runtime_health(&health_client, &target).await;

    // (d) Seal the api_key when provided.
    let sealed_key: Option<String> = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(crate::services::crypto::seal);

    // UPSERT singleton row (id=1). When api_key is omitted (NULL), COALESCE
    // preserves the existing stored key so the operator doesn't need to re-enter
    // it on every model/URL change — matching routes/llm.rs upsert behaviour.
    sqlx::query(
        "INSERT INTO runtime_config (id, provider, base_url, model, api_key, updated_at)
         VALUES (1, $1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET
             provider   = $1,
             base_url   = $2,
             model      = $3,
             api_key    = COALESCE($4, runtime_config.api_key),
             updated_at = now()",
    )
    .bind(&provider)
    .bind(&validated_base)
    .bind(&model)
    .bind(&sealed_key)
    .execute(&state.db)
    .await?;

    crate::services::audit::log_access(
        &state.db, &claims, "infra.runtime.set", "runtime_config", "1",
        0, None, true, None,
    ).await;

    let mut resp = json!({ "saved": true, "healthy": healthy });
    if !healthy {
        resp["warning"] = json!(
            "Runtime saved but health probe failed. The server may not be running yet — \
             it will be used once it is reachable."
        );
    }
    Ok(Json(resp))
}

// ── GET /api/infra/models ─────────────────────────────────────────────────────

/// `GET /api/infra/models?runtime=<kind>` → model catalog for a given runtime.
/// runtime: "ollama" | "llamacpp" | "vllm"
async fn list_gen_models(
    Extension(_claims): Extension<crate::middleware::auth::JwtClaims>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>> {
    let runtime = params.get("runtime").map(|s| s.as_str()).unwrap_or("ollama");
    let models: Vec<Value> = RUNTIME_GEN_MODELS
        .iter()
        .map(|e| {
            let arg = resolve_model_arg(e.id, runtime);
            json!({
                "id":      e.id,
                "label":   e.label,
                "arg":     arg,
                "ram_gb":  e.ram_gb,
            })
        })
        .collect();
    Ok(Json(json!({ "runtime": runtime, "models": models })))
}

// ── POST /api/infra/switch-runtime ───────────────────────────────────────────

#[derive(serde::Deserialize)]
struct SwitchRuntimeReq {
    runtime:  String,
    model:    Option<String>,
    base_url: Option<String>,
    api_key:  Option<String>,
}

/// `POST /api/infra/switch-runtime` — SSE stream, admin-only.
/// Body: `{ runtime, model?, base_url?, api_key? }`
/// runtime ∈ "ollama" | "llamacpp" | "external"
async fn switch_runtime(
    Extension(claims): Extension<crate::middleware::auth::JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SwitchRuntimeReq>,
) -> axum::response::Response {
    if let Err(e) = crate::middleware::auth::require_role(&claims, "admin") {
        return axum::response::IntoResponse::into_response(e);
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<std::result::Result<Event, Infallible>>();

    let db = state.db.clone();
    tokio::spawn(async move {
        run_switch_runtime(tx, db, req).await;
    });

    let stream = async_stream::stream! {
        while let Some(item) = rx.recv().await {
            yield item;
        }
    };

    let sse = Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    );
    axum::response::IntoResponse::into_response(sse)
}

async fn run_switch_runtime(
    tx: mpsc::UnboundedSender<std::result::Result<Event, Infallible>>,
    db: sqlx::PgPool,
    req: SwitchRuntimeReq,
) {
    let send = |event: &str, data: serde_json::Value| {
        let _ = tx.send(Ok(Event::default().event(event).data(data.to_string())));
    };

    let runtime = req.runtime.trim().to_string();

    match runtime.as_str() {
        "external" => {
            // Validate base_url and health-probe before saving.
            send("progress", json!({ "step": "validating", "message": "Validating external endpoint…" }));

            let base_url = match req.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(b) => b.to_string(),
                None => {
                    send("error", json!({ "message": "base_url is required for external runtime" }));
                    return;
                }
            };

            if let Err(e) = crate::services::llm::validate_llm_base("openai_compatible", Some(&base_url)) {
                send("error", json!({ "message": format!("Invalid base_url: {e}") }));
                return;
            }

            let model_str = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty())
                .unwrap_or("llama3.2").to_string();

            let health_client = reqwest::Client::new();
            let target = crate::services::llm::LlmTarget {
                provider: "openai_compatible".into(),
                model: model_str.clone(),
                base_url: Some(base_url.clone()),
                api_key: None,
            };
            let healthy = crate::services::llm::runtime_health(&health_client, &target).await;
            if !healthy {
                send("progress", json!({ "step": "validating", "message": "Health probe returned unhealthy — saving anyway (server may still be starting)." }));
            }

            send("progress", json!({ "step": "saving", "message": "Saving runtime config…" }));

            let api_key_opt = req.api_key.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if let Err(e) = persist_runtime(&db, "openai_compatible", Some(&base_url), Some(&model_str), api_key_opt).await {
                send("error", json!({ "message": format!("DB save failed: {e}") }));
                return;
            }

            send("done", json!({ "provider": "openai_compatible", "base_url": base_url, "model": model_str, "healthy": healthy }));
        }

        "ollama" => {
            send("progress", json!({ "step": "saving", "message": "Switching back to bundled Ollama…" }));

            if let Err(e) = persist_runtime(&db, "ollama", None, None, None).await {
                send("error", json!({ "message": format!("DB save failed: {e}") }));
                return;
            }

            // Best-effort: stop gctrl-llamacpp if running (ignore errors).
            let _ = tokio::task::spawn_blocking(|| {
                let _ = crate::routes::update::docker_http(
                    "POST",
                    "/containers/gctrl-llamacpp/stop",
                    None,
                    10,
                );
            }).await;

            send("done", json!({ "provider": "ollama" }));
        }

        "llamacpp" => {
            // 1. Resolve model arg (default: qwen2.5-3b)
            let model_id = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty())
                .unwrap_or("qwen2.5-3b");
            let hf_arg = match resolve_model_arg(model_id, "llamacpp") {
                Some(a) => a,
                None => {
                    send("error", json!({ "message": format!("Unknown model id '{model_id}'. Valid: qwen2.5-3b, qwen2.5-7b, llama-3.2-3b") }));
                    return;
                }
            };

            if !std::path::Path::new("/var/run/docker.sock").exists() {
                send("error", json!({ "message": "Docker socket not accessible — cannot launch llama.cpp container" }));
                return;
            }

            // 2. Pull image
            send("progress", json!({ "step": "pull", "message": "Pulling ghcr.io/ggml-org/llama.cpp:server…" }));
            let pull_img = "ghcr.io/ggml-org/llama.cpp:server".to_string();
            match tokio::task::spawn_blocking(move || crate::routes::update::pull_image(&pull_img)).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    send("error", json!({ "message": format!("Image pull failed: {e}") }));
                    return;
                }
                Err(e) => {
                    send("error", json!({ "message": format!("Pull task failed: {e}") }));
                    return;
                }
            }

            // 3. Detect our own network by inspecting our container
            send("progress", json!({ "step": "create", "message": "Detecting container network…" }));
            let network_mode = detect_own_network().unwrap_or_else(|| "bridge".to_string());

            // 3b. Remove old container if exists, then create + start
            send("progress", json!({ "step": "create", "message": format!("Creating gctrl-llamacpp on network '{network_mode}'…") }));
            let hf_arg_clone = hf_arg.clone();
            let net_clone = network_mode.clone();
            match tokio::task::spawn_blocking(move || {
                launch_llamacpp_container(&hf_arg_clone, &net_clone)
            }).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    send("error", json!({ "message": format!("Container create/start failed: {e}") }));
                    return;
                }
                Err(e) => {
                    send("error", json!({ "message": format!("Container task failed: {e}") }));
                    return;
                }
            }

            // 4. Poll health until ready (GGUF download can take minutes)
            send("progress", json!({ "step": "downloading model", "message": format!("Waiting for llama.cpp to download model '{hf_arg}'… (this may take several minutes)") }));
            let health_client = reqwest::Client::new();
            let model_id_owned = model_id.to_string();
            let target = crate::services::llm::LlmTarget {
                provider: "openai_compatible".into(),
                model: model_id_owned.clone(),
                base_url: Some("http://gctrl-llamacpp:8080".into()),
                api_key: None,
            };
            let healthy = poll_llamacpp_health(&health_client, &target, &tx).await;

            // 5. UPSERT runtime_config regardless of health (download continues)
            if let Err(e) = persist_runtime(
                &db,
                "openai_compatible",
                Some("http://gctrl-llamacpp:8080"),
                Some(&model_id_owned),
                None,
            ).await {
                send("error", json!({ "message": format!("DB save failed: {e}") }));
                return;
            }

            if healthy {
                send("done", json!({
                    "provider": "openai_compatible",
                    "base_url": "http://gctrl-llamacpp:8080",
                    "model": model_id_owned,
                    "note": "llama.cpp is running and healthy"
                }));
            } else {
                send("done", json!({
                    "provider": "openai_compatible",
                    "base_url": "http://gctrl-llamacpp:8080",
                    "model": model_id_owned,
                    "note": "llama.cpp container started but model download is still in progress — runtime config saved; it will serve requests once the download completes"
                }));
            }
        }

        other => {
            send("error", json!({ "message": format!("Unknown runtime '{other}'. Valid: ollama, llamacpp, external") }));
        }
    }
}

/// Poll gctrl-llamacpp's health endpoint until it responds or times out.
/// Emits periodic progress events. Returns true if healthy within the window.
async fn poll_llamacpp_health(
    client: &reqwest::Client,
    target: &crate::services::llm::LlmTarget,
    tx: &mpsc::UnboundedSender<std::result::Result<Event, Infallible>>,
) -> bool {
    // Allow up to 10 minutes for model download
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    let mut attempt = 0u32;

    loop {
        if tokio::time::Instant::now() >= deadline {
            let _ = tx.send(Ok(Event::default()
                .event("progress")
                .data(json!({ "step": "downloading model", "message": "Timed out waiting for llama.cpp — model download continues in background" }).to_string())));
            return false;
        }

        interval.tick().await;
        attempt += 1;

        if crate::services::llm::runtime_health(client, target).await {
            return true;
        }

        let _ = tx.send(Ok(Event::default()
            .event("progress")
            .data(json!({ "step": "downloading model", "message": format!("Still waiting for llama.cpp (attempt {attempt})…") }).to_string())));
    }
}

/// Detect this container's primary network by inspecting our own container.
/// Reads the container hostname from the HOSTNAME env var (Docker sets it to
/// the short container ID), then calls `GET /containers/{id}/json` and reads
/// the first key in `NetworkSettings.Networks`.
///
/// Returns None if the socket is unreachable or we're not in a container.
fn detect_own_network() -> Option<String> {
    // Docker sets HOSTNAME to the container short-id.
    let hostname = std::env::var("HOSTNAME").ok().filter(|s| !s.trim().is_empty())?;
    let hostname = hostname.trim();

    let (status, body) = crate::routes::update::docker_http(
        "GET",
        &format!("/containers/{hostname}/json"),
        None,
        10,
    ).ok()?;

    if status != 200 { return None; }

    let inspect = crate::routes::update::json_from_body(&body);

    // First try the stored NetworkMode from HostConfig.
    if let Some(nm) = inspect["HostConfig"]["NetworkMode"].as_str() {
        let nm = nm.trim();
        if !nm.is_empty() && nm != "default" {
            return Some(nm.to_string());
        }
    }

    // Fall back: the first key in NetworkSettings.Networks.
    if let Some(networks) = inspect["NetworkSettings"]["Networks"].as_object() {
        if let Some(net_name) = networks.keys().next() {
            let n = net_name.trim();
            if !n.is_empty() {
                return Some(n.to_string());
            }
        }
    }

    None
}

/// Create (or replace) and start the `gctrl-llamacpp` container.
/// - Force-removes any existing container first.
/// - Mounts a named volume `gctrl-llamacpp-models:/root/.cache` for the GGUF cache.
/// - Joins the API's own network so it's reachable at `gctrl-llamacpp:8080`.
fn launch_llamacpp_container(hf_arg: &str, network_mode: &str) -> std::result::Result<(), String> {
    // Force-remove existing container (ignore 404).
    let _ = crate::routes::update::docker_http(
        "DELETE",
        "/containers/gctrl-llamacpp?force=true",
        None,
        30,
    );

    let create_body = serde_json::json!({
        "Image": "ghcr.io/ggml-org/llama.cpp:server",
        "Cmd": ["-hf", hf_arg, "--host", "0.0.0.0", "--port", "8080", "-c", "8192"],
        "HostConfig": {
            "Binds": ["gctrl-llamacpp-models:/root/.cache"],
            "NetworkMode": network_mode,
            "RestartPolicy": { "Name": "unless-stopped" }
        }
    }).to_string();

    let (create_status, create_body_resp) = crate::routes::update::docker_http(
        "POST",
        "/containers/create?name=gctrl-llamacpp",
        Some(&create_body),
        30,
    )?;

    if create_status != 201 {
        return Err(format!("Container create HTTP {create_status}: {create_body_resp}"));
    }

    let created = crate::routes::update::json_from_body(&create_body_resp);
    let id = created["Id"].as_str().unwrap_or("gctrl-llamacpp");

    let (start_status, _) = crate::routes::update::docker_http(
        "POST",
        &format!("/containers/{id}/start"),
        None,
        10,
    )?;

    if start_status != 204 && start_status != 304 {
        return Err(format!("Container start HTTP {start_status}"));
    }

    Ok(())
}

// ── Unit tests (pure validation logic — no DB harness) ───────────────────────

#[cfg(test)]
mod runtime_tests {
    use super::validate_runtime_input;

    // ── Provider validation ───────────────────────────────────────────────────

    #[test]
    fn unknown_provider_is_rejected() {
        let err = validate_runtime_input("gpt-4o", None).unwrap_err();
        assert!(err.contains("Unknown provider"), "got: {err}");
    }

    #[test]
    fn openai_provider_is_rejected() {
        // "openai" is not in the runtime catalog (it lives in per-user providers)
        let err = validate_runtime_input("openai", None).unwrap_err();
        assert!(err.contains("Unknown provider"), "got: {err}");
    }

    #[test]
    fn anthropic_provider_is_rejected() {
        let err = validate_runtime_input("anthropic", None).unwrap_err();
        assert!(err.contains("Unknown provider"), "got: {err}");
    }

    // ── ollama ────────────────────────────────────────────────────────────────

    #[test]
    fn ollama_no_base_is_ok() {
        let result = validate_runtime_input("ollama", None);
        assert!(result.is_ok(), "got: {:?}", result);
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn ollama_with_local_base_is_ok() {
        let result = validate_runtime_input("ollama", Some("http://localhost:11434"));
        assert!(result.is_ok(), "got: {:?}", result);
    }

    #[test]
    fn ollama_with_lan_base_is_ok() {
        let result = validate_runtime_input("ollama", Some("http://10.0.0.5:11434"));
        assert!(result.is_ok(), "got: {:?}", result);
    }

    #[test]
    fn ollama_with_bad_scheme_is_rejected() {
        let err = validate_runtime_input("ollama", Some("file:///etc/passwd")).unwrap_err();
        assert!(!err.is_empty(), "got: {err}");
    }

    #[test]
    fn ollama_with_embedded_creds_is_rejected() {
        let err = validate_runtime_input("ollama", Some("http://user:pass@localhost:11434")).unwrap_err();
        assert!(!err.is_empty(), "got: {err}");
    }

    // ── openai_compatible ─────────────────────────────────────────────────────

    #[test]
    fn openai_compatible_requires_base_url() {
        let err = validate_runtime_input("openai_compatible", None).unwrap_err();
        assert!(err.contains("base_url is required"), "got: {err}");
    }

    #[test]
    fn openai_compatible_empty_base_url_rejected() {
        let err = validate_runtime_input("openai_compatible", Some("  ")).unwrap_err();
        assert!(err.contains("base_url is required"), "got: {err}");
    }

    #[test]
    fn openai_compatible_local_base_is_ok() {
        let result = validate_runtime_input("openai_compatible", Some("http://localhost:8080/v1"));
        assert!(result.is_ok(), "got: {:?}", result);
        let base = result.unwrap().unwrap();
        // Trailing slash stripped, /v1 path preserved or stripped — just check it parses.
        assert!(base.starts_with("http://localhost:8080"), "got: {base}");
    }

    #[test]
    fn openai_compatible_lan_base_is_ok() {
        let result = validate_runtime_input("openai_compatible", Some("http://10.0.0.5:8080"));
        assert!(result.is_ok(), "got: {:?}", result);
    }

    #[test]
    fn openai_compatible_embedded_creds_rejected() {
        let err = validate_runtime_input("openai_compatible", Some("http://u:p@host/v1")).unwrap_err();
        assert!(!err.is_empty(), "got: {err}");
    }

    #[test]
    fn openai_compatible_bad_scheme_rejected() {
        let err = validate_runtime_input("openai_compatible", Some("gopher://localhost")).unwrap_err();
        assert!(!err.is_empty(), "got: {err}");
    }
}

#[cfg(test)]
mod switch_runtime_tests {
    use super::{resolve_model_arg, RUNTIME_GEN_MODELS};

    // ── resolve_model_arg ────────────────────────────────────────────────────

    #[test]
    fn resolve_qwen25_3b_ollama() {
        assert_eq!(resolve_model_arg("qwen2.5-3b", "ollama").as_deref(), Some("qwen2.5:3b"));
    }

    #[test]
    fn resolve_qwen25_3b_llamacpp() {
        assert_eq!(
            resolve_model_arg("qwen2.5-3b", "llamacpp").as_deref(),
            Some("bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"),
        );
    }

    #[test]
    fn resolve_qwen25_3b_vllm() {
        assert_eq!(
            resolve_model_arg("qwen2.5-3b", "vllm").as_deref(),
            Some("Qwen/Qwen2.5-3B-Instruct"),
        );
    }

    #[test]
    fn resolve_qwen25_7b_ollama() {
        assert_eq!(resolve_model_arg("qwen2.5-7b", "ollama").as_deref(), Some("qwen2.5:7b"));
    }

    #[test]
    fn resolve_qwen25_7b_llamacpp() {
        assert_eq!(
            resolve_model_arg("qwen2.5-7b", "llamacpp").as_deref(),
            Some("bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M"),
        );
    }

    #[test]
    fn resolve_llama32_3b_all_runtimes() {
        assert_eq!(resolve_model_arg("llama-3.2-3b", "ollama").as_deref(), Some("llama3.2"));
        assert_eq!(
            resolve_model_arg("llama-3.2-3b", "llamacpp").as_deref(),
            Some("bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M"),
        );
        assert_eq!(
            resolve_model_arg("llama-3.2-3b", "vllm").as_deref(),
            Some("meta-llama/Llama-3.2-3B-Instruct"),
        );
    }

    #[test]
    fn resolve_unknown_model_returns_none() {
        assert!(resolve_model_arg("gpt-4o", "ollama").is_none());
        assert!(resolve_model_arg("", "llamacpp").is_none());
        assert!(resolve_model_arg("nonexistent", "vllm").is_none());
    }

    #[test]
    fn resolve_unknown_runtime_returns_none() {
        assert!(resolve_model_arg("qwen2.5-3b", "tgi").is_none());
        assert!(resolve_model_arg("qwen2.5-3b", "").is_none());
        assert!(resolve_model_arg("qwen2.5-7b", "lmstudio").is_none());
    }

    #[test]
    fn default_model_id_resolves_llamacpp() {
        // The default model when none is specified is "qwen2.5-3b"
        let default_id = "qwen2.5-3b";
        let arg = resolve_model_arg(default_id, "llamacpp");
        assert!(arg.is_some(), "default model must resolve for llamacpp");
        assert_eq!(arg.as_deref(), Some("bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"));
    }

    #[test]
    fn catalog_has_three_entries() {
        assert_eq!(RUNTIME_GEN_MODELS.len(), 3);
    }

    #[test]
    fn all_catalog_entries_have_all_runtimes() {
        for entry in RUNTIME_GEN_MODELS {
            assert!(!entry.ollama.is_empty(), "ollama tag missing for {}", entry.id);
            assert!(!entry.llamacpp.is_empty(), "llamacpp arg missing for {}", entry.id);
            assert!(!entry.vllm.is_empty(), "vllm repo missing for {}", entry.id);
            assert!(entry.ram_gb > 0.0, "ram_gb must be positive for {}", entry.id);
        }
    }

    // ── Runtime string validation ────────────────────────────────────────────

    #[test]
    fn valid_runtimes() {
        // These are the three valid runtime strings for switch-runtime
        for rt in &["ollama", "llamacpp", "external"] {
            assert!(matches!(*rt, "ollama" | "llamacpp" | "external"),
                "runtime '{rt}' should be valid");
        }
    }

    #[test]
    fn invalid_runtimes_not_in_set() {
        for rt in &["vllm", "openai", "tgi", ""] {
            assert!(!matches!(*rt, "ollama" | "llamacpp" | "external"),
                "runtime '{rt}' should be invalid");
        }
    }
}

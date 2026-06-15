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
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
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

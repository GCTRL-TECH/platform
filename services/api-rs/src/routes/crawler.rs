//! Web-crawler ingest (`/api/crawler`).
//!
//! The dashboard's "Crawl a Website" action (KEX → Sources → Web Crawler) POSTs a
//! start URL plus crawl bounds here. We mirror the `/api/kex/extract` text-ingest
//! path exactly — create a `jobs` row, deduct tokens, resolve the ontology, link
//! the job into a target compilation, inject the owner's Ollama overrides, and
//! enqueue onto the same `kex:jobs` Redis list the KEX worker drains.
//!
//! The only differences from `/extract` are the job `type` (`crawl`) and the
//! payload fields the worker needs to drive a multi-page crawl: `url`,
//! `max_pages`, `max_depth`. The worker fans the start URL out into pages and
//! extracts each one into the resolved ontology / compilation.
//!
//! ## Routes (mounted under `/api/crawler`)
//!
//! - `POST /crawl` → `{ jobId, status: "pending" }`

use axum::{
    extract::{Extension, State},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
    routes::kex::{link_job_to_target_or_default, resolve_ontology},
    services::{redis::lpush, usage::record_usage},
};

#[derive(Deserialize)]
struct CrawlReq {
    url: String,
    #[serde(rename = "maxDepth")]              max_depth:               Option<i64>,
    #[serde(rename = "maxPages")]              max_pages:               Option<i64>,
    #[serde(rename = "ontologyId")]            ontology_id:             Option<Uuid>,
    #[serde(rename = "discoveryMode")]         discovery_mode:          Option<String>,
    #[serde(rename = "classificationLevelId")] classification_level_id: Option<Uuid>,
    #[serde(rename = "compilationId")]         compilation_id:          Option<Uuid>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new().route("/crawl", post(crawl))
}

/// POST /api/crawler/crawl — enqueue a website crawl into the KEX pipeline.
///
/// Mirrors `kex::extract`: same token spend, ontology resolution, compilation
/// linking, classification forwarding, and Ollama override injection. Enqueues a
/// single `kex:jobs` payload of `type: "crawl"` that carries the crawl bounds.
async fn crawl(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CrawlReq>,
) -> Result<Json<Value>> {
    // Normalise + validate the start URL (default to https:// if scheme omitted,
    // matching the web client's own fixup so either side is forgiving).
    let mut url = req.url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::BadRequest("url is required".into()));
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        url = format!("https://{url}");
    }
    let parsed = url::Url::parse(&url)
        .map_err(|_| AppError::BadRequest("invalid url".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::BadRequest("url must be http(s)".into()));
    }
    // SSRF guard: resolve the host and reject any non-public address (loopback,
    // RFC1918, link-local / cloud-metadata, CGNAT, etc.) so an authenticated user
    // cannot make the server crawl internal services. KEX re-validates every page
    // and redirect hop for defence-in-depth (DNS-rebinding / redirect bypass).
    assert_public_url(&parsed).await?;

    // Clamp crawl bounds to sane limits (mirrors the legacy crawler's zod schema).
    let max_depth = req.max_depth.unwrap_or(3).clamp(1, 10);
    let max_pages = req.max_pages.unwrap_or(50).clamp(1, 200);

    // GREATEST(0, ...) prevents negative balances if a prior bug/race left them stuck.
    sqlx::query("UPDATE users SET tokens_balance = GREATEST(0, tokens_balance - 5) WHERE id = $1")
        .bind(claims.sub).execute(&state.db).await?;

    let (ontology_id, entity_types) = resolve_ontology(&state.db, claims.sub, req.ontology_id).await;

    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id)
         VALUES ($1, $2, 'kex_extract', 'pending', $3, $4)"
    )
    .bind(job_id).bind(claims.sub)
    .bind(json!({
        "source": "web_crawl",
        "url": url,
        "fileName": url,
        "maxDepth": max_depth,
        "maxPages": max_pages,
        "ontologyId": ontology_id,
        "discoveryMode": req.discovery_mode.clone().unwrap_or_else(|| "discover".into()),
    }))
    .bind(req.classification_level_id)
    .execute(&state.db).await?;

    // Record the spend locally so the heartbeat task can ship it upstream.
    record_usage(&state.db, claims.sub, "kex_extract", 5, Some(job_id)).await;

    // Link into the target compilation: explicit choice, else the user's default
    // knowledge base, so the crawled pages are never orphaned.
    link_job_to_target_or_default(&state.db, claims.sub, req.compilation_id, job_id).await;

    // Look up classification name to forward to KEX worker for Neo4j tagging.
    let classification_name: Option<String> = if let Some(clf_id) = req.classification_level_id {
        sqlx::query_scalar("SELECT name FROM classification_levels WHERE id = $1")
            .bind(clf_id).fetch_optional(&state.db).await.ok().flatten()
    } else {
        None
    };

    let mut payload = json!({
        "job_id": job_id, "user_id": claims.sub, "type": "crawl",
        "url": url,
        "max_pages": max_pages,
        "max_depth": max_depth,
        "entity_types": entity_types,
        "ontology_id": ontology_id,
        "classification": classification_name,
        "classification_level_id": req.classification_level_id,
    });
    crate::services::llm::inject_ollama_overrides(&state.db, claims.sub, &mut payload).await;
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
}

// ── SSRF protection ─────────────────────────────────────────────────────────
/// Reject a URL whose host resolves to ANY non-public IP. Resolving here (not
/// just string-matching) blocks literal-IP and DNS-based attempts to reach
/// internal infra / cloud metadata. KEX re-checks each fetch + redirect hop.
async fn assert_public_url(parsed: &url::Url) -> Result<()> {
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::BadRequest("url has no host".into()))?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| AppError::BadRequest("could not resolve url host".into()))?
        .collect();
    if addrs.is_empty() {
        return Err(AppError::BadRequest("could not resolve url host".into()));
    }
    if addrs.iter().any(|a| ip_is_blocked(a.ip())) {
        return Err(AppError::BadRequest("url resolves to a non-public address (blocked)".into()));
    }
    Ok(())
}

fn ip_is_blocked(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(a) => ipv4_blocked(a.octets()),
        std::net::IpAddr::V6(a) => {
            if a.is_loopback() || a.is_unspecified() {
                return true;
            }
            if let Some(v4) = a.to_ipv4_mapped() {
                return ipv4_blocked(v4.octets());
            }
            let s = a.segments();
            (s[0] & 0xffc0) == 0xfe80      // link-local fe80::/10
                || (s[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (s[0] & 0xff00) == 0xff00 // multicast ff00::/8
        }
    }
}

fn ipv4_blocked(o: [u8; 4]) -> bool {
    o[0] == 0                                          // 0.0.0.0/8 (this host)
        || o[0] == 127                                 // loopback
        || o[0] == 10                                  // RFC1918 private
        || (o[0] == 172 && (16..=31).contains(&o[1]))  // RFC1918 private
        || (o[0] == 192 && o[1] == 168)                // RFC1918 private
        || (o[0] == 169 && o[1] == 254)                // link-local (incl. 169.254.169.254 metadata)
        || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT 100.64/10
        || o[0] >= 224                                 // multicast / reserved
}

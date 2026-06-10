use axum::{extract::State, http::HeaderMap, response::IntoResponse, routing::{get, post}, Json, Router};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};

use crate::middleware::auth::JwtClaims;

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/status",   get(status))
        .route("/activate", post(activate))
}

// ─── Activate ────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct ActivateRequest {
    license_key: String,
}

async fn activate(
    State(state): State<Arc<crate::models::AppState>>,
    headers: HeaderMap,
    Json(req): Json<ActivateRequest>,
) -> impl IntoResponse {
    let client = reqwest::Client::new();

    // If the caller is authenticated (Settings page, post-login), we'll persist
    // the license JWT to their licenses row so the heartbeat loop can use it.
    let caller = extract_optional_claims(&headers, &state.cfg.jwt_secret);

    // ── 1. Try gctrl-agent (production stack) ──────────────────────────────
    let agent_resp = client
        .post("http://gctrl-agent:7070/activate")
        .json(&serde_json::json!({ "license_key": req.license_key }))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;

    if let Ok(resp) = agent_resp {
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        if status.is_success() {
            // Spawn Docker pull + resolver start in background (best-effort).
            let registry_token = body["registry_token"].as_str().unwrap_or("").to_string();
            let pulling_fusion = !registry_token.is_empty();
            if pulling_fusion {
                tokio::task::spawn_blocking(move || {
                    if let Err(e) = docker_pull_fusion_engine(&registry_token) {
                        tracing::warn!("Failed to pull fusion-engine: {e}");
                    } else if let Err(e) = docker_start_resolver() {
                        tracing::warn!("Failed to start resolver: {e}");
                    } else {
                        tracing::info!("fusion-engine pulled and gctrl-resolver started");
                    }
                });
            }
            persist_license_from_response(&state.db, caller.as_ref(), &req.license_key, &body).await;
            return (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "tier": body["tier"],
                    "credits_balance": body["credits_balance"],
                    "fusion_engine_pulling": pulling_fusion,
                    "via": "agent",
                })),
            );
        } else {
            let msg = body["error"].as_str().unwrap_or("Agent rejected key").to_string();
            return (
                axum::http::StatusCode::from_u16(status.as_u16())
                    .unwrap_or(axum::http::StatusCode::BAD_REQUEST),
                Json(serde_json::json!({ "error": msg })),
            );
        }
    }

    // ── 2. Agent unreachable → talk directly to license-api ───────────────
    // Production fallback (and the path that just works for local dev where
    // gctrl-agent isn't deployed). License-api at api.gctrl.tech is the
    // source of truth for license keys.
    let license_api_url = std::env::var("GCTRL_LICENSE_API_URL")
        .unwrap_or_else(|_| "https://api.gctrl.tech".into());
    let direct = client
        .post(format!("{license_api_url}/v1/activate"))
        .json(&serde_json::json!({
            "license_key": req.license_key,
            "hardware_fingerprint": "local-dev",
        }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    if let Ok(resp) = direct {
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        if status.is_success() {
            persist_license_from_response(&state.db, caller.as_ref(), &req.license_key, &body).await;
            return (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "tier": body["tier"],
                    "credits_balance": body["credits_balance"],
                    "fusion_engine_pulling": false,
                    "via": "license-api",
                })),
            );
        } else {
            let msg = body["error"].as_str().unwrap_or("License rejected").to_string();
            return (
                axum::http::StatusCode::from_u16(status.as_u16())
                    .unwrap_or(axum::http::StatusCode::BAD_REQUEST),
                Json(serde_json::json!({ "error": msg })),
            );
        }
    }

    // ── 3. Both unreachable → record locally so dev / offline still works ─
    // The /billing/license endpoint linked from the frontend will persist
    // the key and tier into the local licenses table after this returns
    // ok=true. We return a default 'free' tier so the UI is functional.
    (
        axum::http::StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "tier": "free",
            "credits_balance": 3000,
            "fusion_engine_pulling": false,
            "via": "local-only",
            "warning": "Agent + license server unreachable — license recorded locally only",
        })),
    )
}

/// Read & verify Authorization: Bearer <jwt> if present. Unauthenticated
/// callers (Activation Wizard) just won't get their license JWT persisted —
/// the heartbeat loop tolerates that and stays a no-op for those users until
/// they re-activate while logged-in (Settings → Activate).
fn extract_optional_claims(headers: &HeaderMap, secret: &str) -> Option<JwtClaims> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))?;
    let key = DecodingKey::from_secret(secret.as_bytes());
    decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256))
        .ok()
        .map(|d| d.claims)
}

/// Persist the license JWT (+ tier + credits) returned by license-api/agent
/// into the local `licenses` row. UPSERT on `license_key` (the unique key) so
/// reactivations refresh the JWT in place. Best-effort: a DB failure here just
/// means the heartbeat loop won't kick in until the next successful activate.
async fn persist_license_from_response(
    db: &sqlx::PgPool,
    caller: Option<&JwtClaims>,
    license_key: &str,
    body: &serde_json::Value,
) {
    let Some(claims) = caller else {
        // Unauthenticated activate (ActivationWizard before login). Frontend
        // will follow up with /billing/license once logged in, which already
        // stores the key+tier — but without the JWT. That's fine, the user
        // can reactivate from Settings to enable heartbeat sync.
        return;
    };

    let license_jwt = body["license_jwt"].as_str();
    let tier = body["tier"].as_str().unwrap_or("free").to_string();
    // license-api returns `credits_balance` (snake) = remaining credits.
    let credits_remaining = body["credits_balance"].as_i64().unwrap_or(3000) as i32;
    // We treat that as the allocation (used=0) on first activation. Subsequent
    // heartbeats reconcile via licenses.credits_used.
    let credits_allocated = credits_remaining.max(0);

    let res = sqlx::query(
        "INSERT INTO licenses (user_id, license_key, tier, credits_allocated, license_jwt, license_jwt_updated_at) \
         VALUES ($1, $2, $3, $4, $5, NOW()) \
         ON CONFLICT (license_key) DO UPDATE SET \
            tier = EXCLUDED.tier, \
            credits_allocated = EXCLUDED.credits_allocated, \
            license_jwt = COALESCE(EXCLUDED.license_jwt, licenses.license_jwt), \
            license_jwt_updated_at = CASE \
                WHEN EXCLUDED.license_jwt IS NOT NULL THEN NOW() \
                ELSE licenses.license_jwt_updated_at \
            END, \
            status = 'active', \
            updated_at = NOW()",
    )
    .bind(claims.sub)
    .bind(license_key)
    .bind(&tier)
    .bind(credits_allocated)
    .bind(license_jwt)
    .execute(db)
    .await;

    if let Err(e) = res {
        tracing::warn!("persist_license_from_response: {e}");
    }
}

// ─── Docker helpers ───────────────────────────────────────────────────────────

#[cfg(unix)]
fn docker_pull_fusion_engine(registry_token: &str) -> Result<(), String> {
    use base64::Engine;
    use std::io::{Read, Write};

    let auth_json = serde_json::json!({
        "username": "gctrl",
        "password": registry_token,
        "serveraddress": "ghcr.io"
    })
    .to_string();
    let auth_b64 = base64::engine::general_purpose::STANDARD.encode(&auth_json);

    let image = "ghcr.io%2Fgctrl-tech%2Ffusion-engine";
    let path = format!("/images/create?fromImage={image}&tag=latest");

    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nX-Registry-Auth: {auth_b64}\r\nContent-Length: 0\r\n\r\n"
    );

    let mut stream = std::os::unix::net::UnixStream::connect("/var/run/docker.sock")
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(300)))
        .ok();
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|e| e.to_string())?;

    let mut resp = String::new();
    stream
        .read_to_string(&mut resp)
        .map_err(|e| e.to_string())?;

    if resp.starts_with("HTTP/1.1 200") || resp.starts_with("HTTP/1.1 204") {
        Ok(())
    } else {
        Err(format!(
            "Docker pull failed: {}",
            resp.lines().next().unwrap_or("")
        ))
    }
}

#[cfg(not(unix))]
fn docker_pull_fusion_engine(_registry_token: &str) -> Result<(), String> {
    Err("Docker socket not available on non-Unix platforms".into())
}

#[cfg(unix)]
fn docker_start_resolver() -> Result<(), String> {
    // First try to remove any existing stopped container
    let _ = docker_socket_request("DELETE", "/containers/gctrl-resolver?force=true", None);

    // Create container
    let body = serde_json::json!({
        "Image": "ghcr.io/gctrl-tech/fusion-engine:latest",
        "Env": ["JAVA_OPTS=-Xmx2G"],
        "Cmd": ["-s"],
        "HostConfig": {
            "RestartPolicy": { "Name": "unless-stopped" },
            "NetworkMode": "gctrl"
        }
    })
    .to_string();

    let create_resp = docker_socket_request(
        "POST",
        "/containers/create?name=gctrl-resolver",
        Some(&body),
    )?;

    // Extract container ID
    let id: serde_json::Value =
        serde_json::from_str(&create_resp).map_err(|e| e.to_string())?;
    let container_id = id["Id"].as_str().unwrap_or("gctrl-resolver");

    // Start container
    docker_socket_request("POST", &format!("/containers/{container_id}/start"), None)?;

    Ok(())
}

#[cfg(not(unix))]
fn docker_start_resolver() -> Result<(), String> {
    Err("Docker socket not available on non-Unix platforms".into())
}

#[cfg(unix)]
fn docker_socket_request(
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<String, String> {
    use std::io::{Read, Write};

    let body_str = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body_str}",
        body_str.len()
    );

    let mut stream = std::os::unix::net::UnixStream::connect("/var/run/docker.sock")
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .ok();
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|e| e.to_string())?;

    let mut resp = String::new();
    stream
        .read_to_string(&mut resp)
        .map_err(|e| e.to_string())?;
    Ok(resp)
}

// ─── Status ───────────────────────────────────────────────────────────────────

async fn probe_tcp(host: &str, port: u16) -> Option<u128> {
    let start = std::time::Instant::now();
    timeout(Duration::from_millis(2000), TcpStream::connect((host, port)))
        .await
        .ok()?
        .ok()?;
    Some(start.elapsed().as_millis())
}

async fn probe_http(url: &str) -> Option<u128> {
    let start = std::time::Instant::now();
    let client = reqwest::Client::new();
    let resp = timeout(Duration::from_millis(3000), client.get(url).send())
        .await
        .ok()?
        .ok()?;
    if resp.status().as_u16() < 500 {
        Some(start.elapsed().as_millis())
    } else {
        None
    }
}

async fn status(State(state): State<Arc<crate::models::AppState>>) -> Json<Value> {
    let qdrant = state.cfg.qdrant_url.clone();
    let ollama =
        std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://localhost:11434".into());
    let neo4j_uri = state.cfg.neo4j_uri.clone();
    let redis_url = state.cfg.redis_url.clone();

    let (neo4j_res, qdrant_res, ollama_res, pg_res, redis_res) = tokio::join!(
        async {
            let start = std::time::Instant::now();
            match state.neo.run(neo4rs::query("RETURN 1")).await {
                Ok(_) => json!({ "connected": true,  "latencyMs": start.elapsed().as_millis() as i64 }),
                Err(_) => json!({ "connected": false, "latencyMs": null }),
            }
        },
        async {
            match probe_http(&format!("{}/", &qdrant)).await {
                Some(ms) => json!({ "connected": true,  "latencyMs": ms as i64 }),
                None     => json!({ "connected": false, "latencyMs": null }),
            }
        },
        async {
            match probe_http(&format!("{}/", &ollama)).await {
                Some(ms) => json!({ "connected": true,  "latencyMs": ms as i64 }),
                None     => json!({ "connected": false, "latencyMs": null }),
            }
        },
        async {
            let start = std::time::Instant::now();
            match sqlx::query("SELECT 1").execute(&state.db).await {
                Ok(_) => json!({ "connected": true,  "latencyMs": start.elapsed().as_millis() as i64 }),
                Err(_) => json!({ "connected": false, "latencyMs": null }),
            }
        },
        async {
            // Parse redis://host:port
            let addr = redis_url.trim_start_matches("redis://");
            let parts: Vec<&str> = addr.splitn(2, ':').collect();
            let host = parts.first().copied().unwrap_or("localhost");
            let port: u16 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(6379);
            match probe_tcp(host, port).await {
                Some(ms) => json!({ "connected": true,  "latencyMs": ms as i64 }),
                None     => json!({ "connected": false, "latencyMs": null }),
            }
        },
    );

    Json(json!({
        "services": {
            "neo4j":    { "url": neo4j_uri,        "connected": neo4j_res["connected"],  "latencyMs": neo4j_res["latencyMs"] },
            "qdrant":   { "url": qdrant,            "connected": qdrant_res["connected"], "latencyMs": qdrant_res["latencyMs"] },
            "ollama":   { "url": ollama,            "connected": ollama_res["connected"], "latencyMs": ollama_res["latencyMs"] },
            "postgres": { "url": "(configured)",   "connected": pg_res["connected"],     "latencyMs": pg_res["latencyMs"] },
            "redis":    { "url": "(configured)",   "connected": redis_res["connected"],  "latencyMs": redis_res["latencyMs"] },
        }
    }))
}

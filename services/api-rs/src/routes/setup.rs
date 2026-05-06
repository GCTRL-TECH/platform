use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new().route("/status", get(status))
}

async fn probe_tcp(host: &str, port: u16) -> Option<u128> {
    let start = std::time::Instant::now();
    timeout(Duration::from_millis(2000), TcpStream::connect((host, port)))
        .await.ok()?.ok()?;
    Some(start.elapsed().as_millis())
}

async fn probe_http(url: &str) -> Option<u128> {
    let start = std::time::Instant::now();
    let client = reqwest::Client::new();
    let resp = timeout(Duration::from_millis(3000), client.get(url).send())
        .await.ok()?.ok()?;
    if resp.status().as_u16() < 500 { Some(start.elapsed().as_millis()) } else { None }
}

async fn status(State(state): State<Arc<crate::models::AppState>>) -> Json<Value> {
    let qdrant = state.cfg.qdrant_url.clone();
    let ollama = std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://localhost:11434".into());
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

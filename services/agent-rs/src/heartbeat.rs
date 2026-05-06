use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio::time::{sleep, Duration};
use serde::{Deserialize, Serialize};

use crate::{config::Config, license::LicenseCache, usage_queue::UsageQueue};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const REPORT_INTERVAL:    Duration = Duration::from_secs(15 * 60);

#[derive(Serialize)]
struct HeartbeatPayload {
    usage_report: Vec<crate::usage_queue::UsageRecord>,
}

#[derive(Deserialize)]
struct HeartbeatResponse {
    license_jwt: Option<String>,
}

pub async fn beat(
    cache: Arc<RwLock<LicenseCache>>,
    queue: Arc<Mutex<UsageQueue>>,
    cfg:   &Config,
) {
    let records    = queue.lock().await.flush();
    let payload    = HeartbeatPayload { usage_report: records.clone() };
    let jwt        = tokio::fs::read_to_string(&cfg.license_jwt_path).await.unwrap_or_default();
    let license_jwt_path = cfg.license_jwt_path.clone();
    let license_public_key = cfg.license_public_key.clone();
    let api_url    = cfg.api_url.clone();

    let client = reqwest::Client::new();
    match client
        .post(format!("{api_url}/v1/heartbeat"))
        .bearer_auth(jwt.trim())
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(body) = resp.json::<HeartbeatResponse>().await {
                if let Some(new_jwt) = body.license_jwt {
                    if let Err(e) = tokio::fs::write(&license_jwt_path, new_jwt.trim()).await {
                        tracing::warn!("Failed to persist JWT: {e}");
                        return;
                    }
                    match LicenseCache::load_from_disk(&license_jwt_path, &license_public_key).await {
                        Ok(new_cache) => {
                            *cache.write().await = new_cache;
                            tracing::info!("Heartbeat OK — balance={}", cache.read().await.balance());
                        }
                        Err(e) => tracing::warn!("JWT reload failed: {e}"),
                    }
                }
            }
        }
        Ok(resp) => tracing::warn!("Heartbeat server error: {}", resp.status()),
        Err(e) => {
            tracing::warn!("Heartbeat failed: {e} — re-queuing {} records", records.len());
            let mut q = queue.lock().await;
            for r in records {
                q.enqueue(r.action, r.chars_processed, r.credits_spent);
            }
        }
    }
}

pub async fn run_loop(
    cache: Arc<RwLock<LicenseCache>>,
    queue: Arc<Mutex<UsageQueue>>,
    cfg:   Config,
) {
    let mut last_heartbeat = std::time::Instant::now();
    loop {
        // Skip heartbeat entirely if not yet activated
        if !cache.read().await.is_activated() {
            sleep(Duration::from_secs(60)).await;
            continue;
        }

        let has_records  = queue.lock().await.size() > 0;
        let time_since   = last_heartbeat.elapsed();

        if (has_records && time_since >= REPORT_INTERVAL) || time_since >= HEARTBEAT_INTERVAL {
            beat(cache.clone(), queue.clone(), &cfg).await;
            last_heartbeat = std::time::Instant::now();
        }
        sleep(Duration::from_secs(60)).await;
    }
}

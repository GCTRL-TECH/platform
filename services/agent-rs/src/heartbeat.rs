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
    /// The agent's cached ER-tuning version (version-delta: the server only sends
    /// a tuning blob when this is stale, so steady state carries nothing extra).
    #[serde(skip_serializing_if = "Option::is_none")]
    tuning_version: Option<i64>,
    /// The RELEASE this instance is currently running (None on a fresh install
    /// that hasn't been seeded yet). Lets the server see per-instance version drift.
    #[serde(skip_serializing_if = "Option::is_none")]
    instance_version: Option<String>,
}

#[derive(Deserialize)]
struct TuningDelta {
    #[allow(dead_code)]
    version: i64,
    jws: String,
}

#[derive(Deserialize)]
struct HeartbeatResponse {
    license_jwt: Option<String>,
    #[serde(default)]
    tuning: Option<TuningDelta>,
}

pub async fn beat(
    cache: Arc<RwLock<LicenseCache>>,
    queue: Arc<Mutex<UsageQueue>>,
    cfg:   &Config,
) {
    let records    = queue.lock().await.flush();
    // Tell the server our cached tuning version so it only re-sends on a bump.
    let tuning_version = crate::tuning::read_cache(&cfg.tuning_profile_path).await.map(|t| t.version);
    // Report the RELEASE this instance is on — but ONLY when it changed since the
    // cloud last acknowledged it. Steady-state heartbeats carry nothing; we signal
    // a version exactly on change (fresh install / after an update), then go quiet.
    // If the change-triggered report fails, the next heartbeat re-sends it (still
    // unacknowledged) — never routine chatter.
    let current_version  = crate::version::read_current(&cfg.version_path).await;
    let reported_version = crate::version::read_current(&cfg.reported_version_path).await;
    let instance_version = current_version
        .clone()
        .filter(|c| reported_version.as_deref() != Some(c.as_str()));
    let payload    = HeartbeatPayload { usage_report: records.clone(), tuning_version, instance_version: instance_version.clone() };
    let jwt        = tokio::fs::read_to_string(&cfg.license_jwt_path).await.unwrap_or_default();
    let license_jwt_path = cfg.license_jwt_path.clone();
    let license_public_key = cfg.license_public_key.clone();
    let tuning_profile_path = cfg.tuning_profile_path.clone();
    let version_path = cfg.version_path.clone();
    let reported_version_path = cfg.reported_version_path.clone();
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
                    } else {
                        match LicenseCache::load_from_disk(&license_jwt_path, &license_public_key).await {
                            Ok(new_cache) => {
                                *cache.write().await = new_cache;
                                tracing::info!("Heartbeat OK — balance={}", cache.read().await.balance());
                            }
                            Err(e) => tracing::warn!("JWT reload failed: {e}"),
                        }
                    }
                }

                // ER tuning delta: only trust a tuning blob while the license is
                // valid. Verify the JWS with the embedded public key; on success
                // persist it as the new last-good cache, otherwise keep the prior
                // one (a tuning miss never breaks FUSE — it falls back to generic).
                if let Some(td) = body.tuning {
                    if cache.read().await.is_valid() {
                        match crate::tuning::verify_tuning_jws(&td.jws, &license_public_key) {
                            Ok(ct) => match crate::tuning::write_cache(&tuning_profile_path, &ct).await {
                                Ok(()) => tracing::info!("ER tuning profile updated to v{}", ct.version),
                                Err(e) => tracing::warn!("tuning cache write failed: {e}"),
                            },
                            Err(e) => tracing::warn!("tuning JWS rejected (keeping last-good): {e}"),
                        }
                    }
                }

                // We sent a changed version this beat → mark it acknowledged so
                // subsequent steady-state heartbeats stay quiet (only re-sends on
                // the next genuine change). On failure the marker stays behind, so
                // the next heartbeat retries automatically.
                if let Some(sent) = instance_version.as_ref() {
                    if let Err(e) = crate::version::write_current(&reported_version_path, sent).await {
                        tracing::warn!("reported_version marker write failed: {e}");
                    }
                }

                // Seed current_version on a fresh install. A fresh install just pulled
                // `:latest`, so it IS on the latest release — but the local version file
                // doesn't exist yet. If it's still unset, seed it from the license's
                // latest_version so updateAvailable computes as false out of the box.
                // (It reports on the next beat via the change-detection above.)
                // Never overwrite an existing current_version here (updates own that).
                if current_version.is_none() {
                    let latest = cache.read().await.latest_version().to_string();
                    if !latest.is_empty() {
                        match crate::version::write_current(&version_path, &latest).await {
                            Ok(()) => tracing::info!("Seeded current_version to {latest} (fresh install)"),
                            Err(e) => tracing::warn!("current_version seed write failed: {e}"),
                        }
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

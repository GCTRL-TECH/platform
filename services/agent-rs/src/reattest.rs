//! Automatic license re-attestation.
//!
//! When the agent is in GRACE (a validly-signed license whose fingerprint binding
//! is stale — e.g. the first boot after the instance-id fingerprint fix), it
//! re-binds the license to the current stable instance id using the license key
//! persisted at activation, with exponential backoff. This is what makes the fix
//! self-healing instead of requiring a manual re-activation.
//!
//! Failure policy (matches the requirement "a hard fail only on active rejection"):
//!   - server unreachable / 5xx / transport error  -> RETRY (grace continues; the
//!     signed JWT keeps enforcement working, so ingestion never stops).
//!   - 4xx active rejection (revoked / seat limit)  -> drop to unactivated.
//!   - success                                      -> fresh JWT, grace cleared.

use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};

use crate::{config::Config, license::LicenseCache};

enum Outcome { Ok, Rejected(&'static str), Retry }

pub async fn run_loop(cache: Arc<RwLock<LicenseCache>>, cfg: Config) {
    let base = Duration::from_secs(15);
    let max  = Duration::from_secs(30 * 60);
    let mut backoff = base;
    let client = reqwest::Client::new();

    loop {
        if !cache.read().await.needs_reattest() {
            backoff = base;
            sleep(Duration::from_secs(120)).await;
            continue;
        }

        // The key is required to re-bind. Installs activated before key-persistence
        // shipped won't have it — they stay in grace (enforcement still works) until
        // an operator re-activates once from Settings, which persists the key.
        let key = tokio::fs::read_to_string(&cfg.license_key_path).await.ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let Some(key) = key else {
            tracing::warn!("re-attest: no persisted license key yet — staying in grace; re-activate once from Settings to rebind this instance");
            sleep(Duration::from_secs(10 * 60)).await;
            continue;
        };

        match attempt(&client, &cache, &cfg, &key).await {
            Outcome::Ok => {
                tracing::info!("re-attest: license re-bound to this instance id");
                backoff = base;
            }
            Outcome::Rejected(reason) => {
                tracing::error!("re-attest: license server actively rejected re-binding ({reason}) — enforcement disabled until re-activated");
                cache.write().await.mark_unactivated(reason);
            }
            Outcome::Retry => {
                tracing::warn!("re-attest: transient failure — staying in grace, retrying in {}s", backoff.as_secs());
                sleep(backoff).await;
                backoff = (backoff * 2).min(max);
            }
        }
    }
}

async fn attempt(
    client: &reqwest::Client,
    cache: &Arc<RwLock<LicenseCache>>,
    cfg: &Config,
    key: &str,
) -> Outcome {
    let fingerprint = crate::fingerprint::compute(&cfg.instance_id_path).await;
    let url = format!("{}/v1/activate", cfg.api_url);
    let resp = match client
        .post(&url)
        .json(&serde_json::json!({ "license_key": key, "hardware_fingerprint": fingerprint }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Outcome::Retry, // server unreachable -> keep grace
    };

    let status = resp.status();
    if status.is_success() {
        #[derive(serde::Deserialize)]
        struct ActivateResp { license_jwt: String }
        let Ok(data) = resp.json::<ActivateResp>().await else { return Outcome::Retry };
        if let Err(e) = tokio::fs::write(&cfg.license_jwt_path, data.license_jwt.trim()).await {
            tracing::warn!("re-attest: failed to persist refreshed JWT: {e}");
            return Outcome::Retry;
        }
        match LicenseCache::from_token(&data.license_jwt, &cfg.license_public_key) {
            Ok(fresh) => { *cache.write().await = fresh; Outcome::Ok }
            Err(e) => { tracing::warn!("re-attest: refreshed JWT parse failed: {e}"); Outcome::Retry }
        }
    } else if status.is_client_error() {
        // 4xx = the server made a decision about THIS key/seat: revoked, seat limit,
        // invalid. Re-trying won't change it — surface it as unenforceable.
        Outcome::Rejected("server_rejected")
    } else {
        // 5xx / anything else = server-side transient -> keep grace, retry.
        Outcome::Retry
    }
}

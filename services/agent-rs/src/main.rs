mod config;
mod docker;
mod error;
mod fingerprint;
mod license;
mod credits;
mod usage_queue;
mod heartbeat;
mod reattest;
mod tuning;
mod version;
mod server;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg = config::Config::from_env();
    tracing::info!("GCTRL Agent starting — license path: {}", cfg.license_jwt_path);

    let cache = match license::LicenseCache::load_from_disk(&cfg.license_jwt_path, &cfg.license_public_key).await {
        Ok(loaded) => {
            let fp = fingerprint::compute(&cfg.instance_id_path).await;
            if loaded.hardware_fingerprint() != fp {
                // GRACE, not hard-fail: the JWT is validly signed, so we keep
                // enforcing and re-attest in the background to rebind it to the
                // (now stable) instance id. A hard fail here is exactly what turned
                // a harmless container recreate into a licensing outage.
                tracing::warn!("Fingerprint mismatch (recreate/first boot after fix) — honoring the signed license in grace, re-attesting in background");
                loaded.into_grace("fingerprint_mismatch")
            } else {
                tracing::info!("License valid — tier={} balance={}", loaded.tier(), loaded.balance());
                loaded
            }
        }
        Err(_) => {
            tracing::info!("No license found — starting in unactivated mode, awaiting activation");
            license::LicenseCache::unactivated()
        }
    };

    let cache = std::sync::Arc::new(tokio::sync::RwLock::new(cache));
    let queue  = std::sync::Arc::new(tokio::sync::Mutex::new(usage_queue::UsageQueue::new()));

    // Spawn heartbeat loop unconditionally — it will check is_activated() on each iteration
    let cfg_hb   = cfg.clone();
    let cache_hb = cache.clone();
    let queue_hb = queue.clone();
    tokio::spawn(async move {
        heartbeat::run_loop(cache_hb, queue_hb, cfg_hb).await;
    });

    // Auto re-attestation loop: rebinds a grace/mismatched license to this
    // instance id using the persisted key, so a fingerprint change self-heals.
    let cfg_re   = cfg.clone();
    let cache_re = cache.clone();
    tokio::spawn(async move {
        reattest::run_loop(cache_re, cfg_re).await;
    });

    server::run(cache, queue, cfg).await;
}

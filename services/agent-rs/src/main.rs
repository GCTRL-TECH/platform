mod config;
mod docker;
mod error;
mod fingerprint;
mod license;
mod credits;
mod usage_queue;
mod heartbeat;
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
            let fp = fingerprint::compute().await;
            if loaded.hardware_fingerprint() != fp {
                tracing::warn!("Hardware fingerprint mismatch — starting in unactivated mode");
                license::LicenseCache::unactivated()
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

    server::run(cache, queue, cfg).await;
}

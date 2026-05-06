mod config;
mod error;
mod fingerprint;
mod license;
mod credits;
mod usage_queue;
mod heartbeat;
mod server;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg = config::Config::from_env();
    tracing::info!("GCTRL Agent starting — license path: {}", cfg.license_jwt_path);

    let cache = license::LicenseCache::load_from_disk(&cfg.license_jwt_path, &cfg.license_public_key)
        .await
        .expect("Failed to load license. Run installer first.");

    let fp = fingerprint::compute().await;
    if cache.hardware_fingerprint() != fp {
        tracing::error!("Hardware fingerprint mismatch. License not valid for this machine.");
        std::process::exit(1);
    }

    tracing::info!("License valid — tier={} balance={}", cache.tier(), cache.balance());

    let cache = std::sync::Arc::new(tokio::sync::RwLock::new(cache));
    let queue  = std::sync::Arc::new(tokio::sync::Mutex::new(usage_queue::UsageQueue::new()));

    heartbeat::beat(cache.clone(), queue.clone(), &cfg).await;

    let cfg_hb   = cfg.clone();
    let cache_hb = cache.clone();
    let queue_hb = queue.clone();
    tokio::spawn(async move {
        heartbeat::run_loop(cache_hb, queue_hb, cfg_hb).await;
    });

    server::run(cache, queue, cfg).await;
}

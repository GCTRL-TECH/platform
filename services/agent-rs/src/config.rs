#[derive(Clone)]
pub struct Config {
    pub license_jwt_path:   String,
    pub license_public_key: String,
    pub api_url:            String,
    pub port:               u16,
    /// Where the verified ER tuning profile is cached + served from (/tuning).
    pub tuning_profile_path: String,
    /// File-backed current instance RELEASE version (decoupled from the image build).
    pub version_path: String,
    /// Marker for the version the cloud has already acknowledged. The heartbeat
    /// only re-sends `instance_version` when `version_path` differs from this, so
    /// steady-state heartbeats carry nothing — we signal a version only when it
    /// actually changes (fresh install / after an update).
    pub reported_version_path: String,
    /// Shared secret gating `/recreate` (and mirroring the same trust boundary
    /// api-rs already applies to kex/fuse's `/search`). Empty = grace mode (no
    /// check) — matches the existing INTERNAL_API_SECRET pattern everywhere else.
    pub internal_api_secret: String,
}

impl Config {
    pub fn from_env() -> Self {
        let license_public_key = if let Ok(path) = std::env::var("GCTRL_LICENSE_PUBLIC_KEY_FILE") {
            std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("Failed to read public key from {path}: {e}"))
        } else {
            std::env::var("GCTRL_LICENSE_PUBLIC_KEY")
                .expect("GCTRL_LICENSE_PUBLIC_KEY or GCTRL_LICENSE_PUBLIC_KEY_FILE must be set")
        };

        Self {
            license_jwt_path: std::env::var("GCTRL_LICENSE_JWT_PATH")
                .unwrap_or_else(|_| "/app/config/license.jwt".into()),
            license_public_key,
            api_url: std::env::var("GCTRL_API_URL")
                .unwrap_or_else(|_| "https://api.gctrl.tech".into()),
            port: std::env::var("PORT").ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(7070),
            tuning_profile_path: std::env::var("GCTRL_TUNING_PROFILE_PATH")
                .unwrap_or_else(|_| "/app/config/tuning.json".into()),
            version_path: std::env::var("GCTRL_VERSION_PATH")
                .unwrap_or_else(|_| "/app/config/current_version".into()),
            reported_version_path: std::env::var("GCTRL_REPORTED_VERSION_PATH")
                .unwrap_or_else(|_| "/app/config/reported_version".into()),
            internal_api_secret: std::env::var("INTERNAL_API_SECRET").unwrap_or_default(),
        }
    }
}

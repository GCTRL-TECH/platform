#[derive(Clone)]
pub struct Config {
    pub license_jwt_path:   String,
    pub license_public_key: String,
    pub api_url:            String,
    pub port:               u16,
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
        }
    }
}

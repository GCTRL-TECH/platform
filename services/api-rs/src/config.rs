#[derive(Clone)]
pub struct Config {
    pub port:               u16,
    pub database_url:       String,
    pub redis_url:          String,
    pub neo4j_uri:          String,
    pub neo4j_user:         String,
    pub neo4j_password:     String,
    pub jwt_secret:         String,
    pub jwt_refresh_secret: String,
    pub frontend_url:       String,
    pub kex_worker_url:     String,
    pub qdrant_url:         String,
    pub upload_dir:         String,
    pub bcrypt_rounds:      u32,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port:               env_u16("PORT", 4000),
            database_url:       req_env("DATABASE_URL"),
            redis_url:          opt_env("REDIS_URL",          "redis://localhost:6379"),
            neo4j_uri:          opt_env("NEO4J_URI",          "bolt://localhost:7687"),
            neo4j_user:         opt_env("NEO4J_USER",         "neo4j"),
            neo4j_password:     opt_env("NEO4J_PASSWORD",     "password"),
            jwt_secret:         req_env("JWT_SECRET"),
            jwt_refresh_secret: opt_env("JWT_REFRESH_SECRET", "refresh-secret"),
            frontend_url:       opt_env("FRONTEND_URL",       "http://localhost:3000"),
            kex_worker_url:     opt_env("KEX_WORKER_URL",     "http://localhost:4010"),
            qdrant_url:         opt_env("QDRANT_URL",         "http://localhost:6333"),
            upload_dir:         opt_env("UPLOAD_DIR",         "/tmp/gctrl-uploads"),
            bcrypt_rounds:      env_u16("BCRYPT_ROUNDS", 12) as u32,
        }
    }
}

fn req_env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("{key} must be set"))
}
fn opt_env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}
fn env_u16(key: &str, default: u16) -> u16 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

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
    pub fuse_url:           String,
    pub qdrant_url:         String,
    pub upload_dir:         String,
    pub bcrypt_rounds:      u32,
    pub google_client_id:     String,
    pub google_client_secret: String,
    pub vaults_root:          String,
    /// Off by default. When true, exposes the remote MCP-over-HTTP gateway at
    /// `/api/agent/mcp` so external multi-agent orchestrators can drive the Pi
    /// harness over the network. Every call is api-key authed, clearance-scoped
    /// and audited. Requires a server restart to take effect.
    pub agent_gateway_enabled: bool,
    /// External URL of the Neo4j Browser, surfaced to the UI via
    /// `GET /api/config/public`. Empty means "let the frontend derive it from
    /// the browser host + :7474". Override with `GCTRL_NEO4J_BROWSER_URL`.
    pub neo4j_browser_url: String,
    /// External URL of the agent health/license endpoint, surfaced to the UI via
    /// `GET /api/config/public`. Empty means "let the frontend derive it from
    /// the browser host + :7070". Override with `GCTRL_AGENT_URL`.
    pub agent_url: String,
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
            fuse_url:           opt_env("FUSE_URL",           "http://localhost:4020"),
            qdrant_url:         opt_env("QDRANT_URL",         "http://localhost:6333"),
            upload_dir:         opt_env("UPLOAD_DIR",         "/tmp/gctrl-uploads"),
            bcrypt_rounds:      env_u16("BCRYPT_ROUNDS", 12) as u32,
            google_client_id:     opt_env("GOOGLE_CLIENT_ID",     ""),
            google_client_secret: opt_env("GOOGLE_CLIENT_SECRET", ""),
            vaults_root:          opt_env("GCTRL_VAULTS_ROOT",     "/vaults"),
            // On by default so a fresh install exposes the MCP-over-HTTP gateway
            // immediately (it's still API-key authed + clearance-scoped + audited,
            // and 403s without a valid token). Set GCTRL_AGENT_GATEWAY_ENABLED=false
            // to turn it off.
            agent_gateway_enabled: env_bool("GCTRL_AGENT_GATEWAY_ENABLED", true),
            neo4j_browser_url:    opt_env("GCTRL_NEO4J_BROWSER_URL", ""),
            agent_url:            opt_env("GCTRL_AGENT_URL", ""),
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
fn env_bool(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

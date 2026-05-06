use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("License file not found: {0}")]
    LicenseNotFound(String),
    #[error("Invalid license JWT: {0}")]
    InvalidJwt(String),
    #[error("Heartbeat failed: {0}")]
    HeartbeatFailed(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

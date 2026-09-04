use std::sync::Arc;
use sqlx::PgPool;

pub struct AppState {
    pub cfg:   Arc<crate::config::Config>,
    pub db:    PgPool,
    pub neo:   Arc<neo4rs::Graph>,
    pub redis: Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
    /// Process-wide generation gate for the active `openai_compatible` runtime
    /// (spec D2): `(configured size, semaphore)`. `llm::acquire_slot` swaps in a
    /// fresh semaphore when `runtime_config.max_concurrency` changes, so the size
    /// is stored next to it to detect the change. Ollama/cloud are never gated.
    pub llm_gate: Arc<tokio::sync::Mutex<(usize, Arc<tokio::sync::Semaphore>)>>,
}

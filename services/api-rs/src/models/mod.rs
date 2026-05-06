use std::sync::Arc;
use sqlx::PgPool;

pub struct AppState {
    pub cfg:   Arc<crate::config::Config>,
    pub db:    PgPool,
    pub neo:   Arc<neo4rs::Graph>,
    pub redis: Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
}

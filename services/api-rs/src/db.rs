use sqlx::{postgres::PgPoolOptions, PgPool};

pub async fn connect(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await
        .expect("Failed to connect to PostgreSQL")
}

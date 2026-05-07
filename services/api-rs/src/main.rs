mod config;
mod db;
mod error;
mod middleware;
mod models;
mod routes;
mod services;
mod background;

use std::sync::Arc;
use axum::Router;
use tower_http::limit::RequestBodyLimitLayer;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg   = Arc::new(config::Config::from_env());
    let db    = db::connect(&cfg.database_url).await;
    sqlx::migrate!().run(&db).await.expect("DB migrations failed");
    let neo   = services::neo4j::connect(&cfg.neo4j_uri, &cfg.neo4j_user, &cfg.neo4j_password).await;
    let redis = services::redis::connect(&cfg.redis_url).await;

    let state = Arc::new(models::AppState { cfg: cfg.clone(), db, neo, redis });

    background::spawn_all(state.clone());

    let app = build_router(state);
    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!("GCTRL API on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn build_router(state: Arc<models::AppState>) -> Router {
    use axum::middleware;
    use crate::middleware::auth::{require_auth, optional_auth};

    let protected = Router::new()
        .nest("/api/users",   routes::users::router())
        .nest("/api/kex",     routes::kex::router())
        .nest("/api/fuse",    routes::fuse::router())
        .nest("/api/kg",      routes::kg::router())
        .nest("/api/billing", routes::billing::router())
        .nest("/api/admin",   routes::admin::router())
        .nest("/api/update",  routes::update::router())
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let optional = Router::new()
        .nest("/api/rag", routes::rag::router())
        .layer(middleware::from_fn_with_state(state.clone(), optional_auth));

    Router::new()
        .nest("/api/health", routes::health::router())
        .nest("/api/auth",   routes::auth::router())
        .nest("/api/setup",  routes::setup::router())
        .merge(protected)
        .merge(optional)
        .layer(tower_http::cors::CorsLayer::permissive())
        .layer(RequestBodyLimitLayer::new(10 * 1024 * 1024))
        .with_state(state)
}

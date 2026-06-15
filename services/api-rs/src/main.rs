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

    // Initialise the at-rest encryption key (GCTRL_SECRET_KEY, or stable dev key
    // derived from JWT_SECRET) before anything reads/writes sealed secrets.
    services::crypto::init(&cfg.jwt_secret);

    let db    = db::connect(&cfg.database_url).await;
    sqlx::migrate!().run(&db).await.expect("DB migrations failed");

    // Encrypt any legacy plaintext secrets in place (idempotent — skips v1:* rows).
    services::crypto::backfill_encrypt_secrets(&db).await;
    // Ensure the system 'gctrl-memory' skill is present/current (single source).
    routes::agent::ensure_system_skills(&db).await;
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
        .nest("/api/users",       routes::users::router().merge(routes::api_keys::router()))
        .nest("/api/kex",         routes::kex::router())
        .nest("/api/crawler",     routes::crawler::router())
        .nest("/api/fuse",        routes::fuse::router())
        .nest("/api/kg",          routes::kg::router())
        .nest("/api/billing",     routes::billing::router())
        .nest("/api/admin",       routes::admin::router())
        .nest("/api/update",      routes::update::router())
        .nest("/api/connectors",  routes::connectors::router()
                                        .merge(routes::connector_configs::router()))
        .nest("/api/ontologies",      routes::ontologies::router())
        .nest("/api/agent",           routes::agent::router().merge(routes::agent_gateway::router()))
        .nest("/api/skills",          routes::skills::router())
        .nest("/api/llm",             routes::llm::router())
        .nest("/api/classification",  routes::classification::router())
        .nest("/api/audit",           routes::audit::router())
        .nest("/api/auth/sso",        routes::sso::protected_router())
        .nest("/api/webhooks",        routes::webhooks::router())
        .nest("/api/triggers",        routes::triggers::router())
        .nest("/api/infra",           routes::infra::router())
        .nest("/api/memory",          routes::memory::router())
        .nest("/api/user",            routes::profile::router())
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let optional = Router::new()
        .nest("/api/rag", routes::rag::router())
        .layer(middleware::from_fn_with_state(state.clone(), optional_auth));

    Router::new()
        .nest("/api/health", routes::health::router())
        .nest("/api/config", routes::config::router())
        .nest("/api/auth",   routes::auth::router())
        .nest("/api/auth/sso", routes::sso::public_router())
        .nest("/api/scim",   routes::sso::scim_router())
        .nest("/api/setup",  routes::setup::router())
        .merge(routes::connectors::public_router())
        .merge(protected)
        .merge(optional)
        .layer(tower_http::cors::CorsLayer::permissive())
        .layer(RequestBodyLimitLayer::new(10 * 1024 * 1024))
        .with_state(state)
}

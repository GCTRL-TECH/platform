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
    // Self-heal admin access (single-tenant instances must always have one admin).
    ensure_admin_exists(&db).await;
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

/// Guarantee a single-tenant instance always has a working admin. The first
/// registered user is meant to be the admin (see `auth.rs`), but instances
/// created before that logic — or where another account took the first slot —
/// can end up with NO admin, leaving the operator unable to configure OAuth
/// connectors, SSO, etc. (the "Connect → go to Settings → can't add credentials"
/// dead-end). This runs every boot and is fully idempotent:
///   1. `BOOTSTRAP_ADMIN_EMAIL` (comma-separated) → always promote those emails.
///   2. Otherwise, if NO admin exists but users do, promote the earliest user.
async fn ensure_admin_exists(db: &sqlx::PgPool) {
    // 1. Explicit operator-driven promotion via env (highest priority).
    let env_emails = std::env::var("BOOTSTRAP_ADMIN_EMAIL")
        .or_else(|_| std::env::var("GCTRL_BOOTSTRAP_ADMIN"))
        .unwrap_or_default();
    for email in env_emails
        .split(',')
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
    {
        match sqlx::query(
            "UPDATE users SET role = 'admin', clearance = 'INTERNAL'
             WHERE lower(email) = $1 AND role <> 'admin'",
        )
        .bind(&email)
        .execute(db)
        .await
        {
            Ok(r) if r.rows_affected() > 0 =>
                tracing::warn!("Bootstrapped admin: promoted {email} (BOOTSTRAP_ADMIN_EMAIL)"),
            Ok(_) => {}
            Err(e) => tracing::warn!("Bootstrap admin promote failed for {email}: {e}"),
        }
    }

    // 2. Self-heal: if there's still no admin at all but users exist, promote the
    //    earliest-created account — the de-facto operator on a single-tenant box.
    let admin_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin'")
        .fetch_one(db)
        .await
        .unwrap_or(0);
    if admin_count == 0 {
        match sqlx::query_scalar::<_, uuid::Uuid>(
            "SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1",
        )
        .fetch_optional(db)
        .await
        {
            Ok(Some(id)) => {
                match sqlx::query(
                    "UPDATE users SET role = 'admin', clearance = 'INTERNAL' WHERE id = $1",
                )
                .bind(id)
                .execute(db)
                .await
                {
                    Ok(_) => tracing::warn!(
                        "No admin found — promoted earliest user ({id}) to admin (self-heal)"
                    ),
                    Err(e) => tracing::warn!("Self-heal admin promote failed: {e}"),
                }
            }
            Ok(None) => {} // No users yet; the first registrant becomes admin via auth.rs.
            Err(e) => tracing::warn!("Admin self-heal query failed: {e}"),
        }
    }
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

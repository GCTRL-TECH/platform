use axum::{
    extract::State,
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::{error::{AppError, Result}, middleware::auth::{sign_access, sign_refresh, JwtClaims}};

#[derive(Deserialize)]
struct RegisterReq { email: String, password: String, name: String }

#[derive(Deserialize)]
struct LoginReq { email: String, password: String }

#[derive(Deserialize)]
struct RefreshReq { #[serde(rename = "refreshToken")] refresh_token: String }

#[derive(Deserialize)]
struct ForgotReq { email: String }

#[derive(Deserialize)]
struct ResetReq { token: String, password: String }

#[derive(Serialize)]
struct AuthTokens {
    #[serde(rename = "token")]  access_token:  String,
    #[serde(rename = "refreshToken")] refresh_token: String,
    user: UserOut,
}

#[derive(Serialize, sqlx::FromRow)]
struct UserOut {
    id: Uuid,
    email: String,
    name: Option<String>,
    role: String,
    clearance: Option<String>,
    tier: Option<String>,
    #[serde(rename = "tokensBalance")]
    tokens_balance: Option<i32>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/register",        post(register))
        .route("/login",           post(login))
        .route("/refresh",         post(refresh))
        .route("/forgot-password", post(forgot_password))
        .route("/reset-password",  post(reset_password))
}

async fn register(
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<RegisterReq>,
) -> Result<Json<AuthTokens>> {
    if req.email.is_empty() || !req.email.contains('@') {
        return Err(AppError::BadRequest("Invalid email".into()));
    }
    if req.password.len() < 8 {
        return Err(AppError::BadRequest("Password must be at least 8 characters".into()));
    }

    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)")
        .bind(&req.email)
        .fetch_one(&state.db)
        .await?;
    if exists { return Err(AppError::Conflict("Email already registered".into())); }

    let hash = bcrypt::hash(&req.password, state.cfg.bcrypt_rounds)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let id = Uuid::new_v4();

    // Fresh-install bootstrap: the VERY FIRST registered user owns the install,
    // so they become an admin (with INTERNAL clearance) rather than a viewer.
    // Every subsequent registration is a normal 'viewer'. We count inside the
    // same request right before the insert; the unique-email guard above already
    // serializes obvious races, and a second concurrent first-user would simply
    // also get admin — acceptable for a single-operator first-run.
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await?;
    let is_first_user = user_count == 0;
    let (role, clearance): (&str, &str) = if is_first_user {
        ("admin", "INTERNAL")
    } else {
        ("viewer", "PUBLIC")
    };

    // 1,000,000 free tokens — the default monthly grant every user receives at no
    // cost (see migration 067 + the daily top-up tick in background::spawn_all).
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, name, role, clearance, tokens_balance, tier)
         VALUES ($1, $2, $3, $4, $5, $6, 1000000, 'free')"
    )
    .bind(id).bind(&req.email).bind(&hash).bind(&req.name).bind(role).bind(clearance)
    .execute(&state.db).await?;

    // Auto-seed default ontology for new user (best-effort: failures must not break registration).
    seed_default_ontology(&state.db, id).await;

    let claims = JwtClaims {
        sub: id, email: req.email.clone(), role: role.into(),
        clearance: Some(clearance.into()),
        exp: (chrono::Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
        api_key_rank: None,
        api_key_id: None,
        read_only: false,
        agent_override_rank: None,
    };
    Ok(Json(AuthTokens {
        access_token:  sign_access(&state.cfg, &claims),
        refresh_token: sign_refresh(&state.cfg, id, &req.email),
        user: UserOut { id, email: req.email, name: Some(req.name), role: role.into(),
                        clearance: Some(clearance.into()), tier: Some("free".into()),
                        tokens_balance: Some(1000000) },
    }))
}

async fn login(
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<LoginReq>,
) -> Result<Json<AuthTokens>> {
    let user = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<String>, Option<String>, Option<i32>, String, bool)>(
        "SELECT id, email, name, role::TEXT, clearance::TEXT, tier, tokens_balance, password_hash, is_active
         FROM users WHERE email = $1 LIMIT 1"
    )
    .bind(&req.email)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::Unauthorized)?;

    let (id, email, name, role, clearance, tier, balance, hash, is_active) = user;
    // SEC-2: deprovisioned accounts cannot log in.
    if !is_active { return Err(AppError::Unauthorized); }
    let valid = bcrypt::verify(&req.password, &hash)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !valid { return Err(AppError::Unauthorized); }

    let claims = JwtClaims {
        sub: id, email: email.clone(), role: role.clone(),
        clearance: clearance.clone(),
        exp: (chrono::Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
        api_key_rank: None,
        api_key_id: None,
        read_only: false,
        agent_override_rank: None,
    };
    Ok(Json(AuthTokens {
        access_token:  sign_access(&state.cfg, &claims),
        refresh_token: sign_refresh(&state.cfg, id, &email),
        user: UserOut { id, email, name, role, clearance, tier, tokens_balance: balance },
    }))
}

async fn refresh(
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<RefreshReq>,
) -> Result<Json<AuthTokens>> {
    use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
    #[derive(serde::Deserialize)]
    struct RefClaims { sub: Uuid, email: String }

    let key = DecodingKey::from_secret(state.cfg.jwt_refresh_secret.as_bytes());
    let data = decode::<RefClaims>(&req.refresh_token, &key, &Validation::new(Algorithm::HS256))
        .map_err(|_| AppError::Unauthorized)?;

    let user = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<String>, Option<String>, Option<i32>, bool)>(
        "SELECT id, email, name, role::TEXT, clearance::TEXT, tier, tokens_balance, is_active FROM users WHERE id = $1"
    )
    .bind(data.claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::Unauthorized)?;

    let (id, email, name, role, clearance, tier, balance, is_active) = user;
    // SEC-2: a deprovisioned user can't mint fresh access tokens via refresh.
    if !is_active { return Err(AppError::Unauthorized); }
    let claims = JwtClaims {
        sub: id, email: email.clone(), role: role.clone(),
        clearance: clearance.clone(),
        exp: (chrono::Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
        api_key_rank: None,
        api_key_id: None,
        read_only: false,
        agent_override_rank: None,
    };
    Ok(Json(AuthTokens {
        access_token:  sign_access(&state.cfg, &claims),
        refresh_token: sign_refresh(&state.cfg, id, &email),
        user: UserOut { id, email, name, role, clearance, tier, tokens_balance: balance },
    }))
}

async fn forgot_password(Json(_req): Json<ForgotReq>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn reset_password(
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<ResetReq>,
) -> Result<Json<serde_json::Value>> {
    if req.password.len() < 8 {
        return Err(AppError::BadRequest("Password too short".into()));
    }
    let user_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW() LIMIT 1"
    )
    .bind(&req.token)
    .fetch_optional(&state.db).await?;

    let id = user_id.ok_or(AppError::BadRequest("Invalid or expired token".into()))?;
    let hash = bcrypt::hash(&req.password, state.cfg.bcrypt_rounds)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    sqlx::query("UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires=NULL WHERE id=$2")
        .bind(&hash).bind(id)
        .execute(&state.db).await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Canonical shared "General Knowledge" ontology (see migration 036). Every user
/// defaults to this single shared ontology; KEX extends it in place. We no longer
/// create a private per-user copy on registration (that produced 35+ duplicates).
const CANONICAL_ONTOLOGY_ID: Uuid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_00a1);

/// Point a freshly-registered user at the shared default ontology.
///
/// Best-effort: any DB error is logged-and-swallowed so seeding hiccups can never
/// break the registration flow.
async fn seed_default_ontology(db: &sqlx::PgPool, user_id: Uuid) {
    if let Err(e) = sqlx::query("UPDATE users SET default_ontology_id = $1 WHERE id = $2")
        .bind(CANONICAL_ONTOLOGY_ID)
        .bind(user_id)
        .execute(db).await {
        tracing::warn!(?e, %user_id, "failed to set default_ontology_id on user");
    }

    seed_default_workspace(db, user_id).await;
}

/// Seeds a default workspace for a freshly-registered user:
///   - 1 KG folder ("My Workspace")
///   - 1 empty compilation ("My First Knowledge Base") inside that folder
///
/// This ensures KEX uploads and FUSE merges have a target out of the box —
/// the user can ingest their first document immediately without any setup.
async fn seed_default_workspace(db: &sqlx::PgPool, user_id: Uuid) {
    let folder_id = Uuid::new_v4();
    if let Err(e) = sqlx::query(
        "INSERT INTO kg_folders (id, user_id, name, position) VALUES ($1, $2, 'My Workspace', 0)"
    )
    .bind(folder_id)
    .bind(user_id)
    .execute(db).await {
        tracing::warn!(?e, %user_id, "failed to seed default folder");
        return;
    }

    let compilation_id = Uuid::new_v4();
    if let Err(e) = sqlx::query(
        "INSERT INTO compilations (id, user_id, name, description, classification, folder_id) \
         VALUES ($1, $2, 'My First Knowledge Base', \
                 'Default knowledge graph — extractions land here unless you create a new one', \
                 'INTERNAL', $3)"
    )
    .bind(compilation_id)
    .bind(user_id)
    .bind(folder_id)
    .execute(db).await {
        tracing::warn!(?e, %user_id, "failed to seed default compilation");
    }

    seed_default_wiki(db, user_id).await;
}

/// Seeds the default, non-deletable "Knowledge Wiki" for a freshly-registered
/// user (mirrors migration 047's backfill for existing users):
///   - 1 WIKI compilation ("Knowledge Wiki", `is_system = true`, hourly-ish
///     `*/10 * * * *` cron) — the delete handler refuses to remove it.
///   - 1 active `distill` cron trigger whose `config.compilationId` points at the
///     wiki, so the background cron executor re-distils it automatically.
///
/// No source graph is selected at seed time — the user wires sources via
/// `PUT /kg/compilations/:id/wiki/sources`; distillation writes 0 pages until then.
/// Best-effort: any DB error is logged-and-swallowed so a seeding hiccup can never
/// break registration.
async fn seed_default_wiki(db: &sqlx::PgPool, user_id: Uuid) {
    let wiki_id = Uuid::new_v4();
    if let Err(e) = sqlx::query(
        "INSERT INTO compilations \
            (id, user_id, name, description, classification, type, is_system, cron_schedule, cron_mode) \
         VALUES ($1, $2, 'Knowledge Wiki', \
                 'Your automatically maintained, LLM-distilled knowledge wiki. Pick which graphs feed it; it re-distils itself on a schedule.', \
                 'INTERNAL', 'WIKI'::compilation_type, TRUE, '*/10 * * * *', 'incremental')"
    )
    .bind(wiki_id)
    .bind(user_id)
    .execute(db).await {
        tracing::warn!(?e, %user_id, "failed to seed default Knowledge Wiki");
        return;
    }

    // Auto-distill trigger: change_detection (heartbeat) — re-distils ONLY when a
    // source graph actually gained content since the last distill (checked every
    // executor tick via wiki_has_new_content). NOT a cron: the previous */10 cron
    // default bypassed the staleness check by design and re-distilled every idle
    // wiki every 10 minutes — ~600 pointless LLM jobs/hour across 100 users
    // (236k-row jobs table on the dev box). Migration 071 converts existing
    // default triggers.
    if let Err(e) = sqlx::query(
        "INSERT INTO triggers \
            (id, user_id, name, module, type, status, cron_schedule, config, next_run_at) \
         VALUES ($1, $2, 'Auto-distill: Knowledge Wiki', \
                 'distill'::trigger_module, 'change_detection'::trigger_type, 'active', \
                 NULL, $3, NOW())"
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(serde_json::json!({ "compilationId": wiki_id.to_string() }))
    .execute(db).await {
        tracing::warn!(?e, %user_id, "failed to seed default Knowledge Wiki auto-distill trigger");
    }
}

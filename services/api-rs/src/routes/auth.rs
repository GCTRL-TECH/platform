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

    sqlx::query(
        "INSERT INTO users (id, email, password_hash, name, role, clearance, tokens_balance, tier)
         VALUES ($1, $2, $3, $4, 'viewer', 'PUBLIC', 50, 'free')"
    )
    .bind(id).bind(&req.email).bind(&hash).bind(&req.name)
    .execute(&state.db).await?;

    // Auto-seed default ontology for new user (best-effort: failures must not break registration).
    seed_default_ontology(&state.db, id).await;

    let claims = JwtClaims {
        sub: id, email: req.email.clone(), role: "viewer".into(),
        clearance: Some("PUBLIC".into()),
        exp: (chrono::Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
    };
    Ok(Json(AuthTokens {
        access_token:  sign_access(&state.cfg, &claims),
        refresh_token: sign_refresh(&state.cfg, id, &req.email),
        user: UserOut { id, email: req.email, name: Some(req.name), role: "viewer".into(),
                        clearance: Some("PUBLIC".into()), tier: Some("free".into()),
                        tokens_balance: Some(50) },
    }))
}

async fn login(
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<LoginReq>,
) -> Result<Json<AuthTokens>> {
    let user = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<String>, Option<String>, Option<i32>, String)>(
        "SELECT id, email, name, role::TEXT, clearance::TEXT, tier, tokens_balance, password_hash
         FROM users WHERE email = $1 LIMIT 1"
    )
    .bind(&req.email)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::Unauthorized)?;

    let (id, email, name, role, clearance, tier, balance, hash) = user;
    let valid = bcrypt::verify(&req.password, &hash)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !valid { return Err(AppError::Unauthorized); }

    let claims = JwtClaims {
        sub: id, email: email.clone(), role: role.clone(),
        clearance: clearance.clone(),
        exp: (chrono::Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
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

    let user = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<String>, Option<String>, Option<i32>)>(
        "SELECT id, email, name, role::TEXT, clearance::TEXT, tier, tokens_balance FROM users WHERE id = $1"
    )
    .bind(data.claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::Unauthorized)?;

    let (id, email, name, role, clearance, tier, balance) = user;
    let claims = JwtClaims {
        sub: id, email: email.clone(), role: role.clone(),
        clearance: clearance.clone(),
        exp: (chrono::Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
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

/// Seed a "General Knowledge" default ontology for a freshly-registered user.
///
/// Best-effort: any DB error is logged-and-swallowed so seeding hiccups can never
/// break the registration flow. Uses direct SQL inserts (no dependency on the
/// ontologies route handlers) so this compiles independently.
async fn seed_default_ontology(db: &sqlx::PgPool, user_id: Uuid) {
    let ontology_id = Uuid::new_v4();

    if let Err(e) = sqlx::query(
        "INSERT INTO ontologies (id, user_id, name, description, scope, source, entity_type_count) \
         VALUES ($1, $2, 'General Knowledge', \
                 'Default ontology with common entity types — covers people, organizations, places, dates, and concepts', \
                 'private', 'system', 10)"
    )
    .bind(ontology_id)
    .bind(user_id)
    .execute(db).await {
        tracing::warn!(?e, %user_id, "failed to seed default ontology row");
        return;
    }

    let entity_types: [(&str, &str, &str, &[&str]); 10] = [
        ("Q5",        "Person",       "#6366f1", &["individual", "human", "name"]),
        ("Q43229",    "Organization", "#f59e0b", &["company", "corporation", "agency", "institution"]),
        ("Q17334923", "Location",     "#10b981", &["place", "city", "country", "region", "address"]),
        ("Q205892",   "Date",         "#ec4899", &["time", "datetime", "period", "year"]),
        ("Q2424752",  "Product",      "#8b5cf6", &["item", "goods", "service"]),
        ("Q1656682",  "Event",        "#ef4444", &["happening", "occurrence", "meeting"]),
        ("Q1368",     "Money",        "#22c55e", &["currency", "price", "amount", "value"]),
        ("Q49848",    "Document",     "#06b6d4", &["file", "paper", "contract", "report"]),
        ("Q151885",   "Concept",      "#94a3b8", &["idea", "topic", "subject"]),
        ("Q9158",     "Email",        "#f97316", &["emailaddress"]),
    ];

    for (qid, name, color, aliases) in entity_types {
        let aliases_vec: Vec<String> = aliases.iter().map(|s| (*s).to_string()).collect();
        if let Err(e) = sqlx::query(
            "INSERT INTO ontology_entity_types (ontology_id, qid, name, aliases, color, confidence_threshold) \
             VALUES ($1, $2, $3, $4, $5, 0.3)"
        )
        .bind(ontology_id)
        .bind(qid)
        .bind(name)
        .bind(&aliases_vec)
        .bind(color)
        .execute(db).await {
            tracing::warn!(?e, %user_id, entity_type = name, "failed to seed default entity type");
        }
    }

    if let Err(e) = sqlx::query("UPDATE users SET default_ontology_id = $1 WHERE id = $2")
        .bind(ontology_id)
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
}

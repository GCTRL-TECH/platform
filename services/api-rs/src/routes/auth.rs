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
    #[serde(rename = "accessToken")]  access_token:  String,
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
        "SELECT id, email, name, role, clearance, tier, tokens_balance, password_hash
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
        "SELECT id, email, name, role, clearance, tier, tokens_balance FROM users WHERE id = $1"
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

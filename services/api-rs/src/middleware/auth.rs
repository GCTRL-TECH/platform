use axum::{extract::{Request, State}, http::StatusCode, middleware::Next, response::Response};
use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub:       uuid::Uuid,
    pub email:     String,
    pub role:      String,
    pub clearance: Option<String>,
    pub exp:       usize,
}

pub async fn require_auth(
    State(state): State<Arc<crate::models::AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let key = DecodingKey::from_secret(state.cfg.jwt_secret.as_bytes());
    let claims = decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256))
        .map_err(|_| StatusCode::UNAUTHORIZED)?
        .claims;

    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

pub async fn optional_auth(
    State(state): State<Arc<crate::models::AppState>>,
    mut req: Request,
    next: Next,
) -> Response {
    // Always insert Option<JwtClaims> so handlers can extract Extension<Option<JwtClaims>>.
    let claims: Option<JwtClaims> = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| {
            let key = DecodingKey::from_secret(state.cfg.jwt_secret.as_bytes());
            decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256)).ok()
        })
        .map(|data| data.claims);
    req.extensions_mut().insert(claims);
    next.run(req).await
}

pub fn require_role(claims: &JwtClaims, role: &str) -> crate::error::Result<()> {
    const ORDER: &[&str] = &["viewer", "analyst", "editor", "admin"];
    let user_level = ORDER.iter().position(|&r| r == claims.role).unwrap_or(0);
    let req_level  = ORDER.iter().position(|&r| r == role).unwrap_or(0);
    if user_level >= req_level { Ok(()) }
    else { Err(crate::error::AppError::Forbidden(format!("Requires role: {role}"))) }
}

pub fn sign_access(cfg: &crate::config::Config, claims: &JwtClaims) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    encode(&Header::default(), claims, &EncodingKey::from_secret(cfg.jwt_secret.as_bytes())).unwrap()
}

pub fn sign_refresh(cfg: &crate::config::Config, sub: uuid::Uuid, email: &str) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    #[derive(Serialize)]
    struct Refresh { sub: uuid::Uuid, email: String, exp: usize }
    let claims = Refresh {
        sub,
        email: email.into(),
        exp: (chrono::Utc::now() + chrono::Duration::days(7)).timestamp() as usize,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(cfg.jwt_refresh_secret.as_bytes())).unwrap()
}

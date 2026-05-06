use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Not found")]
    NotFound,
    #[error("Unauthorized")]
    Unauthorized,
    #[error("Forbidden: {0}")]
    Forbidden(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Conflict: {0}")]
    Conflict(String),
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::NotFound       => (StatusCode::NOT_FOUND,            self.to_string()),
            AppError::Unauthorized   => (StatusCode::UNAUTHORIZED,         self.to_string()),
            AppError::Forbidden(m)   => (StatusCode::FORBIDDEN,            m.clone()),
            AppError::BadRequest(m)  => (StatusCode::BAD_REQUEST,          m.clone()),
            AppError::Conflict(m)    => (StatusCode::CONFLICT,             m.clone()),
            AppError::Database(e)    => {
                tracing::error!("DB: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Database error".into())
            }
            AppError::Internal(m)    => {
                tracing::error!("Internal: {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, m.clone())
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

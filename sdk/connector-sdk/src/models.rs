use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// ConnectorFile
// ---------------------------------------------------------------------------

/// Metadata for a single file (or folder) exposed by a connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorFile {
    /// Connector-local unique identifier for this file.
    pub id: String,

    /// Human-readable display name (filename or folder name).
    pub name: String,

    /// MIME type, e.g. `"text/plain"` or `"application/pdf"`.
    pub mime_type: String,

    /// File size in bytes if known.
    pub size_bytes: Option<u64>,

    /// Last-modified timestamp if known.
    pub modified_at: Option<chrono::DateTime<chrono::Utc>>,

    /// `true` if this entry represents a folder rather than a file.
    pub is_folder: bool,

    /// ID of the parent folder, if any.
    pub parent_id: Option<String>,
}

// ---------------------------------------------------------------------------
// ConnectorContent / ConnectorContentType
// ---------------------------------------------------------------------------

/// The actual content of a file fetched by a connector.
#[derive(Debug, Clone)]
pub struct ConnectorContent {
    /// ID of the file this content belongs to.
    pub file_id: String,

    /// Filename used when uploading to GCTRL.
    pub file_name: String,

    /// Raw content, either UTF-8 text or arbitrary bytes.
    pub content: ConnectorContentType,

    /// MIME type of the content.
    pub mime_type: String,
}

/// Discriminated union for file content.
#[derive(Debug, Clone)]
pub enum ConnectorContentType {
    /// UTF-8 text content.
    Text(String),

    /// Binary content.
    Bytes(Vec<u8>),
}

impl ConnectorContent {
    /// Convert content to a byte vector regardless of variant.
    pub fn as_bytes(&self) -> Vec<u8> {
        match &self.content {
            ConnectorContentType::Text(s) => s.as_bytes().to_vec(),
            ConnectorContentType::Bytes(b) => b.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// AuthTokens
// ---------------------------------------------------------------------------

/// OAuth / API tokens handed to a connector after authentication completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthTokens {
    /// Short-lived access token.
    pub access_token: String,

    /// Long-lived refresh token, if provided by the OAuth server.
    pub refresh_token: Option<String>,

    /// Absolute expiry timestamp of the access token.
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

// ---------------------------------------------------------------------------
// SyncResult
// ---------------------------------------------------------------------------

/// Summary of a completed sync run.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncResult {
    /// Total number of files discovered (folders excluded).
    pub total: usize,

    /// Number of files successfully submitted for extraction.
    pub synced: usize,

    /// Number of files that failed.
    pub failed: usize,

    /// Human-readable error messages for each failure.
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// API response helpers (internal)
// ---------------------------------------------------------------------------

/// Envelope returned by `POST /api/kex/upload`.
#[derive(Debug, Deserialize)]
pub(crate) struct UploadResponse {
    pub job_id: String,
}

/// Generic error body returned by GCTRL on non-2xx responses.
#[derive(Debug, Deserialize)]
pub(crate) struct ApiErrorBody {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub message: String,
}

impl ApiErrorBody {
    pub fn best_message(&self) -> String {
        if !self.message.is_empty() {
            self.message.clone()
        } else if !self.error.is_empty() {
            self.error.clone()
        } else {
            "unknown error".to_string()
        }
    }
}

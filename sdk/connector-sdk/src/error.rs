/// Errors that can occur during connector operations.
#[derive(Debug, thiserror::Error)]
pub enum ConnectorError {
    /// An HTTP transport error from reqwest.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// A non-2xx response from the GCTRL API.
    #[error("API error {status}: {message}")]
    Api { status: u16, message: String },

    /// Authentication / token error.
    #[error("Auth error: {0}")]
    Auth(String),

    /// The requested file or resource was not found.
    #[error("File not found: {0}")]
    NotFound(String),

    /// Local I/O error (e.g. reading from disk in a connector).
    #[error("IO error: {0}")]
    Io(String),
}

/// Convenience alias used throughout the SDK.
pub type ConnectorResult<T> = Result<T, ConnectorError>;

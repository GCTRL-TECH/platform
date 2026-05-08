//! Example: FileSystemConnector
//!
//! Syncs all `.txt` and `.pdf` files from a local directory to GCTRL.
//!
//! Run with:
//!   cargo run --example file_system --manifest-path sdk/connector-sdk/Cargo.toml
//!
//! Set GCTRL_API_URL and GCTRL_API_KEY environment variables, or edit the
//! constants at the bottom of this file.

use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use gctrl_connector_sdk::{
    AuthTokens, ConnectorContent, ConnectorContentType, ConnectorFile, ConnectorResult,
    GctrlClient, GctrlConnector,
};

// ---------------------------------------------------------------------------
// FileSystemConnector
// ---------------------------------------------------------------------------

/// A simple connector that reads files from a local directory.
///
/// Only `.txt` and `.pdf` extensions are synced; everything else is skipped.
struct FileSystemConnector {
    root_path: PathBuf,
}

impl FileSystemConnector {
    fn new(root_path: impl Into<PathBuf>) -> Self {
        Self { root_path: root_path.into() }
    }

    /// Determine MIME type from file extension (minimal, no external deps).
    fn mime_for_path(path: &Path) -> &'static str {
        match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
            "txt" | "text" | "md" => "text/plain",
            "pdf" => "application/pdf",
            "html" | "htm" => "text/html",
            "json" => "application/json",
            "csv" => "text/csv",
            _ => "application/octet-stream",
        }
    }

    /// Check whether a file extension is one we want to sync.
    fn is_supported(path: &Path) -> bool {
        matches!(
            path.extension().and_then(|e| e.to_str()).unwrap_or(""),
            "txt" | "text" | "md" | "pdf" | "html" | "htm" | "json" | "csv"
        )
    }
}

#[async_trait]
impl GctrlConnector for FileSystemConnector {
    fn name(&self) -> &str {
        "FileSystem Connector"
    }

    fn provider(&self) -> &str {
        "filesystem"
    }

    async fn list_files(&self, folder_id: Option<&str>) -> ConnectorResult<Vec<ConnectorFile>> {
        // If a sub-folder is requested, resolve it relative to root; otherwise use root.
        let base: PathBuf = match folder_id {
            Some(rel) => self.root_path.join(rel),
            None => self.root_path.clone(),
        };

        if !base.exists() {
            return Err(gctrl_connector_sdk::ConnectorError::NotFound(
                base.display().to_string(),
            ));
        }

        let mut entries = Vec::new();

        let read_dir = std::fs::read_dir(&base)
            .map_err(|e| gctrl_connector_sdk::ConnectorError::Io(e.to_string()))?;

        for entry in read_dir.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let is_folder = meta.is_dir();

            // Skip unsupported file types (still include folders so callers can recurse)
            if !is_folder && !Self::is_supported(&path) {
                continue;
            }

            // Use the path relative to root as the stable ID
            let id = path
                .strip_prefix(&self.root_path)
                .unwrap_or(&path)
                .display()
                .to_string()
                // Normalise separators for portability
                .replace('\\', "/");

            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| id.clone());

            let size_bytes = if meta.is_file() { Some(meta.len()) } else { None };

            let modified_at: Option<DateTime<Utc>> = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| DateTime::from_timestamp(d.as_secs() as i64, 0).unwrap_or_default());

            // Parent is the folder_id that was passed in, or None for root items.
            let parent_id = folder_id.map(str::to_owned);

            let mime_type = if is_folder {
                "inode/directory".to_owned()
            } else {
                Self::mime_for_path(&path).to_owned()
            };

            entries.push(ConnectorFile {
                id,
                name,
                mime_type,
                size_bytes,
                modified_at,
                is_folder,
                parent_id,
            });
        }

        Ok(entries)
    }

    async fn fetch_content(&self, file_id: &str) -> ConnectorResult<ConnectorContent> {
        let path = self.root_path.join(file_id.replace('/', std::path::MAIN_SEPARATOR_STR));

        if !path.exists() {
            return Err(gctrl_connector_sdk::ConnectorError::NotFound(
                path.display().to_string(),
            ));
        }

        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_id.to_owned());

        let mime_type = Self::mime_for_path(&path).to_owned();

        // Read content: try UTF-8 first for text types; fall back to raw bytes.
        let content = if mime_type.starts_with("text/") || mime_type == "application/json" {
            let text = std::fs::read_to_string(&path)
                .map_err(|e| gctrl_connector_sdk::ConnectorError::Io(e.to_string()))?;
            ConnectorContentType::Text(text)
        } else {
            let bytes = std::fs::read(&path)
                .map_err(|e| gctrl_connector_sdk::ConnectorError::Io(e.to_string()))?;
            ConnectorContentType::Bytes(bytes)
        };

        Ok(ConnectorContent {
            file_id: file_id.to_owned(),
            file_name,
            content,
            mime_type,
        })
    }

    /// No-op: filesystem connector doesn't use OAuth.
    async fn on_auth_complete(&self, _tokens: &AuthTokens) -> ConnectorResult<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    // Initialise basic logging so tracing output is visible.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("gctrl_connector_sdk=debug".parse().unwrap()),
        )
        .init();

    // Configuration — override via env vars or edit these constants.
    let api_url = std::env::var("GCTRL_API_URL")
        .unwrap_or_else(|_| "http://localhost:4000".to_string());
    let api_key = std::env::var("GCTRL_API_KEY")
        .unwrap_or_else(|_| "your-api-key".to_string());
    let docs_dir = std::env::var("GCTRL_SYNC_DIR")
        .unwrap_or_else(|_| "./docs".to_string());
    let compilation_id = std::env::var("GCTRL_COMPILATION_ID").ok();

    // Create connector and client
    let connector = FileSystemConnector::new(&docs_dir);
    let client = GctrlClient::new(&api_url, &api_key);

    println!("GCTRL FileSystem Connector");
    println!("  Source dir    : {}", docs_dir);
    println!("  GCTRL API     : {}", api_url);
    println!(
        "  Compilation   : {}",
        compilation_id.as_deref().unwrap_or("(none — transient)")
    );
    println!();

    match client
        .sync_connector(&connector, None, compilation_id.as_deref())
        .await
    {
        Ok(result) => {
            println!("Sync complete:");
            println!("  Total files : {}", result.total);
            println!("  Synced      : {}", result.synced);
            println!("  Failed      : {}", result.failed);
            if !result.errors.is_empty() {
                println!("  Errors:");
                for e in &result.errors {
                    println!("    - {}", e);
                }
            }
        }
        Err(e) => {
            eprintln!("Sync failed: {}", e);
            std::process::exit(1);
        }
    }
}

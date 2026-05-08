//! # GCTRL Connector SDK
//!
//! This crate provides the building blocks for writing third-party **GCTRL
//! connectors**. A connector bridges an external data source (local filesystem,
//! Google Drive, Slack, SharePoint, …) and the GCTRL knowledge extraction
//! pipeline.
//!
//! ## Quickstart
//!
//! 1. Add `gctrl-connector-sdk` to your `Cargo.toml`.
//! 2. Implement the [`GctrlConnector`] trait for your data source.
//! 3. Create a [`GctrlClient`] with your GCTRL API URL and bearer token.
//! 4. Call [`GctrlClient::sync_connector`] to push documents into the KEX queue.
//!
//! ```rust,no_run
//! use gctrl_connector_sdk::{GctrlClient, GctrlConnector, ConnectorResult,
//!                           ConnectorFile, ConnectorContent, ConnectorContentType,
//!                           AuthTokens};
//!
//! struct MyConnector;
//!
//! #[async_trait::async_trait]
//! impl GctrlConnector for MyConnector {
//!     fn name(&self) -> &str { "My Connector" }
//!     fn provider(&self) -> &str { "my_provider" }
//!
//!     async fn list_files(&self, _folder_id: Option<&str>) -> ConnectorResult<Vec<ConnectorFile>> {
//!         Ok(vec![])
//!     }
//!
//!     async fn fetch_content(&self, file_id: &str) -> ConnectorResult<ConnectorContent> {
//!         Ok(ConnectorContent {
//!             file_id: file_id.to_string(),
//!             file_name: "example.txt".to_string(),
//!             content: ConnectorContentType::Text("hello world".to_string()),
//!             mime_type: "text/plain".to_string(),
//!         })
//!     }
//! }
//!
//! #[tokio::main]
//! async fn main() {
//!     let connector = MyConnector;
//!     let client = GctrlClient::new("http://localhost:4000", "your-api-key");
//!     let result = client.sync_connector(&connector, None, None).await.unwrap();
//!     println!("Synced {}/{} files", result.synced, result.total);
//! }
//! ```

pub mod client;
pub mod connector;
pub mod error;
pub mod models;

// Flat re-exports for ergonomic use
pub use client::GctrlClient;
pub use connector::GctrlConnector;
pub use error::{ConnectorError, ConnectorResult};
pub use models::{
    AuthTokens, ConnectorContent, ConnectorContentType, ConnectorFile, SyncResult,
};

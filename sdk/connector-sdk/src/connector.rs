use crate::{
    error::ConnectorResult,
    models::{AuthTokens, ConnectorContent, ConnectorFile},
};

/// The core trait that every GCTRL connector must implement.
///
/// Implement this trait for your data source (Google Drive, Slack, SharePoint,
/// local filesystem, …) and hand an instance to [`GctrlClient::sync_connector`]
/// to push documents into the KEX extraction queue.
///
/// All methods are `async` to allow non-blocking I/O in the connector
/// implementation.
#[async_trait::async_trait]
pub trait GctrlConnector: Send + Sync {
    /// Human-readable connector name shown in the GCTRL UI.
    ///
    /// Example: `"Slack Connector"`.
    fn name(&self) -> &str;

    /// Short, machine-readable provider slug used for logging and metrics.
    ///
    /// Example: `"slack"`. Should be lowercase, no spaces.
    fn provider(&self) -> &str;

    /// Return the list of files (and optionally folders) available for sync.
    ///
    /// Pass `folder_id = Some(id)` to restrict the listing to a specific
    /// sub-folder, or `None` to list from the connector's root.
    async fn list_files(&self, folder_id: Option<&str>) -> ConnectorResult<Vec<ConnectorFile>>;

    /// Download and return the content of the file identified by `file_id`.
    ///
    /// The returned [`ConnectorContent`] will be submitted verbatim to the
    /// GCTRL KEX upload endpoint.
    async fn fetch_content(&self, file_id: &str) -> ConnectorResult<ConnectorContent>;

    /// Called by the SDK immediately after OAuth completes, so the connector
    /// can persist or validate the received tokens.
    ///
    /// The default implementation is a no-op; override if needed.
    async fn on_auth_complete(&self, _tokens: &AuthTokens) -> ConnectorResult<()> {
        Ok(())
    }
}

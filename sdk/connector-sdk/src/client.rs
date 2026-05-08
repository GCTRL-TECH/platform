use tracing::{debug, error, info, warn};

use crate::{
    connector::GctrlConnector,
    error::{ConnectorError, ConnectorResult},
    models::{ApiErrorBody, ConnectorContent, SyncResult, UploadResponse},
};

/// HTTP client for the GCTRL REST API.
///
/// # Example
///
/// ```rust,no_run
/// # use gctrl_connector_sdk::GctrlClient;
/// let client = GctrlClient::new("http://localhost:4000", "your-jwt-token");
/// ```
pub struct GctrlClient {
    api_url: String,
    api_key: String,
    http: reqwest::Client,
}

impl GctrlClient {
    /// Create a new client.
    ///
    /// * `api_url`  – Base URL of the GCTRL service, e.g. `"http://localhost:4000"`.
    /// * `api_key`  – Bearer JWT obtained from the GCTRL login flow.
    pub fn new(api_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();
        Self {
            api_url: api_url.into().trim_end_matches('/').to_owned(),
            api_key: api_key.into(),
            http,
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// Submit a file for knowledge extraction.
    ///
    /// Sends the content as `multipart/form-data` to
    /// `POST {api_url}/api/kex/upload` and returns the enqueued `job_id`.
    ///
    /// Optional `compilation_id` associates the job with an existing KG
    /// compilation; if omitted, GCTRL creates a transient extraction.
    pub async fn submit_for_extraction(
        &self,
        content: ConnectorContent,
        compilation_id: Option<&str>,
    ) -> ConnectorResult<String> {
        let url = format!("{}/api/kex/upload", self.api_url);

        debug!(
            file_id = %content.file_id,
            file_name = %content.file_name,
            mime_type = %content.mime_type,
            "Submitting file for extraction"
        );

        // Build multipart form — send the file bytes under the field name "file"
        // as expected by the KEX /upload endpoint.  The file_id field is not
        // part of the KEX API and must NOT be included.
        let file_bytes = content.as_bytes();
        let part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(content.file_name.clone())
            .mime_str(&content.mime_type)
            .map_err(|e| ConnectorError::Http(e))?;

        let mut form = reqwest::multipart::Form::new().part("file", part);

        if let Some(cid) = compilation_id {
            form = form.text("compilation_id", cid.to_owned());
        }

        // Send request — allow up to 5 minutes for large file uploads
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await?;

        let status = resp.status();

        if !status.is_success() {
            let body: ApiErrorBody = resp
                .json()
                .await
                .unwrap_or(ApiErrorBody { error: String::new(), message: String::new() });
            error!(
                status = status.as_u16(),
                message = %body.best_message(),
                "GCTRL API returned error on upload"
            );
            return Err(ConnectorError::Api {
                status: status.as_u16(),
                message: body.best_message(),
            });
        }

        let upload: UploadResponse = resp.json().await?;
        debug!(job_id = %upload.job_id, "File enqueued for extraction");

        Ok(upload.job_id)
    }

    /// Run a full sync cycle for the given connector.
    ///
    /// Steps performed:
    /// 1. Call [`GctrlConnector::list_files`] (with `folder_id`).
    /// 2. Skip any entries that are folders (`is_folder == true`).
    /// 3. For each file: call [`GctrlConnector::fetch_content`], then
    ///    [`GctrlClient::submit_for_extraction`].
    /// 4. Collect per-file outcomes into a [`SyncResult`].
    ///
    /// Errors on individual files are recorded in [`SyncResult::errors`] and do
    /// **not** abort the sync – all files are attempted.
    pub async fn sync_connector(
        &self,
        connector: &dyn GctrlConnector,
        folder_id: Option<&str>,
        compilation_id: Option<&str>,
    ) -> ConnectorResult<SyncResult> {
        info!(
            connector = connector.name(),
            provider = connector.provider(),
            "Starting sync"
        );

        // 1. List available files
        let all_entries = connector.list_files(folder_id).await?;

        // 2. Filter out folders
        let files: Vec<_> = all_entries.into_iter().filter(|f| !f.is_folder).collect();

        let total = files.len();
        info!(total, "Files discovered (folders excluded)");

        let mut synced = 0usize;
        let mut failed = 0usize;
        let mut errors: Vec<String> = Vec::new();

        // 3. Fetch + submit each file
        for file in &files {
            debug!(file_id = %file.id, file_name = %file.name, "Processing file");

            // Fetch content
            let content = match connector.fetch_content(&file.id).await {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("[{}] fetch failed: {}", file.name, e);
                    warn!(%msg);
                    errors.push(msg);
                    failed += 1;
                    continue;
                }
            };

            // Submit for extraction
            match self.submit_for_extraction(content, compilation_id).await {
                Ok(job_id) => {
                    debug!(file_name = %file.name, %job_id, "Submitted successfully");
                    synced += 1;
                }
                Err(e) => {
                    let msg = format!("[{}] upload failed: {}", file.name, e);
                    warn!(%msg);
                    errors.push(msg);
                    failed += 1;
                }
            }
        }

        let result = SyncResult { total, synced, failed, errors };

        info!(
            connector = connector.name(),
            total = result.total,
            synced = result.synced,
            failed = result.failed,
            "Sync complete"
        );

        Ok(result)
    }
}

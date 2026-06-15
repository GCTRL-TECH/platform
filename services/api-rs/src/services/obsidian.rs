//! Shared Obsidian vault re-ingest core.
//!
//! Both the HTTP sync handlers (`routes::connectors`) and the background cron
//! executor (`background`) re-ingest an Obsidian vault by listing its `.md`
//! notes and enqueuing one KEX job per note. This module holds the single
//! source of truth for that logic so the download → enqueue path is not
//! duplicated.
//!
//! Two vault kinds are supported, both server-reachable:
//!   * `folder` — a directory mounted into the API container (under
//!     `cfg.vaults_root`). Notes are read from disk, base64-encoded, and pushed
//!     as `kex_connector` / `type:"file"` jobs (same as a direct upload).
//!   * `rest`   — an Obsidian Local REST API endpoint (loopback only). Notes are
//!     listed via the REST API and pushed as `kex_obsidian` jobs; the worker
//!     downloads each note itself using the (decrypted) url + token.
//!
//! Local (browser-drive) vaults cannot be re-ingested server-side — the server
//! has no access to the browser's filesystem — so they are simply never given an
//! Obsidian trigger by the frontend.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use uuid::Uuid;

use crate::services::redis::lpush;

/// One Obsidian vault row, as needed for re-ingest. Mirrors the columns the
/// connectors route already reads; `api_token` is the AES-sealed token (we
/// decrypt with `crypto::open` before use).
#[derive(sqlx::FromRow, Clone)]
pub struct VaultRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub label: String,
    pub kind: String,
    pub folder_path: Option<String>,
    pub vault_url: Option<String>,
    pub api_token: Option<String>,
}

/// Resolved KEX options for a re-ingest (ontology entity types + classification).
/// Built once per vault sync, reused for every note.
#[derive(Clone, Default)]
pub struct ReingestOpts {
    pub ontology_id: Option<Uuid>,
    pub entity_types: Option<Vec<String>>,
    pub discovery_mode: Option<String>,
    pub compilation_id: Option<Uuid>,
    pub classification_level_id: Option<Uuid>,
    pub classification_name: Option<String>,
    /// `full` (default) re-ingests every note. `incremental` re-ingests only
    /// notes whose mtime is newer than `since` (folder vaults only; REST vaults
    /// fall back to full because the Local REST API list has no cheap mtime).
    pub mode: ReingestMode,
    /// For incremental folder syncs: only notes modified at/after this instant
    /// are re-ingested. `None` = treat all as changed (first run).
    pub since: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum ReingestMode {
    #[default]
    Full,
    Incremental,
}

impl ReingestMode {
    pub fn from_str(s: Option<&str>) -> Self {
        match s {
            Some("incremental") => ReingestMode::Incremental,
            _ => ReingestMode::Full,
        }
    }
}

/// Outcome of a vault re-ingest: how many notes were enqueued / skipped / failed.
#[derive(Default)]
pub struct ReingestResult {
    pub synced: u32,
    pub skipped: u32,
    pub failed: u32,
    pub job_ids: Vec<Uuid>,
}

/// Re-ingest a single vault: list its `.md` notes and enqueue a KEX job per note.
///
/// Resilient by construction — per-note failures are counted, not propagated, so
/// a single unreadable note never aborts the whole vault. Returns an `Err` only
/// for vault-level problems (e.g. folder root missing, REST list unreachable)
/// that mean *no* work could be done; callers (HTTP handler / cron loop) log and
/// continue.
pub async fn reingest_vault(
    db: &sqlx::PgPool,
    redis: &Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
    http: &reqwest::Client,
    vaults_root: &str,
    vault: &VaultRow,
    opts: &ReingestOpts,
) -> Result<ReingestResult, String> {
    match vault.kind.as_str() {
        "folder" => reingest_folder_vault(db, redis, vaults_root, vault, opts).await,
        "rest" => reingest_rest_vault(db, redis, http, vault, opts).await,
        // Local (browser-drive) vaults are not server-reachable.
        other => Err(format!(
            "vault {} is kind '{other}' — not server-reachable, cannot re-ingest",
            vault.id
        )),
    }
}

// ─── Folder vaults ───────────────────────────────────────────────────────────

async fn reingest_folder_vault(
    db: &sqlx::PgPool,
    redis: &Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
    vaults_root: &str,
    vault: &VaultRow,
    opts: &ReingestOpts,
) -> Result<ReingestResult, String> {
    use base64::Engine;

    let folder_path = vault
        .folder_path
        .as_deref()
        .ok_or_else(|| "folder vault has no folder_path".to_string())?;

    let base = resolve_vault_path(vaults_root, folder_path)
        .map_err(|e| format!("vault path unusable: {e}"))?;

    let mut rels: Vec<PathBuf> = Vec::new();
    collect_md_files(&base, &base, &mut rels);

    let mut out = ReingestResult::default();

    for rel in &rels {
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        // Defence in depth: reject absolute / traversal paths.
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            out.failed += 1;
            continue;
        }
        let abs = base.join(rel);
        let canon = match std::fs::canonicalize(&abs) {
            Ok(c) if c.starts_with(&base) => c,
            _ => {
                out.failed += 1;
                continue;
            }
        };

        // Incremental: skip notes not modified since the last run.
        if opts.mode == ReingestMode::Incremental {
            if let Some(since) = opts.since {
                let modified = std::fs::metadata(&canon)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| {
                        chrono::DateTime::<chrono::Utc>::from_timestamp(
                            d.as_secs() as i64,
                            d.subsec_nanos(),
                        )
                        .unwrap_or_else(chrono::Utc::now)
                    });
                if let Some(mt) = modified {
                    if mt < since {
                        out.skipped += 1;
                        continue;
                    }
                }
            }
        }

        let bytes = match std::fs::read(&canon) {
            Ok(b) => b,
            Err(_) => {
                out.failed += 1;
                continue;
            }
        };

        let note_name = canon
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel_str.clone());

        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let kex_input = json!({
            "fileBase64":       encoded,
            "mimetype":         "text/markdown",
            "originalFilename": note_name,
        })
        .to_string();

        let job_id = Uuid::new_v4();
        let insert = sqlx::query(
            "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id)
             VALUES ($1, $2, 'kex_connector', 'pending', $3, $4)",
        )
        .bind(job_id)
        .bind(vault.user_id)
        .bind(json!({
            "fileName":      note_name,
            "vaultId":       vault.id,
            "ontologyId":    opts.ontology_id,
            "compilationId": opts.compilation_id,
            "discoveryMode": opts.discovery_mode,
        }))
        .bind(opts.classification_level_id)
        .execute(db)
        .await;

        if insert.is_err() {
            out.failed += 1;
            continue;
        }

        crate::services::usage::record_usage(db, vault.user_id, "kex_extract", 5, Some(job_id))
            .await;

        let mut payload = json!({
            "job_id":                  job_id,
            "user_id":                 vault.user_id,
            "type":                    "file",
            "input":                   kex_input,
            "file_name":               note_name,
            "entity_types":            opts.entity_types,
            "ontology_id":             opts.ontology_id,
            "classification":          opts.classification_name,
            "classification_level_id": opts.classification_level_id,
        });
        crate::services::llm::inject_ollama_overrides(db, vault.user_id, &mut payload).await;

        if lpush(redis, "kex:jobs", &payload.to_string()).await.is_err() {
            out.failed += 1;
            continue;
        }

        out.synced += 1;
        out.job_ids.push(job_id);
    }

    Ok(out)
}

// ─── REST vaults ─────────────────────────────────────────────────────────────

async fn reingest_rest_vault(
    db: &sqlx::PgPool,
    redis: &Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
    http: &reqwest::Client,
    vault: &VaultRow,
    opts: &ReingestOpts,
) -> Result<ReingestResult, String> {
    let vault_url = vault
        .vault_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "rest vault has no vault_url".to_string())?
        .to_string();
    let api_token = crate::services::crypto::open(vault.api_token.as_deref().unwrap_or(""));

    // List all `.md` notes via the Obsidian Local REST API.
    let list_url = format!("{}/vault/", vault_url.trim_end_matches('/'));
    let resp = http
        .get(&list_url)
        .bearer_auth(&api_token)
        .send()
        .await
        .map_err(|e| format!("REST list request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("REST list returned HTTP {}", resp.status()));
    }
    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("REST list parse failed: {e}"))?;

    let note_paths: Vec<String> = data
        .get("files")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .filter(|p| p.ends_with(".md"))
        .collect();

    let mut out = ReingestResult::default();

    for note_path in &note_paths {
        let note_name = note_path.rsplit('/').next().unwrap_or(note_path).to_string();
        let job_id = Uuid::new_v4();

        let insert = sqlx::query(
            "INSERT INTO jobs (id, user_id, type, status, input, classification_level_id)
             VALUES ($1, $2, 'kex_obsidian', 'pending', $3, $4)",
        )
        .bind(job_id)
        .bind(vault.user_id)
        .bind(json!({
            "fileName":      note_name,
            "vaultId":       vault.id,
            "notePath":      note_path,
            "ontologyId":    opts.ontology_id,
            "compilationId": opts.compilation_id,
            "discoveryMode": opts.discovery_mode,
        }))
        .bind(opts.classification_level_id)
        .execute(db)
        .await;

        if insert.is_err() {
            out.failed += 1;
            continue;
        }

        crate::services::usage::record_usage(db, vault.user_id, "kex_extract", 5, Some(job_id))
            .await;

        let mut payload = json!({
            "job_id":                  job_id,
            "user_id":                 vault.user_id,
            "type":                    "kex_obsidian",
            "input":                   {
                "vaultUrl": vault_url,
                "apiToken": api_token,
                "notePath": note_path,
                "vaultId":  vault.id,
            },
            "entity_types":            opts.entity_types,
            "ontology_id":             opts.ontology_id,
            "classification":          opts.classification_name,
            "classification_level_id": opts.classification_level_id,
        });
        crate::services::llm::inject_ollama_overrides(db, vault.user_id, &mut payload).await;

        if lpush(redis, "kex:jobs", &payload.to_string()).await.is_err() {
            out.failed += 1;
            continue;
        }

        out.synced += 1;
        out.job_ids.push(job_id);
    }

    Ok(out)
}

// ─── Filesystem helpers (shared with routes::connectors) ─────────────────────

/// Resolve `requested` against `root`, canonicalize both, and verify the result
/// stays inside `root`. Blocks `..` traversal and symlink escape.
pub fn resolve_vault_path(root: &str, requested: &str) -> Result<PathBuf, String> {
    use std::path::Path;

    let root_canon = std::fs::canonicalize(root)
        .map_err(|_| format!("vault root '{root}' does not exist on the server"))?;

    let req_path = Path::new(requested);
    let joined = if req_path.is_absolute() {
        req_path.to_path_buf()
    } else {
        root_canon.join(req_path)
    };

    let canon = std::fs::canonicalize(&joined).map_err(|_| "path does not exist".to_string())?;

    if !canon.starts_with(&root_canon) {
        return Err("path must be inside the vault root".to_string());
    }
    Ok(canon)
}

/// Recursively collect `.md` files under `dir`, returning paths relative to
/// `base`. Skips `.obsidian/` and `.trash/` subdirectories.
pub fn collect_md_files(base: &std::path::Path, dir: &std::path::Path, acc: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if file_type.is_dir() {
            if name == ".obsidian" || name == ".trash" {
                continue;
            }
            collect_md_files(base, &path, acc);
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
        {
            if let Ok(rel) = path.strip_prefix(base) {
                acc.push(rel.to_path_buf());
            }
        }
    }
}

/// Load a server-reachable Obsidian vault row by id (no user scoping — the cron
/// executor acts on behalf of the trigger's owner, which is resolved separately).
pub async fn load_vault(db: &sqlx::PgPool, vault_id: Uuid) -> Result<VaultRow, String> {
    sqlx::query_as::<_, VaultRow>(
        "SELECT id, user_id, label, kind, folder_path, vault_url, api_token
         FROM obsidian_vaults WHERE id = $1",
    )
    .bind(vault_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("vault {vault_id} not found"))
}

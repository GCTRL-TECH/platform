//! P2b — document identity + version chains.
//!
//! Every ingested document gets a stable identity keyed on `(user_id, path)`.
//! Re-ingesting the SAME content (same sha256) just touches `last_ingested_at`;
//! CHANGED content creates version+1 in a chain (the previous row's `latest`
//! flag flips to false, `supersedes` points back to it). A later phase can then
//! rank fact authority by source recency (`modified_at`) instead of just
//! extraction recency.

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// sha256 of arbitrary content, hex-encoded — the `content_hash` stored on
/// `source_documents`.
pub fn hash_content(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Outcome of resolving a document against its (user, path) identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceDocResolution {
    pub id: Uuid,
    pub version: i32,
    /// True when a NEW row was inserted (first sighting of this path, or a
    /// changed-content version bump). False when an existing row was merely
    /// touched (same content re-ingested).
    pub is_new_version: bool,
}

/// The latest known row for a (user, path), as read from `source_documents`.
#[derive(Debug, Clone)]
pub struct ExistingLatest {
    pub id: Uuid,
    pub version: i32,
    pub content_hash: String,
}

/// Decision outcome — pure, DB-free, and therefore unit-testable without a
/// database harness (none exists in this crate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// No prior row for this path — insert version 1.
    FirstVersion { new_id: Uuid },
    /// Same content as the current latest — touch it, no new row.
    Touch { id: Uuid, version: i32 },
    /// Different content — insert version+1, superseding the old latest.
    NewVersion { new_id: Uuid, version: i32, supersedes: Uuid },
}

/// Pure decision helper: given the current latest row for a (user, path) (if
/// any) and the new content's hash, decide what `resolve_source_document`
/// must do. `new_id` is a caller-supplied fresh UUID for the row that would be
/// inserted (kept as an argument, rather than generated inside, so this stays
/// pure and deterministic for tests).
pub fn decide(existing: Option<&ExistingLatest>, new_hash: &str, new_id: Uuid) -> Decision {
    match existing {
        None => Decision::FirstVersion { new_id },
        Some(row) if row.content_hash == new_hash => {
            Decision::Touch { id: row.id, version: row.version }
        }
        Some(row) => Decision::NewVersion {
            new_id,
            version: row.version + 1,
            supersedes: row.id,
        },
    }
}

/// Resolve (or create) the `source_documents` identity for one ingested
/// document. See module docs for the version-chain semantics.
///
/// `path` should be the fullest source path/URL the caller has (falls back to
/// a bare name, or `text:<preview>` for raw text extraction with no source
/// reference — callers decide that fallback before calling this).
pub async fn resolve_source_document(
    db: &sqlx::PgPool,
    user_id: Uuid,
    connector_id: Option<Uuid>,
    path: &str,
    name: Option<&str>,
    content_hash: &str,
    modified_at: Option<DateTime<Utc>>,
) -> Result<SourceDocResolution, sqlx::Error> {
    let existing: Option<ExistingLatest> = sqlx::query_as::<_, (Uuid, i32, String)>(
        "SELECT id, version, content_hash FROM source_documents
          WHERE user_id = $1 AND path = $2 AND latest LIMIT 1",
    )
    .bind(user_id)
    .bind(path)
    .fetch_optional(db)
    .await?
    .map(|(id, version, content_hash)| ExistingLatest { id, version, content_hash });

    let new_id = Uuid::new_v4();
    match decide(existing.as_ref(), content_hash, new_id) {
        Decision::Touch { id, version } => {
            sqlx::query(
                "UPDATE source_documents SET
                     last_ingested_at = NOW(),
                     connector_id     = COALESCE($2, connector_id),
                     name             = COALESCE($3, name),
                     modified_at      = COALESCE($4, modified_at)
                 WHERE id = $1",
            )
            .bind(id)
            .bind(connector_id)
            .bind(name)
            .bind(modified_at)
            .execute(db)
            .await?;
            Ok(SourceDocResolution { id, version, is_new_version: false })
        }
        Decision::FirstVersion { new_id } => {
            sqlx::query(
                "INSERT INTO source_documents
                     (id, user_id, connector_id, path, name, content_hash, version, latest, modified_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 1, true, COALESCE($7, NOW()))",
            )
            .bind(new_id)
            .bind(user_id)
            .bind(connector_id)
            .bind(path)
            .bind(name)
            .bind(content_hash)
            .bind(modified_at)
            .execute(db)
            .await?;
            Ok(SourceDocResolution { id: new_id, version: 1, is_new_version: true })
        }
        Decision::NewVersion { new_id, version, supersedes } => {
            let mut tx = db.begin().await?;
            sqlx::query("UPDATE source_documents SET latest = false WHERE id = $1")
                .bind(supersedes)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO source_documents
                     (id, user_id, connector_id, path, name, content_hash, version, supersedes, latest, modified_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, COALESCE($9, NOW()))",
            )
            .bind(new_id)
            .bind(user_id)
            .bind(connector_id)
            .bind(path)
            .bind(name)
            .bind(content_hash)
            .bind(version)
            .bind(supersedes)
            .bind(modified_at)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            Ok(SourceDocResolution { id: new_id, version, is_new_version: true })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_existing_row_is_first_version() {
        let new_id = Uuid::new_v4();
        let decision = decide(None, "abc123", new_id);
        assert_eq!(decision, Decision::FirstVersion { new_id });
    }

    #[test]
    fn same_hash_touches_existing_id_no_new_row() {
        let existing_id = Uuid::new_v4();
        let existing = ExistingLatest { id: existing_id, version: 3, content_hash: "abc123".into() };
        let new_id = Uuid::new_v4();
        let decision = decide(Some(&existing), "abc123", new_id);
        assert_eq!(decision, Decision::Touch { id: existing_id, version: 3 });
    }

    #[test]
    fn changed_hash_creates_version_plus_one_chain() {
        let existing_id = Uuid::new_v4();
        let existing = ExistingLatest { id: existing_id, version: 3, content_hash: "abc123".into() };
        let new_id = Uuid::new_v4();
        let decision = decide(Some(&existing), "different-hash", new_id);
        assert_eq!(
            decision,
            Decision::NewVersion { new_id, version: 4, supersedes: existing_id }
        );
    }

    #[test]
    fn hash_content_is_stable_sha256_hex() {
        // Known sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        let h = hash_content(b"hello");
        assert_eq!(h, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        // Deterministic across calls.
        assert_eq!(h, hash_content(b"hello"));
        assert_ne!(h, hash_content(b"hello!"));
    }
}

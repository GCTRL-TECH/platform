use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::fs;

/// Stable per-instance activation fingerprint.
///
/// Derived from a UUID persisted in the RW config volume (next to `license.jwt`),
/// NOT from ephemeral container properties. The previous derivation hashed the
/// first network interface's MAC + a `sysinfo` disk name; inside a container the
/// veth MAC is randomly reassigned on every `docker compose up -d` recreate (and
/// the disk enumeration is non-deterministic), so a plain recreate with identical
/// images produced a NEW fingerprint, mismatched the license binding, and dropped
/// the agent to "unactivated" until a manual re-activation. Anchoring identity to
/// a persisted UUID makes recreates, image updates and compose changes preserve
/// the activation automatically.
pub async fn compute(instance_id_path: &str) -> String {
    hash(&load_or_create_instance_id(instance_id_path).await)
}

/// Read the persisted instance id, or mint + persist one on first run / a wiped
/// volume. A failed write is logged loudly (the value is stable for this process
/// but would NOT survive a recreate), yet never fatal — the agent keeps serving.
async fn load_or_create_instance_id(path: &str) -> String {
    if let Ok(existing) = fs::read_to_string(path).await {
        let id = existing.trim();
        if !id.is_empty() {
            return id.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(dir) = Path::new(path).parent() {
        let _ = fs::create_dir_all(dir).await;
    }
    match fs::write(path, &id).await {
        Ok(()) => tracing::info!("minted persistent instance id at {path}"),
        Err(e) => tracing::error!(
            "failed to persist instance id to {path}: {e} — the license may not survive a container recreate"
        ),
    }
    id
}

fn hash(id: &str) -> String {
    let mut h = Sha256::new();
    // Namespaced so the hash is unambiguously an instance-id fingerprint.
    h.update(format!("gctrl-instance::{id}").as_bytes());
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stable_across_recreates_via_persisted_id() {
        let dir = std::env::temp_dir().join(format!("gctrl-fp-{}", uuid::Uuid::new_v4()));
        let path = dir.join("instance_id").to_string_lossy().into_owned();

        // First boot mints + persists an id.
        let a = compute(&path).await;
        assert!(fs::metadata(&path).await.is_ok(), "instance id must be persisted");

        // A container recreate = a new process reading the SAME persisted file →
        // identical fingerprint (the whole point: no license invalidation).
        let b = compute(&path).await;
        assert_eq!(a, b, "fingerprint must survive a recreate");
        assert_eq!(a.len(), 64, "sha256 hex");

        // A wiped config volume mints a new identity (expected edge case).
        let _ = fs::remove_file(&path).await;
        let c = compute(&path).await;
        assert_ne!(a, c);

        let _ = fs::remove_dir_all(&dir).await;
    }
}

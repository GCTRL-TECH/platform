//! Application-level AES-256-GCM encryption at rest for sensitive credential
//! columns (OAuth tokens, OAuth client secrets, Obsidian API tokens, SharePoint
//! client secrets).
//!
//! ## Design
//!
//! - **Algorithm**: AES-256-GCM (authenticated encryption — tamper-evident).
//! - **Stored format**: `v1:<base64(nonce12)>:<base64(ciphertext+tag)>`. The
//!   version prefix lets us evolve the scheme and — critically — lets [`open`]
//!   distinguish ciphertext from legacy plaintext.
//! - **Key**: 32 bytes. In prod, set `GCTRL_SECRET_KEY` to a base64-encoded
//!   32-byte value. In dev (key unset), we derive a *stable* key from
//!   `JWT_SECRET` via SHA-256 so the value is deterministic across restarts and
//!   existing dev data keeps working without configuration.
//! - **Nonce**: a fresh random 96-bit nonce per [`seal`] call. AES-GCM nonces
//!   must never repeat under the same key; 96 random bits per message is the
//!   standard, collision-safe construction.
//! - **Backward/forward compatibility**: [`open`] returns any value that does
//!   not start with `v1:` unchanged, treating it as legacy plaintext. This makes
//!   every read site safe *before, during, and after* the one-time backfill, so
//!   the whole change is non-breaking.
//!
//! WARNING: losing the key makes all sealed secrets unrecoverable. Rotate via a
//! re-encrypt migration, never by silently changing the key.

use std::sync::OnceLock;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::Engine;
use sha2::{Digest, Sha256};

/// Process-wide 32-byte AES key, initialised once at startup via [`init`].
static KEY: OnceLock<[u8; 32]> = OnceLock::new();

const VERSION_PREFIX: &str = "v1:";
const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Resolve the encryption key from the environment and store it process-wide.
///
/// Call once from `main` before any [`seal`]/[`open`]. Precedence:
/// 1. `GCTRL_SECRET_KEY` — base64 of exactly 32 bytes (production path).
/// 2. Fallback: SHA-256 of `jwt_secret` → a stable, deterministic 32-byte key
///    (dev path). Logs a `warn!` so operators know to set a real key in prod.
pub fn init(jwt_secret: &str) {
    let key = match std::env::var("GCTRL_SECRET_KEY") {
        Ok(b64) if !b64.trim().is_empty() => match B64.decode(b64.trim()) {
            Ok(bytes) if bytes.len() == 32 => {
                let mut k = [0u8; 32];
                k.copy_from_slice(&bytes);
                tracing::info!("crypto: using GCTRL_SECRET_KEY for at-rest encryption");
                k
            }
            Ok(bytes) => {
                panic!(
                    "GCTRL_SECRET_KEY must decode to exactly 32 bytes (got {})",
                    bytes.len()
                );
            }
            Err(e) => panic!("GCTRL_SECRET_KEY is not valid base64: {e}"),
        },
        _ => {
            tracing::warn!(
                "crypto: GCTRL_SECRET_KEY not set — deriving at-rest key from JWT_SECRET. \
                 Set a real GCTRL_SECRET_KEY (base64 of 32 bytes) in production."
            );
            derive_key_from(jwt_secret)
        }
    };
    // Ignore the Err case (already initialised) — init is idempotent in tests.
    let _ = KEY.set(key);
}

/// SHA-256(jwt_secret) → 32 bytes. Deterministic across restarts.
fn derive_key_from(jwt_secret: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(jwt_secret.as_bytes());
    let digest = hasher.finalize();
    let mut k = [0u8; 32];
    k.copy_from_slice(&digest);
    k
}

/// Return the active key, falling back to a test key if [`init`] was never
/// called (only happens in unit tests that don't boot the app).
fn key() -> &'static [u8; 32] {
    KEY.get_or_init(|| derive_key_from("gctrl-crypto-test-key"))
}

/// Encrypt `plaintext` → `v1:<base64(nonce)>:<base64(ciphertext)>`.
///
/// Panics only on a programming error (key/cipher init); encryption of arbitrary
/// bytes with a valid key/nonce does not fail.
pub fn seal(plaintext: &str) -> String {
    use rand::RngCore;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key()));

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .expect("AES-GCM encryption failed");

    format!(
        "{VERSION_PREFIX}{}:{}",
        B64.encode(nonce_bytes),
        B64.encode(ciphertext)
    )
}

/// Decrypt a value produced by [`seal`]. Values that do not start with `v1:`
/// are returned unchanged (legacy plaintext passthrough), so reads are safe
/// regardless of whether the backfill has run.
///
/// A malformed `v1:` payload (bad base64, wrong length, failed auth) returns the
/// raw stored string rather than erroring — defensive, so one corrupt row can't
/// take down a whole handler. Such rows simply fail downstream auth as before.
pub fn open(stored: &str) -> String {
    let Some(rest) = stored.strip_prefix(VERSION_PREFIX) else {
        return stored.to_string(); // legacy plaintext
    };

    let mut parts = rest.splitn(2, ':');
    let (Some(nonce_b64), Some(ct_b64)) = (parts.next(), parts.next()) else {
        tracing::warn!("crypto::open: malformed v1 payload (missing nonce/ciphertext)");
        return stored.to_string();
    };

    let (Ok(nonce_bytes), Ok(ciphertext)) = (B64.decode(nonce_b64), B64.decode(ct_b64)) else {
        tracing::warn!("crypto::open: v1 payload base64 decode failed");
        return stored.to_string();
    };
    if nonce_bytes.len() != 12 {
        tracing::warn!("crypto::open: v1 nonce wrong length");
        return stored.to_string();
    }

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key()));
    let nonce = Nonce::from_slice(&nonce_bytes);
    match cipher.decrypt(nonce, ciphertext.as_ref()) {
        Ok(plain) => String::from_utf8_lossy(&plain).into_owned(),
        Err(_) => {
            tracing::warn!("crypto::open: AES-GCM decryption/auth failed");
            stored.to_string()
        }
    }
}

/// True if `stored` is already sealed (`v1:` prefix). Used by the backfill to
/// skip rows that are encrypted already (idempotency).
pub fn is_sealed(stored: &str) -> bool {
    stored.starts_with(VERSION_PREFIX)
}

/// One-shot, idempotent encryption backfill for all sensitive credential
/// columns. Run from `main` after migrations. For each (table, column) pair it
/// selects rows whose value is non-null and not yet sealed (`v1:` prefix), then
/// rewrites the value with [`seal`]. Safe to run on every boot — already-sealed
/// rows are skipped by the `NOT LIKE 'v1:%'` filter.
///
/// Because [`open`] passes legacy plaintext through unchanged, the system works
/// correctly whether or not this has run yet.
pub async fn backfill_encrypt_secrets(db: &sqlx::PgPool) {
    // (table, id_column, secret_column). id_column is the PK we update by.
    const TARGETS: &[(&str, &str, &str)] = &[
        ("oauth_connectors",          "id", "access_token"),
        ("oauth_connectors",          "id", "refresh_token"),
        ("connector_configs",         "provider", "client_secret"),
        ("sso_configs",               "id", "client_secret"),
        ("obsidian_vaults",           "id", "api_token"),
        ("sharepoint_tenant_configs", "id", "client_secret"),
    ];

    let mut total = 0u64;
    for (table, id_col, col) in TARGETS {
        match backfill_one(db, table, id_col, col).await {
            Ok(n) => {
                if n > 0 {
                    tracing::info!("crypto backfill: encrypted {n} row(s) in {table}.{col}");
                }
                total += n;
            }
            Err(e) => {
                // A missing table/column (schema drift) shouldn't crash boot —
                // log and continue so the rest of the columns still get sealed.
                tracing::warn!("crypto backfill: {table}.{col} skipped: {e}");
            }
        }
    }
    tracing::info!("crypto backfill complete: {total} secret value(s) encrypted at rest");
}

/// Backfill a single (table, column). `id_col` is the primary-key column we
/// update by (`id` for UUID tables, `provider` for connector_configs).
async fn backfill_one(
    db: &sqlx::PgPool,
    table: &str,
    id_col: &str,
    col: &str,
) -> Result<u64, sqlx::Error> {
    // Identifiers come from a const allowlist above, not user input — safe to
    // interpolate. Values are always bound.
    let select_sql = format!(
        "SELECT {id_col}::text, {col} FROM {table} \
         WHERE {col} IS NOT NULL AND {col} <> '' AND {col} NOT LIKE 'v1:%'"
    );
    let rows: Vec<(String, String)> = sqlx::query_as(&select_sql).fetch_all(db).await?;

    let update_sql = format!("UPDATE {table} SET {col} = $1 WHERE {id_col}::text = $2");
    let mut n = 0u64;
    for (id, plaintext) in rows {
        let sealed = seal(&plaintext);
        sqlx::query(&update_sql)
            .bind(&sealed)
            .bind(&id)
            .execute(db)
            .await?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let secret = "ya29.super-secret-oauth-token-value";
        let sealed = seal(secret);
        assert!(sealed.starts_with("v1:"));
        assert_ne!(sealed, secret);
        assert_eq!(open(&sealed), secret);
    }

    #[test]
    fn open_passes_through_legacy_plaintext() {
        // A value that was stored before encryption existed.
        assert_eq!(open("legacy-plaintext-token"), "legacy-plaintext-token");
        assert_eq!(open(""), "");
    }

    #[test]
    fn distinct_nonces_produce_distinct_ciphertext() {
        let a = seal("same-input");
        let b = seal("same-input");
        assert_ne!(a, b, "nonce reuse — ciphertexts must differ");
        assert_eq!(open(&a), "same-input");
        assert_eq!(open(&b), "same-input");
    }

    #[test]
    fn is_sealed_detects_prefix() {
        assert!(is_sealed(&seal("x")));
        assert!(!is_sealed("plaintext"));
    }

    #[test]
    fn malformed_v1_returns_raw() {
        // Not valid base64 after the prefix → returned unchanged, no panic.
        assert_eq!(open("v1:not-valid"), "v1:not-valid");
    }
}

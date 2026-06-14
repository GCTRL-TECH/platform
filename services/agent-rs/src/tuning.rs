//! ER tuning cache. The license server delivers the (signed) FUSE entity-
//! resolution tuning profile over the heartbeat; the agent verifies it with the
//! license public key it already embeds, caches the last-good `{version, profile}`
//! on disk, and serves it to the local FUSE service at GET /tuning. A repo-dropper
//! has neither the profile (not in the repo) nor the private key (can't forge it).

use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct TuningClaims {
    #[serde(rename = "tuningVersion")]
    tuning_version: i64,
    profile: Value,
    #[allow(dead_code)]
    exp: Option<i64>,
}

/// The on-disk cache shape (and the /tuning response body). FUSE's tuning.py reads
/// `profile` out of this.
#[derive(Serialize, Deserialize, Clone)]
pub struct CachedTuning {
    pub version: i64,
    pub profile: Value,
}

/// Verify a tuning JWS with the license RS256 public key. Enforces the issuer and
/// the token's expiry, so a forged / stale / wrong-key token is rejected and the
/// caller keeps the last-good cache (or generic defaults). Returns Err on any
/// failure — never trusts unverified bytes.
pub fn verify_tuning_jws(jws: &str, public_key_pem: &str) -> Result<CachedTuning, String> {
    let key = DecodingKey::from_rsa_pem(public_key_pem.as_bytes()).map_err(|e| e.to_string())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&["api.gctrl.tech"]);
    // exp is validated by default → an expired tuning token is refused.
    let data = decode::<TuningClaims>(jws, &key, &validation).map_err(|e| e.to_string())?;
    Ok(CachedTuning {
        version: data.claims.tuning_version,
        profile: data.claims.profile,
    })
}

/// Read the cached profile from disk (the last verified one). None when absent/bad.
pub async fn read_cache(path: &str) -> Option<CachedTuning> {
    let s = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str::<CachedTuning>(&s).ok()
}

/// Atomically-ish persist the verified profile as the new last-good cache.
pub async fn write_cache(path: &str, t: &CachedTuning) -> std::io::Result<()> {
    let s = serde_json::to_string(t).unwrap_or_default();
    tokio::fs::write(path, s).await
}

#[cfg(test)]
mod tests {
    use super::*;
    // Interop check: a tuning JWT signed externally (RS256, like license-api's
    // jose signer) is accepted, its version/profile extracted; a wrong-key token
    // is rejected. Token + keys are injected via env by the test harness.
    #[test]
    fn verifies_external_tuning_jws() {
        // Skips cleanly when the round-trip harness env isn't present (normal CI).
        let token = match std::env::var("TEST_TUNING_JWS") { Ok(t) => t, Err(_) => return };
        let good = match std::env::var("TEST_PUBKEY") { Ok(k) => k, Err(_) => return };
        let t = verify_tuning_jws(&token, &good).expect("valid token should verify");
        assert_eq!(t.version, 7);
        assert_eq!(
            t.profile.get("default_metrics").and_then(|m| m.get("person")).and_then(|v| v.as_str()),
            Some("AND(jaro(x.name, y.name)|0.85, exactmatch(x.type, y.type)|1.0)")
        );
        if let Ok(wrong) = std::env::var("TEST_WRONG_PUBKEY") {
            assert!(verify_tuning_jws(&token, &wrong).is_err(), "wrong key must be rejected");
        }
    }
}

use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
use serde::{Deserialize, Serialize};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseClaims {
    pub sub:                  String,
    #[serde(rename = "licenseId")]
    pub license_id:           String,
    pub tier:                 String,
    #[serde(rename = "creditsBalance")]
    pub credits_balance:      i64,
    #[serde(rename = "overdraftLimit")]
    pub overdraft_limit:      i64,
    #[serde(rename = "hardwareFingerprint")]
    pub hardware_fingerprint: String,
    #[serde(rename = "latestVersion")]
    pub latest_version:       String,
    #[serde(rename = "updateAvailable")]
    pub update_available:     bool,
    #[serde(rename = "updateRequired")]
    pub update_required:      bool,
    pub exp: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct LicenseCache {
    activated:     bool,
    claims:        Option<LicenseClaims>,
    local_balance: i64,
    /// Machine-readable activation state for /status + /health + operators:
    /// "active" | "unactivated" | "fingerprint_mismatch" | "revoked" | "seat_limit".
    reason:        &'static str,
    /// Grace flag: a validly-signed license is being honored but its fingerprint
    /// binding is stale (e.g. first boot after the fingerprint fix). Enforcement
    /// keeps working; the re-attestation loop rebinds it to this instance.
    needs_reattest: bool,
}

impl LicenseCache {
    pub fn unactivated() -> Self {
        Self {
            activated:     false,
            claims:        None,
            local_balance: 0,
            reason:        "unactivated",
            needs_reattest: false,
        }
    }

    pub async fn load_from_disk(path: &str, public_key_pem: &str) -> Result<Self, crate::error::AgentError> {
        let token = fs::read_to_string(path).await
            .map_err(|_| crate::error::AgentError::LicenseNotFound(path.into()))?;
        Self::from_token(token.trim(), public_key_pem)
    }

    pub fn from_token(token: &str, public_key_pem: &str) -> Result<Self, crate::error::AgentError> {
        let key = DecodingKey::from_rsa_pem(public_key_pem.as_bytes())
            .map_err(|e| crate::error::AgentError::InvalidJwt(e.to_string()))?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_exp = false;
        let data = decode::<LicenseClaims>(token, &key, &validation)
            .map_err(|e| crate::error::AgentError::InvalidJwt(e.to_string()))?;
        let balance = data.claims.credits_balance;
        Ok(Self {
            activated:     true,
            claims:        Some(data.claims),
            local_balance: balance,
            reason:        "active",
            needs_reattest: false,
        })
    }

    pub fn set_from_claims(&mut self, claims: LicenseClaims) {
        self.local_balance = claims.credits_balance;
        self.activated     = true;
        self.claims        = Some(claims);
        self.reason        = "active";
        self.needs_reattest = false;
    }

    /// Honor a validly-signed but fingerprint-mismatched license: keep enforcing
    /// (activated stays true) but flag it for background re-attestation. A hard
    /// fail here is what caused the recreate outage — grace + re-attest is the fix.
    pub fn into_grace(mut self, reason: &'static str) -> Self {
        if self.claims.is_some() {
            self.needs_reattest = true;
            self.reason = reason;
        }
        self
    }

    /// The license server ACTIVELY rejected this instance (revoked / seat limit).
    /// Only this drops enforcement — a transient/unreachable server never does.
    pub fn mark_unactivated(&mut self, reason: &'static str) {
        self.activated = false;
        self.needs_reattest = false;
        self.reason = reason;
    }

    pub fn reason(&self)         -> &'static str { self.reason }
    pub fn needs_reattest(&self) -> bool { self.needs_reattest }

    pub fn is_activated(&self)         -> bool { self.activated }
    pub fn is_valid(&self)             -> bool { self.activated }
    pub fn tier(&self)                 -> &str { self.claims.as_ref().map_or("", |c| &c.tier) }
    pub fn balance(&self)              -> i64  { self.local_balance }
    pub fn overdraft_limit(&self)      -> i64  { self.claims.as_ref().map_or(0, |c| c.overdraft_limit) }
    pub fn hardware_fingerprint(&self) -> &str { self.claims.as_ref().map_or("", |c| &c.hardware_fingerprint) }
    pub fn is_update_required(&self)   -> bool { self.claims.as_ref().map_or(false, |c| c.update_required) }
    pub fn is_update_available(&self)  -> bool { self.claims.as_ref().map_or(false, |c| c.update_available) }
    pub fn latest_version(&self)       -> &str { self.claims.as_ref().map_or("", |c| &c.latest_version) }
    pub fn license_id(&self)           -> &str { self.claims.as_ref().map_or("", |c| &c.license_id) }

    pub fn can_spend(&self, cost: i64) -> bool {
        if !self.activated {
            return false;
        }
        let overdraft = self.claims.as_ref().map_or(0, |c| c.overdraft_limit);
        self.local_balance >= cost || self.local_balance + overdraft >= cost
    }

    pub fn deduct_local(&mut self, cost: i64) {
        self.local_balance -= cost;
    }
}

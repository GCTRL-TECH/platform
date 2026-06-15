//! File-backed instance version tracking.
//!
//! The agent tracks which RELEASE this instance is running ("current_version"),
//! decoupled from individual image builds. The version is persisted in the agent
//! config dir so it survives restarts. It is:
//!   - reported upstream only when it CHANGES (`instance_version`), tracked
//!     against a `reported_version` marker so steady-state heartbeats stay quiet,
//!   - seeded on a fresh install from the license's `latest_version`,
//!   - exposed on `/status` as `currentVersion`,
//!   - set by the API update executor via `POST /version` after a successful update.

use tokio::fs;

/// Read the current instance version from `path`. Returns `None` if the file is
/// absent or contains only whitespace.
pub async fn read_current(path: &str) -> Option<String> {
    let raw = fs::read_to_string(path).await.ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Write the current instance version atomically-ish: write to a temp file then
/// rename over the target so a crash mid-write never leaves a truncated version.
pub async fn write_current(path: &str, version: &str) -> std::io::Result<()> {
    let tmp = format!("{path}.tmp");
    fs::write(&tmp, version.trim()).await?;
    fs::rename(&tmp, path).await
}

/// Numeric dotted semver compare: `true` iff `a` is strictly greater than `b`.
/// If either side is unparseable, fall back to a plain string `>` comparison.
pub fn version_gt(a: &str, b: &str) -> bool {
    match (parse_version(a), parse_version(b)) {
        // Fixed-width [major, minor, patch] tuples so 1.2 == 1.2.0 (no false positives).
        (Some(va), Some(vb)) => va > vb,
        _ => a.trim() > b.trim(),
    }
}

fn parse_version(s: &str) -> Option<[u64; 3]> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    // Drop pre-release / build metadata.
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let nums: Vec<u64> = core.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    if nums.is_empty() || nums.len() > 3 {
        return None;
    }
    let mut out = [0u64; 3];
    for (i, n) in nums.into_iter().enumerate() {
        out[i] = n;
    }
    Some(out)
}

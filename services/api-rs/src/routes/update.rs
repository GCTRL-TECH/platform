use axum::{
    extract::Query,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

// Images to pull + their container names (api last — it hosts this endpoint)
const SERVICES: &[(&str, &str)] = &[
    ("gctrl-agent",    "ghcr.io/gctrl-tech/agent:latest"),
    ("gctrl-web",      "ghcr.io/gctrl-tech/web:latest"),
    ("gctrl-fuse",     "ghcr.io/gctrl-tech/fuse:latest"),
    ("gctrl-kex",      "ghcr.io/gctrl-tech/kex:latest"),
    ("gctrl-resolver", "ghcr.io/gctrl-tech/fusion-engine:latest"),
    ("gctrl-api",      "ghcr.io/gctrl-tech/api:latest"),
];

/// Server version. Defaults to the crate version, overridable at build/run time
/// via the `GCTRL_VERSION` environment variable (build-time `env!` is preferred,
/// runtime fallback below in [`current_version`]).
const CARGO_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default update channel: a tiny JSON document exposing the latest version.
/// Overridable via the `GCTRL_UPDATE_CHANNEL_URL` env var.
const DEFAULT_CHANNEL_URL: &str = "https://gctrl.tech/version.json";

/// How long a successful (or gracefully-degraded) check is cached in-memory,
/// so the bell can poll cheaply.
const CHECK_CACHE_TTL: Duration = Duration::from_secs(3600);

/// Returns the running server version. Prefers the build-time `GCTRL_VERSION`
/// override (compiled in if present), then a runtime env override, then the
/// crate version.
pub(crate) fn current_version() -> String {
    if let Some(v) = option_env!("GCTRL_VERSION") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("GCTRL_VERSION") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    CARGO_VERSION.to_string()
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        // GET — EventSource-compatible SSE stream used by LicenseBanner / bell
        .route("/", get(trigger_update))
        // GET — lightweight version/update-available check (bell polling)
        .route("/check", get(check_update))
        // GET — server-side proxy to the gctrl-agent's :7070/status, so browsers
        // that can't reach the agent's internal-network port directly still get a
        // truthful reachable/unreachable signal via the API's own origin.
        .route("/agent-status", get(agent_status))
}

// ─── Version / update-available check ─────────────────────────────────────────

#[derive(Clone)]
struct CachedCheck {
    payload: Value,
    fetched_at: Instant,
}

fn check_cache() -> &'static Mutex<Option<CachedCheck>> {
    static CACHE: OnceLock<Mutex<Option<CachedCheck>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(serde::Deserialize)]
struct CheckParams {
    /// `?force=1` bypasses the read of the cache (a fresh result is still written
    /// back to it). Used by the Settings "Check now" button.
    force: Option<String>,
}

/// `GET /api/update/check[?force=1]` → digest-based update detection (primary),
/// with the semver channel kept only as display metadata.
///
/// Every service ships as `:latest`, so semver is the wrong tool for "is there an
/// update" — the authoritative signal is whether the locally-pulled image digest
/// still matches the digest ghcr.io serves for `:latest` (see [`collect_service_digests`]).
/// The semver channel (`current`/`latest`) is fetched purely for display + changelog
/// purposes and can never mask or override the digest result. Degrades honestly:
/// if neither the registry nor the channel is reachable, `method: "unavailable"`
/// and `note` explain why — never a false "up to date". Results are cached for
/// [`CHECK_CACHE_TTL`] so bell polling and repeated Settings visits stay cheap.
async fn check_update(Query(params): Query<CheckParams>) -> Json<Value> {
    let force = params.force.as_deref() == Some("1");
    let current = current_version();

    // Serve from cache if fresh (unless the caller explicitly asked to bypass it).
    if !force {
        if let Ok(guard) = check_cache().lock() {
            if let Some(c) = guard.as_ref() {
                if c.fetched_at.elapsed() < CHECK_CACHE_TTL {
                    return Json(c.payload.clone());
                }
            }
        }
    }

    // 1. Digest pass — the authoritative detector when it yields data for at
    //    least one service (locally installed + registry reachable).
    let services = collect_service_digests().await;
    let any_checked = services
        .iter()
        .any(|s| s.local.is_some() && s.remote.is_some());
    let digest_update_available = services.iter().any(|s| s.up_to_date() == Some(false));

    // 2. Semver channel — metadata only (current/latest for display + changelog).
    //    A channel failure must never mask a digest result, and vice versa.
    let latest_opt = fetch_latest_version().await;
    let channel_ok = latest_opt.is_some();
    let latest = latest_opt.unwrap_or_else(|| current.clone());
    let semver_update_available = version_gt(&latest, &current);

    let (method, update_available, note): (&str, bool, Option<&str>) = if any_checked {
        ("digest", digest_update_available, None)
    } else if channel_ok {
        ("semver", semver_update_available, None)
    } else {
        (
            "unavailable",
            false,
            Some("Could not reach ghcr.io or the update channel — install state unknown."),
        )
    };

    // Both naming conventions are emitted so every consumer is satisfied:
    // Header.tsx / SettingsPage.tsx read `current`/`latest`; other clients (and the
    // license banner) read `currentVersion`/`latestVersion`. `updateAvailable` is
    // always present and reflects the digest pass whenever one was possible.
    let payload = json!({
        "current": current,
        "latest": latest,
        "currentVersion": current,
        "latestVersion": latest,
        "updateAvailable": update_available,
        "method": method,
        "services": services.iter().map(ServiceDigest::to_json).collect::<Vec<_>>(),
        "checkedAt": chrono::Utc::now().to_rfc3339(),
        "note": note,
    });

    if let Ok(mut guard) = check_cache().lock() {
        *guard = Some(CachedCheck { payload: payload.clone(), fetched_at: Instant::now() });
    }

    Json(payload)
}

// ─── Digest-based detection ─────────────────────────────────────────────────

/// Per-service digest comparison result for the `/check` response and the
/// post-update verification line.
#[derive(Clone, Debug)]
struct ServiceDigest {
    name: String,
    image: String,
    local: Option<String>,
    remote: Option<String>,
}

impl ServiceDigest {
    /// `Some(true)` up to date, `Some(false)` outdated, `None` unknown (not
    /// installed locally, locally built, or the registry was unreachable).
    fn up_to_date(&self) -> Option<bool> {
        match (&self.local, &self.remote) {
            (Some(l), Some(r)) => Some(l == r),
            _ => None,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "image": self.image,
            "localDigest": self.local,
            "remoteDigest": self.remote,
            "upToDate": self.up_to_date(),
        })
    }
}

/// Runs the local+remote digest check for every entry in [`SERVICES`], concurrently
/// across services (each service's own local/remote lookup is sequential).
async fn collect_service_digests() -> Vec<ServiceDigest> {
    let checks = SERVICES.iter().map(|(_container, image)| async move {
        let local = local_image_digest_async((*image).to_string()).await;
        let remote = fetch_remote_digest(image).await;
        ServiceDigest {
            name: short_name_from_image(image),
            image: image.to_string(),
            local,
            remote,
        }
    });
    futures::future::join_all(checks).await
}

/// "ghcr.io/gctrl-tech/agent:latest" → "agent" (last path segment, tag stripped).
fn short_name_from_image(image: &str) -> String {
    image
        .rsplit('/')
        .next()
        .unwrap_or(image)
        .split(':')
        .next()
        .unwrap_or(image)
        .to_string()
}

/// "ghcr.io/gctrl-tech/agent:latest" → Some("gctrl-tech/agent"). `None` if the
/// image isn't hosted on ghcr.io (nothing to look up anonymously).
fn ghcr_repo_from_image(image: &str) -> Option<String> {
    let rest = image.strip_prefix("ghcr.io/")?;
    let repo = rest.split(':').next().unwrap_or(rest);
    if repo.is_empty() { None } else { Some(repo.to_string()) }
}

/// Anonymous ghcr.io manifest digest for `<repo>:latest`. ghcr.io manifests are
/// publicly readable even for repos under an org, so this needs no credentials —
/// verified empirically: `GET /token?scope=repository:<repo>:pull` → bearer token,
/// then `HEAD /v2/<repo>/manifests/latest` → `docker-content-digest` header. `None`
/// on any failure (network, non-2xx, missing header) — never surfaced as an error.
async fn fetch_remote_digest(image: &str) -> Option<String> {
    let repo = ghcr_repo_from_image(image)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;

    let token_url = format!("https://ghcr.io/token?scope=repository:{repo}:pull");
    let token_resp = client.get(&token_url).send().await.ok()?;
    if !token_resp.status().is_success() {
        return None;
    }
    let token_json: Value = token_resp.json().await.ok()?;
    let token = token_json.get("token").and_then(|v| v.as_str())?;

    let manifest_url = format!("https://ghcr.io/v2/{repo}/manifests/latest");
    let manifest_resp = client
        .head(&manifest_url)
        .header("Authorization", format!("Bearer {token}"))
        .header(
            "Accept",
            "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
        )
        .send()
        .await
        .ok()?;
    if !manifest_resp.status().is_success() {
        return None;
    }

    manifest_resp
        .headers()
        .get("docker-content-digest")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Async wrapper around [`local_image_digest`] (which uses the blocking
/// [`docker_http`] socket helper) so it can be awaited alongside the ghcr lookup.
async fn local_image_digest_async(image: String) -> Option<String> {
    tokio::task::spawn_blocking(move || local_image_digest(&image))
        .await
        .ok()
        .flatten()
}

/// The digest Docker recorded locally for `image` the last time it was pulled
/// (`RepoDigests[0]`, the part after `@`). `None` if the image isn't present
/// locally (404) or was built locally rather than pulled (no `RepoDigests`).
fn local_image_digest(image: &str) -> Option<String> {
    let (status, body) = docker_http("GET", &format!("/images/{image}/json"), None, 10).ok()?;
    if status != 200 {
        return None;
    }
    let inspect = json_from_body(&body);
    inspect
        .get("RepoDigests")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .and_then(|s| s.rsplit('@').next())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// `GET /api/update/agent-status` → proxies the gctrl-agent's internal `:7070/status`
/// through the API's own origin, since browsers on a different LAN than the agent
/// host can reach the API but not that agent port directly (it's published
/// loopback-only). Absence of the agent is a normal dev/grace state, not an error:
/// on any failure this returns HTTP 200 `{"reachable": false}`, never a 5xx.
async fn agent_status() -> Json<Value> {
    let base = std::env::var("GCTRL_AGENT_URL").unwrap_or_else(|_| "http://gctrl-agent:7070".to_string());
    let base = base.trim_end_matches('/').to_string();

    let fetched: Option<Value> = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .ok()?;
        let resp = client.get(format!("{base}/status")).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<Value>().await.ok()
    }
    .await;

    match fetched {
        Some(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("reachable".to_string(), json!(true));
            }
            Json(v)
        }
        None => Json(json!({ "reachable": false })),
    }
}

/// Fetch the latest version. Tries the configured version channel first, then
/// falls back to the GitHub releases API so a future GitHub release is caught
/// even if the channel endpoint is down/unmaintained. `None` on total failure.
async fn fetch_latest_version() -> Option<String> {
    if let Some(v) = fetch_from_channel().await {
        return Some(v);
    }
    fetch_from_github_releases().await
}

/// Parse the latest version string from the configured update channel
/// (`GCTRL_UPDATE_CHANNEL_URL`, default `gctrl.tech/version.json`).
async fn fetch_from_channel() -> Option<String> {
    let url = std::env::var("GCTRL_UPDATE_CHANNEL_URL")
        .unwrap_or_else(|_| DEFAULT_CHANNEL_URL.to_string());
    if url.trim().is_empty() {
        return None;
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .ok()?;

    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }

    // Prefer JSON; accept a few common shapes, then fall back to a bare string.
    let text = resp.text().await.ok()?;
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        for key in ["version", "latest", "latestVersion", "tag", "tag_name"] {
            if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                let s = s.trim();
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        if let Some(s) = v.as_str() {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
        return None;
    }

    // Plain-text body containing just a version.
    let s = text.trim();
    if !s.is_empty() && s.len() < 64 && !s.contains('<') {
        Some(s.to_string())
    } else {
        None
    }
}

/// Fallback: the latest release tag from the GitHub releases API. Repo via
/// `GCTRL_UPDATE_GITHUB_REPO` (default `gctrl-tech/gctrl`). Unauthenticated
/// (60 req/h is plenty given the hourly cache); a `User-Agent` is required.
async fn fetch_from_github_releases() -> Option<String> {
    let repo = std::env::var("GCTRL_UPDATE_GITHUB_REPO")
        .unwrap_or_else(|_| "gctrl-tech/gctrl".to_string());
    let repo = repo.trim();
    if repo.is_empty() || !repo.contains('/') {
        return None;
    }
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client
        .get(&url)
        .header("User-Agent", "gctrl-update-check")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v = resp.json::<Value>().await.ok()?;
    // `tag_name` (e.g. "v1.2.3") is the canonical release version.
    v.get("tag_name")
        .or_else(|| v.get("name"))
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Loose semver comparison: returns true if `a > b`. Strips a leading `v`,
/// drops any pre-release/build suffix, compares numeric components left-to-right.
/// Any unparseable input compares as not-greater (conservative — no false positives).
fn version_gt(a: &str, b: &str) -> bool {
    match (parse_version(a), parse_version(b)) {
        // Fixed-width [major, minor, patch] tuples so 1.2 == 1.2.0 (no false positives).
        (Some(va), Some(vb)) => va > vb,
        _ => false,
    }
}

fn parse_version(s: &str) -> Option<[u64; 3]> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    // Drop pre-release / build metadata.
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let nums: Vec<u64> = core
        .split('.')
        .map(|p| p.trim().parse::<u64>())
        .collect::<Result<_, _>>()
        .ok()?;
    if nums.is_empty() {
        return None;
    }
    Some([
        nums.first().copied().unwrap_or(0),
        nums.get(1).copied().unwrap_or(0),
        nums.get(2).copied().unwrap_or(0),
    ])
}

async fn trigger_update() -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Result<Event, Infallible>>();

    tokio::spawn(async move {
        run_update(tx).await;
    });

    let stream = async_stream::stream! {
        while let Some(item) = rx.recv().await {
            yield item;
        }
    };

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

// ─── Update logic ─────────────────────────────────────────────────────────────

async fn run_update(tx: mpsc::UnboundedSender<Result<Event, Infallible>>) {
    let send = |event: &str, data: serde_json::Value| {
        let _ = tx.send(Ok(Event::default().event(event).data(data.to_string())));
    };

    if !std::path::Path::new("/var/run/docker.sock").exists() {
        send("error", json!({
            "message": "Docker socket not accessible",
            "manualCommand": "curl -fsSL https://gctrl.tech/update | bash"
        }));
        return;
    }

    // Step 1: Pull all images
    for (_container, image) in SERVICES {
        send("progress", json!({ "step": "pull", "image": image, "message": format!("Pulling {}…", image) }));

        // Pull with up to 3 attempts so a transient registry/network hiccup
        // doesn't abort the whole update.
        let mut ok = false;
        let mut last_err = String::new();
        for attempt in 1..=3 {
            let img = image.to_string();
            match tokio::task::spawn_blocking(move || pull_image(&img)).await {
                Ok(Ok(_)) => { ok = true; break; }
                Ok(Err(e)) => last_err = e,
                Err(e) => last_err = e.to_string(),
            }
            if attempt < 3 {
                send("progress", json!({ "step": "pull", "image": image, "message": format!("Retrying {} (attempt {}/3)…", image, attempt + 1) }));
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
        if ok {
            send("progress", json!({ "step": "pulled", "image": image, "message": format!("{} ready", image) }));
        } else {
            send("error", json!({ "message": format!("Pull failed for {} after 3 attempts: {}", image, last_err), "manualCommand": "curl -fsSL https://gctrl.tech/update | bash" }));
            return;
        }
    }

    // Step 2: Recreate all non-api containers. A container that isn't deployed
    // (e.g. fusion-engine on an install that never enabled FUSE) is skipped, not
    // failed — absence of an optional service is normal, not an error.
    for (container, _) in SERVICES.iter().filter(|(c, _)| *c != "gctrl-api") {
        send("progress", json!({ "step": "restart", "container": container, "message": format!("Recreating {}…", container) }));

        let name = container.to_string();
        match tokio::task::spawn_blocking(move || recreate_container(&name)).await {
            Ok(Ok(true)) => {
                send("progress", json!({ "step": "restarted", "container": container, "message": format!("{} updated", container) }));
            }
            Ok(Ok(false)) => {
                send("progress", json!({ "step": "skipped", "container": container, "message": format!("Skipped {} (not deployed)", container) }));
            }
            Ok(Err(e)) => {
                tracing::warn!("Recreate {} failed: {}", container, e);
                send("progress", json!({ "step": "restart_warn", "container": container, "message": format!("{}: {}", container, e) }));
            }
            Err(_) => {}
        }
    }

    // Step 2b: Close the loop — tell the agent what version we just installed so it
    // flips updateAvailable=false and reports the new version on its next heartbeat.
    // Best-effort: a failure here doesn't fail the update (the agent re-derives it).
    notify_agent_updated().await;

    // Step 2c: Re-run the digest comparison so the client sees a truthful final
    // state (rather than assuming success) before the stream closes.
    let post_services = collect_service_digests().await;
    let still_outdated: Vec<String> = post_services
        .iter()
        .filter(|s| s.up_to_date() == Some(false))
        .map(|s| s.name.clone())
        .collect();
    let verify_message = if still_outdated.is_empty() {
        "Verified: all services up to date.".to_string()
    } else {
        format!("Still outdated after update: {}", still_outdated.join(", "))
    };
    send("progress", json!({ "step": "verify", "message": verify_message }));

    // Step 3: Done — client reloads on receiving this
    send("done", json!({}));

    // Step 4: After client received done, restart the api container itself.
    // We use a simple Docker restart (not recreate) to avoid killing the live response
    // mid-stream. The container will fully recreate on the next docker compose up.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let _ = tokio::task::spawn_blocking(|| docker_restart("gctrl-api")).await;
}

/// Tell the agent which version we just installed so it updates its instance
/// `current_version` and stops advertising the update. We ask the agent for the
/// `latestVersion` it knows about (its single source of truth from the license
/// heartbeat) and write that back as the new current version. Entirely
/// best-effort — any failure is logged and swallowed; the agent will re-derive
/// the correct state on its next heartbeat regardless.
async fn notify_agent_updated() {
    let base = std::env::var("GCTRL_AGENT_INTERNAL_URL")
        .unwrap_or_else(|_| "http://gctrl-agent:7070".to_string());
    let base = base.trim_end_matches('/');

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("notify_agent_updated: client build failed: {e}");
            return;
        }
    };

    // 1. Ask the agent which version is the latest it knows about.
    let status: Value = match client.get(format!("{base}/status")).send().await {
        Ok(resp) => match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("notify_agent_updated: parse /status failed: {e}");
                return;
            }
        },
        Err(e) => {
            tracing::warn!("notify_agent_updated: GET /status failed: {e}");
            return;
        }
    };

    let version = status
        .get("latestVersion")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(version) = version else {
        tracing::warn!("notify_agent_updated: agent /status had no latestVersion; skipping");
        return;
    };

    // 2. Write it back as the instance's new current_version.
    match client
        .post(format!("{base}/version"))
        .json(&json!({ "version": version }))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!("notify_agent_updated: agent current_version set to {version}");
        }
        Ok(resp) => {
            tracing::warn!("notify_agent_updated: POST /version returned {}", resp.status());
        }
        Err(e) => {
            tracing::warn!("notify_agent_updated: POST /version failed: {e}");
        }
    }
}

// ─── Docker socket helpers ────────────────────────────────────────────────────

#[cfg(unix)]
pub(crate) fn docker_http(method: &str, path: &str, body: Option<&str>, timeout_secs: u64) -> Result<(u16, String), String> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let body_str = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body_str}",
        body_str.len()
    );

    let mut stream = UnixStream::connect("/var/run/docker.sock")
        .map_err(|e| format!("Docker socket: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(timeout_secs))).ok();
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    // NOTE: deliberately NOT shutting down the write half here (a prior version
    // did `stream.shutdown(Shutdown::Write)` right after flush). Verified live
    // against the daemon (raw-socket replay via `socat`): the FIN can land before
    // dockerd has finished reading the request off the socket, and dockerd reacts
    // to that half-close with a bare `500 Internal Server Error` / empty body —
    // a genuine race, not a protocol requirement (the request already carries an
    // explicit `Content-Length` so the daemon knows exactly when it's complete).
    // Delaying/removing the shutdown reproducibly fixed it. Since we no longer
    // rely on the daemon closing the connection, the read loop below detects the
    // end of the response itself (Content-Length or chunked trailer) instead of
    // reading to EOF, so a keep-alive connection can't hang us for the full
    // `timeout_secs` on every call either.
    read_http_response(&mut stream, timeout_secs)
}

#[cfg(unix)]
fn read_http_response(stream: &mut impl std::io::Read, _timeout_secs: u64) -> Result<(u16, String), String> {
    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut header_end: Option<usize> = None;

    loop {
        let n = match stream.read(&mut chunk) {
            Ok(0) => break, // daemon closed the connection — whatever we have is final
            Ok(n) => n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                // A read error (e.g. our own timeout) after a complete response was
                // already parsed is harmless; only fatal if we never got one.
                if header_end.is_some() { break; }
                return Err(e.to_string());
            }
        };
        raw.extend_from_slice(&chunk[..n]);

        if header_end.is_none() {
            header_end = find_subslice(&raw, b"\r\n\r\n").map(|p| p + 4);
        }
        let Some(head_end) = header_end else { continue }; // still reading headers

        let headers_lower = String::from_utf8_lossy(&raw[..head_end]).to_ascii_lowercase();
        let received_body = &raw[head_end..];

        if let Some(len) = content_length(&headers_lower) {
            if received_body.len() >= len { break; }
        } else if headers_lower.contains("transfer-encoding: chunked") {
            if find_subslice(received_body, b"\r\n0\r\n\r\n").is_some() || received_body == b"0\r\n\r\n" {
                break;
            }
        } else if headers_lower.contains("http/1.1 1") || headers_lower.contains("http/1.1 204") || headers_lower.contains("http/1.1 304") {
            break; // 1xx/204/304 never carry a body
        }
        // No length signal we recognize yet (or body still incomplete) — keep reading,
        // bounded by the caller's read timeout on the socket.
    }

    let raw_str = String::from_utf8_lossy(&raw);
    let status: u16 = raw_str.split_whitespace().nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let head_end = raw_str.find("\r\n\r\n").map(|i| i + 4).unwrap_or(raw_str.len());
    let headers_lower = raw_str[..head_end].to_ascii_lowercase();
    let raw_body = &raw_str[head_end..];
    let body = if headers_lower.contains("transfer-encoding: chunked") {
        dechunk(raw_body)
    } else {
        raw_body.to_string()
    };
    Ok((status, body))
}

/// Parses `Content-Length: N` out of a lowercased header block.
#[cfg(unix)]
fn content_length(headers_lower: &str) -> Option<usize> {
    headers_lower
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse().ok())
}

/// Finds the first occurrence of `needle` in `haystack` (byte search).
#[cfg(unix)]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Strips HTTP chunked transfer-encoding framing, returning the concatenated
/// payload. Malformed/truncated input degrades gracefully (returns whatever was
/// successfully decoded rather than erroring) — callers already treat an
/// unparseable body as `Value::Null` via [`json_from_body`].
#[cfg(unix)]
fn dechunk(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    loop {
        let Some(nl) = rest.find("\r\n") else { break };
        let size_str = rest[..nl].split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_str, 16) else { break };
        rest = &rest[nl + 2..];
        if size == 0 { break; } // last-chunk marker
        if rest.len() < size {
            out.push_str(rest); // truncated (mid-chunk) — best-effort
            break;
        }
        out.push_str(&rest[..size]);
        rest = rest[size..].strip_prefix("\r\n").unwrap_or(&rest[size..]);
    }
    out
}

#[cfg(not(unix))]
pub(crate) fn docker_http(_method: &str, _path: &str, _body: Option<&str>, _timeout: u64) -> Result<(u16, String), String> {
    Err("Not supported on non-Unix platforms".into())
}

pub(crate) fn json_from_body(body: &str) -> serde_json::Value {
    // Docker may return chunked bodies; find the first '{' or '['
    let start = body.find('{').or_else(|| body.find('['));
    start
        .and_then(|i| serde_json::from_str(&body[i..]).ok())
        .unwrap_or(serde_json::Value::Null)
}

pub(crate) fn pull_image(image: &str) -> Result<(), String> {
    let (name, tag) = match image.rfind(':') {
        Some(p) => (&image[..p], &image[p + 1..]),
        None => (image, "latest"),
    };
    // The Docker Engine API `fromImage` takes the registry path with RAW slashes
    // (e.g. `ghcr.io/ggml-org/llama.cpp`). Percent-encoding the slashes makes the
    // daemon reject it (HTTP 500) — it was the cause of the bundled-llamacpp /
    // updater pull failing on a registry-qualified image.
    let path = format!("/images/create?fromImage={name}&tag={tag}");
    let (status, _) = docker_http("POST", &path, None, 300)?;
    if status == 200 {
        Ok(())
    } else {
        Err(format!("HTTP {status}"))
    }
}

/// Recreates `name` from its (already-pulled) image, preserving its runtime config.
/// Returns `Ok(true)` when recreated, `Ok(false)` when the container simply isn't
/// deployed on this install (404 on inspect) — that's a normal skip, not a failure.
fn recreate_container(name: &str) -> Result<bool, String> {
    // Inspect existing container for its config
    let (status, body) = docker_http("GET", &format!("/containers/{name}/json"), None, 10)?;
    if status == 404 {
        return Ok(false); // not deployed on this install — skip, don't fail the run
    }
    if status != 200 {
        return Err(format!("Inspect returned HTTP {status}"));
    }
    let inspect = json_from_body(&body);

    let network_mode = inspect["HostConfig"]["NetworkMode"]
        .as_str()
        .unwrap_or("bridge")
        .to_string();

    let create_cfg = json!({
        "Image":        inspect["Config"]["Image"],
        "Cmd":          inspect["Config"]["Cmd"],
        "Env":          inspect["Config"]["Env"],
        "ExposedPorts": inspect["Config"]["ExposedPorts"],
        "HostConfig": {
            "Binds":         inspect["HostConfig"]["Binds"],
            "PortBindings":  inspect["HostConfig"]["PortBindings"],
            "RestartPolicy": inspect["HostConfig"]["RestartPolicy"],
            "NetworkMode":   network_mode,
        }
    })
    .to_string();

    // Remove old container (force-stop + delete)
    docker_http("DELETE", &format!("/containers/{name}?force=true"), None, 30)?;

    // Create new container from pulled image
    let (create_status, create_body) =
        docker_http("POST", &format!("/containers/create?name={name}"), Some(&create_cfg), 10)?;
    if create_status != 201 {
        return Err(format!("Create returned HTTP {create_status}: {create_body}"));
    }

    let created = json_from_body(&create_body);
    let id = created["Id"].as_str().unwrap_or(name);

    // Start it
    docker_http("POST", &format!("/containers/{id}/start"), None, 10)?;
    Ok(true)
}

fn docker_restart(name: &str) {
    let _ = docker_http("POST", &format!("/containers/{name}/restart?t=5"), None, 30);
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── version_gt / parse_version (pre-existing behavior, unchanged) ─────────

    #[test]
    fn version_gt_basic() {
        assert!(version_gt("1.2.3", "1.2.2"));
        assert!(!version_gt("1.2.2", "1.2.3"));
        assert!(!version_gt("1.2.3", "1.2.3"));
    }

    #[test]
    fn version_gt_padded_components_are_equal() {
        assert!(!version_gt("1.2", "1.2.0"));
        assert!(version_gt("1.3", "1.2.9"));
    }

    #[test]
    fn version_gt_unparseable_is_conservative() {
        assert!(!version_gt("not-a-version", "1.0.0"));
        assert!(!version_gt("1.0.0", "not-a-version"));
    }

    // ── short_name_from_image / ghcr_repo_from_image ───────────────────────────

    #[test]
    fn short_name_strips_registry_and_tag() {
        assert_eq!(short_name_from_image("ghcr.io/gctrl-tech/agent:latest"), "agent");
        assert_eq!(
            short_name_from_image("ghcr.io/gctrl-tech/fusion-engine:latest"),
            "fusion-engine"
        );
    }

    #[test]
    fn ghcr_repo_extracts_org_and_name() {
        assert_eq!(
            ghcr_repo_from_image("ghcr.io/gctrl-tech/agent:latest"),
            Some("gctrl-tech/agent".to_string())
        );
    }

    #[test]
    fn ghcr_repo_none_for_non_ghcr_image() {
        assert_eq!(ghcr_repo_from_image("docker.io/library/postgres:16"), None);
    }

    // ── ServiceDigest::up_to_date / to_json (response-shape) ───────────────────

    fn digest(local: Option<&str>, remote: Option<&str>) -> ServiceDigest {
        ServiceDigest {
            name: "agent".to_string(),
            image: "ghcr.io/gctrl-tech/agent:latest".to_string(),
            local: local.map(str::to_string),
            remote: remote.map(str::to_string),
        }
    }

    #[test]
    fn up_to_date_true_when_digests_match() {
        assert_eq!(digest(Some("sha256:aaa"), Some("sha256:aaa")).up_to_date(), Some(true));
    }

    #[test]
    fn up_to_date_false_when_digests_differ() {
        assert_eq!(digest(Some("sha256:aaa"), Some("sha256:bbb")).up_to_date(), Some(false));
    }

    #[test]
    fn up_to_date_unknown_when_either_digest_missing() {
        assert_eq!(digest(None, Some("sha256:aaa")).up_to_date(), None);
        assert_eq!(digest(Some("sha256:aaa"), None).up_to_date(), None);
        assert_eq!(digest(None, None).up_to_date(), None);
    }

    #[test]
    fn service_digest_to_json_shape() {
        let d = digest(Some("sha256:aaa"), Some("sha256:bbb"));
        let v = d.to_json();
        assert_eq!(v["name"], "agent");
        assert_eq!(v["image"], "ghcr.io/gctrl-tech/agent:latest");
        assert_eq!(v["localDigest"], "sha256:aaa");
        assert_eq!(v["remoteDigest"], "sha256:bbb");
        assert_eq!(v["upToDate"], false);
    }

    #[test]
    fn service_digest_to_json_nulls_when_unknown() {
        let v = digest(None, None).to_json();
        assert!(v["localDigest"].is_null());
        assert!(v["remoteDigest"].is_null());
        assert!(v["upToDate"].is_null());
    }

    // ── local_image_digest RepoDigests parsing ──────────────────────────────────
    // (local_image_digest itself talks to /var/run/docker.sock via docker_http, so
    // only the pure-parsing half is unit-testable here; the digest-extraction logic
    // — "take the part after @" — is exercised directly.)

    #[test]
    fn repo_digest_extracts_hash_after_at() {
        let repo_digest = "ghcr.io/gctrl-tech/agent@sha256:deadbeef";
        assert_eq!(repo_digest.rsplit('@').next(), Some("sha256:deadbeef"));
    }
}

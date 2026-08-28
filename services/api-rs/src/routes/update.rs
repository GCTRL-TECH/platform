use axum::{
    extract::{Extension, Query},
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Json, Router,
};
use crate::middleware::auth::JwtClaims;
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
}

/// The one `/api/update/*` route that must answer WITHOUT a session.
///
/// `ActivationGate` (web/src/App.tsx) probes it on mount — deliberately before
/// any login, because a freshly installed box has no users yet. Behind
/// `require_auth` that probe answered 401, the axios interceptor turned the 401
/// into `window.location.href = '/login'`, the full page load re-mounted the
/// gate, and the gate probed again: a reload loop that looked like the login
/// page flickering (only under a real hostname — `isLocalDev()` skips the gate
/// on localhost). Commit 69048a5 fixed the interceptor half; this is the cause.
///
/// Registered with FULL paths and merged into the public router in `main.rs`
/// rather than nested: a second `.nest("/api/update", …)` beside the protected
/// nest would collide. `/` and `/check` stay behind `require_auth`.
pub fn public_router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        // GET — server-side proxy to the gctrl-agent's :7070/status, so browsers
        // that can't reach the agent's internal-network port directly still get a
        // truthful reachable/unreachable signal via the API's own origin.
        .route("/api/update/agent-status", get(agent_status))
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
    /// Which local lookup produced `local`: `"running-container"` (the honest
    /// signal — what's actually executing right now) or `"image-tag"` (the
    /// weaker fallback, used only when the container isn't deployed at all).
    source: &'static str,
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
            "source": self.source,
        })
    }
}

/// Runs the local+remote digest check for every entry in [`SERVICES`], concurrently
/// across services (each service's own local/remote lookup is sequential).
async fn collect_service_digests() -> Vec<ServiceDigest> {
    let checks = SERVICES.iter().map(|(container, image)| async move {
        let LocalDigest { digest: local, source } =
            local_digest_async((*container).to_string(), (*image).to_string()).await;
        let remote = fetch_remote_digest(image).await;
        ServiceDigest {
            name: short_name_from_image(image),
            image: image.to_string(),
            local,
            remote,
            source,
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

/// Result of a single service's local digest lookup, tagged with which method
/// produced it (see [`ServiceDigest::source`]).
struct LocalDigest {
    digest: Option<String>,
    source: &'static str,
}

/// Async wrapper around [`local_image_digest_for_service`] (which uses the
/// blocking [`docker_http`] socket helper) so it can be awaited alongside the
/// ghcr lookup.
async fn local_digest_async(container: String, image: String) -> LocalDigest {
    tokio::task::spawn_blocking(move || local_image_digest_for_service(&container, &image))
        .await
        .unwrap_or(LocalDigest { digest: None, source: "image-tag" })
}

/// The honest local signal: what image is the RUNNING container actually on?
/// Inspects the container for its current image ID (`.Image`), then inspects
/// that image by ID for its `RepoDigests`. This is deliberately NOT "what tag
/// did we last pull" — a `docker restart` (as opposed to a recreate) leaves the
/// container on its OLD image while the `:latest` tag has already moved on to
/// the new one, so a tag-based check would report "up to date" while the
/// running process is stale (the exact bug this replaces).
///
/// Falls back to [`local_image_digest`] (tag-based) when the container isn't
/// deployed at all (404 / inspect failure) — e.g. an optional profile service
/// (fusion-engine) that was never enabled on this install still gets a sane
/// comparison instead of silently reporting "unknown".
fn local_image_digest_for_service(container: &str, image: &str) -> LocalDigest {
    match docker_http("GET", &format!("/containers/{container}/json"), None, 10) {
        Ok((200, body)) => {
            let inspect = json_from_body(&body);
            let digest = inspect
                .get("Image")
                .and_then(|v| v.as_str())
                .and_then(digest_for_image_id);
            LocalDigest { digest, source: "running-container" }
        }
        _ => LocalDigest { digest: local_image_digest(image), source: "image-tag" },
    }
}

/// The digest recorded for image ID `id` (e.g. `sha256:abcd…`, as returned by a
/// container inspect's `.Image` field). `None` if the image is gone or has no
/// `RepoDigests` (built locally rather than pulled — never comparable).
fn digest_for_image_id(id: &str) -> Option<String> {
    let (status, body) = docker_http("GET", &format!("/images/{id}/json"), None, 10).ok()?;
    if status != 200 {
        return None;
    }
    first_repo_digest(&json_from_body(&body))
}

/// The digest Docker recorded locally for `image` the last time it was pulled
/// (`RepoDigests[0]`, the part after `@`). `None` if the image isn't present
/// locally (404) or was built locally rather than pulled (no `RepoDigests`).
/// This is the TAG-based fallback — see [`local_image_digest_for_service`] for
/// why the container-based check is preferred whenever a container exists.
fn local_image_digest(image: &str) -> Option<String> {
    let (status, body) = docker_http("GET", &format!("/images/{image}/json"), None, 10).ok()?;
    if status != 200 {
        return None;
    }
    first_repo_digest(&json_from_body(&body))
}

/// Extracts the first `RepoDigests` entry's digest (the part after `@`) from a
/// Docker image-inspect JSON body. Shared by the running-container path
/// ([`digest_for_image_id`]) and the tag-based fallback ([`local_image_digest`]).
fn first_repo_digest(inspect: &Value) -> Option<String> {
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
///
/// Anonymous callers (the pre-login `ActivationGate`, see [`public_router`]) get
/// only the two booleans that gate actually reads. The full agent payload —
/// licence tier, credit balance, versions — stays behind a session; its only
/// consumers (`LicenseBanner`, Settings) render inside the authenticated shell.
async fn agent_status(Extension(claims): Extension<Option<JwtClaims>>) -> Json<Value> {
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
            if claims.is_none() {
                let activated = v.get("activated").cloned().unwrap_or(json!(false));
                return Json(json!({ "reachable": true, "activated": activated }));
            }
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

    // Step 0: Reclaim the images the PREVIOUS update superseded, before pulling
    // several GB of new ones.
    //
    // Doing this first rather than last is what makes it safe: at this moment
    // every container still runs the current generation, so anything owned by
    // GCTRL and unreferenced is provably the leftover of an earlier run. It also
    // frees the disk exactly when it is about to be needed — the failure mode
    // this replaces was an update dying halfway through on a full disk.
    match tokio::task::spawn_blocking(prune_superseded_images).await {
        Ok(report) => {
            if let Some(message) = report.message() {
                send("progress", json!({ "step": "cleanup", "message": message }));
            }
        }
        // A cleanup that cannot run is never a reason to block an update.
        Err(e) => tracing::warn!("Pre-update image cleanup failed: {}", e),
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

    // Step 2a: Every service except the api is now on its new image, so the
    // generation they just left is unreferenced and can go immediately rather
    // than lingering until the next update. The api's own outgoing image is
    // deliberately NOT reachable here — its container is still running on it, so
    // the in-use filter protects it; the agent reclaims it after the swap in
    // Step 3 (see agent-rs `reclaim_previous_image`).
    match tokio::task::spawn_blocking(prune_superseded_images).await {
        Ok(report) => {
            if let Some(message) = report.message() {
                send("progress", json!({ "step": "cleanup", "message": message }));
            }
        }
        Err(e) => tracing::warn!("Post-update image cleanup failed: {}", e),
    }

    // Step 2b: Close the loop — tell the agent what version we just installed so it
    // flips updateAvailable=false and reports the new version on its next heartbeat.
    // Best-effort: a failure here doesn't fail the update (the agent re-derives it).
    notify_agent_updated().await;

    // Step 2c: Re-run the digest comparison so the client sees a truthful final
    // state (rather than assuming success) before the stream closes. The api is
    // deliberately EXCLUDED from this verdict: it hasn't been recreated yet at
    // this point in the run (that happens next, in Step 3) — a check here would
    // compare against the api's *previous* image, so including it would
    // misreport a successful update as "still outdated". Its own outcome is
    // reported as its own honest, separate, asynchronous step below instead of
    // folded into this one — never silently lumped in as a false pass or fail.
    let post_services = collect_service_digests().await;
    let still_outdated: Vec<String> = post_services
        .iter()
        .filter(|s| s.name != "api" && s.up_to_date() == Some(false))
        .map(|s| s.name.clone())
        .collect();
    let verify_message = if still_outdated.is_empty() {
        "Verified: all other services up to date.".to_string()
    } else {
        format!("Still outdated after update: {}", still_outdated.join(", "))
    };
    send("progress", json!({ "step": "verify", "message": verify_message }));

    // Step 3: The api cannot delete-and-recreate its own container without
    // dying mid-operation, so the gctrl-agent does it on the api's behalf — it
    // mounts docker.sock and was ALREADY recreated onto the new image earlier
    // in this same run (Step 2). The agent responds 202 immediately and only
    // performs the actual container swap ~1.5s later (see agent-rs `/recreate`),
    // safely after this HTTP call returns, so this process survives long enough
    // to still emit `done` and close the stream cleanly afterward.
    send("progress", json!({
        "step": "self_update",
        "message": "Updating the API itself (the app will briefly disconnect)…"
    }));
    let self_recreate_ok = ask_agent_to_recreate_api().await;
    if self_recreate_ok {
        send("progress", json!({
            "step": "self_update_ok",
            "message": "API updates itself in the background — refresh in ~20s."
        }));
    } else {
        // Never silently lie: the agent couldn't do it, so say so explicitly.
        // The actual fallback restart happens AFTER `done` below (same reason
        // the old code delayed it) — restarting now would kill this very
        // process before the response finishes.
        send("progress", json!({
            "step": "self_update_warn",
            "message": "API container could not self-recreate — it will be restarted on the current image; run the update again or `docker compose up -d gctrl-api` to finish."
        }));
    }

    // Step 4: Done — client reloads on receiving this.
    send("done", json!({}));

    // Step 5: Only the fallback path still touches the api container from here.
    // A simple restart (not recreate) avoids killing the live response mid-
    // stream; the container fully recreates on the next successful update run
    // or manual `docker compose up -d`.
    if !self_recreate_ok {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let _ = tokio::task::spawn_blocking(|| docker_restart("gctrl-api")).await;
    }
}

/// Asks the gctrl-agent to recreate the api container from its already-pulled
/// image (see [`run_update`] Step 3 for why the api can't do this to itself).
/// Returns `true` only on a genuine `202 Accepted` from the agent — anything
/// else (unreachable, wrong secret, non-202) is treated as failure so the
/// caller falls back honestly rather than assuming success.
async fn ask_agent_to_recreate_api() -> bool {
    let base = std::env::var("GCTRL_AGENT_INTERNAL_URL")
        .unwrap_or_else(|_| "http://gctrl-agent:7070".to_string());
    let base = base.trim_end_matches('/');
    let secret = std::env::var("INTERNAL_API_SECRET").unwrap_or_default();

    let client = match reqwest::Client::builder().timeout(Duration::from_secs(5)).build() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("ask_agent_to_recreate_api: client build failed: {e}");
            return false;
        }
    };

    let mut req = client
        .post(format!("{base}/recreate"))
        .json(&json!({ "container": "gctrl-api" }));
    if !secret.is_empty() {
        req = req.header("X-Internal-Secret", secret);
    }

    match req.send().await {
        Ok(resp) if resp.status() == reqwest::StatusCode::ACCEPTED => true,
        Ok(resp) => {
            tracing::warn!("ask_agent_to_recreate_api: agent returned {}", resp.status());
            false
        }
        Err(e) => {
            tracing::warn!("ask_agent_to_recreate_api: request failed: {e}");
            false
        }
    }
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

/// Builds the `/containers/create` body for a recreate from a `/containers/{name}/json`
/// inspect document.
///
/// The whole `Config` and `HostConfig` are carried over verbatim (the same
/// round-trip Watchtower relies on) instead of a hand-picked field list. The old
/// list dropped everything it did not name — `Labels` (Traefik routers and the
/// `com.docker.compose.*` identity, so `docker compose` stopped recognising the
/// container), `ExtraHosts` (`host.docker.internal` for kex/fuse/api → graphs
/// without edges), `Healthcheck` (kex/fuse `depends_on` the agent's health, so a
/// later `compose up` refused to start them) and `HostConfig.Mounts` (named
/// volumes). Seen live on 2026-08-25: `brain.gctrl.tech` answered 404 after an
/// update because gctrl-web came back without its Traefik labels.
///
/// Two things must NOT be copied: the auto-generated `Hostname` (dockerd sets it
/// to the old container's short id when compose did not pin one — copying it
/// would freeze a stale id as the hostname) and the old id's network alias.
/// Compose service aliases are kept so DNS by service name keeps working.
fn build_create_config(inspect: &Value) -> Value {
    let old_id = inspect["Id"].as_str().unwrap_or("");
    let short_id: String = old_id.chars().take(12).collect();

    let mut config = inspect["Config"].clone();
    if config["Hostname"].as_str() == Some(short_id.as_str()) {
        config.as_object_mut().map(|m| m.remove("Hostname"));
    }

    let mut host_config = inspect["HostConfig"].clone();
    if host_config["NetworkMode"].as_str().map_or(true, str::is_empty) {
        host_config["NetworkMode"] = json!("bridge");
    }

    let mut endpoints = serde_json::Map::new();
    if let Some(nets) = inspect["NetworkSettings"]["Networks"].as_object() {
        for (net, ep) in nets {
            let aliases: Vec<Value> = ep["Aliases"]
                .as_array()
                .map(|a| a.iter().filter(|v| v.as_str() != Some(short_id.as_str())).cloned().collect())
                .unwrap_or_default();
            if !aliases.is_empty() {
                endpoints.insert(net.clone(), json!({ "Aliases": aliases }));
            }
        }
    }

    let mut body = config;
    body["HostConfig"] = host_config;
    if !endpoints.is_empty() {
        body["NetworkingConfig"] = json!({ "EndpointsConfig": endpoints });
    }
    body
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

    let create_cfg = build_create_config(&inspect).to_string();

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

// ─── Superseded-image cleanup ─────────────────────────────────────────────────
//
// Every GCTRL image ships under a floating `:latest` tag, so each pull moves the
// tag to the new image and leaves the previous one behind, untagged and forever.
// Nothing ever collected it, so long-lived installs grew without bound. This
// reclaims it.

/// The container repositories GCTRL publishes and therefore owns. The cleanup
/// only ever removes images attributable to one of these.
///
/// This is deliberately NOT `docker image prune` / `docker system prune`: a GCTRL
/// install regularly shares its host with unrelated stacks (n8n, Traefik, other
/// compose projects), whose dangling images a blanket prune would also collect.
/// Deleting a foreign image would be an unrecoverable surprise for the operator,
/// so attribution is required before anything is touched.
///
/// Tag variants live under the same repo (`kex:latest` and `kex:latest-cuda`),
/// so they need no separate entries.
const OWNED_REPOS: &[&str] = &[
    "ghcr.io/gctrl-tech/agent",
    "ghcr.io/gctrl-tech/api",
    "ghcr.io/gctrl-tech/web",
    "ghcr.io/gctrl-tech/kex",
    "ghcr.io/gctrl-tech/fuse",
    "ghcr.io/gctrl-tech/fusion-engine",
];

/// Escape hatch: `GCTRL_KEEP_OLD_IMAGES=1` in the install's `.env` disables the
/// cleanup entirely — for an air-gapped host that must be able to roll back
/// without registry access, since a removed image can only come back by pulling.
fn cleanup_disabled() -> bool {
    matches!(
        std::env::var("GCTRL_KEEP_OLD_IMAGES").ok().as_deref().map(str::trim),
        Some("1") | Some("true") | Some("yes")
    )
}

/// One entry from `GET /images/json`, reduced to what the cleanup needs.
#[derive(Debug, Clone, PartialEq)]
struct ImageEntry {
    id: String,
    /// Every reference this image answers to — `RepoTags` plus `RepoDigests`.
    ///
    /// `RepoDigests` is what makes this work: a superseded image has no tags left
    /// (the tag moved to the newly pulled image) but KEEPS its
    /// `ghcr.io/gctrl-tech/api@sha256:…` digest reference. That is the only
    /// reliable way to attribute an untagged image to GCTRL — compose labels
    /// can't be used, because [`recreate_container`] does not preserve them.
    refs: Vec<String>,
    size: u64,
}

/// True when any reference names a repo GCTRL owns. Matches on the `repo:tag` /
/// `repo@digest` boundary, so a future `…/api-experimental` is never mistaken
/// for `…/api`.
fn is_owned(refs: &[String]) -> bool {
    refs.iter().any(|r| {
        OWNED_REPOS.iter().any(|repo| {
            r.strip_prefix(repo)
                .is_some_and(|rest| rest.starts_with(':') || rest.starts_with('@'))
        })
    })
}

/// The images that may be removed: owned by GCTRL, and referenced by no
/// container — running OR stopped. A stopped container still pins its image (a
/// `docker start` would boot straight back onto it), so both count as in use.
fn select_removable(images: &[ImageEntry], in_use: &std::collections::HashSet<String>) -> Vec<ImageEntry> {
    images
        .iter()
        .filter(|img| is_owned(&img.refs))
        .filter(|img| !in_use.contains(&img.id) && !img.refs.iter().any(|r| in_use.contains(r)))
        .cloned()
        .collect()
}

/// Parses `GET /images/json`. Docker reports a fully untagged image as the
/// literal `<none>:<none>` / `<none>@<none>` rather than an empty list; those
/// placeholders are not references and are dropped.
fn parse_images(v: &Value) -> Vec<ImageEntry> {
    let Some(arr) = v.as_array() else { return Vec::new() };
    arr.iter()
        .map(|e| {
            let mut refs = Vec::new();
            for key in ["RepoTags", "RepoDigests"] {
                if let Some(list) = e.get(key).and_then(|x| x.as_array()) {
                    refs.extend(
                        list.iter()
                            .filter_map(|s| s.as_str())
                            .filter(|s| !s.starts_with("<none>"))
                            .map(|s| s.to_string()),
                    );
                }
            }
            ImageEntry {
                id: e.get("Id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                refs,
                size: e.get("Size").and_then(|v| v.as_u64()).unwrap_or(0),
            }
        })
        .filter(|i| !i.id.is_empty())
        .collect()
}

/// Parses `GET /containers/json?all=true` into the set of image references that
/// are spoken for. Collects BOTH `ImageID` (the resolved `sha256:…`) and `Image`
/// (which for a container built by [`recreate_container`] is the image *name*),
/// because either form may be how a container pins its image.
fn parse_in_use(v: &Value) -> std::collections::HashSet<String> {
    let Some(arr) = v.as_array() else { return std::collections::HashSet::new() };
    arr.iter()
        .flat_map(|c| {
            ["ImageID", "Image"]
                .into_iter()
                .filter_map(move |k| c.get(k).and_then(|v| v.as_str()))
        })
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Human-readable size for the one log line this feature emits.
fn format_bytes(bytes: u64) -> String {
    const GB: u64 = 1_000_000_000;
    const MB: u64 = 1_000_000;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else {
        format!("{} MB", bytes / MB)
    }
}

/// Outcome of one cleanup pass.
pub(crate) struct PruneReport {
    pub removed: usize,
    /// Sum of the removed images' reported sizes. Docker counts layers shared
    /// with a surviving image in that figure, so this is an upper bound on the
    /// disk actually returned — phrased as "up to" wherever it is shown.
    pub bytes: u64,
}

impl PruneReport {
    /// `None` when there was nothing to do — the caller stays silent rather than
    /// reporting a no-op as work.
    pub fn message(&self) -> Option<String> {
        (self.removed > 0).then(|| {
            format!(
                "Removed {} superseded image{}, freeing up to {}.",
                self.removed,
                if self.removed == 1 { "" } else { "s" },
                format_bytes(self.bytes)
            )
        })
    }
}

/// Removes GCTRL images that no container references any more.
///
/// Blocking (uses the [`docker_http`] socket helper) — call from
/// `spawn_blocking`. Never fails the caller: every step degrades to "removed
/// nothing", because a cleanup that cannot run is not a reason to block an
/// update.
///
/// Deletion deliberately omits `force`: Docker then refuses (409) to remove an
/// image that is still referenced, which is a second, daemon-enforced safety net
/// under the in-use filter. It also refuses an image carrying several
/// repository references, so a locally pinned `:v0.1.230` tag survives instead of
/// being silently untagged.
pub(crate) fn prune_superseded_images() -> PruneReport {
    let empty = PruneReport { removed: 0, bytes: 0 };
    if cleanup_disabled() {
        return empty;
    }

    let Ok((200, images_body)) = docker_http("GET", "/images/json", None, 30) else {
        return empty;
    };
    let Ok((200, containers_body)) = docker_http("GET", "/containers/json?all=true", None, 30) else {
        // Without the container list we cannot prove an image is unused. Removing
        // anything on that basis would be a guess, so do nothing.
        return empty;
    };

    let images = parse_images(&json_from_body(&images_body));
    let in_use = parse_in_use(&json_from_body(&containers_body));

    let mut report = PruneReport { removed: 0, bytes: 0 };
    for img in select_removable(&images, &in_use) {
        match docker_http("DELETE", &format!("/images/{}", img.id), None, 60) {
            Ok((200, _)) => {
                report.removed += 1;
                report.bytes += img.size;
            }
            Ok((status, _)) => {
                tracing::debug!("Cleanup kept image {} (HTTP {})", img.id, status);
            }
            Err(e) => {
                tracing::debug!("Cleanup kept image {} ({})", img.id, e);
            }
        }
    }

    if report.removed > 0 {
        tracing::info!(
            "Image cleanup removed {} superseded image(s), up to {}",
            report.removed,
            format_bytes(report.bytes)
        );
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── build_create_config ────────────────────────────────────────────────────

    fn sample_inspect() -> Value {
        json!({
            "Id": "abcdef123456789",
            "Config": {
                "Hostname": "abcdef123456",
                "Image": "ghcr.io/gctrl-tech/web:latest",
                "Env": ["A=1"],
                "Labels": {
                    "traefik.enable": "true",
                    "com.docker.compose.project": "gctrl"
                },
                "Healthcheck": { "Test": ["CMD", "wget", "-q", "http://127.0.0.1/health"] }
            },
            "HostConfig": {
                "Binds": ["/root/gctrl/nginx.conf:/etc/nginx/conf.d/default.conf:ro"],
                "Mounts": [{ "Type": "volume", "Source": "gctrl_pgdata", "Target": "/data" }],
                "ExtraHosts": ["host.docker.internal:host-gateway"],
                "NetworkMode": "gctrl_gctrl",
                "RestartPolicy": { "Name": "unless-stopped" }
            },
            "NetworkSettings": {
                "Networks": {
                    "gctrl_gctrl": { "Aliases": ["gctrl-web", "abcdef123456"], "IPAddress": "172.16.24.9" }
                }
            }
        })
    }

    #[test]
    fn build_create_config_preserves_labels_extra_hosts_healthcheck_and_mounts() {
        let cfg = build_create_config(&sample_inspect());
        assert_eq!(cfg["Labels"]["traefik.enable"], "true");
        assert_eq!(cfg["Labels"]["com.docker.compose.project"], "gctrl");
        assert_eq!(cfg["Healthcheck"]["Test"][0], "CMD");
        assert_eq!(cfg["HostConfig"]["ExtraHosts"][0], "host.docker.internal:host-gateway");
        assert_eq!(cfg["HostConfig"]["Mounts"][0]["Source"], "gctrl_pgdata");
        assert!(cfg["HostConfig"]["Binds"][0].as_str().is_some_and(|b| !b.is_empty()));
        assert_eq!(cfg["HostConfig"]["NetworkMode"], "gctrl_gctrl");
        assert_eq!(cfg["Image"], "ghcr.io/gctrl-tech/web:latest");
    }

    #[test]
    fn build_create_config_drops_auto_hostname_but_keeps_pinned_one() {
        let cfg = build_create_config(&sample_inspect());
        assert!(cfg.get("Hostname").is_none(), "old container id must not become the hostname");

        let mut pinned = sample_inspect();
        pinned["Config"]["Hostname"] = json!("brain");
        assert_eq!(build_create_config(&pinned)["Hostname"], "brain");
    }

    #[test]
    fn build_create_config_keeps_service_alias_not_old_id_and_no_ip_pin() {
        let cfg = build_create_config(&sample_inspect());
        let ep = &cfg["NetworkingConfig"]["EndpointsConfig"]["gctrl_gctrl"];
        assert_eq!(ep["Aliases"], json!(["gctrl-web"]));
        assert!(ep.get("IPAddress").is_none());
    }

    #[test]
    fn build_create_config_defaults_missing_network_mode_to_bridge() {
        let mut i = sample_inspect();
        i["HostConfig"]["NetworkMode"] = json!("");
        assert_eq!(build_create_config(&i)["HostConfig"]["NetworkMode"], "bridge");
    }

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
        digest_with_source(local, remote, "running-container")
    }

    fn digest_with_source(local: Option<&str>, remote: Option<&str>, source: &'static str) -> ServiceDigest {
        ServiceDigest {
            name: "agent".to_string(),
            image: "ghcr.io/gctrl-tech/agent:latest".to_string(),
            local: local.map(str::to_string),
            remote: remote.map(str::to_string),
            source,
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
        assert_eq!(v["source"], "running-container");
    }

    #[test]
    fn service_digest_to_json_nulls_when_unknown() {
        let v = digest(None, None).to_json();
        assert!(v["localDigest"].is_null());
        assert!(v["remoteDigest"].is_null());
        assert!(v["upToDate"].is_null());
    }

    #[test]
    fn service_digest_to_json_reports_image_tag_source() {
        let v = digest_with_source(Some("sha256:aaa"), Some("sha256:aaa"), "image-tag").to_json();
        assert_eq!(v["source"], "image-tag");
        assert_eq!(v["upToDate"], true);
    }

    // ── local_image_digest / local_image_digest_for_service RepoDigests parsing ──
    // (the docker_http-calling halves talk to /var/run/docker.sock, so only the
    // pure-parsing logic is unit-testable here.)

    #[test]
    fn repo_digest_extracts_hash_after_at() {
        let repo_digest = "ghcr.io/gctrl-tech/agent@sha256:deadbeef";
        assert_eq!(repo_digest.rsplit('@').next(), Some("sha256:deadbeef"));
    }

    #[test]
    fn first_repo_digest_extracts_from_inspect_json() {
        let inspect = json!({
            "RepoDigests": ["ghcr.io/gctrl-tech/agent@sha256:deadbeef"]
        });
        assert_eq!(first_repo_digest(&inspect), Some("sha256:deadbeef".to_string()));
    }

    #[test]
    fn first_repo_digest_none_when_missing_or_empty() {
        assert_eq!(first_repo_digest(&json!({})), None);
        assert_eq!(first_repo_digest(&json!({ "RepoDigests": [] })), None);
        assert_eq!(first_repo_digest(&json!({ "RepoDigests": [""] })), None);
    }

    // ── Superseded-image cleanup ──────────────────────────────────────────────
    // The selection half is pure, so the safety properties that matter (never
    // touch a foreign image, never touch an in-use one) are provable here rather
    // than only on a live host.

    fn img(id: &str, refs: &[&str], size: u64) -> ImageEntry {
        ImageEntry {
            id: id.to_string(),
            refs: refs.iter().map(|s| s.to_string()).collect(),
            size,
        }
    }

    fn in_use(items: &[&str]) -> std::collections::HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn owns_gctrl_images_by_tag_and_by_digest() {
        assert!(is_owned(&["ghcr.io/gctrl-tech/api:latest".into()]));
        assert!(is_owned(&["ghcr.io/gctrl-tech/kex:latest-cuda".into()]));
        // The superseded case: tag already moved away, only the digest is left.
        assert!(is_owned(&["ghcr.io/gctrl-tech/api@sha256:old".into()]));
    }

    #[test]
    fn does_not_own_foreign_or_lookalike_repos() {
        // Foreign stacks sharing the host must never be attributed to GCTRL.
        assert!(!is_owned(&["postgres:16-alpine".into()]));
        assert!(!is_owned(&["ollama/ollama:latest".into()]));
        assert!(!is_owned(&["vllm/vllm-openai:latest".into()]));
        assert!(!is_owned(&["ghcr.io/ggml-org/llama.cpp:server".into()]));
        // Prefix matching must respect the repo boundary.
        assert!(!is_owned(&["ghcr.io/gctrl-tech/api-experimental:latest".into()]));
        // An image with no references left is unattributable, so off-limits.
        assert!(!is_owned(&[]));
    }

    #[test]
    fn selects_superseded_gctrl_image_only() {
        let images = vec![
            img("sha256:new", &["ghcr.io/gctrl-tech/api:latest", "ghcr.io/gctrl-tech/api@sha256:n"], 900),
            img("sha256:old", &["ghcr.io/gctrl-tech/api@sha256:o"], 800),
            img("sha256:pg", &["postgres:16-alpine"], 400),
        ];
        let selected = select_removable(&images, &in_use(&["sha256:new", "sha256:pg"]));
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "sha256:old");
    }

    #[test]
    fn never_selects_an_image_a_container_still_pins() {
        let images = vec![img("sha256:a", &["ghcr.io/gctrl-tech/web:latest"], 100)];
        // Pinned by resolved ID (the running case)…
        assert!(select_removable(&images, &in_use(&["sha256:a"])).is_empty());
        // …and pinned by name, which is how `recreate_container` records it.
        assert!(select_removable(&images, &in_use(&["ghcr.io/gctrl-tech/web:latest"])).is_empty());
    }

    #[test]
    fn never_selects_a_foreign_dangling_image() {
        // The exact case a blanket `docker image prune` would get wrong: an
        // untagged image belonging to some other stack on the same host.
        let images = vec![img("sha256:x", &["registry.example.com/other/app@sha256:z"], 5_000)];
        assert!(select_removable(&images, &in_use(&[])).is_empty());
    }

    #[test]
    fn parses_images_and_drops_none_placeholders() {
        let parsed = parse_images(&json!([
            {
                "Id": "sha256:old",
                "RepoTags": ["<none>:<none>"],
                "RepoDigests": ["ghcr.io/gctrl-tech/api@sha256:o"],
                "Size": 800
            },
            { "Id": "", "RepoTags": [], "RepoDigests": [], "Size": 1 }
        ]));
        assert_eq!(parsed.len(), 1, "entries without an Id are unusable");
        assert_eq!(parsed[0].refs, vec!["ghcr.io/gctrl-tech/api@sha256:o".to_string()]);
        assert_eq!(parsed[0].size, 800);
    }

    #[test]
    fn parses_in_use_from_both_id_and_name_fields() {
        let set = parse_in_use(&json!([
            { "ImageID": "sha256:a", "Image": "ghcr.io/gctrl-tech/api:latest" },
            { "ImageID": "sha256:b", "Image": "" }
        ]));
        assert!(set.contains("sha256:a"));
        assert!(set.contains("ghcr.io/gctrl-tech/api:latest"));
        assert!(set.contains("sha256:b"));
        assert!(!set.contains(""));
    }

    #[test]
    fn report_stays_silent_when_nothing_was_removed() {
        assert!(PruneReport { removed: 0, bytes: 0 }.message().is_none());
        let msg = PruneReport { removed: 1, bytes: 2_400_000_000 }.message().unwrap();
        assert!(msg.contains("1 superseded image,"), "singular, got: {msg}");
        assert!(msg.contains("2.4 GB"), "got: {msg}");
    }
}

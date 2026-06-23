use axum::{
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
    ("gctrl-agent", "ghcr.io/gctrl-tech/agent:latest"),
    ("gctrl-web",   "ghcr.io/gctrl-tech/web:latest"),
    ("gctrl-fuse",  "ghcr.io/gctrl-tech/fuse:latest"),
    ("gctrl-kex",   "ghcr.io/gctrl-tech/kex:latest"),
    ("gctrl-api",   "ghcr.io/gctrl-tech/api:latest"),
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

/// `GET /api/update/check` → `{ current, latest, updateAvailable }`.
///
/// Determines `latest` from a configurable update channel (`GCTRL_UPDATE_CHANNEL_URL`,
/// default [`DEFAULT_CHANNEL_URL`]). Degrades gracefully: any failure to reach or
/// parse the channel yields `{ current, latest: current, updateAvailable: false }`
/// — never a false positive, never an error surfaced to the UI. Results are cached
/// in-memory for [`CHECK_CACHE_TTL`] so bell polling stays cheap.
async fn check_update() -> Json<Value> {
    let current = current_version();

    // Serve from cache if fresh.
    if let Ok(guard) = check_cache().lock() {
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed() < CHECK_CACHE_TTL {
                return Json(c.payload.clone());
            }
        }
    }

    let latest = fetch_latest_version().await.unwrap_or_else(|| current.clone());
    let update_available = version_gt(&latest, &current);

    // Both naming conventions are emitted so every consumer is satisfied:
    // Header.tsx / SettingsPage.tsx read `current`/`latest`; other clients (and the
    // license banner) read `currentVersion`/`latestVersion`. `updateAvailable` is
    // always present and false on any upstream failure (never a 5xx, never a false
    // positive) so the UI can truthfully say "up to date" when the channel is down.
    let payload = json!({
        "current": current,
        "latest": latest,
        "currentVersion": current,
        "latestVersion": latest,
        "updateAvailable": update_available,
    });

    if let Ok(mut guard) = check_cache().lock() {
        *guard = Some(CachedCheck { payload: payload.clone(), fetched_at: Instant::now() });
    }

    Json(payload)
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

    // Step 2: Recreate all non-api containers
    for (container, _) in SERVICES.iter().filter(|(c, _)| *c != "gctrl-api") {
        send("progress", json!({ "step": "restart", "container": container, "message": format!("Recreating {}…", container) }));

        let name = container.to_string();
        match tokio::task::spawn_blocking(move || recreate_container(&name)).await {
            Ok(Ok(_)) => {
                send("progress", json!({ "step": "restarted", "container": container, "message": format!("{} updated", container) }));
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
    stream.shutdown(std::net::Shutdown::Write).map_err(|e| e.to_string())?;

    let mut raw = String::new();
    stream.read_to_string(&mut raw).map_err(|e| e.to_string())?;

    let status: u16 = raw.split_whitespace().nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body = raw.find("\r\n\r\n").map_or("", |i| &raw[i + 4..]).to_string();
    Ok((status, body))
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
    let encoded = name.replace('/', "%2F");
    let path = format!("/images/create?fromImage={encoded}&tag={tag}");
    let (status, _) = docker_http("POST", &path, None, 300)?;
    if status == 200 {
        Ok(())
    } else {
        Err(format!("HTTP {status}"))
    }
}

fn recreate_container(name: &str) -> Result<(), String> {
    // Inspect existing container for its config
    let (status, body) = docker_http("GET", &format!("/containers/{name}/json"), None, 10)?;
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
    Ok(())
}

fn docker_restart(name: &str) {
    let _ = docker_http("POST", &format!("/containers/{name}/restart?t=5"), None, 30);
}

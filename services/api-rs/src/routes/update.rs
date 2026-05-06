use axum::{
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use serde_json::json;
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::mpsc;

// Images to pull + their container names (api last — it hosts this endpoint)
const SERVICES: &[(&str, &str)] = &[
    ("gctrl-agent", "ghcr.io/gctrl-tech/agent:latest"),
    ("gctrl-web",   "ghcr.io/gctrl-tech/web:latest"),
    ("gctrl-fuse",  "ghcr.io/gctrl-tech/fuse:latest"),
    ("gctrl-kex",   "ghcr.io/gctrl-tech/kex:latest"),
    ("gctrl-api",   "ghcr.io/gctrl-tech/api:latest"),
];

pub fn router() -> Router<Arc<crate::models::AppState>> {
    // GET — EventSource-compatible SSE stream used by LicenseBanner
    Router::new().route("/", get(trigger_update))
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
    for (container, image) in SERVICES {
        send("progress", json!({ "step": "pull", "image": image, "message": format!("Pulling {}…", image) }));

        let img = image.to_string();
        match tokio::task::spawn_blocking(move || pull_image(&img)).await {
            Ok(Ok(_)) => {
                send("progress", json!({ "step": "pulled", "image": image, "message": format!("✓ {} ready", image) }));
            }
            Ok(Err(e)) => {
                send("error", json!({ "message": format!("Pull failed for {}: {}", image, e), "manualCommand": "curl -fsSL https://gctrl.tech/update | bash" }));
                return;
            }
            Err(e) => {
                send("error", json!({ "message": format!("Task error: {}", e), "manualCommand": "curl -fsSL https://gctrl.tech/update | bash" }));
                return;
            }
        }
    }

    // Step 2: Recreate all non-api containers
    for (container, _) in SERVICES.iter().filter(|(c, _)| *c != "gctrl-api") {
        send("progress", json!({ "step": "restart", "container": container, "message": format!("Recreating {}…", container) }));

        let name = container.to_string();
        match tokio::task::spawn_blocking(move || recreate_container(&name)).await {
            Ok(Ok(_)) => {
                send("progress", json!({ "step": "restarted", "container": container, "message": format!("✓ {} running new version", container) }));
            }
            Ok(Err(e)) => {
                tracing::warn!("Recreate {} failed: {}", container, e);
                send("progress", json!({ "step": "restart_warn", "container": container, "message": format!("⚠ {} – {}", container, e) }));
            }
            Err(_) => {}
        }
    }

    // Step 3: Done — client reloads on receiving this
    send("done", json!({}));

    // Step 4: After client received done, restart the api container itself.
    // We use a simple Docker restart (not recreate) to avoid killing the live response
    // mid-stream. The container will fully recreate on the next docker compose up.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let _ = tokio::task::spawn_blocking(|| docker_restart("gctrl-api")).await;
}

// ─── Docker socket helpers ────────────────────────────────────────────────────

#[cfg(unix)]
fn docker_http(method: &str, path: &str, body: Option<&str>, timeout_secs: u64) -> Result<(u16, String), String> {
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
fn docker_http(_method: &str, _path: &str, _body: Option<&str>, _timeout: u64) -> Result<(u16, String), String> {
    Err("Not supported on non-Unix platforms".into())
}

fn json_from_body(body: &str) -> serde_json::Value {
    // Docker may return chunked bodies; find the first '{' or '['
    let start = body.find('{').or_else(|| body.find('['));
    start
        .and_then(|i| serde_json::from_str(&body[i..]).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn pull_image(image: &str) -> Result<(), String> {
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

use axum::{
    extract::{Extension, State},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    routing::get,
    Router,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use crate::{error::{AppError, Result}, middleware::auth::{require_role, JwtClaims}};

const IMAGES: &[&str] = &[
    "ghcr.io/gctrl-tech/agent:latest",
    "ghcr.io/gctrl-tech/kex:latest",
    "ghcr.io/gctrl-tech/fuse:latest",
    "ghcr.io/gctrl-tech/fusion-engine:latest",
    "ghcr.io/gctrl-tech/api:latest",
    "ghcr.io/gctrl-tech/web:latest",
];

const CONTAINERS: &[&str] = &["gctrl-agent","gctrl-resolver","gctrl-fuse","gctrl-kex","gctrl-web","gctrl-api"];

fn has_docker_socket() -> bool {
    std::path::Path::new("/var/run/docker.sock").exists()
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/", get(update_info).post(trigger_update))
}

async fn update_info(State(_state): State<Arc<crate::models::AppState>>) -> Result<axum::Json<serde_json::Value>> {
    let client = reqwest::Client::new();
    let status = match client.get("http://localhost:7070/status")
        .timeout(Duration::from_secs(3)).send().await {
        Ok(r) => r.json::<serde_json::Value>().await.unwrap_or_default(),
        Err(_) => serde_json::Value::Null,
    };
    Ok(axum::Json(json!({
        "updateAvailable": status["updateAvailable"],
        "updateRequired":  status["updateRequired"],
        "latestVersion":   status["latestVersion"],
        "canAutoUpdate":   has_docker_socket(),
    })))
}

async fn trigger_update(
    Extension(claims): Extension<JwtClaims>,
    State(_state): State<Arc<crate::models::AppState>>,
) -> Result<Response> {
    require_role(&claims, "admin")?;

    if !has_docker_socket() {
        return Err(AppError::BadRequest(
            "Docker socket not accessible. Run: curl -fsSL https://gctrl.tech/update | bash".into()
        ));
    }

    let stream = async_stream::stream! {
        for image in IMAGES {
            let image = *image;
            yield Ok::<Event, std::convert::Infallible>(
                Event::default().event("progress")
                    .data(json!({ "step": "pull", "image": image, "message": format!("Pulling {}…", image) }).to_string())
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
            yield Ok(Event::default().event("progress")
                .data(json!({ "step": "pulled", "image": image, "message": format!("✓ {}", image) }).to_string()));
        }
        for container in CONTAINERS {
            let container = *container;
            yield Ok(Event::default().event("progress")
                .data(json!({ "step": "restart", "container": container, "message": format!("Restarting {}…", container) }).to_string()));
            docker_restart(container).await;
            if container != "gctrl-api" {
                yield Ok(Event::default().event("progress")
                    .data(json!({ "step": "restarted", "container": container, "message": format!("✓ {}", container) }).to_string()));
            }
        }
        yield Ok(Event::default().event("done")
            .data(json!({ "message": "Update complete. GCTRL is restarting…" }).to_string()));
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}

async fn docker_restart(name: &str) {
    let path = format!("/v1.41/containers/{}/restart?t=5", name);
    let _name = name.to_string();
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        {
            use std::io::Write;
            if let Ok(mut stream) = std::os::unix::net::UnixStream::connect("/var/run/docker.sock") {
                let req = format!("POST {} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", path);
                let _ = stream.write_all(req.as_bytes());
            }
        }
        #[cfg(not(unix))]
        {
            let _ = path; // suppress unused warning on Windows
        }
    }).await.ok();
}

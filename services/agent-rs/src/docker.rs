//! Minimal Docker Engine API client over the unix socket, ported from
//! `api-rs/src/routes/update.rs` (the framing-aware, non-read-to-EOF version —
//! see that file's `docker_http` doc comment for why a naive read-to-EOF loop
//! is wrong: a keep-alive connection or a request that lands before dockerd has
//! finished reading it can otherwise hang or bare-500). Used by the `/recreate`
//! endpoint to swap the gctrl-api container onto its already-pulled new image
//! on the api's behalf (the api can't safely recreate its own container).

use serde_json::{json, Value};
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
pub fn docker_http(method: &str, path: &str, body: Option<&str>, timeout_secs: u64) -> Result<(u16, String), String> {
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
    // Deliberately NOT shutting down the write half here — see api-rs's
    // docker_http for the verified race this avoids (dockerd reacting to an
    // early FIN with a bare 500 before it's read the full request).
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
        // No length signal we recognize yet (or body still incomplete) — keep
        // reading, bounded by the caller's read timeout on the socket.
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

#[cfg(unix)]
fn content_length(headers_lower: &str) -> Option<usize> {
    headers_lower
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse().ok())
}

#[cfg(unix)]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

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
pub fn docker_http(_method: &str, _path: &str, _body: Option<&str>, _timeout: u64) -> Result<(u16, String), String> {
    Err("Not supported on non-Unix platforms".into())
}

pub fn json_from_body(body: &str) -> Value {
    let start = body.find('{').or_else(|| body.find('['));
    start
        .and_then(|i| serde_json::from_str(&body[i..]).ok())
        .unwrap_or(Value::Null)
}

/// Recreates `name` from its (already-pulled) image, preserving its runtime
/// config. Ported from api-rs's `recreate_container` (the one it uses to
/// recreate every other service each update run) — the api container gets the
/// exact same treatment, just triggered from here instead of from inside the
/// api's own process. Returns `Ok(true)` when recreated, `Ok(false)` when the
/// container simply isn't present (404 on inspect).
pub fn recreate_container(name: &str) -> Result<bool, String> {
    let (status, body) = docker_http("GET", &format!("/containers/{name}/json"), None, 10)?;
    if status == 404 {
        return Ok(false);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_from_body_finds_object_after_garbage_prefix() {
        let body = "garbage{\"a\":1}";
        assert_eq!(json_from_body(body), json!({"a": 1}));
    }

    #[test]
    fn json_from_body_null_on_unparseable() {
        assert_eq!(json_from_body("not json at all"), Value::Null);
    }
}

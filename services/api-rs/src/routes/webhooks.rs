use axum::{
    extract::{Extension, Path, State},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;
use crate::{error::{AppError, Result}, middleware::auth::JwtClaims};

fn is_ipv4_private(v4: std::net::Ipv4Addr) -> bool {
    v4.is_loopback() || v4.is_private() || v4.is_link_local()
        || v4.is_unspecified() || v4.octets()[0] == 100
}

fn is_ip_private(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_ipv4_private(v4),
        std::net::IpAddr::V6(v6) => {
            // Collapse IPv4-mapped (::ffff:a.b.c.d) addresses to their v4 form so
            // e.g. ::ffff:10.0.0.1 can't bypass the v4 checks. We deliberately do
            // NOT use the deprecated `to_ipv4()`, which ALSO maps IPv4-COMPATIBLE
            // addresses — crucially `::1` → `0.0.0.1`, which is_ipv4_private does
            // not flag (it only matches 0.0.0.0 exactly), letting IPv6 loopback
            // slip through as "public". Handling only the mapped form lets native
            // IPv6 addresses like `::1` fall through to the explicit v6 checks below.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_ipv4_private(v4);
            }
            // Reject deprecated IPv4-compatible addresses (::a.b.c.d, high 96 bits
            // zero, excluding :: and ::1 which the v6 checks already cover) — they
            // have no legitimate use here and could otherwise embed a private v4.
            let segs = v6.segments();
            if segs[..6].iter().all(|&s| s == 0) && (segs[6] != 0 || segs[7] > 1) {
                return true;
            }
            let seg0 = segs[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (seg0 & 0xfe00) == 0xfc00   // ULA  fc00::/7
                || (seg0 & 0xffc0) == 0xfe80    // link-local fe80::/10
        }
    }
}

/// Block webhook URLs that target internal/private networks (SSRF prevention).
/// Validates schema, hostname blocklist, and IP literals at store-time.
/// DNS-resolved validation happens again at delivery time via `validate_webhook_host`.
fn validate_webhook_url(raw: &str) -> std::result::Result<(), AppError> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| AppError::BadRequest("Invalid webhook URL".into()))?;

    if parsed.scheme() != "https" {
        return Err(AppError::BadRequest("Webhook URL must use HTTPS".into()));
    }

    let host = parsed.host_str().unwrap_or("").to_lowercase();

    if host.is_empty() {
        return Err(AppError::BadRequest("Webhook URL missing host".into()));
    }

    // Block known-internal hostnames
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".internal") {
        return Err(AppError::BadRequest("Webhook URL must not target internal hosts".into()));
    }

    // Block IP literals in private ranges
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_ip_private(ip) {
            return Err(AppError::BadRequest("Webhook URL must not target private IP ranges".into()));
        }
    }

    Ok(())
}

/// Resolve hostname at delivery time, re-check every returned IP, and return the
/// validated `(host, addrs)` so the caller can **pin** the connection to those
/// exact IPs. Returning the addrs (rather than just Ok) is what actually closes
/// the DNS-rebinding hole: validating the hostname then letting reqwest re-resolve
/// at connect time is a TOCTOU — the second lookup can return 169.254.x.x / 10.x.x.x.
/// We hand the pre-validated public addrs to `ClientBuilder::resolve_to_addrs`, so
/// the socket connects to a checked IP and never re-resolves.
async fn validate_webhook_host(
    url: &str,
) -> std::result::Result<(String, Vec<std::net::SocketAddr>), AppError> {
    let parsed = url::Url::parse(url).map_err(|_| AppError::Internal("bad url".into()))?;
    let host = parsed.host_str().unwrap_or("").to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);

    match tokio::net::lookup_host(format!("{host}:{port}")).await {
        Ok(addrs) => {
            let addrs: Vec<std::net::SocketAddr> = addrs.collect();
            if addrs.is_empty() {
                return Err(AppError::BadRequest("Webhook host did not resolve".into()));
            }
            for addr in &addrs {
                if is_ip_private(addr.ip()) {
                    return Err(AppError::BadRequest(
                        "Webhook host resolved to a private IP — delivery blocked".into(),
                    ));
                }
            }
            Ok((host, addrs))
        }
        Err(_) => Err(AppError::BadRequest("Webhook host DNS lookup failed".into())),
    }
}

#[derive(Deserialize)]
struct CreateWebhook {
    name: String,
    url: String,
    secret: String,
    events: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct UpdateWebhook {
    name: Option<String>,
    url: Option<String>,
    secret: Option<String>,
    events: Option<Vec<String>>,
    is_active: Option<bool>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/",                  get(list).post(create))
        .route("/:id",               put(update).delete(del))
        .route("/:id/deliveries",    get(deliveries))
        .route("/:id/test",          post(test_ping))
}

async fn list(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, Vec<String>, bool, i32, Option<chrono::DateTime<chrono::Utc>>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, name, url, events, is_active, consecutive_failures, last_triggered_at, created_at
         FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC"
    ).bind(claims.sub).fetch_all(&state.db).await?;

    let hooks: Vec<Value> = rows.into_iter().map(|(id, name, url, events, active, failures, last_trig, created)| {
        json!({
            "id": id,
            "name": name,
            "url": url,
            "events": events,
            "isActive": active,
            "consecutiveFailures": failures,
            "lastTriggeredAt": last_trig,
            "createdAt": created,
        })
    }).collect();

    Ok(Json(json!({ "webhooks": hooks })))
}

async fn create(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(body): Json<CreateWebhook>,
) -> Result<Json<Value>> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if body.url.trim().is_empty() {
        return Err(AppError::BadRequest("url is required".into()));
    }
    validate_webhook_url(body.url.trim())?;
    if body.secret.trim().is_empty() {
        return Err(AppError::BadRequest("secret is required".into()));
    }

    let events = body.events.unwrap_or_else(|| vec!["job.completed".into()]);
    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO webhooks (id, user_id, name, url, secret, events)
         VALUES ($1, $2, $3, $4, $5, $6)"
    )
    .bind(id)
    .bind(claims.sub)
    .bind(body.name.trim())
    .bind(body.url.trim())
    .bind(body.secret.trim())
    .bind(&events)
    .execute(&state.db).await?;

    Ok(Json(json!({ "id": id, "ok": true })))
}

async fn update(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateWebhook>,
) -> Result<Json<Value>> {
    if let Some(ref new_url) = body.url {
        validate_webhook_url(new_url.trim())?;
    }
    let rows = sqlx::query(
        "UPDATE webhooks
         SET name     = COALESCE($1, name),
             url      = COALESCE($2, url),
             secret   = COALESCE($3, secret),
             events   = COALESCE($4, events),
             is_active = COALESCE($5, is_active)
         WHERE id = $6 AND user_id = $7"
    )
    .bind(body.name.as_deref())
    .bind(body.url.as_deref())
    .bind(body.secret.as_deref())
    .bind(body.events.as_deref())
    .bind(body.is_active)
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db).await?;

    if rows.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn del(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM webhooks WHERE id = $1 AND user_id = $2")
        .bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn deliveries(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // Verify ownership
    let exists: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM webhooks WHERE id = $1 AND user_id = $2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }

    let rows = sqlx::query_as::<_, (Uuid, String, Value, Option<i32>, Option<String>, chrono::DateTime<chrono::Utc>, bool)>(
        "SELECT id, event, payload, response_status, response_body, delivered_at, success
         FROM webhook_deliveries WHERE webhook_id = $1
         ORDER BY delivered_at DESC LIMIT 50"
    ).bind(id).fetch_all(&state.db).await?;

    let items: Vec<Value> = rows.into_iter().map(|(did, event, payload, status, body, delivered_at, success)| {
        json!({
            "id": did,
            "event": event,
            "payload": payload,
            "responseStatus": status,
            "responseBody": body,
            "deliveredAt": delivered_at,
            "success": success,
        })
    }).collect();

    Ok(Json(json!({ "deliveries": items })))
}

async fn test_ping(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // Verify ownership + fetch webhook
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT url, secret FROM webhooks WHERE id = $1 AND user_id = $2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;

    let Some((url, secret)) = row else {
        return Err(AppError::NotFound);
    };

    let payload = json!({
        "event": "ping",
        "webhookId": id,
        "userId": claims.sub,
        "message": "This is a test ping from GCTRL",
    });

    deliver_event(&state.db, claims.sub, "ping", &payload).await;

    Ok(Json(json!({ "ok": true, "url": url, "secret": &secret[..4.min(secret.len())] })))
}

// ── Delivery service ──────────────────────────────────────────────────────────

pub async fn deliver_event(db: &sqlx::PgPool, user_id: Uuid, event: &str, payload: &Value) {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    // Find active webhooks subscribed to this event
    let hooks = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id, url, secret FROM webhooks
         WHERE user_id = $1 AND is_active = true AND $2 = ANY(events)"
    )
    .bind(user_id)
    .bind(event)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    for (hook_id, url, secret) in hooks {
        // Re-validate DNS at delivery time and capture the validated public IPs so
        // we can pin the connection to them (blocks DNS rebinding — see fn docs).
        let (host, validated_addrs) = match validate_webhook_host(&url).await {
            Ok(v) => v,
            Err(_) => {
                tracing::warn!("webhook {hook_id}: delivery blocked — host resolved to private IP");
                continue;
            }
        };

        let body = payload.to_string();

        // HMAC-SHA256 signature — no redirects to prevent hop-based SSRF
        let sig = if let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) {
            mac.update(body.as_bytes());
            hex::encode(mac.finalize().into_bytes())
        } else {
            String::new()
        };

        // Pin DNS to the pre-validated public addrs: reqwest connects to these exact
        // IPs instead of re-resolving the hostname at connect time, closing the
        // check-then-connect rebinding window. The original Host header is preserved
        // (we still POST to `url`), so SNI / virtual-host routing / TLS stay correct.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host, &validated_addrs)
            .build()
            .unwrap_or_default();
        let result = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("X-GCTRL-Signature", format!("sha256={sig}"))
            .header("X-GCTRL-Event", event)
            .body(body.clone())
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;

        let (status, resp_body, success) = match result {
            Ok(r) => {
                let s = r.status().as_u16() as i32;
                let b = r.text().await.unwrap_or_default();
                (Some(s), Some(b), s >= 200 && s < 300)
            }
            Err(_) => (None, None, false),
        };

        // Record delivery
        let _ = sqlx::query(
            "INSERT INTO webhook_deliveries (webhook_id, event, payload, response_status, response_body, success)
             VALUES ($1, $2, $3, $4, $5, $6)"
        )
        .bind(hook_id)
        .bind(event)
        .bind(payload)
        .bind(status)
        .bind(&resp_body)
        .bind(success)
        .execute(db)
        .await;

        // Track failures; disable after 3 consecutive
        if success {
            let _ = sqlx::query(
                "UPDATE webhooks SET consecutive_failures = 0, last_triggered_at = NOW() WHERE id = $1"
            )
            .bind(hook_id)
            .execute(db)
            .await;
        } else {
            let _ = sqlx::query(
                "UPDATE webhooks
                 SET consecutive_failures = consecutive_failures + 1,
                     is_active = CASE WHEN consecutive_failures + 1 >= 3 THEN false ELSE is_active END
                 WHERE id = $1"
            )
            .bind(hook_id)
            .execute(db)
            .await;
        }
    }
}

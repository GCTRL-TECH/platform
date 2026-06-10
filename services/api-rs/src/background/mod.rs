use std::sync::Arc;
use tokio::time::{sleep, Duration};
use serde_json::{json, Value};
use futures::StreamExt;
use uuid::Uuid;
use crate::models::AppState;

pub fn spawn_all(state: Arc<AppState>) {
    let s = state.clone();
    tokio::spawn(async move { subscribe_results(s).await });

    let s = state.clone();
    tokio::spawn(async move {
        recover_stale_jobs(&s).await;
        loop {
            sleep(Duration::from_secs(300)).await;
            recover_stale_jobs(&s).await;
        }
    });

    // License heartbeat: ship local token_usage deltas to the central
    // license-api so the user's dashboard at gctrl.tech mirrors local truth.
    let s = state.clone();
    tokio::spawn(async move {
        // Small initial delay so the migrations + DB pool are fully ready.
        sleep(Duration::from_secs(10)).await;
        loop {
            if let Err(e) = run_license_heartbeat(&s).await {
                tracing::warn!("license heartbeat tick failed: {e}");
            }
            sleep(Duration::from_secs(60)).await;
        }
    });
}

async fn subscribe_results(state: Arc<AppState>) {
    let client = match redis::Client::open(state.cfg.redis_url.as_str()) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Redis subscriber client error: {e}");
            return;
        }
    };
    let mut pubsub = match client.get_async_pubsub().await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("Redis pubsub connection failed: {e}");
            return;
        }
    };
    if let Err(e) = pubsub.subscribe(&["kex:results", "fuse:results"]).await {
        tracing::warn!("Redis subscribe failed: {e}");
        return;
    }

    let mut stream = pubsub.into_on_message();
    while let Some(msg) = stream.next().await {
        let payload: String = msg.get_payload().unwrap_or_default();
        if let Ok(result) = serde_json::from_str::<Value>(&payload) {
            process_job_result(&state, result).await;
        }
    }
}

async fn process_job_result(state: &AppState, result: Value) {
    let job_id = match result["job_id"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) {
        Some(id) => id,
        None => return,
    };
    let status = result["status"].as_str().unwrap_or("failed");

    let _ = match status {
        "completed" => sqlx::query(
            "UPDATE jobs SET status='completed', result=$1, updated_at=NOW(), completed_at=NOW() WHERE id=$2"
        )
        .bind(result.get("result").cloned().unwrap_or_default())
        .bind(job_id)
        .execute(&state.db).await,

        "processing" => sqlx::query("UPDATE jobs SET status='processing', updated_at=NOW() WHERE id=$1")
            .bind(job_id).execute(&state.db).await,

        _ => sqlx::query(
            "UPDATE jobs SET status='failed', error=$1, updated_at=NOW(), completed_at=NOW() WHERE id=$2"
        )
        .bind(result["error"].as_str().unwrap_or("Unknown error"))
        .bind(job_id)
        .execute(&state.db).await,
    };
}

async fn recover_stale_jobs(state: &AppState) {
    let now = chrono::Utc::now();
    // Jobs in 'processing' for >5 min: worker likely died mid-pipeline.
    let five_min_ago = now - chrono::Duration::minutes(5);
    let _ = sqlx::query(
        "UPDATE jobs SET status='failed', error='Worker died mid-processing (>5min)', completed_at=NOW(), updated_at=NOW()
         WHERE status='processing' AND COALESCE(updated_at, created_at) < $1"
    )
    .bind(five_min_ago)
    .execute(&state.db).await;

    // Jobs in 'pending' for >10 min: queue not draining, mark failed so the user sees something.
    let ten_min_ago = now - chrono::Duration::minutes(10);
    let _ = sqlx::query(
        "UPDATE jobs SET status='failed', error='Queue stalled (>10min pending)', completed_at=NOW(), updated_at=NOW()
         WHERE status='pending' AND created_at < $1"
    )
    .bind(ten_min_ago)
    .execute(&state.db).await;
}

// ── License heartbeat ───────────────────────────────────────────────────────
//
// For every (user, active license w/ JWT), batch up to 100 unsynced
// token_usage rows and POST them to `${GCTRL_LICENSE_API_URL}/v1/heartbeat`.
// On 200: mark the rows synced and store the refreshed JWT + canonical
// credits balance. On 401: clear the JWT (forces the user to re-activate).
// On network failure: log and leave rows for the next tick.

async fn run_license_heartbeat(state: &AppState) -> Result<(), String> {
    // Cheap pre-check: any unsynced rows at all? Skip the per-user fan-out
    // when the table is quiet.
    let pending: (Option<i64>,) = sqlx::query_as(
        "SELECT COUNT(*) FROM token_usage WHERE synced_to_license_api = false"
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    if pending.0.unwrap_or(0) == 0 {
        return Ok(());
    }

    // Find (user_id, license_id, license_jwt) for users with usage to ship.
    // A user can in principle have multiple licenses; we pick the most
    // recently activated active one. license_jwt = NULL means we can't
    // authenticate to /v1/heartbeat → skip until the user re-activates.
    let rows: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT DISTINCT ON (l.user_id) l.user_id, l.id, l.license_jwt \
         FROM licenses l \
         WHERE l.status = 'active' \
           AND l.license_jwt IS NOT NULL \
           AND EXISTS ( \
             SELECT 1 FROM token_usage t \
              WHERE t.user_id = l.user_id AND t.synced_to_license_api = false \
           ) \
         ORDER BY l.user_id, l.activated_at DESC"
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    if rows.is_empty() {
        return Ok(());
    }

    let license_api_url = std::env::var("GCTRL_LICENSE_API_URL")
        .unwrap_or_else(|_| "https://api.gctrl.tech".into());
    let heartbeat_url = format!("{license_api_url}/v1/heartbeat");
    let client = reqwest::Client::new();

    for (user_id, license_id, license_jwt) in rows {
        if let Err(e) = ship_one_user(state, &client, &heartbeat_url, user_id, license_id, &license_jwt).await {
            tracing::warn!("heartbeat for user {user_id}: {e}");
        }
    }
    Ok(())
}

async fn ship_one_user(
    state: &AppState,
    client: &reqwest::Client,
    heartbeat_url: &str,
    user_id: Uuid,
    license_id: Uuid,
    license_jwt: &str,
) -> Result<(), String> {
    // Up to 100 unsynced rows at a time → keeps each request bounded.
    let usage: Vec<(Uuid, String, i32, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, action, tokens_spent, created_at FROM token_usage \
         WHERE user_id = $1 AND synced_to_license_api = false \
         ORDER BY created_at ASC LIMIT 100"
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    if usage.is_empty() {
        return Ok(());
    }

    let usage_ids: Vec<Uuid> = usage.iter().map(|r| r.0).collect();
    let usage_report: Vec<Value> = usage
        .iter()
        .map(|(_, action, tokens_spent, created_at)| {
            // license-api heartbeat expects: action, chars_processed, credits_spent, timestamp.
            // We don't track chars_processed locally (KEX has it, FUSE doesn't), so
            // we approximate as credits_spent — the central side mostly cares about credits.
            json!({
                "action": action,
                "chars_processed": *tokens_spent as i64,
                "credits_spent": *tokens_spent,
                "timestamp": created_at.to_rfc3339(),
            })
        })
        .collect();

    let resp = client
        .post(heartbeat_url)
        .bearer_auth(license_jwt)
        .json(&json!({ "usage_report": usage_report }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        // Stale or revoked JWT — clear it so we stop hammering. User must re-activate.
        let _ = sqlx::query(
            "UPDATE licenses SET license_jwt = NULL, license_jwt_updated_at = NOW() WHERE id = $1"
        )
        .bind(license_id)
        .execute(&state.db)
        .await;
        tracing::warn!("heartbeat 401 for user {user_id} — cleared license_jwt; awaiting re-activate");
        return Ok(());
    }

    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    let body: Value = resp.json().await.unwrap_or(Value::Null);

    // Mark the rows synced. Do this BEFORE updating the local credits mirror so
    // a downstream failure can't double-count them on the next tick.
    let _ = sqlx::query(
        "UPDATE token_usage SET synced_to_license_api = true WHERE id = ANY($1)"
    )
    .bind(&usage_ids)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    // Persist refreshed JWT if the server rotated it.
    if let Some(new_jwt) = body["license_jwt"].as_str() {
        if !new_jwt.is_empty() && new_jwt != license_jwt {
            let _ = sqlx::query(
                "UPDATE licenses SET license_jwt = $1, license_jwt_updated_at = NOW() WHERE id = $2"
            )
            .bind(new_jwt)
            .bind(license_id)
            .execute(&state.db)
            .await;
        }
    }

    // Mirror the canonical balance returned by license-api into the local
    // licenses row so /api/billing/balance returns server-side truth.
    if let Some(credits_balance) = body["credits_balance"].as_i64() {
        let _ = sqlx::query(
            "UPDATE licenses \
             SET credits_used = GREATEST(0, credits_allocated - $1), updated_at = NOW() \
             WHERE id = $2"
        )
        .bind(credits_balance as i32)
        .bind(license_id)
        .execute(&state.db)
        .await;
    }

    tracing::debug!("heartbeat ok for user {user_id}: shipped {} rows", usage_ids.len());
    Ok(())
}

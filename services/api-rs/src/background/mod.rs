use std::sync::Arc;
use tokio::time::{sleep, Duration};
use serde_json::Value;
use futures::StreamExt;
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
    let one_hour_ago = chrono::Utc::now() - chrono::Duration::hours(1);
    let _ = sqlx::query(
        "UPDATE jobs SET status='failed', error='Worker timeout — job stuck >1h', completed_at=NOW(), updated_at=NOW()
         WHERE status IN ('pending','processing') AND created_at < $1"
    )
    .bind(one_hour_ago)
    .execute(&state.db).await;
}

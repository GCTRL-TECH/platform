//! Runtime guardrail — a slow-cadence loop that watches the ACTIVE generation
//! runtime (`runtime_config`, id=1) for repeated REAL failures (unreachable /
//! 5xx / OOM-crash / context-length errors) and auto-reverts to the bundled
//! Ollama default after `CONSECUTIVE_FAILURE_THRESHOLD` consecutive failures.
//! This exists so a bad runtime switch (a dead external endpoint, a GPU OOM, a
//! model that doesn't fit) never leaves the agent/RAG/KEX permanently broken
//! with no operator around to notice.
//!
//! This is a SEPARATE loop from `background::run_watchdog`, which stays
//! observe-only by design (see its doc comment) — this module is the one place
//! allowed to ACT (revert `runtime_config`). It NEVER touches
//! `user_model_prefs`: per-user model choices (Cookbook / Settings → AI
//! Models) are never overridden by this guardrail, only the operator-level
//! active runtime.
//!
//! Also tracks a notify-only signal: many recent KEX jobs completed in
//! "degraded" mode (relation extraction skipped mid-job, see
//! `services/kex/src/main.py`'s `result["degraded"] = True`). This is surfaced
//! as a dashboard nudge ONLY — a degraded job already finished, so reverting
//! the runtime now wouldn't undo it; this NEVER drives a revert.

use std::sync::Arc;
use serde_json::json;
use tokio::time::{sleep, Duration};

use crate::models::AppState;

/// Consecutive real-failure count that triggers an auto-revert to Ollama.
const CONSECUTIVE_FAILURE_THRESHOLD: i32 = 3;
/// Completed-degraded KEX jobs in the last hour that triggers a notify-only event.
const DEGRADED_JOB_THRESHOLD: i64 = 5;
/// Hard cap on the probe call, enforced via `tokio::time::timeout` (see NOTE
/// below on why this wraps rather than threads through `chat_once`).
const PROBE_TIMEOUT_SECS: u64 = 20;

fn probe_interval_secs() -> u64 {
    std::env::var("GUARDRAIL_PROBE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300)
}

/// Spawn the guardrail loop. Call once from `background::spawn_all`.
pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Let the stack finish booting (migrations, pool, other services) before
        // the first probe.
        sleep(Duration::from_secs(30)).await;
        loop {
            run_tick(&state).await;
            sleep(Duration::from_secs(probe_interval_secs())).await;
        }
    });
}

async fn run_tick(state: &AppState) {
    // Degraded-jobs signal is independent of the revert logic below — always
    // check it, regardless of what the active runtime is.
    check_degraded_jobs(state).await;

    let runtime_row: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        chrono::DateTime<chrono::Utc>,
    )> = sqlx::query_as(
        "SELECT provider, base_url, model, api_key, updated_at FROM runtime_config WHERE id = 1",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let Some((provider, base_url, model, api_key, updated_at)) = runtime_row else {
        // No runtime_config row at all → nothing configured (bundled Ollama
        // default). Nothing to guard.
        reset_failures(state).await;
        return;
    };

    let provider = provider.unwrap_or_default();
    let has_custom_base = base_url.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);

    // Safe default: bundled Ollama with no custom base → nothing to guard.
    if (provider.is_empty() || provider == "ollama") && !has_custom_base {
        reset_failures(state).await;
        return;
    }

    let guard_row: Option<(i32, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
        "SELECT consecutive_failures, reverted_at FROM guardrail_state WHERE id = 1",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let (failures, reverted_at) = guard_row.unwrap_or((0, None));

    // Once-only: we already reverted and the admin hasn't re-applied a runtime
    // change since (runtime_config.updated_at <= reverted_at) → stand down.
    // Any subsequent PUT /infra/runtime or /infra/switch-runtime bumps
    // updated_at past reverted_at, which re-arms the guardrail.
    if let Some(rev) = reverted_at {
        if updated_at <= rev {
            return;
        }
    }

    let target = crate::services::llm::LlmTarget {
        provider: provider.clone(),
        model: model.clone().unwrap_or_else(|| "llama3.2".into()),
        base_url: base_url.clone(),
        api_key: api_key
            .map(|k| crate::services::crypto::open(&k))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };

    match probe(&target).await {
        Ok(()) => reset_failures(state).await,
        Err(reason) => {
            let new_count = failures + 1;
            let _ = sqlx::query(
                "UPDATE guardrail_state
                    SET consecutive_failures = $1, last_probe_at = now(), last_error = $2
                  WHERE id = 1",
            )
            .bind(new_count)
            .bind(&reason)
            .execute(&state.db)
            .await;
            tracing::warn!(
                "guardrail: runtime probe failed ({new_count}/{CONSECUTIVE_FAILURE_THRESHOLD}): {reason}"
            );

            if new_count >= CONSECUTIVE_FAILURE_THRESHOLD {
                revert_runtime(state, &provider, base_url.as_deref(), model.as_deref(), &reason).await;
            }
        }
    }
}

/// Real reachability probe: a tiny completion ("ping") through the existing
/// LLM service chat path against the active runtime, hard-capped at
/// `PROBE_TIMEOUT_SECS`.
///
/// NOTE / deviation: the design asks for `max_tokens=8` on the probe request.
/// `services::llm::ChatMessages::build` (shared by the agent SSE loop, RAG fast
/// + deep modes, and ~10 call sites across 3 files) has no `max_tokens` knob for
/// any of the 4 wire formats, and adding one would mean threading a new field
/// through every existing call site for a change that only benefits this probe.
/// Instead we wrap `chat_once` in a hard `tokio::time::timeout` — this still
/// exercises the full request/response/parse path (so unreachable / 5xx /
/// OOM-crash / context-length errors are all caught) without touching shared
/// request-building code. A "ping" completion is small enough on every
/// reasonable model that the 20s cap is not a practical constraint.
async fn probe(target: &crate::services::llm::LlmTarget) -> Result<(), String> {
    let client = reqwest::Client::new();
    let fut = crate::services::llm::chat_once(
        &client,
        target,
        "You are a health probe. Reply with a single word.",
        "ping",
    );
    match tokio::time::timeout(Duration::from_secs(PROBE_TIMEOUT_SECS), fut).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(classify_error(&e)),
        Err(_) => Err(format!("timeout after {PROBE_TIMEOUT_SECS}s")),
    }
}

/// Classify a raw chat error string into a short, stable reason. Matching is
/// case-insensitive (mirrors `(?i)out of memory|CUDA|context length`) via a
/// lowercased `contains` check — no regex dependency needed for this shape.
fn classify_error(raw: &str) -> String {
    let low = raw.to_lowercase();
    if low.contains("unreachable") {
        "unreachable".to_string()
    } else if low.contains("out of memory") || low.contains("cuda") || low.contains("context length") {
        format!("out of memory / CUDA / context-length error: {}", raw.chars().take(200).collect::<String>())
    } else if low.contains("llm error 5") {
        format!("server error (5xx): {}", raw.chars().take(200).collect::<String>())
    } else {
        raw.chars().take(200).collect()
    }
}

async fn reset_failures(state: &AppState) {
    let _ = sqlx::query(
        "UPDATE guardrail_state SET consecutive_failures = 0 WHERE id = 1 AND consecutive_failures <> 0",
    )
    .execute(&state.db)
    .await;
}

/// Revert `runtime_config` to the bundled Ollama default, record the snapshot +
/// revert timestamp on `guardrail_state`, and log a `runtime_reverted` event —
/// all in ONE transaction. NEVER touches `user_model_prefs`.
async fn revert_runtime(
    state: &AppState,
    provider: &str,
    base_url: Option<&str>,
    model: Option<&str>,
    reason: &str,
) {
    let snapshot = json!({ "provider": provider, "base_url": base_url, "model": model });

    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("guardrail: could not start revert transaction: {e}");
            return;
        }
    };

    let steps: Result<(), sqlx::Error> = async {
        sqlx::query(
            "UPDATE runtime_config SET provider = 'ollama', base_url = NULL, model = NULL, updated_at = now() WHERE id = 1",
        )
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE guardrail_state
                SET reverted_at = now(), reverted_from = $1, consecutive_failures = 0
              WHERE id = 1",
        )
        .bind(&snapshot)
        .execute(&mut *tx)
        .await?;

        sqlx::query("INSERT INTO guardrail_events (kind, detail) VALUES ('runtime_reverted', $1)")
            .bind(json!({ "reason": reason, "from": snapshot }))
            .execute(&mut *tx)
            .await?;

        Ok(())
    }
    .await;

    if let Err(e) = steps {
        tracing::warn!("guardrail: revert transaction failed, rolling back: {e}");
        let _ = tx.rollback().await;
        return;
    }

    if let Err(e) = tx.commit().await {
        tracing::warn!("guardrail: revert transaction commit failed: {e}");
        return;
    }

    tracing::warn!(
        "guardrail: REVERTED active runtime to bundled Ollama after {CONSECUTIVE_FAILURE_THRESHOLD} \
         consecutive failures ({reason}) — was provider={provider} base={base_url:?} model={model:?}. \
         Re-apply in the Cookbook to re-arm the guardrail."
    );
}

/// Notify-only: count KEX extraction jobs that completed "degraded" (relation
/// extraction skipped, see kex `result["degraded"]`) in the last hour. At
/// `DEGRADED_JOB_THRESHOLD` or more, with no existing undismissed
/// `degraded_jobs` event, insert one. NEVER triggers a runtime revert.
async fn check_degraded_jobs(state: &AppState) {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs
          WHERE type = 'kex_extract' AND status = 'completed'
            AND completed_at > now() - interval '1 hour'
            AND result->>'degraded' = 'true'",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    if count < DEGRADED_JOB_THRESHOLD {
        return;
    }

    let existing: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM guardrail_events WHERE kind = 'degraded_jobs' AND dismissed = false LIMIT 1",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    if existing.is_some() {
        return;
    }

    let _ = sqlx::query("INSERT INTO guardrail_events (kind, detail) VALUES ('degraded_jobs', $1)")
        .bind(json!({ "count": count, "windowHours": 1 }))
        .execute(&state.db)
        .await;

    tracing::warn!("guardrail: {count} KEX job(s) completed degraded in the last hour (notify-only)");
}

//! Runtime guardrail — a slow-cadence loop that watches the ACTIVE generation
//! runtime (`runtime_config`, id=1) for repeated REAL failures (unreachable /
//! 5xx / OOM-crash / context-length errors) and auto-reverts to the bundled
//! Ollama default after `CONSECUTIVE_FAILURE_THRESHOLD` consecutive failures.
//! This exists so a bad runtime switch (a dead external endpoint, a GPU OOM, a
//! model that doesn't fit) never leaves the agent/RAG/KEX permanently broken
//! with no operator around to notice.
//!
//! Two things it deliberately does NOT count (spec 2026-09-04, D5):
//!
//! - **Transient backpressure.** A live server saying "not right now" (`507`
//!   under memory pressure, `409` "model busy; unload pending", `429`, `503`
//!   while loading …) is logged and recorded on `guardrail_state.last_error`
//!   with the suffix ` (transient, not counted)` but never increments the
//!   counter. Three of those reverted Asgard's oMLX runtime to a bundled Ollama
//!   where the model did not even exist.
//! - **A revert onto a fallback that cannot serve.** Before reverting, bundled
//!   Ollama must answer `/api/tags` with at least one model. If it cannot, the
//!   counter is HELD at the threshold, one undismissed `runtime_unhealthy` event
//!   tells the operator, and the revert waits until the fallback is proven usable.
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
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};

use crate::models::AppState;

/// Consecutive real-failure count that triggers an auto-revert to Ollama.
const CONSECUTIVE_FAILURE_THRESHOLD: i32 = 3;
/// Completed-degraded KEX jobs in the last hour that triggers a notify-only event.
const DEGRADED_JOB_THRESHOLD: i64 = 5;
/// Hard cap on the probe call, enforced via `tokio::time::timeout` (see NOTE
/// below on why this wraps rather than threads through `chat_once`). 60 s, not
/// 20: the chat layer now retries transient statuses with a `1+2+4+8+16 s`
/// ladder (31 s worst case, spec D1) BEFORE returning — a shorter cap would turn
/// a memory-pressure burst into a "timeout" and count it as fatal, which is the
/// exact misclassification this revision removes.
const PROBE_TIMEOUT_SECS: u64 = 60;
/// Fallback reachability check (bundled Ollama `/api/tags`).
const FALLBACK_PROBE_SECS: u64 = 3;

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
        Ok(()) => {
            // Stamp the healthy probe too: `last_probe_at` frozen at the last
            // failure made a working guardrail look asleep (Asgard, 2026-09-04).
            let _ = sqlx::query(
                "UPDATE guardrail_state SET last_probe_at = now(), last_error = NULL WHERE id = 1",
            )
            .execute(&state.db)
            .await;
            reset_failures(state).await;
            dismiss_unhealthy_events(state).await;
        }
        Err(ProbeFailure::Transient(reason)) => {
            // Alive but busy: record, never count. The chat layer already
            // retried the ladder before this surfaced.
            let _ = sqlx::query(
                "UPDATE guardrail_state SET last_probe_at = now(), last_error = $1 WHERE id = 1",
            )
            .bind(format!("{reason} (transient, not counted)"))
            .execute(&state.db)
            .await;
            tracing::info!("guardrail: runtime under transient backpressure, not counted: {reason}");
        }
        Err(ProbeFailure::Fatal(reason)) => {
            // Held at the threshold: once there, every tick re-checks the
            // fallback instead of growing a meaningless count.
            let new_count = (failures + 1).min(CONSECUTIVE_FAILURE_THRESHOLD);
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
                match fallback_usable().await {
                    Ok(()) => {
                        revert_runtime(state, &provider, base_url.as_deref(), model.as_deref(), &reason).await
                    }
                    Err(fallback_error) => {
                        mark_unhealthy(state, &reason, &fallback_error, &provider, base_url.as_deref(), model.as_deref()).await
                    }
                }
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
/// reasonable model that the cap is not a practical constraint.
async fn probe(target: &crate::services::llm::LlmTarget) -> Result<(), ProbeFailure> {
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
        Err(_) => Err(ProbeFailure::Fatal(format!("timeout after {PROBE_TIMEOUT_SECS}s"))),
    }
}

/// How a failed probe is treated: `Transient` is recorded but never counted,
/// `Fatal` counts towards the revert threshold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeFailure {
    Transient(String),
    Fatal(String),
}

/// Numeric status out of the chat layer's `LLM error <code> <text>: …` string
/// (`StatusCode` displays as `507 Insufficient Storage`).
fn llm_error_status(low: &str) -> Option<u16> {
    let rest = low.split("llm error ").nth(1)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Classify a raw chat error string. Matching is case-insensitive via a
/// lowercased `contains` check — no regex dependency needed for this shape.
///
/// Transient (spec D1/D5): an `LLM error <status>` with a transient status
/// (`is_transient_status`), or backpressure wording from the server body —
/// "busy", "unload is pending" / "unload pending", "memory pressure".
/// Fatal: unreachable, OOM / CUDA / context-length, any other 5xx, and every
/// remaining error (401/403/404 …). OOM is checked BEFORE the wording rule so a
/// genuine "out of memory … please retry" from a crashed backend still counts.
pub fn classify_error(raw: &str) -> ProbeFailure {
    let low = raw.to_lowercase();
    let short: String = raw.chars().take(200).collect();

    if let Some(code) = llm_error_status(&low) {
        if crate::services::llm::is_transient_status(code) {
            return ProbeFailure::Transient(format!("transient HTTP {code}: {short}"));
        }
    }
    if low.contains("unreachable") {
        return ProbeFailure::Fatal("unreachable".to_string());
    }
    if low.contains("out of memory") || low.contains("cuda") || low.contains("context length") {
        return ProbeFailure::Fatal(format!("out of memory / CUDA / context-length error: {short}"));
    }
    const BACKPRESSURE: &[&str] = &["busy", "unload is pending", "unload pending", "memory pressure"];
    if BACKPRESSURE.iter().any(|k| low.contains(k)) {
        return ProbeFailure::Transient(format!("transient backpressure: {short}"));
    }
    if low.contains("llm error 5") {
        return ProbeFailure::Fatal(format!("server error (5xx): {short}"));
    }
    ProbeFailure::Fatal(short)
}

async fn reset_failures(state: &AppState) {
    let _ = sqlx::query(
        "UPDATE guardrail_state SET consecutive_failures = 0 WHERE id = 1 AND consecutive_failures <> 0",
    )
    .execute(&state.db)
    .await;
}

/// A healthy probe means any "cannot revert, fallback unusable" alert is stale.
async fn dismiss_unhealthy_events(state: &AppState) {
    let _ = sqlx::query(
        "UPDATE guardrail_events SET dismissed = true WHERE kind = 'runtime_unhealthy' AND dismissed = false",
    )
    .execute(&state.db)
    .await;
}

/// Is the bundled Ollama (`ollama_default_base()`) able to serve as the revert
/// target? `GET /api/tags` must answer 2xx AND list ≥1 model — reverting onto an
/// Ollama with nothing pulled just moves the outage (Asgard: the guardrail
/// reverted to an Ollama where the model did not exist).
async fn fallback_usable() -> Result<(), String> {
    let base = crate::services::llm::ollama_default_base();
    let url = format!("{}/api/tags", base.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(FALLBACK_PROBE_SECS))
        .send()
        .await
        .map_err(|e| format!("bundled Ollama unreachable at {base}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("bundled Ollama at {base} answered HTTP {}", resp.status().as_u16()));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("bundled Ollama /api/tags unparseable: {e}"))?;
    let n = v["models"].as_array().map(|a| a.len()).unwrap_or(0);
    if n == 0 {
        return Err(format!("bundled Ollama at {base} has no models pulled"));
    }
    Ok(())
}

/// The runtime is failing AND the fallback cannot serve: do not revert, tell the
/// operator once. Idempotent — a second tick with an open `runtime_unhealthy`
/// event inserts nothing (the banner would otherwise stack).
async fn mark_unhealthy(
    state: &AppState,
    reason: &str,
    fallback_error: &str,
    provider: &str,
    base_url: Option<&str>,
    model: Option<&str>,
) {
    tracing::warn!(
        "guardrail: runtime failing ({reason}) but NOT reverting — fallback unusable: {fallback_error}"
    );
    let existing: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM guardrail_events WHERE kind = 'runtime_unhealthy' AND dismissed = false LIMIT 1",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    if existing.is_some() {
        return;
    }
    let _ = sqlx::query("INSERT INTO guardrail_events (kind, detail) VALUES ('runtime_unhealthy', $1)")
        .bind(json!({
            "reason": reason,
            "fallback_error": fallback_error,
            "target": { "provider": provider, "base_url": base_url, "model": model },
        }))
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
            "UPDATE runtime_config SET provider = 'ollama', base_url = NULL, model = NULL, runtime_id = 'ollama', updated_at = now() WHERE id = 1",
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

        // The "cannot revert" alert (if any) is superseded by the revert itself.
        sqlx::query(
            "UPDATE guardrail_events SET dismissed = true WHERE kind = 'runtime_unhealthy' AND dismissed = false",
        )
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

#[cfg(test)]
mod tests {
    use super::{classify_error, ProbeFailure};

    fn transient(s: &str) -> bool { matches!(classify_error(s), ProbeFailure::Transient(_)) }
    fn fatal(s: &str) -> bool { matches!(classify_error(s), ProbeFailure::Fatal(_)) }

    /// The exact strings oMLX produced on Asgard (spec "Why" #4) — these must
    /// never count towards a revert.
    #[test]
    fn omlx_backpressure_is_transient() {
        assert!(transient("LLM error 507 Insufficient Storage: {\"error\":\"retry after memory pressure drops\"}"));
        assert!(transient("LLM error 409 Conflict: {\"error\":\"model busy; unload pending\"}"));
    }

    #[test]
    fn transient_status_codes_are_transient() {
        for code in ["408", "409", "425", "429", "502", "503", "504", "507"] {
            let s = format!("LLM error {code} Whatever: nothing useful in the body");
            assert!(transient(&s), "{code} must be transient");
        }
    }

    /// Backpressure WORDING is transient even on an otherwise fatal status.
    #[test]
    fn backpressure_wording_is_transient_case_insensitive() {
        assert!(transient("LLM error 500 Internal Server Error: Model BUSY"));
        assert!(transient("LLM error 500 Internal Server Error: unload is pending"));
        assert!(transient("LLM error 500 Internal Server Error: Unload Pending"));
        assert!(transient("LLM error 500 Internal Server Error: memory pressure"));
    }

    #[test]
    fn dead_runtime_classes_are_fatal() {
        assert!(fatal("LLM unreachable: error sending request for url (http://mac:8020/v1/chat/completions)"));
        assert!(fatal("LLM error 401 Unauthorized: invalid api key"));
        assert!(fatal("LLM error 404 Not Found: model 'x' not found"));
        assert!(fatal("LLM error 500 Internal Server Error: boom"));
        assert!(fatal("LLM error 403 Forbidden: "));
        assert!(fatal("timeout after 60s"));
        assert!(fatal("LLM parse error: expected value"));
    }

    /// The existing reason strings are preserved (the banner and logs key on them).
    #[test]
    fn fatal_reasons_keep_their_existing_shape() {
        assert_eq!(classify_error("LLM unreachable: x"), ProbeFailure::Fatal("unreachable".into()));
        match classify_error("LLM error 500 Internal Server Error: CUDA out of memory") {
            ProbeFailure::Fatal(r) => assert!(r.starts_with("out of memory / CUDA / context-length error:"), "got {r}"),
            other => panic!("expected Fatal, got {other:?}"),
        }
        match classify_error("LLM error 500 Internal Server Error: boom") {
            ProbeFailure::Fatal(r) => assert!(r.starts_with("server error (5xx):"), "got {r}"),
            other => panic!("expected Fatal, got {other:?}"),
        }
    }

    /// OOM wins over the wording rule: a crashed backend asking to "retry" is
    /// still a crash.
    #[test]
    fn oom_beats_backpressure_wording() {
        assert!(fatal("LLM error 500 Internal Server Error: CUDA out of memory, please retry"));
    }

    /// An "unreachable" that happens to contain a keyword stays fatal.
    #[test]
    fn unreachable_beats_backpressure_wording() {
        assert!(fatal("LLM unreachable: connection reset by peer, retry"));
    }

    #[test]
    fn transient_reason_carries_the_status() {
        match classify_error("LLM error 429 Too Many Requests: slow down") {
            ProbeFailure::Transient(r) => assert!(r.contains("429"), "got {r}"),
            other => panic!("expected Transient, got {other:?}"),
        }
    }
}

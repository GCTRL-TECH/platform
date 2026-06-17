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

    // Retention cleanup: delete expired compilations and jobs nightly.
    let s = state.clone();
    tokio::spawn(async move {
        // Initial delay: 1h after startup so migrations + seed data are settled
        sleep(Duration::from_secs(3600)).await;
        loop {
            run_retention_cleanup(&s).await;
            sleep(Duration::from_secs(86400)).await; // 24h
        }
    });

    // A4/A5/A7 — Memory-governance cycle: ONE ordered pass (decay → dedup →
    // promote → evict → dossier-refresh) on a slow cadence (default 600s, env
    // GCTRL_MEMORY_TICK_SECS), independent of the 60s cron. Each run records a
    // structured summary in memory_cycle_runs so the Memory Health panel can show
    // when maintenance last ran and what it did.
    let s = state.clone();
    tokio::spawn(async move {
        // Initial delay so migrations + pool + seed are settled before the first pass.
        sleep(Duration::from_secs(120)).await;
        let period = std::env::var("GCTRL_MEMORY_TICK_SECS")
            .ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(600);
        loop {
            let _ = run_memory_cycle(&s, "scheduled").await;
            sleep(Duration::from_secs(period)).await;
        }
    });

    // Cron / heartbeat executor: ticks ~every 60s and re-ingests Obsidian vaults
    // whose triggers are due. This is the only thing that actually executes the
    // `triggers` table — without it, vaults can only be synced manually.
    let s = state.clone();
    tokio::spawn(async move {
        // Small initial delay so migrations + DB pool are ready.
        sleep(Duration::from_secs(15)).await;
        loop {
            let n = run_cron_tick(&s).await;
            if n > 0 {
                tracing::info!("cron executor: fired {n} due trigger(s)");
            }
            sleep(Duration::from_secs(60)).await;
        }
    });
}

// ── Cron / heartbeat executor ────────────────────────────────────────────────
//
// Finds every active Obsidian trigger that is due and re-ingests its vault via
// the shared `services::obsidian::reingest_vault` helper (the same path the HTTP
// sync handlers use). Resilient: one bad trigger (missing/unreachable vault,
// malformed config) is logged and skipped — it never kills the loop.
//
// Due semantics:
//   * type = 'cron'             → due when next_run_at IS NULL or <= now.
//   * type = 'change_detection' → heartbeat: runs every tick (next_run_at is
//     always set to "now" so it re-fires next pass). KEX-side dedup keeps this
//     cheap (re-extracting unchanged notes is idempotent at the graph layer).
//
// Returns the number of triggers that were executed (success or handled error).

pub async fn run_cron_tick(state: &AppState) -> usize {
    let rows = sqlx::query_as::<_, (Uuid, Uuid, String, Option<String>, Value)>(
        "SELECT id, user_id, type::text, cron_schedule, config
         FROM triggers
         WHERE status = 'active'
           AND module = 'obsidian'
           AND (next_run_at IS NULL OR next_run_at <= NOW())",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mut executed = 0usize;
    for (trigger_id, user_id, kind, cron_schedule, config) in rows {
        // Wrap each run so a single failure never aborts the whole tick.
        let res = run_one_obsidian_trigger(state, trigger_id, user_id, &config).await;
        match res {
            Ok(synced) => {
                let next = compute_next_run(&kind, cron_schedule.as_deref());
                let _ = sqlx::query(
                    "UPDATE triggers SET last_run_at = NOW(), next_run_at = $1,
                        run_count = run_count + CASE WHEN $2 > 0 THEN 1 ELSE 0 END,
                        last_error = NULL, status = 'active', updated_at = NOW()
                     WHERE id = $3",
                )
                .bind(next)
                .bind(synced as i64)
                .bind(trigger_id)
                .execute(&state.db)
                .await;
            }
            Err(e) => {
                tracing::warn!("cron trigger {trigger_id} failed: {e}");
                // Keep it active but record the error + still advance next_run_at
                // so a permanently-broken vault doesn't get retried every tick.
                let next = compute_next_run(&kind, cron_schedule.as_deref());
                let _ = sqlx::query(
                    "UPDATE triggers SET last_run_at = NOW(), next_run_at = $1,
                        last_error = $2, status = 'error', updated_at = NOW()
                     WHERE id = $3",
                )
                .bind(next)
                .bind(e)
                .bind(trigger_id)
                .execute(&state.db)
                .await;
            }
        }
        executed += 1;
    }

    // Also run any due distill triggers (the "automatically maintained" wiki).
    executed += run_distill_triggers(state).await;
    executed
}

// ── Auto-distill executor ────────────────────────────────────────────────────
//
// Finds every active `distill` trigger that is due and enqueues a `distill_wiki`
// job on the `distill:jobs` Redis queue (the same queue the FUSE worker consumes).
// The job re-distils the WIKI compilation from its (multi-)sources.
//
// Idempotent + debounced: before enqueuing we check for an already pending/
// processing `distill_wiki` job for the SAME compilation and skip if one exists —
// so a slow LLM run never lets distill jobs pile up (mirrors the compilation-
// refresh debounce intent). next_run_at is advanced every tick regardless, so a
// misconfigured trigger never busy-loops.
//
// Returns the number of distill triggers processed (enqueued or debounced-skip).

async fn run_distill_triggers(state: &AppState) -> usize {
    let rows = sqlx::query_as::<_, (Uuid, Uuid, String, Option<String>, Value)>(
        "SELECT id, user_id, type::text, cron_schedule, config
         FROM triggers
         WHERE status = 'active'
           AND module = 'distill'
           AND (next_run_at IS NULL OR next_run_at <= NOW())",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mut executed = 0usize;
    for (trigger_id, user_id, kind, cron_schedule, config) in rows {
        let res = enqueue_one_distill(state, user_id, &kind, &config).await;
        let next = compute_next_run(&kind, cron_schedule.as_deref());
        match res {
            Ok(enqueued) => {
                let _ = sqlx::query(
                    "UPDATE triggers SET last_run_at = NOW(), next_run_at = $1,
                        run_count = run_count + CASE WHEN $2 THEN 1 ELSE 0 END,
                        last_error = NULL, status = 'active', updated_at = NOW()
                     WHERE id = $3",
                )
                .bind(next)
                .bind(enqueued)
                .bind(trigger_id)
                .execute(&state.db)
                .await;
            }
            Err(e) => {
                tracing::warn!("distill trigger {trigger_id} failed: {e}");
                let _ = sqlx::query(
                    "UPDATE triggers SET last_run_at = NOW(), next_run_at = $1,
                        last_error = $2, status = 'error', updated_at = NOW()
                     WHERE id = $3",
                )
                .bind(next)
                .bind(e)
                .bind(trigger_id)
                .execute(&state.db)
                .await;
            }
        }
        executed += 1;
    }
    executed
}

/// Resolve the WIKI compilation from the trigger config and enqueue a
/// `distill_wiki` job — unless a job for that compilation is already in flight.
/// Returns Ok(true) when a job was enqueued, Ok(false) when debounced (skipped).
async fn enqueue_one_distill(
    state: &AppState,
    user_id: Uuid,
    kind: &str,
    config: &Value,
) -> std::result::Result<bool, String> {
    let compilation_id = config
        .get("compilationId")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok())
        .ok_or_else(|| "trigger config missing/invalid compilationId".to_string())?;

    // Safety: the wiki must belong to the trigger's user and still be a WIKI.
    let owner_type: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT user_id, type::text FROM compilations WHERE id = $1",
    )
    .bind(compilation_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    match owner_type {
        None => return Err(format!("wiki compilation {compilation_id} not found")),
        Some((owner, _)) if owner != user_id => {
            return Err(format!("wiki {compilation_id} not owned by trigger user"));
        }
        Some((_, ref t)) if t != "WIKI" => {
            return Err(format!("compilation {compilation_id} is {t}, not WIKI"));
        }
        _ => {}
    }

    // Heartbeat mode (`change_detection`): only distil when there's actually new
    // content since the last distil — otherwise the heartbeat is a silent no-op.
    // Cron triggers always fire on their schedule (the interval is the throttle;
    // the distiller is incremental and cheap when nothing changed).
    if kind == "change_detection" && !wiki_has_new_content(state, compilation_id).await? {
        tracing::debug!("distill heartbeat: nothing new for {compilation_id}, skipped");
        return Ok(false);
    }

    // Debounce: skip if a distill_wiki job for this comp is already pending/
    // processing (don't pile up jobs behind a slow LLM run).
    let in_flight: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM jobs
         WHERE type = 'distill_wiki'
           AND status IN ('pending', 'processing')
           AND input->>'compilation_id' = $1
         LIMIT 1",
    )
    .bind(compilation_id.to_string())
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    if in_flight.is_some() {
        tracing::debug!("distill: job already in flight for {compilation_id}, debounced");
        return Ok(false);
    }

    // Record the job (authoritative status) then enqueue on the shared queue.
    let job_id = Uuid::new_v4();
    let input = json!({ "compilation_id": compilation_id.to_string(), "user_id": user_id.to_string() });
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input) VALUES ($1, $2, 'distill_wiki', 'pending', $3)",
    )
    .bind(job_id)
    .bind(user_id)
    .bind(&input)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    // Per-user distill model + Ollama base (Settings → AI Models / Infra). Unset →
    // FUSE uses its env defaults, so scheduled distills match the sync HTTP path.
    let (distill_model, ollama_base) =
        crate::services::llm::resolve_distill_overrides(&state.db, user_id).await;
    crate::services::redis::lpush(
        &state.redis,
        "distill:jobs",
        &json!({
            "job_id": job_id.to_string(),
            "compilation_id": compilation_id.to_string(),
            "user_id": user_id.to_string(),
            "distill_model": distill_model,
            "ollama_base": ollama_base,
        })
        .to_string(),
    )
    .await
    .map_err(|e| e.to_string())?;

    tracing::info!("distill trigger enqueued distill_wiki job {job_id} for wiki {compilation_id}");
    Ok(true)
}

/// Has the wiki gained anything to distil since its last distillation?
///
/// "New content" = the wiki was never distilled, OR its source set changed
/// (`compilations.updated_at` bumps when sources are edited), OR any extraction/
/// fuse job feeding one of its source graphs completed after the last distil.
/// Used to make a heartbeat (`change_detection`) distill trigger a no-op when
/// idle, so it doesn't enqueue pointless jobs every tick.
async fn wiki_has_new_content(
    state: &AppState,
    wiki_id: Uuid,
) -> std::result::Result<bool, String> {
    // last_distill_at NULL → never distilled → always "new".
    let row: Option<(Option<chrono::DateTime<chrono::Utc>>, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT last_distill_at, updated_at FROM compilations WHERE id = $1")
            .bind(wiki_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    let (last_distill_at, updated_at) = match row {
        Some(v) => v,
        None => return Ok(false),
    };
    let Some(last) = last_distill_at else { return Ok(true); };
    // Source set changed after the last distil.
    if updated_at > last {
        return Ok(true);
    }
    // Any job feeding the wiki's source graphs completed after the last distil.
    let newer: Option<bool> = sqlx::query_scalar(
        "WITH src AS (
             SELECT source_compilation_id AS cid FROM wiki_sources WHERE wiki_compilation_id = $1
             UNION
             SELECT wiki_source_compilation_id FROM compilations
               WHERE id = $1 AND wiki_source_compilation_id IS NOT NULL
         )
         SELECT true FROM compilations c
         JOIN src ON src.cid = c.id
         CROSS JOIN LATERAL unnest(COALESCE(c.source_job_ids, '{}'::uuid[])) AS jid
         JOIN jobs j ON j.id = jid
         WHERE j.completed_at IS NOT NULL AND j.completed_at > $2
         LIMIT 1",
    )
    .bind(wiki_id)
    .bind(last)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(newer.is_some())
}

/// Compute the next run instant. change_detection → always due next tick (now);
/// cron → parsed from the schedule.
fn compute_next_run(kind: &str, cron_schedule: Option<&str>) -> chrono::DateTime<chrono::Utc> {
    let now = chrono::Utc::now();
    if kind == "change_detection" {
        return now;
    }
    match cron_schedule.filter(|s| !s.is_empty()) {
        Some(c) => crate::services::cron::next_run_from_cron(c, now),
        None => now + chrono::Duration::hours(24),
    }
}

/// Load the vault referenced by `config.vaultId`, build re-ingest options from
/// the trigger config, and run the shared re-ingest. Returns the number of notes
/// enqueued.
async fn run_one_obsidian_trigger(
    state: &AppState,
    _trigger_id: Uuid,
    user_id: Uuid,
    config: &Value,
) -> std::result::Result<u32, String> {
    use crate::services::obsidian::{self, ReingestMode, ReingestOpts};

    let vault_id = config
        .get("vaultId")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok())
        .ok_or_else(|| "trigger config missing/invalid vaultId".to_string())?;

    let vault = obsidian::load_vault(&state.db, vault_id).await?;
    // Safety: the trigger and the vault must belong to the same user.
    if vault.user_id != user_id {
        return Err(format!("vault {vault_id} not owned by trigger user"));
    }

    // Resolve ontology entity types + classification name the same way the HTTP
    // sync does, so scheduled jobs carry identical extraction options.
    let ontology_id = config
        .get("ontologyId")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok());
    let (ontology_id, entity_types) =
        crate::routes::kex::resolve_ontology(&state.db, user_id, ontology_id).await;

    let classification_level_id = config
        .get("classificationLevelId")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok());
    let classification_name = if let Some(cid) = classification_level_id {
        sqlx::query_scalar::<_, String>("SELECT name FROM classification_levels WHERE id = $1")
            .bind(cid)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
    } else {
        None
    };

    let mode = ReingestMode::from_str(config.get("mode").and_then(|v| v.as_str()));

    let opts = ReingestOpts {
        ontology_id,
        entity_types,
        discovery_mode: config
            .get("discoveryMode")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        compilation_id: config
            .get("compilationId")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<Uuid>().ok()),
        classification_level_id,
        classification_name,
        mode,
        // Incremental: only re-ingest notes changed since the last run.
        since: if mode == ReingestMode::Incremental {
            sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
                "SELECT last_run_at FROM triggers WHERE id = $1",
            )
            .bind(_trigger_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten()
        } else {
            None
        },
    };

    let http = reqwest::Client::builder()
        // REST vaults are loopback self-signed; folder vaults don't use HTTP.
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let res = obsidian::reingest_vault(
        &state.db,
        &state.redis,
        &http,
        &state.cfg.vaults_root,
        &vault,
        &opts,
    )
    .await?;

    Ok(res.synced)
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
    if let Err(e) = pubsub.subscribe(&["kex:results", "fuse:results", "distill:results"]).await {
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

    // Fire webhook for job completion
    if status == "completed" {
        let user_id: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM jobs WHERE id=$1")
            .bind(job_id).fetch_optional(&state.db).await.ok().flatten();
        if let Some(uid) = user_id {
            let wh_payload = json!({
                "event": "job.completed",
                "jobId": job_id,
                "userId": uid,
            });
            crate::routes::webhooks::deliver_event(&state.db, uid, "job.completed", &wh_payload).await;
        }
    }
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

// ── Retention cleanup ───────────────────────────────────────────────────────
//
// Runs nightly (every 24h, after a 1h startup delay).
// Deletes compilations and jobs whose `expires_at` has passed.
// Compilation deletes also remove the corresponding Neo4j nodes.

async fn run_retention_cleanup(state: &AppState) {
    // 1. Find expired compilations
    let expired = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, name FROM compilations WHERE expires_at IS NOT NULL AND expires_at < NOW()"
    ).fetch_all(&state.db).await.unwrap_or_default();

    for (comp_id, comp_name) in &expired {
        tracing::info!("retention: deleting expired compilation {comp_name} ({comp_id})");

        // Delete from Neo4j
        let cypher = "MATCH (n {compilation_id: $cid}) DETACH DELETE n";
        let _ = state.neo.run(
            neo4rs::query(cypher).param("cid", comp_id.to_string().as_str())
        ).await;

        // Audit log — insert before the DELETE so the FK to compilations still resolves
        let _ = sqlx::query(
            "INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
             SELECT user_id, 'retention_delete', 'compilation', $1, $2
             FROM compilations WHERE id = $1"
        ).bind(comp_id)
         .bind(serde_json::json!({"reason": "retention_policy_expired", "name": comp_name}))
         .execute(&state.db).await;

        // Delete from Postgres (cascades to related records)
        let _ = sqlx::query("DELETE FROM compilations WHERE id = $1")
            .bind(comp_id).execute(&state.db).await;
    }

    // 2. Find expired jobs and their chunks
    let _ = sqlx::query(
        "DELETE FROM jobs WHERE expires_at IS NOT NULL AND expires_at < NOW()"
    ).execute(&state.db).await;

    if !expired.is_empty() {
        tracing::info!("retention: cleaned up {} expired compilations", expired.len());
    }
}

// ── A4/A5/A7: Memory-governance cycle ─────────────────────────────────────────
//
// The dynamics layer over the HOT (dossier) + COLD (chunk) memory tiers. A7
// consolidates the A4 passes into ONE ordered cycle, run on a slow cadence
// (default 600s, env GCTRL_MEMORY_TICK_SECS) and also on demand via
// POST /api/memory/maintenance/run. Every run is idempotent, loudly logged, and
// recorded as a structured summary in `memory_cycle_runs`:
//
//   1. DECAY    heat *= DECAY (0.95) on dossiers + chunks NOT accessed within
//               IDLE_SECS (1h). Floored at 0. Recently-touched items are skipped
//               so a hot item isn't decayed the same tick it was used.
//   2. DEDUP    (A5) near-duplicate chunks (embedding cosine > τ 0.92) are merged
//               into one canonical chunk — union provenance, most-restrictive
//               clearance kept — and the duplicates soft-archived. Per-user only.
//               Delegated to KEX POST /dedup (it owns Qdrant + the chunk rows).
//   3. PROMOTE  (A4-refined) a non-dossiered entity whose surrounding chunk-heat
//               crosses PROMOTE_HEAT *AND* that exists as a real owned :Entity graph
//               node with degree ≥ PROMOTE_MIN_DEGREE → build a dossier via FUSE.
//               The degree gate stops noisy GLiNER mentions ("PS", "Self-driven")
//               from ever acquiring dossiers. Debounced (skip if dossier exists).
//   4. EVICT    dossiers/chunks whose heat < EVICT_FLOOR AND not `pinned` AND idle
//               → soft-archive (archived = true). Pinned items are NEVER evicted.
//               Nothing is hard-deleted; a later access revives it (archived→false).
//   5. REFRESH  count of promotions doubles as the dossier-refresh signal (new
//               dossiers are freshly built); reported in the run summary.
//
// Tunables: DECAY 0.95, IDLE_SECS 3600, PROMOTE_HEAT 5.0, PROMOTE_MIN_DEGREE 2,
// PROMOTE_BUILD_CAP 3 (bounded LLM work), EVICT_FLOOR 0.5, DEDUP_TAU 0.92.

const MEM_DECAY: f64 = 0.95;
const MEM_IDLE_SECS: i64 = 3600;          // only decay/evict items idle ≥ 1h
const MEM_PROMOTE_HEAT: f64 = 5.0;        // chunk-heat-around-entity threshold
// We SCAN up to this many hot candidate names per tick but only BUILD up to
// MEM_PROMOTE_BUILD_CAP of them — most candidates are noisy entity_mentions that
// aren't real owned graph nodes, so a wider scan is needed to reach the genuine
// high-degree entities worth a dossier.
const MEM_PROMOTE_SCAN: i64 = 25;
const MEM_PROMOTE_BUILD_CAP: usize = 3;   // bound the per-tick dossier builds (LLM)
const MEM_PROMOTE_MIN_DEGREE: i64 = 2;    // A4 refinement: real node must have degree ≥ this
const MEM_EVICT_FLOOR: f64 = 0.5;         // heat below this (and idle) → archive
const MEM_DEDUP_TAU: f64 = 0.92;          // cosine threshold for near-dup chunks

/// Structured summary of one governance cycle — persisted to memory_cycle_runs and
/// returned by POST /api/memory/maintenance/run.
#[derive(Default, Clone, serde::Serialize)]
pub struct MemoryCycleSummary {
    pub decayed_dossiers: i64,
    pub decayed_chunks:   i64,
    pub deduped_chunks:   i64,
    pub promoted:         i64,
    pub evicted_dossiers: i64,
    pub evicted_chunks:   i64,
    pub duration_ms:      i64,
    pub trigger:          String,
}

/// Run the full memory-governance cycle once (ordered: decay → dedup → promote →
/// evict → refresh), persist a run summary, and return it. `trigger` is
/// "scheduled" (600s tick) or "manual" (operator-pressed). Each step is
/// independently best-effort — a failure in one never aborts the cycle.
pub async fn run_memory_cycle(state: &AppState, trigger: &str) -> MemoryCycleSummary {
    let started = std::time::Instant::now();

    let decayed_d = decay_dossiers(state).await;
    let decayed_c = decay_chunks(state).await;
    let deduped   = dedup_chunks(state).await;          // A5
    let promoted  = promote_hot_entities(state).await;  // A4-refined (degree gate)
    let evicted_d = evict_cold_dossiers(state).await;
    let evicted_c = evict_cold_chunks(state).await;

    let summary = MemoryCycleSummary {
        decayed_dossiers: decayed_d,
        decayed_chunks:   decayed_c,
        deduped_chunks:   deduped,
        promoted,
        evicted_dossiers: evicted_d,
        evicted_chunks:   evicted_c,
        duration_ms:      started.elapsed().as_millis() as i64,
        trigger:          trigger.to_string(),
    };

    if decayed_d + decayed_c + deduped + promoted + evicted_d + evicted_c > 0 {
        tracing::info!(
            "memory-cycle [{trigger}]: decayed {decayed_d} dossier(s)/{decayed_c} chunk(s), \
             deduped {deduped} chunk(s), promoted {promoted} entity→dossier, \
             evicted {evicted_d} dossier(s)/{evicted_c} chunk(s) in {}ms",
            summary.duration_ms
        );
    } else {
        tracing::debug!("memory-cycle [{trigger}]: nothing to do ({}ms)", summary.duration_ms);
    }

    persist_cycle_run(state, &summary).await;
    summary
}

/// Persist the cycle summary as a row in memory_cycle_runs, then prune to the last
/// 200 rows so the log can't grow unbounded. Best-effort.
async fn persist_cycle_run(state: &AppState, s: &MemoryCycleSummary) {
    let summary_json = serde_json::to_value(s).unwrap_or_else(|_| json!({}));
    let _ = sqlx::query(
        "INSERT INTO memory_cycle_runs \
            (finished_at, duration_ms, trigger, decayed_dossiers, decayed_chunks, \
             deduped_chunks, promoted, evicted_dossiers, evicted_chunks, summary) \
         VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9)"
    )
    .bind(s.duration_ms)
    .bind(&s.trigger)
    .bind(s.decayed_dossiers)
    .bind(s.decayed_chunks)
    .bind(s.deduped_chunks)
    .bind(s.promoted)
    .bind(s.evicted_dossiers)
    .bind(s.evicted_chunks)
    .bind(&summary_json)
    .execute(&state.db)
    .await;

    let _ = sqlx::query(
        "DELETE FROM memory_cycle_runs WHERE id NOT IN \
            (SELECT id FROM memory_cycle_runs ORDER BY started_at DESC LIMIT 200)"
    ).execute(&state.db).await;
}

/// A5 — DEDUP: ask KEX to find near-duplicate chunks (cosine > τ) and merge each
/// cluster into one canonical chunk (union provenance, most-restrictive clearance,
/// duplicates soft-archived). KEX owns Qdrant + the chunk rows, so this is one HTTP
/// call (mirrors the FUSE /dossier/build promotion call). Returns merged count.
async fn dedup_chunks(state: &AppState) -> i64 {
    let url = format!("{}/dedup", state.cfg.kex_worker_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&json!({ "tau": MEM_DEDUP_TAU }))
        // Dedup is a corpus sweep — generous timeout, still bounded by KEX MAX_SCAN.
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {
            let body: Value = r.json().await.unwrap_or(Value::Null);
            let merged = body.get("merged").and_then(|v| v.as_i64()).unwrap_or(0);
            if merged > 0 {
                let clusters = body.get("clusters").and_then(|v| v.as_i64()).unwrap_or(0);
                let scanned = body.get("scanned").and_then(|v| v.as_i64()).unwrap_or(0);
                tracing::info!(
                    "memory-cycle: DEDUP merged {merged} duplicate chunk(s) across {clusters} cluster(s) (scanned {scanned})"
                );
            }
            merged
        }
        Ok(r) => {
            tracing::warn!("memory-cycle: dedup KEX {}", r.status());
            0
        }
        Err(e) => {
            tracing::warn!("memory-cycle: dedup KEX unreachable: {e}");
            0
        }
    }
}

/// A4 refinement helper — does this (user, name) exist as a REAL owned graph entity
/// with degree ≥ MEM_PROMOTE_MIN_DEGREE? Noisy GLiNER mentions ("PS") have a hot
/// chunk-mention count but no high-degree node, so they fail this gate and are never
/// promoted. Matches by node `name` scoped to the user's owned subgraph (_owner).
async fn entity_has_degree(state: &AppState, user_id: Uuid, name: &str) -> bool {
    let cypher =
        "MATCH (n {name: $name}) WHERE n._owner = $uid \
         OPTIONAL MATCH (n)-[ro]->() \
         OPTIONAL MATCH ()-[ri]->(n) \
         WITH count(DISTINCT ro) AS outd, count(DISTINCT ri) AS ind \
         RETURN (outd + ind) AS degree ORDER BY degree DESC LIMIT 1";
    let mut stream = match state.neo
        .execute(
            neo4rs::query(cypher)
                .param("name", name)
                .param("uid", user_id.to_string().as_str()),
        )
        .await
    {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!("memory-cycle: degree check failed for '{name}': {e}");
            return false;
        }
    };
    match stream.next().await {
        Ok(Some(row)) => row.get::<i64>("degree").unwrap_or(0) >= MEM_PROMOTE_MIN_DEGREE,
        _ => false,
    }
}

/// Decay heat on dossiers idle ≥ MEM_IDLE_SECS. Returns rows touched.
async fn decay_dossiers(state: &AppState) -> i64 {
    sqlx::query(
        "UPDATE entity_dossiers \
            SET heat = GREATEST(0, heat * $1) \
          WHERE archived = false AND heat > 0 \
            AND (last_accessed IS NULL OR last_accessed < NOW() - ($2 || ' seconds')::interval)"
    )
    .bind(MEM_DECAY)
    .bind(MEM_IDLE_SECS.to_string())
    .execute(&state.db)
    .await
    .map(|r| r.rows_affected() as i64)
    .unwrap_or(0)
}

/// Decay heat on chunks idle ≥ MEM_IDLE_SECS. Returns rows touched.
async fn decay_chunks(state: &AppState) -> i64 {
    sqlx::query(
        "UPDATE text_chunks \
            SET heat = GREATEST(0, heat * $1) \
          WHERE archived = false AND heat > 0 \
            AND (last_accessed IS NULL OR last_accessed < NOW() - ($2 || ' seconds')::interval)"
    )
    .bind(MEM_DECAY)
    .bind(MEM_IDLE_SECS.to_string())
    .execute(&state.db)
    .await
    .map(|r| r.rows_affected() as i64)
    .unwrap_or(0)
}

/// PROMOTE: find (user, entity) pairs whose surrounding chunk-heat crosses
/// MEM_PROMOTE_HEAT and that DON'T already have a (live) dossier, then build one
/// via FUSE. Aggregates heat over `text_chunks.entity_mentions[].name`. Bounded to
/// MEM_PROMOTE_MAX_PER_TICK builds per tick (LLM-bound). Idempotent: an existing
/// dossier (archived or not) for the same (user, name) is skipped via NOT EXISTS,
/// and the FUSE upsert itself is keyed by (user_id, entity_uri).
async fn promote_hot_entities(state: &AppState) -> i64 {
    // Top hot non-dossiered entities. lower(name) join makes the dossier check
    // case-insensitive (matches fetch_dossier_row's lower(entity_name) lookup).
    let rows: Vec<(Uuid, String, f64)> = sqlx::query_as(
        // SUM(real) returns `real` in Postgres — cast to float8 so it decodes into
        // the Rust f64 (a `real` SUM silently fails the (Uuid,String,f64) decode and
        // returns an empty set, which would silently disable promotion).
        "SELECT tc.user_id, em.name, SUM(tc.heat)::float8 AS hot \
           FROM text_chunks tc \
           CROSS JOIN LATERAL jsonb_array_elements(tc.entity_mentions) AS e(val) \
           CROSS JOIN LATERAL (SELECT e.val->>'name' AS name) AS em \
          WHERE tc.archived = false AND tc.heat > 0 AND em.name IS NOT NULL AND em.name <> '' \
            AND NOT EXISTS ( \
                SELECT 1 FROM entity_dossiers d \
                 WHERE d.user_id = tc.user_id \
                   AND lower(d.entity_name) = lower(em.name) \
            ) \
          GROUP BY tc.user_id, em.name \
         HAVING SUM(tc.heat) >= $1 \
          ORDER BY hot DESC \
          LIMIT $2"
    )
    .bind(MEM_PROMOTE_HEAT)
    .bind(MEM_PROMOTE_SCAN)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mut built = 0i64;
    for (user_id, name, hot) in rows {
        // Stop once we've BUILT the per-tick cap (real builds are LLM-bound). We
        // keep scanning past skips above this point, but never build more.
        if built as usize >= MEM_PROMOTE_BUILD_CAP { break; }

        // A4 REFINEMENT — the noisy-promotion fix. Before spending an LLM dossier
        // build, require the candidate to be a REAL owned graph entity with degree
        // ≥ MEM_PROMOTE_MIN_DEGREE. Hot chunk-mention heat alone is not enough:
        // GLiNER emits noisy mentions ("PS", "Self-driven") that accumulate heat but
        // are not high-degree :Entity nodes. This gate filters them out cheaply
        // (one Cypher) BEFORE the FUSE call, so they never get dossiers.
        if !entity_has_degree(state, user_id, &name).await {
            tracing::debug!(
                "memory-cycle: promote skip '{name}' — no owned node with degree ≥ {MEM_PROMOTE_MIN_DEGREE}"
            );
            continue;
        }

        let url = format!("{}/dossier/build", state.cfg.fuse_url);
        let resp = reqwest::Client::new()
            .post(&url)
            .json(&json!({ "user_id": user_id.to_string(), "entity_name": name }))
            .timeout(std::time::Duration::from_secs(180))
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => {
                tracing::info!(
                    "memory-maintenance: PROMOTED '{name}' (chunk-heat {hot:.1}) → dossier for user {user_id}"
                );
                // Seed the new dossier with a little heat so it isn't immediately
                // re-evicted before it gets accessed.
                let _ = sqlx::query(
                    "UPDATE entity_dossiers SET heat = GREATEST(heat, $1), last_accessed = NOW() \
                      WHERE user_id = $2 AND lower(entity_name) = lower($3)"
                )
                .bind(MEM_PROMOTE_HEAT)
                .bind(user_id)
                .bind(&name)
                .execute(&state.db)
                .await;
                built += 1;
            }
            Ok(r) if r.status().as_u16() == 404 => {
                tracing::debug!("memory-maintenance: promote skip '{name}' — FUSE found no such owned entity");
            }
            Ok(r) => tracing::warn!("memory-maintenance: promote '{name}' FUSE {}", r.status()),
            Err(e) => tracing::warn!("memory-maintenance: promote '{name}' FUSE unreachable: {e}"),
        }
    }
    built
}

/// EVICT cold, non-pinned dossiers (soft-archive). Pinned never evicted.
async fn evict_cold_dossiers(state: &AppState) -> i64 {
    sqlx::query(
        "UPDATE entity_dossiers \
            SET archived = true, updated_at = NOW() \
          WHERE archived = false AND pinned = false AND heat < $1 \
            AND (last_accessed IS NULL OR last_accessed < NOW() - ($2 || ' seconds')::interval)"
    )
    .bind(MEM_EVICT_FLOOR)
    .bind(MEM_IDLE_SECS.to_string())
    .execute(&state.db)
    .await
    .map(|r| r.rows_affected() as i64)
    .unwrap_or(0)
}

/// EVICT cold chunks (soft-archive). text_chunks have no pin concept. CRUCIAL
/// guard: only chunks that were ACCESSED at least once (last_accessed IS NOT NULL)
/// and then cooled are evicted — a never-yet-retrieved chunk (the bulk of a fresh
/// KB, heat 0 / last_accessed NULL) stays LIVE so retrieval is never starved. A
/// later retrieval bump revives an evicted chunk (archived→false).
async fn evict_cold_chunks(state: &AppState) -> i64 {
    sqlx::query(
        "UPDATE text_chunks \
            SET archived = true \
          WHERE archived = false AND heat < $1 \
            AND last_accessed IS NOT NULL \
            AND last_accessed < NOW() - ($2 || ' seconds')::interval"
    )
    .bind(MEM_EVICT_FLOOR)
    .bind(MEM_IDLE_SECS.to_string())
    .execute(&state.db)
    .await
    .map(|r| r.rows_affected() as i64)
    .unwrap_or(0)
}

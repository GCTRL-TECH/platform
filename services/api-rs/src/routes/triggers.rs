//! Trigger management API — scheduled / heartbeat re-ingest configuration.
//!
//! Backs the Triggers page and the KEX page's `maybeCreateTrigger`. The actual
//! execution happens in `background::cron_executor`; these handlers only CRUD the
//! `triggers` table. Modules: `kex`, `fuse`, `compilation`, `obsidian`.

use axum::{
    extract::{Extension, Path, State},
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    error::{AppError, Result},
    middleware::auth::{require_role, JwtClaims},
    services::cron::next_run_from_cron,
};

const VALID_MODULES: [&str; 5] = ["kex", "fuse", "compilation", "obsidian", "distill"];
const VALID_TYPES: [&str; 2] = ["cron", "change_detection"];

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/", get(list_triggers).post(create_trigger))
        .route("/heartbeat", get(get_heartbeat).put(set_heartbeat))
        .route("/heartbeat/tick", post(tick_heartbeat))
        .route("/:id", get(get_trigger).put(update_trigger).delete(delete_trigger))
        .route("/:id/pause", post(pause_trigger))
        .route("/:id/resume", post(resume_trigger))
        .route("/:id/run-now", post(run_now))
}

#[derive(Deserialize)]
struct CreateTriggerReq {
    name: String,
    module: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "cronSchedule")]
    cron_schedule: Option<String>,
    #[serde(default)]
    config: Value,
}

#[derive(Deserialize)]
struct UpdateTriggerReq {
    name: Option<String>,
    #[serde(rename = "cronSchedule")]
    cron_schedule: Option<String>,
    config: Option<Value>,
    /// Optionally switch the execution mode: "cron" (fixed interval) or
    /// "change_detection" (heartbeat — runs every tick, skips when nothing new).
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(sqlx::FromRow)]
struct TriggerRow {
    id: Uuid,
    user_id: Uuid,
    name: String,
    module: String,
    #[sqlx(rename = "type")]
    kind: String,
    status: String,
    cron_schedule: Option<String>,
    config: Value,
    last_run_at: Option<DateTime<Utc>>,
    next_run_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    run_count: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

fn trigger_json(t: &TriggerRow) -> Value {
    json!({
        "id": t.id,
        "userId": t.user_id,
        "name": t.name,
        "module": t.module,
        "type": t.kind,
        "status": t.status,
        "cronSchedule": t.cron_schedule,
        "config": t.config,
        "lastRunAt": t.last_run_at,
        "nextRunAt": t.next_run_at,
        "lastError": t.last_error,
        "runCount": t.run_count,
        "createdAt": t.created_at,
        "updatedAt": t.updated_at,
    })
}

const SELECT_COLS: &str = "id, user_id, name, module::text AS module, type::text AS type, \
    status::text AS status, cron_schedule, config, last_run_at, next_run_at, last_error, \
    run_count, created_at, updated_at";

/// GET /api/triggers
async fn list_triggers(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, TriggerRow>(&format!(
        "SELECT {SELECT_COLS} FROM triggers WHERE user_id = $1 ORDER BY created_at DESC"
    ))
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let triggers: Vec<Value> = rows.iter().map(trigger_json).collect();
    Ok(Json(json!({ "triggers": triggers })))
}

/// POST /api/triggers
async fn create_trigger(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateTriggerReq>,
) -> Result<Json<Value>> {
    // Distill triggers are self-service over a wiki you own (ownership is checked
    // below); other modules still require the analyst role.
    if req.module != "distill" {
        require_role(&claims, "analyst")?;
    }

    if req.name.trim().is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if !VALID_MODULES.contains(&req.module.as_str()) {
        return Err(AppError::BadRequest(format!("invalid module: {}", req.module)));
    }
    if !VALID_TYPES.contains(&req.kind.as_str()) {
        return Err(AppError::BadRequest(format!("invalid type: {}", req.kind)));
    }

    // A distill trigger must target a WIKI compilation the caller owns.
    if req.module == "distill" {
        let cid = req.config.get("compilationId").and_then(|v| v.as_str())
            .and_then(|s| s.parse::<Uuid>().ok())
            .ok_or_else(|| AppError::BadRequest("distill triggers need config.compilationId".into()))?;
        let ok: Option<String> = sqlx::query_scalar(
            "SELECT type::text FROM compilations WHERE id = $1 AND user_id = $2"
        ).bind(cid).bind(claims.sub).fetch_optional(&state.db).await?;
        match ok.as_deref() {
            Some("WIKI") => {}
            Some(_) => return Err(AppError::BadRequest("compilationId must be a WIKI compilation".into())),
            None => return Err(AppError::BadRequest("compilationId is not a wiki you own".into())),
        }
    }

    let next_run_at: Option<DateTime<Utc>> = req
        .cron_schedule
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|c| next_run_from_cron(c, Utc::now()));

    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO triggers (id, user_id, name, module, type, status, cron_schedule, config, next_run_at)
         VALUES ($1, $2, $3, $4::trigger_module, $5::trigger_type, 'active', $6, $7, $8)",
    )
    .bind(id)
    .bind(claims.sub)
    .bind(req.name.trim())
    .bind(&req.module)
    .bind(&req.kind)
    .bind(req.cron_schedule.as_deref().filter(|s| !s.is_empty()))
    .bind(if req.config.is_null() { json!({}) } else { req.config })
    .bind(next_run_at)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, TriggerRow>(&format!(
        "SELECT {SELECT_COLS} FROM triggers WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({ "trigger": trigger_json(&row) })))
}

/// GET /api/triggers/:id
async fn get_trigger(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, TriggerRow>(&format!(
        "SELECT {SELECT_COLS} FROM triggers WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(json!({ "trigger": trigger_json(&row) })))
}

/// PUT /api/triggers/:id
async fn update_trigger(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateTriggerReq>,
) -> Result<Json<Value>> {
    // Ownership check.
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM triggers WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(claims.sub)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }

    if let Some(k) = req.kind.as_deref() {
        if !VALID_TYPES.contains(&k) {
            return Err(AppError::BadRequest(format!("invalid type: {k}")));
        }
    }

    // Recompute next_run_at: a switch to heartbeat → due now; otherwise from the
    // (possibly new) cron schedule when one was provided.
    let next_run_at: Option<DateTime<Utc>> = if req.kind.as_deref() == Some("change_detection") {
        Some(Utc::now())
    } else {
        req.cron_schedule
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|c| next_run_from_cron(c, Utc::now()))
    };

    sqlx::query(
        "UPDATE triggers SET
            name          = COALESCE($1, name),
            cron_schedule = COALESCE($2, cron_schedule),
            config        = COALESCE($3, config),
            type          = COALESCE($4::trigger_type, type),
            next_run_at   = COALESCE($5, next_run_at),
            updated_at    = NOW()
         WHERE id = $6",
    )
    .bind(req.name.as_deref())
    .bind(req.cron_schedule.as_deref().filter(|s| !s.is_empty()))
    .bind(req.config)
    .bind(req.kind.as_deref())
    .bind(next_run_at)
    .bind(id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true, "triggerId": id })))
}

/// DELETE /api/triggers/:id
async fn delete_trigger(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM triggers WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(claims.sub)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true, "deleted": id })))
}

/// POST /api/triggers/:id/pause
async fn pause_trigger(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query(
        "UPDATE triggers SET status = 'paused', updated_at = NOW() WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "status": "paused" })))
}

/// POST /api/triggers/:id/resume
async fn resume_trigger(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let cron: Option<String> = sqlx::query_scalar(
        "SELECT cron_schedule FROM triggers WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .flatten();

    let next_run_at = cron
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|c| next_run_from_cron(c, Utc::now()));

    sqlx::query(
        "UPDATE triggers SET status = 'active', next_run_at = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3",
    )
    .bind(next_run_at)
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "status": "active" })))
}

/// POST /api/triggers/:id/run-now — force this trigger to fire on the next tick
/// by clearing next_run_at (the executor treats NULL as "due now").
async fn run_now(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let updated = sqlx::query(
        "UPDATE triggers SET next_run_at = NULL, status = 'active', updated_at = NOW()
         WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true, "message": "Trigger will run on the next tick" })))
}

// ─── Heartbeat config (interval stored in Redis) ─────────────────────────────

const HEARTBEAT_KEY: &str = "triggers:heartbeat:interval";

/// GET /api/triggers/heartbeat
async fn get_heartbeat(
    Extension(_claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let interval_ms: i64 = {
        let mut c = state.redis.lock().await;
        redis::cmd("GET")
            .arg(HEARTBEAT_KEY)
            .query_async::<_, Option<String>>(&mut *c)
            .await
            .ok()
            .flatten()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(60_000)
    };
    Ok(Json(json!({ "intervalMs": interval_ms, "lastTickAt": null })))
}

/// PUT /api/triggers/heartbeat  { intervalMs }
async fn set_heartbeat(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let ms = body
        .get("intervalMs")
        .and_then(|v| v.as_i64())
        .unwrap_or(60_000)
        .max(1_000);
    {
        let mut c = state.redis.lock().await;
        let _: std::result::Result<(), redis::RedisError> = redis::cmd("SET")
            .arg(HEARTBEAT_KEY)
            .arg(ms)
            .query_async(&mut *c)
            .await;
    }
    Ok(Json(json!({ "ok": true, "intervalMs": ms })))
}

/// POST /api/triggers/heartbeat/tick — run the executor once, immediately.
async fn tick_heartbeat(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let n = crate::background::run_cron_tick(&state).await;
    Ok(Json(json!({ "ok": true, "message": format!("Executed {n} due trigger(s)") })))
}

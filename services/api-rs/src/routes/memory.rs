//! A7 — Memory Health + maintenance trigger (`/api/memory`).
//!
//! Operational surface for the memory-governance layer (A4 dynamics + A5 dedup +
//! A7 cycle). Owner-scoped: every metric is computed for the calling user only.
//!
//! ## Routes (mounted under `/api/memory`, behind `require_auth`)
//!
//! - `GET  /health`            → coverage %, store sizes, heat/trust distributions,
//!                               and the last governance-cycle summary.
//! - `POST /maintenance/run`   → run one governance cycle now ("manual" trigger) and
//!                               return its structured summary.

use axum::{extract::{Extension, State}, routing::{get, post}, Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::error::Result;
use crate::middleware::auth::JwtClaims;

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/health",          get(health))
        .route("/maintenance/run", post(run_maintenance))
}

/// Count this user's graph entities (excluding the structural :Compilation nodes)
/// and edges via Neo4j, owner-scoped by `_owner`. Best-effort → (0,0) on error.
async fn graph_counts(state: &crate::models::AppState, uid: &str) -> (i64, i64) {
    let nodes = run_count(
        state,
        "MATCH (n) WHERE n._owner = $uid AND NOT n:Compilation RETURN count(n) AS c",
        uid,
    ).await;
    let edges = run_count(
        state,
        "MATCH (n)-[r]->() WHERE n._owner = $uid RETURN count(r) AS c",
        uid,
    ).await;
    (nodes, edges)
}

async fn run_count(state: &crate::models::AppState, cypher: &str, uid: &str) -> i64 {
    use futures::StreamExt;
    let mut stream = match state.neo
        .execute(neo4rs::query(cypher).param("uid", uid))
        .await
    {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!("memory/health count failed: {e}");
            return 0;
        }
    };
    match stream.next().await {
        Ok(Some(row)) => row.get::<i64>("c").unwrap_or(0),
        _ => 0,
    }
}

/// GET /api/memory/health — the operational snapshot.
async fn health(
    State(state): State<Arc<crate::models::AppState>>,
    Extension(claims): Extension<JwtClaims>,
) -> Result<Json<Value>> {
    Ok(Json(health_json(&state, claims.sub).await))
}

/// The memory-health snapshot for a user — shared by the REST handler and the
/// `memory_health` agent tool.
pub(crate) async fn health_json(
    state: &std::sync::Arc<crate::models::AppState>,
    uid: uuid::Uuid,
) -> Value {
    let uid_str = uid.to_string();

    // ── Graph store (Neo4j) ──────────────────────────────────────────────
    let (entities, edges) = graph_counts(state, &uid_str).await;

    // ── Chunk store (Postgres) — live vs archived ───────────────────────
    let (chunks_live, chunks_archived): (i64, i64) = sqlx::query_as(
        "SELECT \
            COUNT(*) FILTER (WHERE archived = false), \
            COUNT(*) FILTER (WHERE archived = true) \
         FROM text_chunks WHERE user_id = $1"
    ).bind(uid).fetch_one(&state.db).await.unwrap_or((0, 0));

    // ── Dossier store — live / archived / pinned ────────────────────────
    let (doss_live, doss_archived, doss_pinned): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
            COUNT(*) FILTER (WHERE archived = false), \
            COUNT(*) FILTER (WHERE archived = true), \
            COUNT(*) FILTER (WHERE pinned = true AND archived = false) \
         FROM entity_dossiers WHERE user_id = $1"
    ).bind(uid).fetch_one(&state.db).await.unwrap_or((0, 0, 0));

    // ── Wiki pages (owned compilations) ─────────────────────────────────
    let wiki_pages: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM wiki_pages w \
         JOIN compilations c ON c.id = w.compilation_id \
         WHERE c.user_id = $1"
    ).bind(uid).fetch_one(&state.db).await.unwrap_or(0);

    // ── Coverage: live dossiers / total graph entities ──────────────────
    let coverage = if entities > 0 {
        (doss_live as f64 / entities as f64).clamp(0.0, 1.0)
    } else {
        0.0
    };

    // ── Heat distribution over LIVE chunks (hot ≥ 5, warm ≥ 1, cold < 1) ─
    let (hot, warm, cold): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
            COUNT(*) FILTER (WHERE heat >= 5), \
            COUNT(*) FILTER (WHERE heat >= 1 AND heat < 5), \
            COUNT(*) FILTER (WHERE heat < 1) \
         FROM text_chunks WHERE user_id = $1 AND archived = false"
    ).bind(uid).fetch_one(&state.db).await.unwrap_or((0, 0, 0));

    // ── Trust distribution over LIVE dossiers ───────────────────────────
    let (trust_high, trust_mid, trust_low): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
            COUNT(*) FILTER (WHERE trust >= 0.8), \
            COUNT(*) FILTER (WHERE trust >= 0.4 AND trust < 0.8), \
            COUNT(*) FILTER (WHERE trust < 0.4) \
         FROM entity_dossiers WHERE user_id = $1 AND archived = false"
    ).bind(uid).fetch_one(&state.db).await.unwrap_or((0, 0, 0));

    // ── Last governance-cycle summary (global; the cycle is corpus-wide) ─
    let last_run: Option<(chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>, i64, String, Value)> =
        sqlx::query_as(
            "SELECT started_at, finished_at, duration_ms, trigger, summary \
             FROM memory_cycle_runs ORDER BY started_at DESC LIMIT 1"
        ).fetch_optional(&state.db).await.unwrap_or(None);

    let last_run_json = last_run.map(|(started, finished, dur, trig, summary)| {
        json!({
            "startedAt":  started.to_rfc3339(),
            "finishedAt": finished.map(|f| f.to_rfc3339()),
            "durationMs": dur,
            "trigger":    trig,
            "summary":    summary,
        })
    });

    json!({
        "coverage": coverage,
        "stores": {
            "entities": entities,
            "edges":    edges,
            "chunks":   { "live": chunks_live, "archived": chunks_archived },
            "dossiers": { "live": doss_live, "archived": doss_archived, "pinned": doss_pinned },
            "wikiPages": wiki_pages,
        },
        "heat":  { "hot": hot, "warm": warm, "cold": cold },
        "trust": { "high": trust_high, "mid": trust_mid, "low": trust_low },
        "lastRun": last_run_json,
    })
}

/// POST /api/memory/maintenance/run — run one governance cycle now and return its
/// summary. The cycle is corpus-wide (any authenticated user can trigger it; the
/// passes themselves are per-user safe). Persists a "manual" run row.
async fn run_maintenance(
    State(state): State<Arc<crate::models::AppState>>,
    Extension(claims): Extension<JwtClaims>,
) -> Result<Json<Value>> {
    let summary = crate::background::run_memory_cycle(&state, "manual").await;
    crate::services::audit::log_access(
        &state.db, &claims, "memory.maintenance.run", "memory", "cycle", 0, None, true, None,
    ).await;
    Ok(Json(json!({
        "ok": true,
        "summary": {
            "decayedDossiers": summary.decayed_dossiers,
            "decayedChunks":   summary.decayed_chunks,
            "dedupedChunks":   summary.deduped_chunks,
            "promoted":        summary.promoted,
            "evictedDossiers": summary.evicted_dossiers,
            "evictedChunks":   summary.evicted_chunks,
            "durationMs":      summary.duration_ms,
            "trigger":         summary.trigger,
        }
    })))
}

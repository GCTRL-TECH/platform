use axum::{
    extract::{Extension, Path, State},
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
};

use serde::Serialize;

// ─── Request types ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SetRetentionReq {
    retention_days: Option<i32>,
    action:         Option<String>,
    notify_email:   Option<String>,
}

#[derive(Deserialize)]
struct CreateLevelReq {
    name:         String,
    display_name: String,
    rank:         i32,
    color:        Option<String>,
    description:  Option<String>,
    icon:         Option<String>,
}

#[derive(Deserialize)]
struct UpdateLevelReq {
    name:         Option<String>,
    display_name: Option<String>,
    rank:         Option<i32>,
    color:        Option<String>,
    description:  Option<String>,
    icon:         Option<String>,
}

// ─── DB row ───────────────────────────────────────────────────────────────────

#[allow(dead_code)]
#[derive(sqlx::FromRow)]
struct ClassificationLevelRow {
    id:           Uuid,
    user_id:      Option<Uuid>,
    name:         String,
    display_name: String,
    rank:         i32,
    color:        Option<String>,
    description:  Option<String>,
    icon:         Option<String>,
    is_system:    bool,
    is_active:    bool,
}

// ─── Retention DB row ─────────────────────────────────────────────────────────

#[allow(dead_code)]
#[derive(sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetentionPolicyRow {
    id:                      Uuid,
    classification_level_id: Option<Uuid>,
    user_id:                 Option<Uuid>,
    retention_days:          Option<i32>,
    action:                  String,
    notify_email:            Option<String>,
    is_active:               bool,
}

// ─── Router ───────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/levels",    get(list_levels).post(create_level))
        .route("/levels/:id", put(update_level).delete(delete_level))
        .route("/levels/:id/retention", get(get_retention).put(set_retention))
        .route("/conflicts", get(list_conflicts))
        .route("/conflicts/:id/suggest", axum::routing::post(suggest_conflict))
        .route("/conflicts/:id/resolve", axum::routing::post(resolve_conflict))
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// GET /api/classification
/// Returns system-level entries (user_id IS NULL) plus the caller's custom levels.
async fn list_levels(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, ClassificationLevelRow>(
        "SELECT id, user_id, name, display_name, rank, color, description, icon, is_system, is_active
         FROM classification_levels
         WHERE user_id IS NULL OR user_id = $1
         ORDER BY rank ASC, name ASC",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let levels: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id":           r.id,
                "user_id":      r.user_id,
                "name":         r.name,
                "display_name": r.display_name,
                "rank":         r.rank,
                "color":        r.color,
                "description":  r.description,
                "icon":         r.icon,
                "is_system":    r.is_system,
                "is_active":    r.is_active,
            })
        })
        .collect();

    Ok(Json(json!({ "levels": levels })))
}

/// POST /api/classification
/// Creates a custom classification level for the authenticated user.
/// Requires role = 'editor' or 'admin'.
async fn create_level(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateLevelReq>,
) -> Result<Json<Value>> {
    // Role check
    require_editor_or_admin(&state.db, claims.sub).await?;

    if req.name.trim().is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if req.display_name.trim().is_empty() {
        return Err(AppError::BadRequest("displayName is required".into()));
    }

    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO classification_levels
             (id, user_id, name, display_name, rank, color, description, icon, is_system, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true)",
    )
    .bind(id)
    .bind(claims.sub)
    .bind(&req.name)
    .bind(&req.display_name)
    .bind(req.rank)
    .bind(&req.color)
    .bind(&req.description)
    .bind(&req.icon)
    .execute(&state.db)
    .await?;

    // Return the full level so the UI can append it without a refetch.
    Ok(Json(json!({
        "id":           id,
        "user_id":      claims.sub,
        "name":         req.name,
        "display_name": req.display_name,
        "rank":         req.rank,
        "color":        req.color,
        "description":  req.description,
        "icon":         req.icon,
        "is_system":    false,
        "is_active":    true,
    })))
}

/// PUT /api/classification/:id
/// Updates a custom classification level. Cannot update system levels.
async fn update_level(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateLevelReq>,
) -> Result<Json<Value>> {
    // Fetch the level and verify ownership + non-system
    let row = sqlx::query_as::<_, ClassificationLevelRow>(
        "SELECT id, user_id, name, display_name, rank, color, description, icon, is_system, is_active
         FROM classification_levels
         WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    if row.is_system {
        return Err(AppError::Forbidden("Cannot update system classification levels".into()));
    }

    if row.user_id != Some(claims.sub) {
        return Err(AppError::Forbidden("Not your classification level".into()));
    }

    // Apply partial updates; fall back to existing values when field is None
    let new_name         = req.name        .unwrap_or(row.name);
    let new_display_name = req.display_name.unwrap_or(row.display_name);
    let new_rank         = req.rank        .unwrap_or(row.rank);
    let new_color        = req.color        .or(row.color);
    let new_description  = req.description  .or(row.description);
    let new_icon         = req.icon         .or(row.icon);

    sqlx::query(
        "UPDATE classification_levels
         SET name = $1, display_name = $2, rank = $3,
             color = $4, description = $5, icon = $6,
             updated_at = NOW()
         WHERE id = $7",
    )
    .bind(&new_name)
    .bind(&new_display_name)
    .bind(new_rank)
    .bind(&new_color)
    .bind(&new_description)
    .bind(&new_icon)
    .bind(id)
    .execute(&state.db)
    .await?;

    // Return the full updated level so the UI can replace its row in place.
    Ok(Json(json!({
        "id":           id,
        "user_id":      row.user_id,
        "name":         new_name,
        "display_name": new_display_name,
        "rank":         new_rank,
        "color":        new_color,
        "description":  new_description,
        "icon":         new_icon,
        "is_system":    false,
        "is_active":    row.is_active,
    })))
}

/// DELETE /api/classification/:id
/// Deletes a custom classification level. Cannot delete system levels.
async fn delete_level(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // Fetch level to check system flag and ownership
    let row = sqlx::query_as::<_, (Option<Uuid>, bool)>(
        "SELECT user_id, is_system FROM classification_levels WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let (user_id, is_system) = row;

    if is_system {
        return Err(AppError::Forbidden("Cannot delete system classification levels".into()));
    }

    if user_id != Some(claims.sub) {
        return Err(AppError::Forbidden("Not your classification level".into()));
    }

    sqlx::query(
        "DELETE FROM classification_levels WHERE id = $1 AND user_id = $2 AND is_system = false",
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true })))
}

// ─── Retention policy handlers ───────────────────────────────────────────────

/// GET /api/classification/levels/:id/retention
/// Returns the effective retention policy for a classification level.
/// Prefers a user-specific override; falls back to the system default.
async fn get_retention(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // Verify the level exists and is visible to this user
    let _exists: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM classification_levels WHERE id = $1 AND (user_id IS NULL OR user_id = $2)",
    )
    .bind(id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?;

    if _exists.is_none() {
        return Err(AppError::NotFound);
    }

    // User override first, then system default
    let row = sqlx::query_as::<_, RetentionPolicyRow>(
        "SELECT id, classification_level_id, user_id, retention_days, action, notify_email, is_active
         FROM retention_policies
         WHERE classification_level_id = $1
           AND (user_id = $2 OR user_id IS NULL)
         ORDER BY (user_id IS NOT NULL) DESC
         LIMIT 1",
    )
    .bind(id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?;

    match row {
        Some(r) => Ok(Json(json!({
            "id":                    r.id,
            "classificationLevelId": r.classification_level_id,
            "userId":                r.user_id,
            "retentionDays":         r.retention_days,
            "action":                r.action,
            "notifyEmail":           r.notify_email,
            "isActive":              r.is_active,
        }))),
        None => Ok(Json(json!({ "retentionDays": null, "action": "delete", "userId": null }))),
    }
}

/// PUT /api/classification/levels/:id/retention
/// Upserts a user-specific retention policy override for a classification level.
/// Body: `{ retention_days: number | null, action: string, notify_email?: string }`
/// Requires role = 'admin'.
async fn set_retention(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<SetRetentionReq>,
) -> Result<Json<Value>> {
    require_admin(&state.db, claims.sub).await?;

    // Verify the level exists and is visible to this user
    let _exists: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM classification_levels WHERE id = $1 AND (user_id IS NULL OR user_id = $2)",
    )
    .bind(id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?;

    if _exists.is_none() {
        return Err(AppError::NotFound);
    }

    let action = req.action.as_deref().unwrap_or("delete");
    if !matches!(action, "delete" | "archive" | "notify") {
        return Err(AppError::BadRequest(
            "action must be one of: delete, archive, notify".into(),
        ));
    }

    // Upsert: insert or update the user-specific override row
    sqlx::query(
        "INSERT INTO retention_policies
             (classification_level_id, user_id, retention_days, action, notify_email)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (classification_level_id, user_id)
         DO UPDATE SET
             retention_days = EXCLUDED.retention_days,
             action         = EXCLUDED.action,
             notify_email   = EXCLUDED.notify_email,
             is_active      = true",
    )
    .bind(id)
    .bind(claims.sub)
    .bind(req.retention_days)
    .bind(action)
    .bind(&req.notify_email)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true })))
}

// ─── Classification conflict handlers ─────────────────────────────────────────

/// GET /api/classification/conflicts
/// List OPEN conflicts across the caller's compilations — a unified surface:
///   kind = "classification" — one element carries two different classification
///          labels (the pre-P3 rows; response shape unchanged, plus `kind`).
///   kind = "fact"           — P3: two sources assert DIFFERENT values for a
///          functional relation of the same entity (fact_conflicts), with the
///          competing values ranked by recency authority.
async fn list_conflicts(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (
        Uuid, Option<Uuid>, String, String, Value, Option<Value>, String,
        chrono::DateTime<chrono::Utc>,
    )>(
        "SELECT cc.id, cc.compilation_id, cc.element_kind, cc.element_key,
                cc.labels, cc.suggestion, cc.status, cc.created_at
         FROM classification_conflicts cc
         JOIN compilations c ON c.id = cc.compilation_id
         WHERE c.user_id = $1 AND cc.status = 'open'
         ORDER BY cc.created_at DESC LIMIT 200",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let mut conflicts: Vec<Value> = rows.into_iter().map(
        |(id, cid, kind, key, labels, suggestion, status, created)| json!({
            "id": id, "kind": "classification",
            "compilationId": cid, "elementKind": kind, "elementKey": key,
            "labels": labels, "suggestion": suggestion, "status": status, "createdAt": created,
        })
    ).collect();

    // P3 — fact conflicts (owner-scoped directly by user_id; compilation_id is
    // NULL for write-time detections, so no compilations join here).
    let fact_rows = sqlx::query_as::<_, (
        Uuid, Option<Uuid>, String, String, String, String, Value, Option<String>,
        String, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>,
    )>(
        "SELECT id, compilation_id, relation, key_uri, key_name, key_side,
                tails, authority_winner, status, first_detected_at, last_evaluated_at
         FROM fact_conflicts
         WHERE user_id = $1 AND status = 'open'
         ORDER BY first_detected_at DESC LIMIT 200",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    conflicts.extend(fact_rows.into_iter().map(
        |(id, cid, relation, key_uri, key_name, key_side, tails, winner,
          status, first_detected, last_evaluated)| json!({
            "id": id, "kind": "fact",
            "compilationId": cid, "relation": relation,
            "keyUri": key_uri, "keyName": key_name, "keySide": key_side,
            "tails": tails, "authorityWinner": winner, "status": status,
            "createdAt": first_detected, "lastEvaluatedAt": last_evaluated,
        })
    ));

    Ok(Json(json!({ "conflicts": conflicts })))
}

/// POST /api/classification/conflicts/:id/suggest
/// Run the resolver (Ollama semantic check) and store a suggested resolution.
async fn suggest_conflict(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_editor_or_admin(&state.db, claims.sub).await?;

    let row = sqlx::query_as::<_, (String, Value)>(
        "SELECT cc.element_key, cc.labels FROM classification_conflicts cc
         JOIN compilations c ON c.id = cc.compilation_id
         WHERE cc.id = $1 AND c.user_id = $2",
    )
    .bind(id).bind(claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;
    let (element_key, labels) = row;

    // Readable element name: node key = "name_type_cid", edge key = "head|rel|tail|cid".
    let name = element_key.split(['_', '|']).next().unwrap_or(&element_key).to_string();
    let suggestion = crate::services::classify_resolver::suggest_resolution(&name, &labels).await;
    let sjson = suggestion.to_json();

    sqlx::query("UPDATE classification_conflicts SET suggestion = $1 WHERE id = $2")
        .bind(&sjson).bind(id).execute(&state.db).await?;

    Ok(Json(json!({ "suggestion": sjson })))
}

#[derive(Deserialize)]
struct ResolveConflictReq {
    /// "keep" (no change), "dismiss", or "remove_label" (drop label of `rank`).
    action: String,
    rank:   Option<i32>,
}

/// POST /api/classification/conflicts/:id/resolve
/// Apply an admin-approved resolution. Only `remove_label` mutates the graph
/// (dropping one label and recomputing `_min_rank`/`_class_conflict`); the
/// labels are otherwise preserved (no silent escalation).
async fn resolve_conflict(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<ResolveConflictReq>,
) -> Result<Json<Value>> {
    require_admin(&state.db, claims.sub).await?;

    let row = sqlx::query_as::<_, (Option<Uuid>, String, String)>(
        "SELECT cc.compilation_id, cc.element_kind, cc.element_key
         FROM classification_conflicts cc
         JOIN compilations c ON c.id = cc.compilation_id
         WHERE cc.id = $1 AND c.user_id = $2",
    )
    .bind(id).bind(claims.sub)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;
    let (comp_id, kind, key) = row;

    let status = match req.action.as_str() {
        "keep" => "resolved",
        "dismiss" => "dismissed",
        "remove_label" => {
            let rank = req.rank.ok_or_else(|| AppError::BadRequest("rank required for remove_label".into()))?;
            remove_element_label(&state, &kind, &key, comp_id, rank).await?;
            "resolved"
        }
        other => return Err(AppError::BadRequest(format!("unknown action: {other}"))),
    };

    sqlx::query(
        "UPDATE classification_conflicts SET status = $1, resolved_by = $2, resolved_at = NOW() WHERE id = $3"
    ).bind(status).bind(claims.sub).bind(id).execute(&state.db).await?;

    Ok(Json(json!({ "ok": true, "status": status })))
}

/// Drop the label of `rank` from a Neo4j node/edge, then recompute `_min_rank`
/// and `_class_conflict` from the remaining parallel label lists.
async fn remove_element_label(
    state: &Arc<crate::models::AppState>,
    kind: &str,
    key: &str,
    comp_id: Option<Uuid>,
    rank: i32,
) -> Result<()> {
    let recompute = "\
        WITH x, [i IN range(0, size(coalesce(x._label_ranks,[])) - 1) WHERE x._label_ranks[i] <> $rank] AS keep \
        SET x._label_ranks  = [i IN keep | x._label_ranks[i]], \
            x._class_labels = [i IN keep | x._class_labels[i]] \
        WITH x \
        SET x._min_rank = CASE WHEN size(coalesce(x._label_ranks,[])) = 0 THEN 0 \
                               ELSE reduce(mn = 2147483647, r IN x._label_ranks | CASE WHEN r < mn THEN r ELSE mn END) END, \
            x._class_conflict = size(coalesce(x._label_ranks,[])) > 1";

    if kind == "edge" {
        // element_key = "head|rel|tail|cid"
        let parts: Vec<&str> = key.split('|').collect();
        if parts.len() < 3 {
            return Err(AppError::BadRequest("malformed edge key".into()));
        }
        let cid = comp_id.map(|c| c.to_string()).unwrap_or_default();
        let cypher = format!(
            "MATCH (a)-[x]->(b) WHERE a.name = $head AND b.name = $tail AND type(x) = $rel AND x._compilation = $cid {recompute}"
        );
        state.neo.run(
            neo4rs::query(&cypher)
                .param("head", parts[0])
                .param("rel", parts[1])
                .param("tail", parts[2])
                .param("cid", cid)
                .param("rank", rank as i64),
        ).await.map_err(|e| AppError::Internal(e.to_string()))?;
    } else {
        let cypher = format!("MATCH (x) WHERE x.uri = $key {recompute}");
        state.neo.run(
            neo4rs::query(&cypher).param("key", key).param("rank", rank as i64),
        ).await.map_err(|e| AppError::Internal(e.to_string()))?;
    }
    Ok(())
}

// ─── Role-check helper ────────────────────────────────────────────────────────

async fn require_editor_or_admin(db: &sqlx::PgPool, user_id: Uuid) -> Result<()> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .flatten();

    match role.as_deref() {
        Some("editor") | Some("admin") => Ok(()),
        _ => Err(AppError::Forbidden(
            "editor or admin role required".into(),
        )),
    }
}

async fn require_admin(db: &sqlx::PgPool, user_id: Uuid) -> Result<()> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .flatten();

    match role.as_deref() {
        Some("admin") => Ok(()),
        _ => Err(AppError::Forbidden("admin role required".into())),
    }
}

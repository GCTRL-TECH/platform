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

// ─── Conflict visibility ──────────────────────────────────────────────────────
//
// A conflict concerns the caller only when the caller may see the compilation
// it lives in. That is the SAME rule `kg::list` / `kg::list_folders` apply to
// graphs (clearance cap, per-graph grant, Codebase access, KB-scope of an
// access token) — before this, the conflict queue was owner-scoped only, so a
// PUBLIC-capped or KB-scoped colleague token enumerated every conflict of the
// owner, including element names and competing values from graphs it may not
// open. The rule is one pure function (`conflict_visible`, unit-tested) used by
// the list AND by every per-conflict action (suggest / resolve, both kinds).

/// What the request may see, resolved once per request.
#[derive(Debug, Clone)]
pub(crate) struct ConflictViewer {
    /// Effective clearance (already capped by any API-key rank).
    pub rank: i32,
    /// True when `rank` is below the owner's own clearance (rank-limited token or
    /// downgraded agent session) — such a request never sees unclassified graphs.
    pub capped: bool,
    /// The token's Codebase-access capability (always true for a session).
    pub code_access: bool,
    /// `Some(set)` for a KB-scoped token: only these compilations exist for it.
    pub scope: Option<std::collections::HashSet<Uuid>>,
}

impl ConflictViewer {
    pub(crate) async fn load(db: &sqlx::PgPool, claims: &JwtClaims) -> Self {
        let (rank, capped) = crate::routes::kg::clearance_rank_with_cap(db, claims).await;
        let scope = crate::routes::kg::api_key_scope(db, claims).await;
        ConflictViewer { rank, capped, code_access: claims.code_access, scope }
    }

    /// A full owner session: not rank-capped, not KB-scoped, Codebase access on.
    /// Only such a request may see conflicts that are tied to NO compilation.
    fn is_full_owner(&self) -> bool {
        !self.capped && self.scope.is_none() && self.code_access
    }
}

/// The facts about one compilation the rule needs.
#[derive(Debug, Clone)]
pub(crate) struct CompilationFacts {
    pub id: Uuid,
    /// Rank of the graph's classification level; None = unclassified.
    pub level_rank: Option<i32>,
    pub is_code: bool,
    /// Per-graph grant of the token used: None = no grant, Some(None) = full
    /// grant, Some(Some(r)) = grant capped at rank r.
    pub grant: Option<Option<i32>>,
}

/// Pure: may this viewer see a conflict living in `comp`? `None` = the conflict
/// is not attributable to a compilation (fact conflicts from write-time
/// detection carry `compilation_id = NULL`): visible to a full owner session
/// only — a limited token cannot be shown data we cannot prove it may see.
pub(crate) fn conflict_visible(viewer: &ConflictViewer, comp: Option<&CompilationFacts>) -> bool {
    let Some(c) = comp else { return viewer.is_full_owner(); };
    if !viewer.code_access && c.is_code { return false; }
    if let Some(set) = &viewer.scope {
        if !set.contains(&c.id) { return false; }
    }
    let granted = |need: Option<i32>| match (c.grant, need) {
        (None, _)              => false,
        (Some(None), _)        => true,   // full grant on this graph
        (Some(Some(_)), None)  => true,   // any grant reaches an unclassified graph
        (Some(Some(g)), Some(r)) => g >= r,
    };
    match c.level_rank {
        Some(r) => r <= viewer.rank || granted(Some(r)),
        None    => !viewer.capped || granted(None),
    }
}

/// The caller's compilations with the facts the rule needs, keyed by id. One
/// query per request; a compilation of another user is simply absent (= not
/// visible). `api_key_id` is NULL for sessions, so the grant join yields none.
pub(crate) async fn load_compilation_facts(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
) -> Result<std::collections::HashMap<Uuid, CompilationFacts>> {
    let rows = sqlx::query_as::<_, (Uuid, Option<i32>, bool, bool, Option<i32>)>(
        "SELECT c.id, cl.rank, c.type::text = 'CODE', g.id IS NOT NULL, g.granted_rank
         FROM compilations c
         LEFT JOIN classification_levels cl ON cl.id = c.classification_level_id
         LEFT JOIN api_key_grants g ON g.compilation_id = c.id AND g.api_key_id = $2
         WHERE c.user_id = $1",
    )
    .bind(claims.sub)
    .bind(claims.api_key_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, level_rank, is_code, has_grant, granted_rank)| {
            let grant = if has_grant { Some(granted_rank) } else { None };
            (id, CompilationFacts { id, level_rank, is_code, grant })
        })
        .collect())
}

/// Gate for ONE conflict (suggest / resolve, both kinds): the caller must be the
/// owner AND pass `conflict_visible` for the conflict's compilation. Fails as
/// NotFound so a caller outside the rule cannot even learn the row exists.
pub(crate) async fn conflict_access(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
    owner: Uuid,
    compilation_id: Option<Uuid>,
) -> Result<()> {
    if owner != claims.sub { return Err(AppError::NotFound); }
    let viewer = ConflictViewer::load(db, claims).await;
    let ok = match compilation_id {
        None => conflict_visible(&viewer, None),
        Some(cid) => {
            let facts = load_compilation_facts(db, claims).await?;
            facts.get(&cid).is_some_and(|f| conflict_visible(&viewer, Some(f)))
        }
    };
    if ok { Ok(()) } else { Err(AppError::NotFound) }
}

// ─── Classification conflict handlers ─────────────────────────────────────────

/// GET /api/classification/conflicts
/// List OPEN conflicts across the compilations the caller may see (see
/// "Conflict visibility" above) — a unified surface:
///   kind = "classification" — one element carries two different classification
///          labels (the pre-P3 rows; response shape unchanged, plus `kind`).
///   kind = "fact"           — P3: two sources assert DIFFERENT values for a
///          functional relation of the same entity (fact_conflicts), with the
///          competing values ranked by recency authority.
async fn list_conflicts(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let viewer = ConflictViewer::load(&state.db, &claims).await;
    let facts = load_compilation_facts(&state.db, &claims).await?;
    let visible = |cid: Option<Uuid>| match cid {
        None => conflict_visible(&viewer, None),
        Some(id) => facts.get(&id).is_some_and(|f| conflict_visible(&viewer, Some(f))),
    };
    // Owner-scoped in SQL, visibility in Rust (one rule, one function); the
    // window is wide enough that filtering rarely empties a page, and each
    // kind is still capped at 200 rows for the UI.
    const PAGE: usize = 200;

    let rows = sqlx::query_as::<_, (
        Uuid, Option<Uuid>, String, String, Value, Option<Value>, String,
        chrono::DateTime<chrono::Utc>,
    )>(
        "SELECT cc.id, cc.compilation_id, cc.element_kind, cc.element_key,
                cc.labels, cc.suggestion, cc.status, cc.created_at
         FROM classification_conflicts cc
         JOIN compilations c ON c.id = cc.compilation_id
         WHERE c.user_id = $1 AND cc.status = 'open'
         ORDER BY cc.created_at DESC LIMIT 1000",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    // Decision memory (migration 086): each conflict carries `history` — the
    // majority decision for its signature with counters, or null when unseen —
    // so the queue can show "decided this way 4 of 5 times" without a suggest
    // round-trip. This is the fact path's only suggestion surface.
    use crate::services::conflict_memory as memory;
    let rows: Vec<_> = rows.into_iter().filter(|r| visible(r.1)).take(PAGE).collect();
    let sigs: Vec<String> = rows.iter().map(|r| memory::classification_signature(&r.2, &r.4)).collect();
    let class_verdicts = memory::verdicts(&state.db, "classification", &sigs).await;

    let mut conflicts: Vec<Value> = rows.into_iter().zip(sigs)
        .map(|((id, cid, kind, key, labels, suggestion, status, created), sig)| json!({
            "id": id, "kind": "classification",
            "compilationId": cid, "elementKind": kind, "elementKey": key,
            "labels": labels, "suggestion": suggestion, "status": status, "createdAt": created,
            "history": memory::verdict_json(class_verdicts.get(&sig)),
        }))
        .collect();

    // P3 — fact conflicts (owner-scoped by user_id; compilation_id is NULL for
    // write-time detections — those rows are for a full owner session only).
    let fact_rows_all = sqlx::query_as::<_, (
        Uuid, Option<Uuid>, String, String, String, String, Value, Option<String>,
        String, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>,
    )>(
        "SELECT id, compilation_id, relation, key_uri, key_name, key_side,
                tails, authority_winner, status, first_detected_at, last_evaluated_at
         FROM fact_conflicts
         WHERE user_id = $1 AND status = 'open'
         ORDER BY first_detected_at DESC LIMIT 1000",
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;
    let fact_rows: Vec<_> = fact_rows_all.into_iter().filter(|r| visible(r.1)).take(PAGE).collect();

    // Enrich tails with a READABLE source-document name. Each tail carries a
    // `sourceDoc` = source_documents.id; the raw card only showed a truncated uuid
    // ("doc 2be4cf5b"), which is undecidable. Resolve id → name so the user can see
    // WHICH document each competing value came from.
    let doc_ids: Vec<Uuid> = fact_rows.iter()
        .flat_map(|r| r.6.as_array().map(|a| a.as_slice()).unwrap_or(&[]))
        .filter_map(|t| t.get("sourceDoc").and_then(|v| v.as_str()).and_then(|s| Uuid::parse_str(s).ok()))
        .collect();
    let doc_names: std::collections::HashMap<Uuid, String> = if doc_ids.is_empty() {
        std::collections::HashMap::new()
    } else {
        sqlx::query_as::<_, (Uuid, Option<String>, String)>(
            "SELECT id, name, path FROM source_documents WHERE id = ANY($1) AND user_id = $2",
        )
        .bind(&doc_ids).bind(claims.sub)
        .fetch_all(&state.db).await.unwrap_or_default()
        .into_iter()
        .map(|(id, name, path)| {
            // Prefer a name; else the basename of the path; else nothing (UI falls back).
            let label = name.filter(|s| !s.is_empty())
                .unwrap_or_else(|| path.rsplit(['/', '\\']).next().unwrap_or(&path).to_string());
            (id, label)
        })
        .collect()
    };

    let fact_sigs: Vec<String> = fact_rows.iter().map(|r| memory::fact_signature(&r.2, &r.5)).collect();
    let fact_verdicts = memory::verdicts(&state.db, "fact", &fact_sigs).await;

    conflicts.extend(fact_rows.into_iter().zip(fact_sigs).map(
        |((id, cid, relation, key_uri, key_name, key_side, mut tails, winner,
          status, first_detected, last_evaluated), sig)| {
            if let Some(arr) = tails.as_array_mut() {
                for t in arr.iter_mut() {
                    let name = t.get("sourceDoc").and_then(|v| v.as_str())
                        .and_then(|s| Uuid::parse_str(s).ok())
                        .and_then(|id| doc_names.get(&id).cloned());
                    if let (Some(obj), Some(n)) = (t.as_object_mut(), name) {
                        obj.insert("sourceDocName".into(), json!(n));
                    }
                }
            }
            json!({
                "id": id, "kind": "fact",
                "compilationId": cid, "relation": relation,
                "keyUri": key_uri, "keyName": key_name, "keySide": key_side,
                "tails": tails, "authorityWinner": winner, "status": status,
                "createdAt": first_detected, "lastEvaluatedAt": last_evaluated,
                "history": memory::verdict_json(fact_verdicts.get(&sig)),
            })
        }
    ));

    Ok(Json(json!({ "conflicts": conflicts })))
}

/// POST /api/classification/conflicts/:id/suggest
/// Store and return a suggested resolution. The decision memory (migration
/// 086) is consulted first: when earlier conflicts with the same signature
/// were decided one way by a strict majority, that decision is the suggestion
/// (`source: "history"`, with `support` = decisions seen and `confidence` =
/// majority share); otherwise the resolver (LLM semantic check) answers
/// (`source: "llm"`, `confidence: null`).
async fn suggest_conflict(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_editor_or_admin(&state.db, claims.sub).await?;

    let row = sqlx::query_as::<_, (Uuid, Option<Uuid>, String, String, Value)>(
        "SELECT c.user_id, cc.compilation_id, cc.element_kind, cc.element_key, cc.labels
         FROM classification_conflicts cc
         JOIN compilations c ON c.id = cc.compilation_id
         WHERE cc.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;
    let (owner, comp_id, element_kind, element_key, labels) = row;
    conflict_access(&state.db, &claims, owner, comp_id).await?;

    use crate::services::conflict_memory as memory;
    let signature = memory::classification_signature(&element_kind, &labels);
    let verdict = memory::verdicts(&state.db, "classification", std::slice::from_ref(&signature))
        .await
        .remove(&signature);

    let (mut sjson, source, support, confidence) = match verdict.as_ref() {
        Some(v) if v.has_majority() && memory::is_generalizable(&v.chosen) => {
            let (action, rank) = match v.chosen.as_str() {
                "keep" => ("keep", None),
                "dismiss" => ("dismiss", None),
                c => ("remove_label", memory::remove_label_rank(c)),
            };
            let s = json!({
                "action": action,
                "rank": rank,
                "rationale": format!(
                    "Decision memory: {} of {} conflicts with the same labels were resolved this way.",
                    v.votes, v.support
                ),
                "matchScore": Value::Null,
            });
            (s, "history", v.support, Some(v.confidence))
        }
        _ => {
            // Readable element name: node key = "name_type_cid", edge key = "head|rel|tail|cid".
            let name = element_key.split(['_', '|']).next().unwrap_or(&element_key).to_string();
            let s = crate::services::classify_resolver::suggest_resolution(&name, &labels).await.to_json();
            (s, "llm", verdict.as_ref().map(|v| v.support).unwrap_or(0), None)
        }
    };
    if let Some(obj) = sjson.as_object_mut() {
        obj.insert("source".into(), json!(source));
    }

    sqlx::query("UPDATE classification_conflicts SET suggestion = $1 WHERE id = $2")
        .bind(&sjson).bind(id).execute(&state.db).await?;

    Ok(Json(json!({
        "suggestion": sjson,
        "source": source,
        "support": support,
        "confidence": confidence,
    })))
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

    let row = sqlx::query_as::<_, (Uuid, Option<Uuid>, String, String, Value)>(
        "SELECT c.user_id, cc.compilation_id, cc.element_kind, cc.element_key, cc.labels
         FROM classification_conflicts cc
         JOIN compilations c ON c.id = cc.compilation_id
         WHERE cc.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;
    let (owner, comp_id, kind, key, labels) = row;
    conflict_access(&state.db, &claims, owner, comp_id).await?;

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

    // Learning loop (migration 086): remember how this label combination was
    // decided, so the next conflict with the same signature gets it suggested
    // (and, once decided often enough, resolved automatically).
    use crate::services::conflict_memory as memory;
    if let Some(chosen) = memory::classification_choice(&req.action, req.rank) {
        let signature = memory::classification_signature(&kind, &labels);
        let level_names: Vec<String> = labels.as_array()
            .map(|a| a.iter().filter_map(|l| l.get("level_name").and_then(|v| v.as_str()).map(String::from)).collect())
            .unwrap_or_default();
        let features = json!({ "elementKind": kind, "levels": level_names, "rank": req.rank });
        memory::record(&state.db, "classification", &signature, &chosen, features, claims.sub, comp_id).await;
    }

    Ok(Json(json!({ "ok": true, "status": status })))
}

/// Drop the label of `rank` from a Neo4j node/edge, then recompute `_min_rank`
/// and `_class_conflict` from the remaining parallel label lists. Shared with
/// the decision memory's auto-resolution (services/conflict_memory.rs).
pub(crate) async fn remove_element_label(
    state: &crate::models::AppState,
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

// ─── Conflict visibility — pure rule tests ───────────────────────────────────

#[cfg(test)]
mod conflict_visibility_tests {
    use super::{conflict_visible, CompilationFacts, ConflictViewer};
    use std::collections::HashSet;
    use uuid::Uuid;

    fn viewer(rank: i32, capped: bool) -> ConflictViewer {
        ConflictViewer { rank, capped, code_access: true, scope: None }
    }
    fn comp(level_rank: Option<i32>) -> CompilationFacts {
        CompilationFacts { id: Uuid::new_v4(), level_rank, is_code: false, grant: None }
    }

    #[test]
    fn full_owner_session_sees_everything_including_untied_conflicts() {
        let v = viewer(100, false);
        assert!(conflict_visible(&v, None), "NULL-compilation fact conflict");
        assert!(conflict_visible(&v, Some(&comp(None))), "unclassified graph");
        assert!(conflict_visible(&v, Some(&comp(Some(100)))), "graph at own rank");
    }

    #[test]
    fn classified_graph_above_clearance_is_hidden() {
        let v = viewer(10, true);
        assert!(conflict_visible(&v, Some(&comp(Some(10)))));
        assert!(!conflict_visible(&v, Some(&comp(Some(11)))));
    }

    #[test]
    fn capped_token_never_sees_unclassified_or_untied_conflicts() {
        let v = viewer(50, true);
        assert!(!conflict_visible(&v, Some(&comp(None))), "owner-default content stays hidden");
        assert!(!conflict_visible(&v, None), "cannot prove the token may see it");
    }

    #[test]
    fn a_grant_raises_access_for_that_graph_only() {
        let v = viewer(0, true);
        let mut full = comp(Some(80));
        full.grant = Some(None);
        assert!(conflict_visible(&v, Some(&full)), "full grant opens a confidential graph");

        let mut partial = comp(Some(80));
        partial.grant = Some(Some(50));
        assert!(!conflict_visible(&v, Some(&partial)), "granted_rank below the level");
        partial.grant = Some(Some(80));
        assert!(conflict_visible(&v, Some(&partial)), "granted_rank reaches the level");

        let mut unclassified = comp(None);
        unclassified.grant = Some(Some(1));
        assert!(conflict_visible(&v, Some(&unclassified)), "any grant reaches an unclassified graph");

        assert!(!conflict_visible(&v, Some(&comp(Some(80)))), "no grant, no access");
        assert!(!conflict_visible(&v, None), "a grant never reaches an untied conflict");
    }

    #[test]
    fn kb_scoped_token_sees_only_its_set() {
        let inside = comp(None);
        let outside = comp(None);
        let mut v = viewer(100, false);
        v.scope = Some(HashSet::from([inside.id]));
        assert!(conflict_visible(&v, Some(&inside)));
        assert!(!conflict_visible(&v, Some(&outside)));
        assert!(!conflict_visible(&v, None), "scoped token: untied conflicts hidden");
        v.scope = Some(HashSet::new());
        assert!(!conflict_visible(&v, Some(&inside)), "empty scope sees nothing");
    }

    #[test]
    fn codebase_access_off_hides_code_graphs_and_untied_conflicts() {
        let mut v = viewer(100, false);
        v.code_access = false;
        let mut code = comp(None);
        code.is_code = true;
        assert!(!conflict_visible(&v, Some(&code)));
        assert!(conflict_visible(&v, Some(&comp(None))), "non-code graph unaffected");
        assert!(!conflict_visible(&v, None));
        // Even a full grant does not override the capability.
        code.grant = Some(None);
        assert!(!conflict_visible(&v, Some(&code)));
    }
}

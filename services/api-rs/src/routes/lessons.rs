//! Project lessons — what a team learned while working, kept warm only while it
//! keeps proving useful.
//!
//! A lesson is a short, self-contained procedure: a convention ("we name X like
//! Y"), a recipe ("to deploy, do A then B"), a pitfall ("after a schema change
//! the client must be regenerated, or login breaks") or a decision with its
//! reason. Anvil distils them from chat and terminal sessions and stores them in
//! the project's knowledge base; agents may also store one directly.
//!
//! Storage: one `text_chunks` row with `kind = 'lesson'` and the fields in
//! `meta` (migration 099), written by the KEX `note` job — embedded, searchable,
//! but WITHOUT entity extraction, so an unconfirmed lesson never reaches the
//! entity graph the wiki writes its pages from.
//!
//! Hot / cold: a lesson is a chunk, so it lives in the Hebbian layer every chunk
//! lives in (services/hebb.rs, background memory cycle): it starts cold, gains
//! heat when it is used — strongly when an agent reports it APPLIED it
//! (`POST /lessons/applied`, the Feedback signal), weakly when a search returns
//! it — decays when nobody needs it, is archived after a month without use and
//! revived when it is found again. Merely listing lessons (the playbook fetch)
//! is NOT use: otherwise the playbook would keep itself warm.
//!
//! Einstufung (08.10.2026): jede Lehre traegt die Freigabestufe ihrer Herkunft —
//! dieselbe Leiter wie ueberall in GCTRL (classification_levels, Rang 0/100/200/300
//! = PUBLIC/INTERNAL/CONFIDENTIAL/STRICTLY_CONFIDENTIAL). Gespeichert wird sie dort,
//! wo jeder Abschnitt seine Einstufung traegt: `text_chunks.min_rank` +
//! `classification_level_id` (Migration 033), gesetzt vom KEX-Note-Job aus dem
//! Payload. Ohne Angabe erbt die Lehre die Einstufung ihrer Wissensbasis; eine
//! Angabe darunter wird auf die Wissensbasis angehoben (nie herabgestuft). Eine
//! befoerderte Team-Lehre erbt die STRENGSTE Einstufung ihrer Quellen. Gelesen
//! wird nur, was `min_rank <= Freigabe` erfuellt — dieselbe Regel wie fuer jeden
//! Abschnitt (`effective_rank_for_compilation`, gesenkt durch `clearanceRank`).

use axum::{
    extract::{Extension, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
    services::redis::lpush,
};

pub const LESSON_TYPES: [&str; 4] = ["convention", "recipe", "pitfall", "decision"];
pub const LESSON_ORIGINS: [&str; 5] = ["chat", "terminal", "agent", "correction", "promotion"];
const MAX_TITLE: usize = 120;
const MAX_TEXT: usize = 800;
const MAX_EVIDENCE: usize = 300;

#[derive(Debug, Deserialize, Clone)]
pub struct StoreLessonReq {
    #[serde(rename = "compilationId")]
    pub compilation_id: Uuid,
    #[serde(rename = "lessonType")]
    pub lesson_type: String,
    pub title: String,
    pub text: String,
    pub evidence: Option<String>,
    #[serde(rename = "sourceRef")]
    pub source_ref: Option<String>,
    pub origin: Option<String>,
    /// Freigabestufe: Name aus classification_levels (PUBLIC, INTERNAL, CONFIDENTIAL,
    /// STRICTLY_CONFIDENTIAL, Alias RESTRICTED, oder eine eigene Stufe) bzw. deren
    /// UUID. Fehlt sie, erbt die Lehre die Stufe ihrer Wissensbasis.
    #[serde(default)]
    pub classification: Option<String>,
}

/// Die Einstufung einer Lehre: Rang + (wenn bekannt) die Stufe dazu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LessonClass {
    pub rank: i32,
    pub level_id: Option<Uuid>,
}

/// Feste IDs der vier System-Stufen (Migration 024).
pub fn system_level_id(rank: i32) -> Option<Uuid> {
    let n = match rank { 0 => 1, 100 => 2, 200 => 3, 300 => 4, _ => return None };
    Some(Uuid::from_u128(n))
}

/// System-Name eines Rangs (fuer Antworten, wenn die Stufe selbst unbekannt ist).
pub fn system_level_name(rank: i32) -> &'static str {
    match rank {
        r if r <= 0 => "PUBLIC",
        r if r <= 100 => "INTERNAL",
        r if r <= 200 => "CONFIDENTIAL",
        _ => "STRICTLY_CONFIDENTIAL",
    }
}

/// Rein: die wirksame Einstufung einer neuen Lehre. Die Wissensbasis ist der Boden —
/// eine Angabe darunter wird angehoben, eine strengere gewinnt. Vererbung = Maximum.
pub fn effective_lesson_class(kb: LessonClass, requested: Option<LessonClass>) -> LessonClass {
    match requested {
        Some(r) if r.rank > kb.rank => r,
        _ => kb,
    }
}

/// Rein: die Einstufung einer befoerderten Team-Lehre — die strengste ihrer Quellen,
/// mindestens die der Team-Wissensbasis. Eine Quelle ohne bekannte Einstufung zaehlt
/// als hoechste Stufe (fail-closed): nichts wird durch Befoerderung lesbarer.
pub fn promoted_lesson_class(sources: &[Option<LessonClass>], team_kb: LessonClass) -> LessonClass {
    let mut out = team_kb;
    for s in sources {
        let c = s.unwrap_or(LessonClass { rank: 300, level_id: system_level_id(300) });
        if c.rank > out.rank { out = c; }
    }
    out
}

/// Einstufung einer Wissensbasis: expliziter Level, sonst die Alt-Spalte (unbekannt =
/// hoechste Stufe, wie `kg::classification_rank_of`).
pub async fn kb_class(db: &sqlx::PgPool, cid: Uuid) -> Result<LessonClass> {
    let row: Option<(Option<i32>, Option<Uuid>, Option<String>)> = sqlx::query_as(
        "SELECT cl.rank, cl.id, c.classification::text FROM compilations c
           LEFT JOIN classification_levels cl ON cl.id = c.classification_level_id
          WHERE c.id = $1",
    ).bind(cid).fetch_optional(db).await?;
    let (lvl_rank, lvl_id, legacy) = row.ok_or(AppError::NotFound)?;
    let rank = crate::routes::kg::classification_rank_of(lvl_rank, legacy.as_deref().unwrap_or(""));
    Ok(LessonClass { rank, level_id: lvl_id.or_else(|| system_level_id(rank)) })
}

/// Rein: ein Stufenname in GCTRLs Schreibweise (`RESTRICTED` ist der Alt-Name von
/// STRICTLY_CONFIDENTIAL, Leer- und Bindestriche werden zu `_`).
pub fn normalize_class_name(raw: &str) -> String {
    let n = raw.trim().to_uppercase().replace([' ', '-'], "_");
    if n == "RESTRICTED" { "STRICTLY_CONFIDENTIAL".into() } else { n }
}

/// Eine angefragte Einstufung (Name oder UUID) aufloesen. Unbekannt = Fehler: still auf
/// die Wissensbasis zurueckzufallen hiesse, einen Tippfehler als "gilt" zu quittieren.
async fn resolve_requested_class(db: &sqlx::PgPool, user_id: Uuid, raw: &str) -> Result<LessonClass> {
    let raw = raw.trim();
    let row: Option<(Uuid, i32)> = if let Ok(id) = raw.parse::<Uuid>() {
        sqlx::query_as("SELECT id, rank FROM classification_levels WHERE id = $1 AND (user_id IS NULL OR user_id = $2)")
            .bind(id).bind(user_id).fetch_optional(db).await?
    } else {
        sqlx::query_as(
            "SELECT id, rank FROM classification_levels WHERE upper(name) = $1 AND (user_id IS NULL OR user_id = $2)
              ORDER BY (user_id IS NULL) ASC LIMIT 1",
        ).bind(normalize_class_name(raw)).bind(user_id).fetch_optional(db).await?
    };
    row.map(|(id, rank)| LessonClass { rank, level_id: Some(id) })
        .ok_or_else(|| AppError::BadRequest(format!("unknown classification '{raw}'")))
}

/// A validated lesson, trimmed to its limits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lesson {
    pub lesson_type: String,
    pub title: String,
    pub text: String,
    pub evidence: Option<String>,
    pub source_ref: Option<String>,
    pub origin: String,
}

fn clip(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max { t.to_string() } else { t.chars().take(max).collect() }
}

/// Pure: check and normalise a lesson request. Err = a message for the caller.
pub fn validate(req: &StoreLessonReq) -> std::result::Result<Lesson, String> {
    let lesson_type = req.lesson_type.trim().to_lowercase();
    if !LESSON_TYPES.contains(&lesson_type.as_str()) {
        return Err(format!("lessonType must be one of {}", LESSON_TYPES.join(", ")));
    }
    let title = clip(&req.title, MAX_TITLE);
    let text = clip(&req.text, MAX_TEXT);
    if title.len() < 3 {
        return Err("title is required".into());
    }
    if text.len() < 10 {
        return Err("text is too short (min 10 chars)".into());
    }
    let origin = req.origin.as_deref().map(|o| o.trim().to_lowercase()).unwrap_or_else(|| "agent".into());
    let origin = if LESSON_ORIGINS.contains(&origin.as_str()) { origin } else { "agent".into() };
    let evidence = req.evidence.as_deref().map(|e| clip(e, MAX_EVIDENCE)).filter(|e| !e.is_empty());
    let source_ref = req.source_ref.as_deref().map(|s| clip(s, 300)).filter(|s| !s.is_empty());
    Ok(Lesson { lesson_type, title, text, evidence, source_ref, origin })
}

/// The `meta` a lesson chunk carries (and the KEX note job receives).
pub fn lesson_meta(lesson: &Lesson, compilation_id: Uuid) -> Value {
    json!({
        "lessonType": lesson.lesson_type,
        "title": lesson.title,
        "text": lesson.text,
        "evidence": lesson.evidence,
        "sourceRef": lesson.source_ref,
        "origin": lesson.origin,
        "compilationId": compilation_id,
    })
}

/// The caller may read lessons of this compilation: it is the caller's own, and a
/// KB-scoped token must hold it in its scope.
async fn ensure_readable(state: &crate::models::AppState, claims: &JwtClaims, cid: Uuid) -> Result<()> {
    let owned: Option<i32> = sqlx::query_scalar("SELECT 1 FROM compilations WHERE id = $1 AND user_id = $2")
        .bind(cid).bind(claims.sub).fetch_optional(&state.db).await?;
    if owned.is_none() {
        return Err(AppError::NotFound);
    }
    if let Some(scope) = crate::routes::kg::api_key_scope(&state.db, claims).await {
        if !scope.contains(&cid) {
            return Err(AppError::Forbidden("This access token is not scoped to that knowledge base".into()));
        }
    }
    Ok(())
}

/// Store one lesson (or report the identical one that already exists).
pub async fn store_lesson_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    req: &StoreLessonReq,
) -> Result<Value> {
    let lesson = validate(req).map_err(AppError::BadRequest)?;
    let cid = req.compilation_id;
    ensure_readable(state, claims, cid).await?;
    crate::routes::kg::enforce_kb_write_scope(&state.db, claims, cid).await?;
    crate::routes::kg::enforce_code_capability(&state.db, claims, cid).await?;

    // Einstufung: geerbt von der Wissensbasis, eine strengere Angabe gewinnt.
    let kb = kb_class(&state.db, cid).await?;
    let requested = match req.classification.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(resolve_requested_class(&state.db, claims.sub, raw).await?),
        None => None,
    };
    let class = effective_lesson_class(kb, requested);

    // The same lesson twice in one knowledge base is one lesson — stored or still on its way.
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT c.id FROM text_chunks c JOIN compilations k ON c.job_id = ANY(k.source_job_ids)
          WHERE k.id = $1 AND c.user_id = $2 AND c.kind = 'lesson' AND NOT c.archived
            AND c.meta->>'lessonType' = $3 AND c.meta->>'text' = $4
            AND COALESCE(c.min_rank, 0) >= $5
          LIMIT 1",
    )
    .bind(cid).bind(claims.sub).bind(&lesson.lesson_type).bind(&lesson.text).bind(class.rank)
    .fetch_optional(&state.db).await?;
    // Nur eine mindestens so streng eingestufte Zwillingslehre zaehlt als "gibt es schon";
    // eine laxere bleibt, wie sie ist, und die strengere wird zusaetzlich gespeichert.
    if let Some(id) = existing {
        return Ok(json!({ "lessonId": id, "jobId": Value::Null, "status": "exists" }));
    }
    let pending: Option<Uuid> = sqlx::query_scalar(
        "SELECT j.id FROM jobs j JOIN compilations k ON j.id = ANY(k.source_job_ids)
          WHERE k.id = $1 AND j.user_id = $2 AND j.type = 'kex_lesson'
            AND j.status::text IN ('pending', 'processing')
            AND j.input->>'lessonType' = $3 AND j.input->>'text' = $4
            AND COALESCE((j.input->>'classificationRank')::int, 0) >= $5
          LIMIT 1",
    )
    .bind(cid).bind(claims.sub).bind(&lesson.lesson_type).bind(&lesson.text).bind(class.rank)
    .fetch_optional(&state.db).await?;
    if let Some(job) = pending {
        return Ok(json!({ "lessonId": Value::Null, "jobId": job, "status": "exists" }));
    }

    let mut meta = lesson_meta(&lesson, cid);
    set_meta_class(&mut meta, class);
    let job_id = enqueue_lesson(state, claims.sub, claims.api_key_id, cid, meta, class).await?;
    Ok(json!({
        "lessonId": Value::Null, "jobId": job_id, "status": "pending",
        "classification": system_level_name(class.rank), "classificationRank": class.rank,
    }))
}

/// Die Einstufung in die Lehre selbst schreiben (Job-Input und Chunk-Meta): fuer die
/// Dubletten-Pruefung, solange der Job noch laeuft, und als lesbare Angabe.
pub fn set_meta_class(meta: &mut Value, class: LessonClass) {
    if !meta.is_object() { *meta = json!({}); }
    meta["classification"] = json!(system_level_name(class.rank));
    meta["classificationRank"] = json!(class.rank);
}

/// Queue the KEX note job that writes one lesson chunk into `cid`. No access
/// checks: callers (the HTTP/agent core above, the promotion cycle) have done them.
/// `class` reist als `classification_level_id` an KEX, das daraus `min_rank` des
/// Abschnitts (Postgres + Qdrant) setzt — derselbe Weg wie bei jedem Ingest.
pub async fn enqueue_lesson(
    state: &crate::models::AppState,
    user_id: Uuid,
    api_key_id: Option<Uuid>,
    cid: Uuid,
    meta: Value,
    class: LessonClass,
) -> Result<Uuid> {
    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, user_id, type, status, input, api_key_id, classification_level_id)
         VALUES ($1, $2, 'kex_lesson', 'pending', $3, $4, $5)",
    )
    .bind(job_id).bind(user_id).bind(&meta).bind(api_key_id).bind(class.level_id)
    .execute(&state.db).await?;
    crate::routes::kex::link_job_to_compilation(&state.db, user_id, cid, job_id).await;
    crate::services::usage::record_usage(&state.db, user_id, "kex_lesson", 1, Some(job_id)).await;

    let mut payload = json!({
        "job_id": job_id, "user_id": user_id, "type": "note",
        "kind": "lesson", "meta": meta,
        // KEX loest bevorzugt die UUID auf; der Name ist die Rueckfallebene (nur System-Stufen).
        "classification_level_id": class.level_id,
        "classification": system_level_name(class.rank),
    });
    crate::services::llm::inject_ollama_overrides(&state.db, user_id, &mut payload).await;
    lpush(&state.redis, "kex:jobs", &payload.to_string()).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(job_id)
}

// ── Team lessons: promotion of lessons proven in several projects ─────────────

/// Name of the account's team-lessons knowledge base (folder `Global/Lessons`).
pub const TEAM_LESSONS_KB: &str = "Team-Lehren";
/// Heat a promoted lesson starts with: it is proven already, just elsewhere.
pub const PROMOTED_SEED_HEAT: f64 = 5.0;

/// The account's team-lessons knowledge base; created on first use when `create`.
pub async fn team_lessons_kb(db: &sqlx::PgPool, user_id: Uuid, create: bool) -> Option<Uuid> {
    let folder_id = if create {
        crate::routes::kg::ensure_folder_path(db, user_id, &["Global", "Lessons"]).await
            .map_err(|e| tracing::warn!(?e, %user_id, "ensure_folder_path(Global/Lessons) failed")).ok()?
    } else {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT f.id FROM kg_folders f JOIN kg_folders g ON g.id = f.parent_folder_id
              WHERE f.user_id = $1 AND f.name = 'Lessons' AND g.name = 'Global' AND g.parent_folder_id IS NULL
              LIMIT 1",
        ).bind(user_id).fetch_optional(db).await.ok().flatten()?
    };
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM compilations WHERE user_id = $1 AND folder_id = $2 AND name = $3
          ORDER BY created_at ASC LIMIT 1",
    ).bind(user_id).bind(folder_id).bind(TEAM_LESSONS_KB).fetch_optional(db).await.ok().flatten() {
        return Some(id);
    }
    if !create {
        return None;
    }
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO compilations (id, user_id, name, description, classification, folder_id)
         VALUES ($1, $2, $3, 'Lehren, die sich in mehreren Projekten bewährt haben — automatisch befördert', 'INTERNAL', $4)",
    ).bind(id).bind(user_id).bind(TEAM_LESSONS_KB).bind(folder_id)
     .execute(db).await
     .map_err(|e| tracing::warn!(?e, %user_id, "creating the team-lessons KB failed")).ok()?;
    Some(id)
}

/// Pure: the meta of the promoted copy of a recurring lesson.
pub fn promoted_meta(source: &Value, lesson_ids: &[String], compilation_ids: &[String], team_kb: Uuid) -> Value {
    let mut m = source.clone();
    if !m.is_object() { m = json!({}); }
    m["origin"] = json!("promotion");
    m["promotedFrom"] = json!(lesson_ids);
    m["promotedFromCompilations"] = json!(compilation_ids);
    m["compilationId"] = json!(team_kb);
    m["seedHeat"] = json!(PROMOTED_SEED_HEAT);
    m["evidence"] = json!(format!("bewährt in {} Projekten", compilation_ids.len()));
    m
}

fn str_list(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// One promotion pass for every account that has hot lessons: ask KEX which of
/// them recur across projects, and store each cluster once in the team-lessons
/// KB. Best-effort; returns how many were promoted.
pub async fn promote_recurring_lessons(state: &crate::models::AppState) -> usize {
    let users: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT user_id FROM text_chunks WHERE kind = 'lesson' AND NOT archived AND heat >= 5.0",
    ).fetch_all(&state.db).await.unwrap_or_default();
    let http = reqwest::Client::new();
    let mut promoted = 0usize;
    for uid in users {
        let url = format!("{}/lessons/recurring", state.cfg.kex_worker_url);
        let resp = http.post(&url).json(&json!({ "user_id": uid }))
            .timeout(std::time::Duration::from_secs(60)).send().await;
        let groups = match resp {
            Ok(r) if r.status().is_success() => r.json::<Value>().await.ok()
                .and_then(|v| v.get("groups").and_then(|g| g.as_array()).cloned()).unwrap_or_default(),
            _ => continue,
        };
        if groups.is_empty() { continue; }
        let Some(team_kb) = team_lessons_kb(&state.db, uid, true).await else { continue };
        for g in groups {
            let ids = str_list(&g["lessonIds"]);
            let comps = str_list(&g["compilationIds"]);
            if ids.is_empty() { continue; }
            // Once per cluster: a team lesson (stored or queued) naming any of these sources stands.
            let already: Option<i32> = sqlx::query_scalar(
                "SELECT 1 FROM text_chunks WHERE user_id = $1 AND kind = 'lesson'
                   AND meta ? 'promotedFrom' AND (meta->'promotedFrom') ?| $2::text[]
                 UNION ALL
                 SELECT 1 FROM jobs WHERE user_id = $1 AND type = 'kex_lesson'
                   AND status::text IN ('pending', 'processing')
                   AND input ? 'promotedFrom' AND (input->'promotedFrom') ?| $2::text[]
                 LIMIT 1",
            ).bind(uid).bind(&ids).fetch_optional(&state.db).await.ok().flatten();
            if already.is_some() { continue; }
            // Strengste Quelle gewinnt: eine Lehre aus einem streng vertraulichen Projekt
            // wird als Team-Lehre nicht lesbarer, als sie im Projekt war.
            let Ok(team_class) = kb_class(&state.db, team_kb).await else { continue };
            let src_rows: Vec<(Uuid, Option<i32>, Option<Uuid>)> = sqlx::query_as(
                "SELECT id, min_rank, classification_level_id FROM text_chunks
                  WHERE user_id = $1 AND id::text = ANY($2)",
            ).bind(uid).bind(&ids).fetch_all(&state.db).await.unwrap_or_default();
            let sources: Vec<Option<LessonClass>> = ids.iter().map(|id| {
                src_rows.iter().find(|(cid, _, _)| cid.to_string() == *id)
                    .map(|(_, r, l)| LessonClass { rank: r.unwrap_or(0), level_id: *l })
            }).collect();
            let class = promoted_lesson_class(&sources, team_class);
            let mut meta = promoted_meta(&g["meta"], &ids, &comps, team_kb);
            set_meta_class(&mut meta, class);
            if enqueue_lesson(state, uid, None, team_kb, meta, class).await.is_ok() {
                promoted += 1;
                tracing::info!("lessons: a lesson proven in {} projects became team knowledge (user {uid})", comps.len());
            }
        }
    }
    promoted
}

#[derive(Debug, Deserialize)]
pub struct ListLessonsQuery {
    #[serde(rename = "compilationId")]
    pub compilation_id: Uuid,
    pub limit: Option<i64>,
    #[serde(rename = "includeArchived", default)]
    pub include_archived: bool,
    /// Stellvertreter-Freigabe (System-/Kontoschluessel liest fuer einen Nutzer): nur senken.
    #[serde(rename = "clearanceRank", default)]
    pub clearance_rank: Option<i32>,
}

/// Lessons of one knowledge base, hottest first. Listing is not use: no heat changes.
pub async fn list_lessons_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    q: &ListLessonsQuery,
) -> Result<Value> {
    let lowered;
    let claims = match q.clearance_rank {
        Some(r) => { lowered = claims.lowered_to(r); &lowered }
        None => claims,
    };
    ensure_readable(state, claims, q.compilation_id).await?;
    // Dieselbe Freigabe wie fuer jeden Abschnitt dieser Wissensbasis (ein Grant hebt, die
    // Stellvertreter-Freigabe senkt). Was darueber liegt, existiert fuer den Aufrufer nicht.
    let rank = crate::routes::kg::effective_rank_for_compilation(&state.db, claims, q.compilation_id).await;
    let limit = q.limit.unwrap_or(40).clamp(1, 200);
    let rows = sqlx::query_as::<_, (Uuid, Option<Value>, Option<f32>, Option<i32>,
        Option<chrono::DateTime<chrono::Utc>>, chrono::DateTime<chrono::Utc>, bool, i32, Option<String>)>(
        "SELECT c.id, c.meta, c.heat, c.access_count, c.last_accessed, c.created_at, c.archived,
                COALESCE(c.min_rank, 0), cl.name::text
           FROM text_chunks c JOIN compilations k ON c.job_id = ANY(k.source_job_ids)
           LEFT JOIN classification_levels cl ON cl.id = c.classification_level_id
          WHERE k.id = $1 AND c.user_id = $2 AND c.kind = 'lesson'
            AND ($3 OR NOT c.archived)
            AND coalesce(c.archived_reason, '') NOT IN ('superseded', 'dedup')
            AND COALESCE(c.min_rank, 0) <= $5
          ORDER BY c.heat DESC NULLS LAST, c.created_at DESC
          LIMIT $4",
    )
    .bind(q.compilation_id).bind(claims.sub).bind(q.include_archived).bind(limit).bind(rank)
    .fetch_all(&state.db).await?;
    let lessons: Vec<Value> = rows.into_iter().map(|(id, meta, heat, access, last, created, archived, min_rank, level)| {
        let m = meta.unwrap_or_else(|| json!({}));
        json!({
            "classification": level.unwrap_or_else(|| system_level_name(min_rank).to_string()),
            "classificationRank": min_rank,
            "id": id,
            "lessonType": m.get("lessonType"),
            "title": m.get("title"),
            "text": m.get("text"),
            "evidence": m.get("evidence"),
            "origin": m.get("origin"),
            // Herkunft (Anvil: `anvil:automation:<id>…`) — der Client entscheidet damit, ob eine
            // Lehre aus DIESEM Kontext stammt.
            "sourceRef": m.get("sourceRef"),
            "promotedFrom": m.get("promotedFrom"),
            "appliedCount": m.get("appliedCount").and_then(|v| v.as_i64()).unwrap_or(0),
            "lastApplied": m.get("lastApplied"),
            "heat": heat.unwrap_or(0.0),
            "accessCount": access.unwrap_or(0),
            "lastAccessed": last,
            "createdAt": created,
            "archived": archived,
        })
    }).collect();
    Ok(json!({ "lessons": lessons }))
}

#[derive(Debug, Deserialize)]
pub struct AppliedReq {
    #[serde(rename = "lessonIds")]
    pub lesson_ids: Vec<Uuid>,
    /// Stellvertreter-Freigabe (System-/Kontoschluessel meldet fuer einen Nutzer): nur senken.
    #[serde(rename = "clearanceRank", default)]
    pub clearance_rank: Option<i32>,
}

/// The agent applied these lessons: the strongest use signal there is. Only the
/// caller's own lesson chunks count (and, for a scoped token, only those inside
/// its knowledge bases); anything else is silently ignored.
pub async fn applied_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    req: &AppliedReq,
) -> Result<Value> {
    let lowered;
    let claims = match req.clearance_rank {
        Some(r) => { lowered = claims.lowered_to(r); &lowered }
        None => claims,
    };
    let mut ids = req.lesson_ids.clone();
    ids.sort();
    ids.dedup();
    ids.truncate(50);
    if ids.is_empty() {
        return Ok(json!({ "reinforced": 0 }));
    }
    let scope: Option<Vec<Uuid>> = crate::routes::kg::api_key_scope(&state.db, claims).await
        .map(|s| s.into_iter().collect());
    // Je Lehre die Wissensbasen, in denen sie liegt (im Scope des Tokens), samt Einstufung.
    let rows: Vec<(Uuid, i32, Uuid)> = sqlx::query_as(
        "SELECT c.id, COALESCE(c.min_rank, 0), k.id FROM text_chunks c
           JOIN compilations k ON c.job_id = ANY(k.source_job_ids) AND k.user_id = c.user_id
          WHERE c.id = ANY($1) AND c.user_id = $2 AND c.kind = 'lesson'
            AND coalesce(c.archived_reason, '') NOT IN ('superseded', 'dedup')
            AND ($3::uuid[] IS NULL OR k.id = ANY($3))",
    )
    .bind(&ids).bind(claims.sub).bind(scope.as_deref())
    .fetch_all(&state.db).await?;
    // Nur was der Aufrufer auch LESEN darf, zaehlt als angewendet — sonst liesse sich die
    // Existenz einer hoeher eingestuften Lehre ueber "reinforced" erfragen.
    let mut ranks: std::collections::HashMap<Uuid, i32> = std::collections::HashMap::new();
    let mut valid: Vec<Uuid> = Vec::new();
    for (id, min_rank, kid) in rows {
        if valid.contains(&id) { continue; }
        let eff = match ranks.get(&kid) {
            Some(r) => *r,
            None => {
                let r = crate::routes::kg::effective_rank_for_compilation(&state.db, claims, kid).await;
                ranks.insert(kid, r);
                r
            }
        };
        if lesson_visible(min_rank, eff) { valid.push(id); }
    }
    // Same strength for each: being applied is not a ranking.
    for id in &valid {
        crate::services::hebb::reinforce_chunks(&state.db, claims.sub, &[*id],
            crate::services::hebb::Signal::Feedback).await;
    }
    // Count it on the lesson itself: heat decays, the count is the record of how
    // often a lesson actually helped (measurement, playbook evidence).
    if !valid.is_empty() {
        let _ = sqlx::query(
            "UPDATE text_chunks
                SET meta = coalesce(meta, '{}'::jsonb)
                         || jsonb_build_object('appliedCount', coalesce((meta->>'appliedCount')::int, 0) + 1,
                                               'lastApplied', to_jsonb(NOW()))
              WHERE id = ANY($1)",
        ).bind(&valid).execute(&state.db).await
         .map_err(|e| tracing::warn!("lessons: applied count not recorded: {e}"));
    }
    Ok(json!({ "reinforced": valid.len() }))
}

/// Rein: die Leseregel einer Lehre — dieselbe wie fuer jeden Abschnitt.
pub fn lesson_visible(min_rank: i32, clearance: i32) -> bool {
    min_rank <= clearance
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

pub async fn store_lesson(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<StoreLessonReq>,
) -> Result<Json<Value>> {
    store_lesson_core(&state, &claims, &req).await.map(Json)
}

pub async fn list_lessons(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<ListLessonsQuery>,
) -> Result<Json<Value>> {
    list_lessons_core(&state, &claims, &q).await.map(Json)
}

/// GET /api/kex/lessons/team — the account's team-lessons knowledge base, or
/// null while no lesson has been promoted yet. Read it with GET /lessons.
pub async fn team_kb(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let id = team_lessons_kb(&state.db, claims.sub, false).await;
    // A scoped token only learns the id when the team KB is inside its scope.
    let visible = match (id, crate::routes::kg::api_key_scope(&state.db, &claims).await) {
        (Some(i), Some(scope)) => scope.contains(&i).then_some(i),
        (other, None) => other,
        (None, Some(_)) => None,
    };
    Ok(Json(json!({ "compilationId": visible })))
}

pub async fn lessons_applied(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<AppliedReq>,
) -> Result<Json<Value>> {
    applied_core(&state, &claims, &req).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(t: &str, title: &str, text: &str) -> StoreLessonReq {
        StoreLessonReq {
            compilation_id: Uuid::nil(), lesson_type: t.into(), title: title.into(), text: text.into(),
            evidence: Some("  Test wurde gruen  ".into()), source_ref: None, origin: Some("Terminal".into()),
            classification: None,
        }
    }

    fn class(rank: i32) -> LessonClass {
        LessonClass { rank, level_id: system_level_id(rank) }
    }

    #[test]
    fn ohne_angabe_erbt_die_lehre_die_stufe_der_wissensbasis() {
        assert_eq!(effective_lesson_class(class(300), None), class(300), "streng vertrauliches Projekt");
        assert_eq!(effective_lesson_class(class(100), None), class(100));
    }

    #[test]
    fn eine_strengere_angabe_gewinnt_eine_laxere_nie() {
        assert_eq!(effective_lesson_class(class(100), Some(class(300))), class(300), "Ordner strenger als Projekt");
        assert_eq!(effective_lesson_class(class(200), Some(class(0))), class(200), "nie unter die Wissensbasis");
        assert_eq!(effective_lesson_class(class(200), Some(class(200))), class(200));
    }

    #[test]
    fn eine_befoerderte_lehre_erbt_die_strengste_quelle() {
        let team = class(100);
        assert_eq!(promoted_lesson_class(&[Some(class(100)), Some(class(300)), Some(class(200))], team), class(300));
        assert_eq!(promoted_lesson_class(&[Some(class(0)), Some(class(0))], team), team, "nie unter die Team-KB");
        assert_eq!(promoted_lesson_class(&[Some(class(100)), None], team).rank, 300, "unbekannte Quelle = hoechste Stufe");
    }

    #[test]
    fn leseregel_wer_die_freigabe_hat_sieht_wer_nicht_nicht() {
        assert!(lesson_visible(300, 300));
        assert!(lesson_visible(100, 200));
        assert!(!lesson_visible(300, 100), "Mitglied mit INTERNAL sieht keine streng vertrauliche Lehre");
        assert!(!lesson_visible(0, i32::MIN), "ausserhalb des Scopes sieht man nichts");
    }

    /// Die Leseregel steckt in SQL (nicht unit-testbar ohne DB) — hier festgenagelt, dass
    /// Liste und "angewendet" sie anwenden und die Stellvertreter-Freigabe einfliesst.
    #[test]
    fn lesestellen_filtern_nach_einstufung() {
        let src = include_str!("lessons.rs");
        let list = &src[src.find("pub async fn list_lessons_core").unwrap()..src.find("pub struct AppliedReq").unwrap()];
        assert!(list.contains("lowered_to(r)"), "clearanceRank wird angewendet");
        assert!(list.contains("effective_rank_for_compilation"), "dieselbe Freigabe wie fuer Abschnitte");
        assert!(list.contains("AND COALESCE(c.min_rank, 0) <= $5"), "Liste filtert nach Rang");
        let applied = &src[src.find("pub async fn applied_core").unwrap()..src.find("// ── HTTP").unwrap()];
        assert!(applied.contains("lowered_to(r)") && applied.contains("lesson_visible(min_rank, eff)"));
        let store = &src[src.find("pub async fn store_lesson_core").unwrap()..src.find("pub fn set_meta_class").unwrap()];
        assert!(store.contains("effective_lesson_class(kb, requested)"));
        assert!(store.contains("enqueue_lesson(state, claims.sub, claims.api_key_id, cid, meta, class)"));
        let promote = &src[src.find("pub async fn promote_recurring_lessons").unwrap()..src.find("pub struct ListLessonsQuery").unwrap()];
        assert!(promote.contains("promoted_lesson_class(&sources, team_class)"));
    }

    #[test]
    fn stufen_namen_und_ids() {
        assert_eq!(normalize_class_name(" restricted "), "STRICTLY_CONFIDENTIAL");
        assert_eq!(normalize_class_name("strictly-confidential"), "STRICTLY_CONFIDENTIAL");
        assert_eq!(normalize_class_name("Internal"), "INTERNAL");
        assert_eq!(system_level_id(300).unwrap().to_string(), "00000000-0000-0000-0000-000000000004");
        assert_eq!(system_level_id(150), None);
        assert_eq!(system_level_name(150), "CONFIDENTIAL");
        let mut m = json!({ "title": "x" });
        set_meta_class(&mut m, class(200));
        assert_eq!(m["classification"], "CONFIDENTIAL");
        assert_eq!(m["classificationRank"], 200);
    }

    #[test]
    fn a_valid_lesson_is_normalised() {
        let l = validate(&req(" Pitfall ", " Prisma neu generieren ", "Nach jeder Schemaaenderung generieren.")).unwrap();
        assert_eq!(l.lesson_type, "pitfall");
        assert_eq!(l.title, "Prisma neu generieren");
        assert_eq!(l.evidence.as_deref(), Some("Test wurde gruen"));
        assert_eq!(l.origin, "terminal");
    }

    #[test]
    fn unknown_types_short_texts_and_missing_titles_are_refused() {
        assert!(validate(&req("fact", "Titel", "Ein langer genug Text.")).is_err());
        assert!(validate(&req("recipe", "Titel", "kurz")).is_err());
        assert!(validate(&req("recipe", "", "Ein langer genug Text.")).is_err());
    }

    #[test]
    fn long_fields_are_clipped_and_unknown_origins_become_agent() {
        let mut r = req("recipe", &"t".repeat(300), &"x".repeat(2000));
        r.origin = Some("somewhere".into());
        let l = validate(&r).unwrap();
        assert_eq!(l.title.chars().count(), MAX_TITLE);
        assert_eq!(l.text.chars().count(), MAX_TEXT);
        assert_eq!(l.origin, "agent");
    }

    #[test]
    fn a_promoted_copy_names_its_sources_and_starts_warm() {
        let src = json!({ "lessonType": "pitfall", "title": "Prisma", "text": "Generieren.", "origin": "terminal" });
        let m = promoted_meta(&src, &["a".into(), "b".into(), "c".into()],
                              &["p1".into(), "p2".into(), "p3".into()], Uuid::nil());
        assert_eq!(m["origin"], "promotion");
        assert_eq!(m["promotedFrom"], json!(["a", "b", "c"]));
        assert_eq!(m["seedHeat"], json!(PROMOTED_SEED_HEAT));
        assert_eq!(m["evidence"], "bewährt in 3 Projekten");
        assert_eq!(m["title"], "Prisma");
    }

    #[test]
    fn the_meta_carries_everything_the_playbook_shows() {
        let l = validate(&req("convention", "Ordnernamen englisch", "Ordner im Baum bleiben englisch.")).unwrap();
        let m = lesson_meta(&l, Uuid::nil());
        for key in ["lessonType", "title", "text", "evidence", "origin", "compilationId"] {
            assert!(m.get(key).is_some(), "{key}");
        }
    }
}

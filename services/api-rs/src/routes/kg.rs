use axum::{extract::{Extension, Path, Query, State}, routing::{get, post, put}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::Arc;
use uuid::Uuid;
use neo4rs::{query as neo_query, Node, Relation};
use crate::{error::{AppError, Result}, middleware::auth::JwtClaims};

/// Validate a Neo4j node label to prevent Cypher injection.
/// A valid label must start with an ASCII letter and contain only
/// ASCII letters, digits, or underscores.
fn is_valid_neo4j_label(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        None    => false,
        Some(c) => c.is_ascii_alphabetic() && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'),
    }
}

/// Fetch the effective clearance_rank for this request.
/// Takes the user's DB rank and caps it at api_key_rank when an API key was used.
pub(crate) async fn get_user_clearance_rank(db: &sqlx::PgPool, claims: &JwtClaims) -> i32 {
    // Per-session agent override wins (the chat handler already validated it: admin
    // → full access; non-admin → capped to their stored rank). It's `#[serde(skip)]`
    // so it can only be set in-process, never via a token.
    if let Some(o) = claims.agent_override_rank {
        return o;
    }
    let db_rank = sqlx::query_scalar::<_, i32>("SELECT COALESCE(clearance_rank, 100) FROM users WHERE id = $1")
        .bind(claims.sub)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or(100);
    match claims.api_key_rank {
        Some(key_rank) => db_rank.min(key_rank),
        None => db_rank,
    }
}

/// KB-scope of the current request.
///
/// Returns `Some(set)` of the granted compilation ids when the request used a
/// **KB-scoped** access token (`api_keys.kb_scoped = true`) — such a token may
/// only ever read/write compilations in that set, regardless of base clearance.
/// Returns `None` for JWT auth and for unscoped tokens (full owner access; grants
/// merely raise clearance). The set may be empty (a scoped token with no grants
/// can see nothing).
pub(crate) async fn api_key_scope(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
) -> Option<std::collections::HashSet<Uuid>> {
    let key_id = claims.api_key_id?;
    let scoped: Option<bool> = sqlx::query_scalar(
        "SELECT kb_scoped FROM api_keys WHERE id = $1"
    ).bind(key_id).fetch_optional(db).await.ok().flatten();
    if scoped != Some(true) { return None; }
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT compilation_id FROM api_key_grants WHERE api_key_id = $1"
    ).bind(key_id).fetch_all(db).await.unwrap_or_default();
    Some(rows.into_iter().map(|(c,)| c).collect())
}

/// Write-scope guard: a KB-scoped token may only WRITE into a compilation in its
/// grant set. JWT callers and unscoped tokens pass through (ownership is enforced
/// at the SQL/tool layer as before). Returns Forbidden when a scoped token targets
/// a compilation outside its assigned knowledge base(s).
pub(crate) async fn enforce_kb_write_scope(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
    compilation_id: Uuid,
) -> Result<()> {
    if let Some(set) = api_key_scope(db, claims).await {
        if !set.contains(&compilation_id) {
            return Err(AppError::Forbidden(
                "This access token is not scoped to that knowledge base".into(),
            ));
        }
    }
    Ok(())
}

/// Effective clearance rank for reading a specific compilation.
///
/// Starts from the request's base clearance (already capped by any API-key rank)
/// and RAISES it when the access token used carries an explicit per-graph grant
/// for this compilation: a grant with NULL `granted_rank` gives full access to
/// that graph (`i32::MAX`); otherwise it raises the cap to `granted_rank`. This
/// is how a PUBLIC-clearance agent token can be allowed into one specific
/// confidential graph without widening its access anywhere else.
///
/// A KB-scoped token that targets a compilation OUTSIDE its grant set is DENIED
/// outright (returns `i32::MIN`), so even PUBLIC content there stays invisible.
pub(crate) async fn effective_rank_for_compilation(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
    compilation_id: Uuid,
) -> i32 {
    // KB-scoped tokens: deny anything outside the assigned knowledge base(s).
    if let Some(set) = api_key_scope(db, claims).await {
        if !set.contains(&compilation_id) { return i32::MIN; }
    }
    let base = get_user_clearance_rank(db, claims).await;
    let Some(key_id) = claims.api_key_id else { return base; };
    let grant: Option<(Option<i32>,)> = sqlx::query_as(
        "SELECT granted_rank FROM api_key_grants WHERE api_key_id = $1 AND compilation_id = $2"
    ).bind(key_id).bind(compilation_id).fetch_optional(db).await.ok().flatten();
    match grant {
        Some((Some(r),)) => base.max(r),
        Some((None,))    => i32::MAX,
        None             => base,
    }
}

#[derive(Deserialize)]
struct CreateComp {
    name: String,
    description: Option<String>,
    classification: Option<String>,
    #[serde(rename = "sourceJobIds")] source_job_ids: Option<Vec<Uuid>>,
    /// "RAW" (default) or "WIKI". RAW = graph compilation; WIKI = distilled
    /// human-readable view over a single RAW source compilation.
    #[serde(rename = "type")] comp_type: Option<String>,
    /// Required when `type == "WIKI"`: the RAW compilation this wiki distils from.
    #[serde(rename = "wikiSourceCompilationId")] wiki_source_compilation_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct ListQuery { limit: Option<i64>, offset: Option<i64> }

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/compilations",                         get(list).post(create))
        .route("/compilations/:id",                     get(get_one).put(update).delete(delete_one))
        .route("/compilations/:id/refresh",             post(refresh))
        .route("/compilations/:id/distill",             post(distill))
        .route("/compilations/:id/communities",         post(communities))
        .route("/compilations/:id/wiki",                get(list_wiki_pages))
        .route("/compilations/:id/wiki/sources",        get(get_wiki_sources).put(set_wiki_sources))
        .route("/compilations/:id/wiki-graph",          get(wiki_graph))
        .route("/compilations/:id/wiki/:slug",          get(get_wiki_page))
        .route("/compilations/:id/schedule",            put(set_schedule))
        .route("/compilations/:id/audit",               get(get_audit))
        .route("/compilations/:id/acl",                 get(get_acl).put(set_acl))
        .route("/compilations/:id/graph",               get(get_graph))
        .route("/compilations/:id/export",              get(export_compilation))
        .route("/compilations/:id/entity/:name",        get(entity_detail))
        .route("/dossier",                              get(get_dossier))
        .route("/dossier/pin",                          post(pin_dossier))
        .route("/relationship",                         post(add_relationship).delete(delete_relationship))
        .route("/node",                                 axum::routing::delete(delete_node))
        .route("/corrections",                          get(list_corrections))
        .route("/graph/search",                         get(graph_search))
        .route("/graph/entity/:name/neighbors",         get(entity_neighbors))
        .route("/graph/entity/:name/lineage",           get(entity_lineage))
        .route("/compilations/:id/lineage",             get(get_compilation_lineage))
        .route("/folders",                              get(list_folders).post(create_folder))
        .route("/folders/:id",                          put(update_folder).delete(delete_folder))
        .route("/folders/move/:compilation_id",         put(move_compilation_to_folder))
}

// ── Folders (workspace organisation) ──────────────────────────────────────────

#[derive(Deserialize)]
struct CreateFolder {
    name: String,
    #[serde(rename = "parentFolderId")] parent_folder_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct UpdateFolder {
    name: Option<String>,
    #[serde(rename = "parentFolderId")] parent_folder_id: Option<Option<Uuid>>,
}

#[derive(Deserialize)]
struct MoveToFolder {
    #[serde(rename = "folderId")] folder_id: Option<Uuid>,
}

async fn list_folders(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, String, Option<Uuid>, i32, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, name, parent_folder_id, position, created_at FROM kg_folders WHERE user_id=$1 ORDER BY position, name"
    ).bind(claims.sub).fetch_all(&state.db).await?;
    let folders: Vec<Value> = rows.into_iter().map(|(id, name, parent, pos, created)| {
        json!({
            "id": id, "name": name, "parentFolderId": parent,
            "position": pos, "createdAt": created,
        })
    }).collect();
    Ok(Json(json!({ "folders": folders })))
}

async fn create_folder(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateFolder>,
) -> Result<Json<Value>> {
    if req.name.trim().is_empty() {
        return Err(AppError::BadRequest("Folder name required".into()));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO kg_folders (id, user_id, name, parent_folder_id) VALUES ($1, $2, $3, $4)")
        .bind(id).bind(claims.sub).bind(req.name.trim()).bind(req.parent_folder_id)
        .execute(&state.db).await?;
    Ok(Json(json!({ "id": id, "name": req.name })))
}

async fn update_folder(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateFolder>,
) -> Result<Json<Value>> {
    sqlx::query(
        "UPDATE kg_folders \
         SET name = COALESCE($1, name), \
             parent_folder_id = CASE WHEN $2::boolean THEN $3 ELSE parent_folder_id END, \
             updated_at = NOW() \
         WHERE id = $4 AND user_id = $5"
    )
    .bind(req.name)
    .bind(req.parent_folder_id.is_some())
    .bind(req.parent_folder_id.unwrap_or(None))
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_folder(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM kg_folders WHERE id=$1 AND user_id=$2")
        .bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn move_compilation_to_folder(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(compilation_id): Path<Uuid>,
    Json(req): Json<MoveToFolder>,
) -> Result<Json<Value>> {
    sqlx::query("UPDATE compilations SET folder_id=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3")
        .bind(req.folder_id).bind(compilation_id).bind(claims.sub)
        .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

// ── neo4rs helpers ────────────────────────────────────────────────────────────

/// Extract all properties from a Node using its public key-iteration API.
/// Each property is fetched as a `serde_json::Value` (works because BoltType
/// implements serde::Deserialize into Value for all primitive/container types).
fn node_props(n: &Node) -> Map<String, Value> {
    n.keys()
        .into_iter()
        .map(|k| {
            let v: Value = n.get::<Value>(k).unwrap_or(Value::Null);
            (k.to_string(), v)
        })
        .collect()
}

/// Extract all properties from a Relation using its public key-iteration API.
fn rel_props(r: &Relation) -> Map<String, Value> {
    r.keys()
        .into_iter()
        .map(|k| {
            let v: Value = r.get::<Value>(k).unwrap_or(Value::Null);
            (k.to_string(), v)
        })
        .collect()
}

/// Serialize a Node into the canonical graph node shape:
/// `{ "id": "...", "label": "...", "type": "...", "properties": {...} }`
fn node_to_json(n: &Node) -> Value {
    let props = node_props(n);
    let label = props.get("name")
        .or_else(|| props.get("label"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let node_type = n.labels().first().copied().unwrap_or("Unknown").to_string();
    // B2: surface community/centrality/god-node as top-level keys (like edge
    // `confidence`) so the canvas can colour by community + highlight god nodes
    // without digging into `properties`. Absent until communities are computed.
    let community = props.get("_community").and_then(|v| v.as_i64());
    let centrality = props.get("_centrality").and_then(|v| v.as_i64());
    let god_node = props.get("_god_node").and_then(|v| v.as_bool());
    json!({
        "id":         n.id().to_string(),
        "label":      label,
        "type":       node_type,
        "community":  community,
        "centrality": centrality,
        "godNode":    god_node,
        "properties": props,
    })
}

/// Serialize a Relation into the canonical graph edge shape:
/// `{ "source": "...", "target": "...", "type": "...", "confidence": 0..1|null,
///    "properties": {...} }`
///
/// A4: `confidence` (written by KEX relex on every edge) is surfaced as a
/// top-level key so the graph UI can encode it directly (edge opacity/width) and
/// the node drawer can show it per-connection — without having to dig into
/// `properties`. Still also present inside `properties` for completeness.
fn relation_to_json(r: &Relation) -> Value {
    let props = rel_props(r);
    let confidence = props.get("confidence").and_then(|v| v.as_f64());
    json!({
        "source":     r.start_node_id().to_string(),
        "target":     r.end_node_id().to_string(),
        "type":       r.typ(),
        "confidence": confidence,
        "properties": props,
    })
}

/// Compute live node + edge counts directly from Neo4j for a compilation.
///
/// Scoping rules:
/// - If `source_job_ids` is non-empty: count nodes whose `_source_job` is in
///   the set, and relationships whose start node's `_source_job` is in the set.
/// - If `source_job_ids` is empty (default compilation): count all nodes
///   owned by the user (treats the default as "the user's full graph").
///
/// On any Neo4j error, returns `(0, 0)` and the caller falls back to the
/// postgres-stored counts (graceful degradation).
///
/// UUIDs are passed as `Vec<String>` because the Neo4j Bolt protocol has no
/// native UUID type — `kg_builder.py` writes them as strings.
async fn live_counts(
    neo: &neo4rs::Graph,
    user_id: &str,
    source_job_ids: &[Uuid],
) -> (i64, i64) {
    if source_job_ids.is_empty() {
        // Default compilation → user's full graph.
        let node_cypher = "MATCH (n) WHERE n._owner = $uid RETURN count(n) AS c";
        let edge_cypher = "MATCH (n)-[r]->() WHERE n._owner = $uid RETURN count(r) AS c";

        let nodes = match neo.execute(neo_query(node_cypher).param("uid", user_id.to_string())).await {
            Ok(mut s) => match s.next().await {
                Ok(Some(row)) => row.get::<i64>("c").unwrap_or(0),
                _ => 0,
            },
            Err(_) => 0,
        };
        let edges = match neo.execute(neo_query(edge_cypher).param("uid", user_id.to_string())).await {
            Ok(mut s) => match s.next().await {
                Ok(Some(row)) => row.get::<i64>("c").unwrap_or(0),
                _ => 0,
            },
            Err(_) => 0,
        };
        (nodes, edges)
    } else {
        let job_strs: Vec<String> = source_job_ids.iter().map(|u| u.to_string()).collect();
        let node_cypher = "MATCH (n) WHERE n._source_job IN $jobIds RETURN count(n) AS c";
        let edge_cypher = "MATCH (n)-[r]->() WHERE n._source_job IN $jobIds RETURN count(r) AS c";

        let nodes = match neo.execute(neo_query(node_cypher).param("jobIds", job_strs.clone())).await {
            Ok(mut s) => match s.next().await {
                Ok(Some(row)) => row.get::<i64>("c").unwrap_or(0),
                _ => 0,
            },
            Err(_) => 0,
        };
        let edges = match neo.execute(neo_query(edge_cypher).param("jobIds", job_strs)).await {
            Ok(mut s) => match s.next().await {
                Ok(Some(row)) => row.get::<i64>("c").unwrap_or(0),
                _ => 0,
            },
            Err(_) => 0,
        };
        (nodes, edges)
    }
}

async fn list(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let clearance_rank = get_user_clearance_rank(&state.db, &claims).await;
    // KB-scoped tokens see only their assigned knowledge base(s).
    let scope = api_key_scope(&state.db, &claims).await;
    let limit  = q.limit.unwrap_or(20).min(100);
    let offset = q.offset.unwrap_or(0);
    let rows = sqlx::query_as::<_, (
        Uuid, String, Option<String>, String, Vec<Uuid>, Option<i32>, Option<i32>,
        Option<Uuid>, chrono::DateTime<chrono::Utc>, Option<Uuid>,
        String, Option<Uuid>, Option<chrono::DateTime<chrono::Utc>>, i32, bool,
    )>(
        "SELECT c.id, c.name, c.description, c.classification,
                COALESCE(c.source_job_ids, '{}'::uuid[]),
                c.node_count, c.edge_count, c.folder_id, c.created_at,
                c.classification_level_id,
                c.type::text, c.wiki_source_compilation_id, c.last_distill_at, c.page_count,
                COALESCE(c.is_system, false)
         FROM compilations c
         LEFT JOIN classification_levels cl ON c.classification_level_id = cl.id
         WHERE c.user_id = $1
           AND (c.classification_level_id IS NULL OR cl.rank <= $2)
         ORDER BY c.created_at DESC LIMIT $3 OFFSET $4"
    ).bind(claims.sub).bind(clearance_rank).bind(limit).bind(offset).fetch_all(&state.db).await?;

    let user_id_str = claims.sub.to_string();
    let mut comps: Vec<Value> = Vec::with_capacity(rows.len());
    for (id, n, d, cls, sji, nc, ec, fid, c, clid, ctype, wiki_src, last_distill, page_count, is_system) in rows {
        if let Some(set) = &scope { if !set.contains(&id) { continue; } }
        let stored_nc = nc.unwrap_or(0);
        let stored_ec = ec.unwrap_or(0);
        // N+1 query — acceptable while typical users have <20 compilations.
        // Batch later if it becomes a hotspot.
        let (live_nodes, live_edges) = live_counts(&state.neo, &user_id_str, &sji).await;
        let final_nodes = if live_nodes > 0 { live_nodes as i32 } else { stored_nc };
        let final_edges = if live_edges > 0 { live_edges as i32 } else { stored_ec };
        comps.push(json!({
            "id": id, "name": n, "description": d, "classification": cls,
            "sourceJobIds": sji, "nodeCount": final_nodes, "edgeCount": final_edges,
            "folderId": fid, "createdAt": c,
            "classificationLevelId": clid,
            "type": ctype,
            "isSystem": is_system,
            "wikiSourceCompilationId": wiki_src,
            "lastDistillAt": last_distill,
            "pageCount": page_count,
        }));
    }
    Ok(Json(json!({ "compilations": comps })))
}

async fn create(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateComp>,
) -> Result<Json<Value>> {
    // A KB-scoped token writes only into its assigned KB(s); creating a brand-new
    // knowledge base is an owner action (mirrors the agent-surface block).
    if api_key_scope(&state.db, &claims).await.is_some() {
        return Err(AppError::Forbidden(
            "This access token is scoped to specific knowledge bases and cannot create new ones".into()));
    }
    // Normalise the requested compilation type. Anything other than an explicit
    // "WIKI" (case-insensitive) is treated as the default RAW.
    let comp_type = match req.comp_type.as_deref().map(|s| s.trim().to_uppercase()) {
        Some(ref t) if t == "WIKI" => "WIKI",
        Some(ref t) if t == "RAW"  => "RAW",
        None                       => "RAW",
        Some(other) => {
            return Err(AppError::BadRequest(format!(
                "Invalid compilation type '{other}' (expected 'RAW' or 'WIKI')"
            )));
        }
    };

    // WIKI compilations must reference a RAW source compilation owned by the
    // same user. Validate before inserting so we never persist a dangling wiki.
    if comp_type == "WIKI" {
        let Some(src_id) = req.wiki_source_compilation_id else {
            return Err(AppError::BadRequest(
                "wikiSourceCompilationId is required for WIKI compilations".into()));
        };
        let src: Option<(String,)> = sqlx::query_as(
            "SELECT type::text FROM compilations WHERE id=$1 AND user_id=$2"
        ).bind(src_id).bind(claims.sub).fetch_optional(&state.db).await?;
        match src {
            None => return Err(AppError::BadRequest(
                "wikiSourceCompilationId does not reference a compilation you own".into())),
            Some((ref t,)) if t != "RAW" => return Err(AppError::BadRequest(
                "wikiSourceCompilationId must reference a RAW compilation".into())),
            _ => {}
        }
    } else if req.wiki_source_compilation_id.is_some() {
        return Err(AppError::BadRequest(
            "wikiSourceCompilationId is only valid for WIKI compilations".into()));
    }

    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO compilations
            (id, user_id, name, description, classification, source_job_ids, version,
             type, wiki_source_compilation_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7::compilation_type,$8)"
    )
        .bind(id).bind(claims.sub).bind(&req.name).bind(&req.description)
        .bind(req.classification.unwrap_or_else(|| "INTERNAL".into()))
        .bind(req.source_job_ids.unwrap_or_default())
        .bind(comp_type)
        .bind(req.wiki_source_compilation_id)
        .execute(&state.db).await?;
    Ok(Json(json!({ "id": id, "name": req.name, "type": comp_type })))
}

// Frontend KGDetailPage expects `{ compilation: ... }` wrapper with full row fields.
async fn get_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // sqlx's tuple FromRow is only implemented up to 16 elements, so the WIKI
    // columns (type/wiki_source/last_distill/page_count) are fetched in a second
    // lightweight query rather than widening this tuple past the limit.
    let row = sqlx::query_as::<_, (
        Uuid, Uuid, String, Option<String>, String, Vec<Uuid>,
        i32, Option<String>, Option<String>, Option<chrono::DateTime<chrono::Utc>>,
        Option<i32>, Option<i32>, Option<Uuid>,
        chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>,
        Option<Uuid>,
    )>(
        "SELECT id, user_id, name, description, classification,
                COALESCE(source_job_ids, '{}'::uuid[]),
                version, cron_schedule, cron_mode, last_refresh_at,
                node_count, edge_count, folder_id,
                created_at, updated_at,
                classification_level_id
         FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let (
        id, user_id, n, d, cls, sji,
        version, cron_schedule, cron_mode, last_refresh_at,
        nc, ec, fid, created_at, updated_at,
        clid,
    ) = row;

    let (ctype, wiki_src, last_distill, page_count, is_system) = sqlx::query_as::<_, (
        String, Option<Uuid>, Option<chrono::DateTime<chrono::Utc>>, i32, bool,
    )>(
        "SELECT type::text, wiki_source_compilation_id, last_distill_at, page_count,
                COALESCE(is_system, false)
         FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_one(&state.db).await?;

    // Clearance check: if a classification level is assigned, verify the user
    // has sufficient clearance_rank to access this compilation.
    let classification_rank: Option<i32> = sqlx::query_scalar(
        "SELECT cl.rank FROM compilations c
         JOIN classification_levels cl ON c.classification_level_id = cl.id
         WHERE c.id = $1"
    ).bind(id).fetch_optional(&state.db).await.ok().flatten();

    if let Some(rank) = classification_rank {
        let user_rank = effective_rank_for_compilation(&state.db, &claims, id).await;
        if user_rank < rank {
            return Err(AppError::Forbidden("Insufficient clearance for this compilation".into()));
        }
    }

    let user_id_str = claims.sub.to_string();
    let stored_nc = nc.unwrap_or(0);
    let stored_ec = ec.unwrap_or(0);
    let (live_nodes, live_edges) = live_counts(&state.neo, &user_id_str, &sji).await;
    let final_nodes = if live_nodes > 0 { live_nodes as i32 } else { stored_nc };
    let final_edges = if live_edges > 0 { live_edges as i32 } else { stored_ec };

    Ok(Json(json!({ "compilation": {
        "id": id,
        "userId": user_id,
        "name": n,
        "description": d,
        "classification": cls,
        "sourceJobIds": sji,
        "version": version,
        "cronSchedule": cron_schedule,
        "cronMode": cron_mode.unwrap_or_else(|| "incremental".into()),
        "lastRefreshAt": last_refresh_at,
        "nodeCount": final_nodes,
        "edgeCount": final_edges,
        // entityCount/duplicateCount/linkCount aren't tracked separately yet;
        // the frontend falls back to nodeCount when entityCount is 0.
        "entityCount": final_nodes,
        "duplicateCount": 0,
        "linkCount": 0,
        "folderId": fid,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "classificationLevelId": clid,
        "type": ctype,
        "isSystem": is_system,
        "wikiSourceCompilationId": wiki_src,
        "lastDistillAt": last_distill,
        "pageCount": page_count,
    } })))
}

async fn update(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
    enforce_kb_write_scope(&state.db, &claims, id).await?;
    if let Some(name) = req.get("name").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE compilations SET name=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3")
            .bind(name).bind(id).bind(claims.sub).execute(&state.db).await?;
    }
    // Set the compilation's classification by level id (system OR custom level).
    // The legacy `classification` enum column is kept in sync from the level's
    // rank so older display paths stay coherent.
    if let Some(clid) = req.get("classificationLevelId").and_then(|v| v.as_str()).and_then(|s| s.parse::<Uuid>().ok()) {
        let rank: Option<i32> = sqlx::query_scalar("SELECT rank FROM classification_levels WHERE id=$1")
            .bind(clid).fetch_optional(&state.db).await.ok().flatten();
        let legacy = match rank.unwrap_or(0) {
            r if r <= 0   => "PUBLIC",
            r if r <= 100 => "INTERNAL",
            r if r <= 200 => "CONFIDENTIAL",
            _             => "RESTRICTED",
        };
        sqlx::query(
            "UPDATE compilations SET classification_level_id=$1, classification=$2, updated_at=NOW() WHERE id=$3 AND user_id=$4"
        ).bind(clid).bind(legacy).bind(id).bind(claims.sub).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    enforce_kb_write_scope(&state.db, &claims, id).await?;
    // System compilations (e.g. the default "Knowledge Wiki") are non-deletable —
    // mirrors the canonical default ontology's 403 protection. Checking ownership
    // and the flag together means a non-owner still gets NotFound, not Forbidden.
    let row: Option<(bool,)> = sqlx::query_as(
        "SELECT is_system FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    match row {
        None => return Err(AppError::NotFound),
        Some((true,)) => return Err(AppError::Forbidden(
            "This is a system compilation and cannot be deleted".into())),
        Some((false,)) => {}
    }
    sqlx::query("DELETE FROM compilations WHERE id=$1 AND user_id=$2").bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn refresh(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    enforce_kb_write_scope(&state.db, &claims, id).await?;
    sqlx::query("UPDATE users SET tokens_balance=tokens_balance-3 WHERE id=$1").bind(claims.sub).execute(&state.db).await?;
    let source_ids: Vec<uuid::Uuid> = sqlx::query_scalar("SELECT unnest(source_job_ids) FROM compilations WHERE id=$1").bind(id).fetch_all(&state.db).await?;
    let job_id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs (id,user_id,type,status,input) VALUES ($1,$2,'fuse_merge','pending',$3)")
        .bind(job_id).bind(claims.sub).bind(json!({ "compilationId": id, "sourceJobIds": source_ids }))
        .execute(&state.db).await?;
    crate::services::redis::lpush(&state.redis, "fuse:jobs", &json!({ "job_id": job_id, "compilation_id": id, "source_job_ids": source_ids }).to_string())
        .await.map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "jobId": job_id, "status": "pending" })))
}

// ── WIKI distillation ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DistillReq { limit: Option<i64> }

/// POST /compilations/:id/distill
/// Distil a WIKI compilation into wiki pages by calling the FUSE service
/// synchronously. The compilation must exist, be owned by the caller, and be of
/// type WIKI. Returns FUSE's summary ({ pages_written, … }).
async fn distill(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<DistillReq>,
) -> Result<Json<Value>> {
    enforce_kb_write_scope(&state.db, &claims, id).await?;
    // Verify ownership + type in one query (NotFound covers "not owned").
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT type::text FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    let Some((comp_type,)) = row else { return Err(AppError::NotFound); };
    if comp_type != "WIKI" {
        return Err(AppError::BadRequest(
            "Distillation is only valid for WIKI compilations".into()));
    }

    let limit = req.limit.unwrap_or(15).clamp(1, 100);
    // Per-user distill model + Ollama base (Settings → AI Models / Infra). Unset →
    // FUSE uses its env defaults, so existing installs are untouched.
    let (distill_model, ollama_base) =
        crate::services::llm::resolve_distill_overrides(&state.db, claims.sub).await;
    let gen_target =
        crate::services::llm::resolve_distill_generation_overrides(&state.db, claims.sub).await;
    let fuse_url = format!("{}/distill", state.cfg.fuse_url);
    let client = reqwest::Client::new();
    let mut distill_payload = serde_json::json!({
        "compilation_id": id.to_string(),
        "user_id": claims.sub.to_string(),
        "limit": limit,
        "distill_model": distill_model,
        "ollama_base": ollama_base,
    });
    if let Some(ref gen) = gen_target {
        if let Some(map) = distill_payload.as_object_mut() {
            crate::services::llm::apply_generation_overrides(gen, map);
        }
    }
    let resp = client
        .post(&fuse_url)
        .json(&distill_payload)
        // Distillation calls the LLM once per entity — give it room.
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("FUSE unreachable: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 400 {
            return Err(AppError::BadRequest(format!("FUSE rejected distill: {body}")));
        }
        return Err(AppError::Internal(format!("FUSE distill failed ({status}): {body}")));
    }

    let summary: Value = resp.json().await
        .map_err(|e| AppError::Internal(format!("FUSE response parse error: {e}")))?;

    let eff = effective_rank_for_compilation(&state.db, &claims, id).await;
    crate::services::audit::log_access(&state.db, &claims, "kg.distill",
        "compilation", &id.to_string(), eff, None, true, None).await;

    Ok(Json(summary))
}

/// POST /compilations/:id/communities
/// B2 — run community detection + centrality ("god nodes") over the compilation's
/// graph via FUSE, writing `_community`/`_centrality`/`_god_node` onto the nodes.
/// Owner + KB-write-scope guarded. Returns FUSE's cluster summary.
async fn communities(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(Json(communities_core(&state, &claims, id).await?))
}

/// Run community detection + centrality on a compilation via FUSE, writing
/// `_community`/`_centrality`/`_god_node` onto its nodes. Owner + KB-write-scope
/// gated. Shared by the REST handler and the agent tool.
pub(crate) async fn communities_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
) -> Result<Value> {
    enforce_kb_write_scope(&state.db, claims, id).await?;
    let row: Option<(Vec<Uuid>,)> = sqlx::query_as(
        "SELECT COALESCE(source_job_ids,'{}'::uuid[]) FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    let Some((job_ids,)) = row else { return Err(AppError::NotFound); };
    let job_strs: Vec<String> = job_ids.iter().map(|u| u.to_string()).collect();

    let fuse_url = format!("{}/communities", state.cfg.fuse_url);
    let resp = reqwest::Client::new()
        .post(&fuse_url)
        .json(&json!({
            "compilation_id": id.to_string(),
            "user_id": claims.sub.to_string(),
            "source_job_ids": job_strs,
        }))
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("FUSE unreachable: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("FUSE communities failed ({status}): {body}")));
    }
    let summary: Value = resp.json().await
        .map_err(|e| AppError::Internal(format!("FUSE response parse error: {e}")))?;

    let eff = effective_rank_for_compilation(&state.db, claims, id).await;
    crate::services::audit::log_access(&state.db, claims, "kg.communities",
        "compilation", &id.to_string(), eff, None, true, None).await;
    Ok(summary)
}

/// Shared clearance gate for the WIKI read endpoints: a WIKI page is only
/// readable if the caller could read the compilation itself. Returns Ok(()) when
/// allowed, the appropriate error otherwise (NotFound when not owned, Forbidden
/// when clearance is insufficient).
async fn enforce_wiki_read(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
) -> Result<()> {
    let owned: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    if owned.is_none() { return Err(AppError::NotFound); }

    let classification_rank: Option<i32> = sqlx::query_scalar(
        "SELECT cl.rank FROM compilations c
         JOIN classification_levels cl ON c.classification_level_id = cl.id
         WHERE c.id = $1 AND c.user_id = $2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();
    if let Some(rank) = classification_rank {
        let eff = effective_rank_for_compilation(&state.db, claims, id).await;
        if eff < rank {
            return Err(AppError::Forbidden("Insufficient clearance for this compilation".into()));
        }
    }
    Ok(())
}

/// GET /compilations/:id/wiki  →  list this WIKI comp's pages (metadata only).
async fn list_wiki_pages(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    Ok(Json(list_wiki_pages_core(&state, &claims, id).await?))
}

/// Clearance-filtered wiki page index — shared by the REST handler and the agent
/// tool. Hides pages whose min_rank exceeds the caller's effective clearance.
pub(crate) async fn list_wiki_pages_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
) -> Result<Value> {
    enforce_wiki_read(state, claims, id).await?;
    let eff = effective_rank_for_compilation(&state.db, claims, id).await;
    let rows = sqlx::query_as::<_, (Uuid, String, String, String, Option<String>, i32, Vec<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, kind, slug, title, entity_uri, min_rank, class_labels, last_distilled_at
         FROM wiki_pages WHERE compilation_id=$1 AND min_rank <= $2 ORDER BY title"
    ).bind(id).bind(eff).fetch_all(&state.db).await?;
    let pages: Vec<Value> = rows.into_iter().map(|(pid, kind, slug, title, uri, min_rank, labels, last)| {
        json!({
            "id": pid, "kind": kind, "slug": slug, "title": title,
            "entityUri": uri, "minRank": min_rank, "classLabels": labels,
            "lastDistilledAt": last,
        })
    }).collect();
    Ok(json!({ "pages": pages }))
}

/// GET /compilations/:id/wiki/:slug  →  one full wiki page.
async fn get_wiki_page(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path((id, slug)): Path<(Uuid, String)>,
) -> Result<Json<Value>> {
    Ok(Json(get_wiki_page_core(&state, &claims, id, &slug).await?))
}

/// Clearance-gated single wiki page — shared by the REST handler and the agent
/// tool. Above-clearance pages return NotFound (never reveal they exist).
pub(crate) async fn get_wiki_page_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
    slug: &str,
) -> Result<Value> {
    enforce_wiki_read(state, claims, id).await?;
    let eff = effective_rank_for_compilation(&state.db, claims, id).await;
    let row = sqlx::query_as::<_, (String, String, String, String, Value, i32, i32, Vec<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT slug, title, kind, body_md, citations, version, min_rank, class_labels, last_distilled_at
         FROM wiki_pages WHERE compilation_id=$1 AND slug=$2 AND min_rank <= $3"
    ).bind(id).bind(slug).bind(eff).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let (slug, title, kind, body_md, citations, version, min_rank, labels, last) = row;
    Ok(json!({
        "slug": slug, "title": title, "kind": kind,
        "bodyMd": body_md, "citations": citations,
        "version": version, "minRank": min_rank, "classLabels": labels,
        "lastDistilledAt": last,
    }))
}

/// Extract `[[Target]]` (or `[[Target|alias]]`) link targets from a markdown
/// body. Mirrors the distiller's wikilink regex without pulling in a regex dep.
fn extract_wikilink_targets(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(close) = body[i + 2..].find("]]") {
                let inner = &body[i + 2..i + 2 + close];
                // Strip an optional |alias and skip nested brackets.
                if !inner.contains('[') {
                    let target = inner.split('|').next().unwrap_or("").trim();
                    if !target.is_empty() {
                        out.push(target.to_string());
                    }
                }
                i = i + 2 + close + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Slugify mirroring the distiller's `slugify` (ASCII, lowercase, hyphenated) so
/// a `[[Title]]` link resolves to the same slug the distiller stored.
fn wiki_slugify(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            s.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            s.push('-');
            prev_dash = true;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "entity".to_string() } else { s }
}

/// GET /compilations/:id/wiki-graph
/// The wiki rendered as a navigable graph: pages are nodes, validated
/// `[[wikilinks]]` are edges. Clearance-filtered identically to the page list —
/// a page above the caller's clearance is absent from the graph, and so are its
/// edges. Mirrors `get_graph`'s response shape so the force-graph renders it
/// unchanged.
async fn wiki_graph(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    enforce_wiki_read(&state, &claims, id).await?;
    let eff = effective_rank_for_compilation(&state.db, &claims, id).await;

    let rows = sqlx::query_as::<_, (String, String, String, String, i32)>(
        "SELECT slug, title, kind, body_md, min_rank
         FROM wiki_pages WHERE compilation_id=$1 AND min_rank <= $2 ORDER BY title"
    ).bind(id).bind(eff).fetch_all(&state.db).await?;

    // slug set + title→slug map so [[Title]] links resolve to visible pages only.
    use std::collections::{HashMap, HashSet};
    let visible: HashSet<String> = rows.iter().map(|(s, ..)| s.clone()).collect();
    let mut title_to_slug: HashMap<String, String> = HashMap::new();
    for (slug, title, ..) in &rows {
        title_to_slug.insert(title.to_lowercase(), slug.clone());
        title_to_slug.insert(wiki_slugify(title), slug.clone());
    }

    let nodes: Vec<Value> = rows.iter().map(|(slug, title, kind, _body, min_rank)| {
        json!({ "id": slug, "label": title, "kind": kind, "minRank": min_rank })
    }).collect();

    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    let mut edges: Vec<Value> = Vec::new();
    for (slug, _title, _kind, body, _r) in &rows {
        for target in extract_wikilink_targets(body) {
            // Resolve target → a visible page slug (by exact slug, title, or
            // slugified title). Links to hidden/absent pages are dropped.
            let tslug = if visible.contains(&target) {
                target.clone()
            } else if let Some(s) = title_to_slug.get(&target.to_lowercase()) {
                s.clone()
            } else if let Some(s) = title_to_slug.get(&wiki_slugify(&target)) {
                s.clone()
            } else {
                continue;
            };
            if &tslug == slug { continue; }
            let key = (slug.clone(), tslug.clone());
            if seen_edges.insert(key) {
                edges.push(json!({ "source": slug, "target": tslug, "rel": "LINKS_TO" }));
            }
        }
    }

    Ok(Json(json!({
        "nodes": nodes,
        "edges": edges,
        "nodeCount": nodes.len(),
        "edgeCount": edges.len(),
        "truncated": false,
    })))
}

// ── WIKI multi-source selection ────────────────────────────────────────────────
//
// A WIKI compilation distils from MULTIPLE RAW source graphs (the user picks
// them). Sources live in the `wiki_sources` link table; the legacy single-source
// column `wiki_source_compilation_id` is kept in sync as a back-compat mirror of
// the FIRST selected source so older read paths keep working.

#[derive(Deserialize)]
struct SetWikiSources {
    #[serde(rename = "sourceCompilationIds")] source_compilation_ids: Vec<Uuid>,
}

/// Verify the compilation exists, is owned by the caller, and is a WIKI.
/// Returns NotFound when not owned, BadRequest when it isn't a WIKI.
async fn ensure_owned_wiki(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    id: Uuid,
) -> Result<()> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT type::text FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    match row {
        None => Err(AppError::NotFound),
        Some((ref t,)) if t != "WIKI" => Err(AppError::BadRequest(
            "Wiki sources are only valid for WIKI compilations".into())),
        Some(_) => Ok(()),
    }
}

/// GET /compilations/:id/wiki/sources → the RAW source graphs feeding this wiki.
async fn get_wiki_sources(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    ensure_owned_wiki(&state, &claims, id).await?;

    let rows = sqlx::query_as::<_, (Uuid, String, Option<i32>, Option<i32>)>(
        "SELECT c.id, c.name, c.node_count, c.edge_count \
         FROM wiki_sources ws \
         JOIN compilations c ON c.id = ws.source_compilation_id \
         WHERE ws.wiki_compilation_id = $1 \
         ORDER BY c.name"
    ).bind(id).fetch_all(&state.db).await?;

    let sources: Vec<Value> = rows.into_iter().map(|(sid, name, nc, ec)| {
        json!({
            "id": sid, "name": name,
            "nodeCount": nc.unwrap_or(0), "edgeCount": ec.unwrap_or(0),
        })
    }).collect();
    Ok(Json(json!({ "sources": sources })))
}

/// PUT /compilations/:id/wiki/sources { sourceCompilationIds: [...] }
/// Replace the wiki's source set. Every id must be a RAW compilation owned by the
/// caller. Also mirrors the first source into the legacy single-source column.
async fn set_wiki_sources(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<SetWikiSources>,
) -> Result<Json<Value>> {
    enforce_kb_write_scope(&state.db, &claims, id).await?;
    ensure_owned_wiki(&state, &claims, id).await?;

    // Validate every source: must exist, be owned by this user, and be RAW.
    // A WIKI can't source from itself or another WIKI.
    for src_id in &req.source_compilation_ids {
        let src: Option<(String,)> = sqlx::query_as(
            "SELECT type::text FROM compilations WHERE id=$1 AND user_id=$2"
        ).bind(src_id).bind(claims.sub).fetch_optional(&state.db).await?;
        match src {
            None => return Err(AppError::BadRequest(format!(
                "source {src_id} is not a compilation you own"))),
            Some((ref t,)) if t != "RAW" => return Err(AppError::BadRequest(format!(
                "source {src_id} must be a RAW compilation"))),
            _ => {}
        }
    }

    // Replace the set atomically.
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM wiki_sources WHERE wiki_compilation_id=$1")
        .bind(id).execute(&mut *tx).await?;
    for src_id in &req.source_compilation_ids {
        sqlx::query(
            "INSERT INTO wiki_sources (wiki_compilation_id, source_compilation_id) \
             VALUES ($1, $2) ON CONFLICT DO NOTHING"
        ).bind(id).bind(src_id).execute(&mut *tx).await?;
    }
    // Mirror the first source into the legacy single-source column for back-compat.
    let first = req.source_compilation_ids.first().copied();
    sqlx::query("UPDATE compilations SET wiki_source_compilation_id=$1, updated_at=NOW() WHERE id=$2")
        .bind(first).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;

    Ok(Json(json!({ "ok": true, "sourceCount": req.source_compilation_ids.len() })))
}

// PUT /compilations/:id/schedule  →  update cron schedule + mode.
// Frontend ScheduleTab posts `{ schedule, mode }`; either may be null.
async fn set_schedule(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
    enforce_kb_write_scope(&state.db, &claims, id).await?;
    let schedule = req.get("schedule")
        .and_then(|v| if v.is_null() { Some(None) } else { v.as_str().map(|s| Some(s.to_string())) })
        .unwrap_or(None);
    let mode = req.get("mode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let result = sqlx::query(
        "UPDATE compilations
         SET cron_schedule = $1,
             cron_mode = COALESCE($2, cron_mode),
             updated_at = NOW()
         WHERE id = $3 AND user_id = $4"
    )
    .bind(schedule.as_deref())
    .bind(mode.as_deref())
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db).await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

// GET /compilations/:id/audit  →  audit log entries scoped to this compilation.
// Frontend AuditTab expects `{ entries: [{ id, action, userId, timestamp, details }, ...] }`.
async fn get_audit(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // Verify compilation belongs to this user (or user is admin) before exposing audit.
    let exists: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    if exists.is_none() && claims.role != "admin" {
        return Err(AppError::NotFound);
    }

    let id_str = id.to_string();
    let rows = sqlx::query_as::<_, (
        Uuid, String, Option<Uuid>, Option<Value>, chrono::DateTime<chrono::Utc>
    )>(
        "SELECT id, action, user_id, details, created_at
         FROM audit_log
         WHERE resource_type = 'compilation' AND resource_id = $1
         ORDER BY created_at DESC LIMIT 200"
    ).bind(&id_str).fetch_all(&state.db).await?;

    let entries: Vec<Value> = rows.into_iter().map(|(eid, action, uid, details, created)| {
        // Render details as a short string for the table cell.
        let details_str = details
            .as_ref()
            .and_then(|v| if v.is_null() { None } else { Some(v.to_string()) });
        json!({
            "id": eid,
            "action": action,
            "userId": uid,
            "timestamp": created,
            "details": details_str,
        })
    }).collect();

    Ok(Json(json!({ "entries": entries })))
}

// Frontend KGDetailPage AclTab expects `{ acl: [{ userId, permission }, ...] }`.
async fn get_acl(
    Extension(_claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, Uuid, String)>(
        "SELECT id, user_id, permission FROM compilation_acl WHERE compilation_id=$1"
    ).bind(id).fetch_all(&state.db).await?;
    let acl: Vec<Value> = rows.into_iter()
        .map(|(_id, uid, perm)| json!({ "userId": uid, "permission": perm }))
        .collect();
    Ok(Json(json!({ "acl": acl })))
}

async fn set_acl(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
    enforce_kb_write_scope(&state.db, &claims, id).await?;
    sqlx::query("DELETE FROM compilation_acl WHERE compilation_id=$1").bind(id).execute(&state.db).await?;
    if let Some(entries) = req.get("entries").and_then(|v| v.as_array()) {
        for e in entries {
            let uid: Uuid = serde_json::from_value(e["userId"].clone()).map_err(|_| AppError::BadRequest("Invalid userId".into()))?;
            let perm = e["permission"].as_str().unwrap_or("read");
            sqlx::query("INSERT INTO compilation_acl (id,compilation_id,user_id,permission,granted_by) VALUES (gen_random_uuid(),$1,$2,$3,$4)")
                .bind(id).bind(uid).bind(perm).bind(claims.sub).execute(&state.db).await?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

// ── Graph visualization endpoints ─────────────────────────────────────────────

#[derive(Deserialize)]
struct GraphQuery {
    limit:     Option<i64>,
    node_type: Option<String>,
}

/// GET /compilations/:id/graph
/// Returns a MEANINGFUL subset of the compilation's graph plus the TRUE totals.
///
/// The naive `MATCH (n) … RETURN n,r,m LIMIT $limit` returned an arbitrary
/// ≤N-row slice with no ordering, so an 8712-node graph and a 292-node graph
/// both rendered ~200 random nodes and looked identical. This handler instead:
///   1. counts the TRUE node/edge totals in scope (so the UI can show real size
///      + a `truncated` flag),
///   2. picks the top-`limit` nodes BY DEGREE (the connected core, not random
///      rows) and returns only the edges induced among those nodes,
/// while keeping all clearance/scoping logic intact.
async fn get_graph(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Query(q): Query<GraphQuery>,
) -> Result<Json<Value>> {
    // Verify the compilation belongs to this user AND fetch its source_job_ids.
    // KEX never writes a `compilation_id` property to nodes — it tags them
    // with `_owner` (user UUID) and `_source_job` (KEX job UUID). So the
    // graph for a compilation is the union of its source jobs' entities,
    // OR — for the seeded default compilation with no explicit sources —
    // every node owned by the user.
    let row: Option<(Vec<Uuid>,)> = sqlx::query_as(
        "SELECT COALESCE(source_job_ids, '{}'::uuid[])
         FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    let Some((source_job_ids,)) = row else { return Err(AppError::NotFound); };

    // Clearance check: if a classification level is assigned, verify the user
    // has sufficient clearance_rank to access this compilation's graph data.
    let classification_rank: Option<i32> = sqlx::query_scalar(
        "SELECT cl.rank FROM compilations c
         JOIN classification_levels cl ON c.classification_level_id = cl.id
         WHERE c.id = $1 AND c.user_id = $2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();

    // Effective rank for THIS compilation (base clearance + any per-graph grant).
    let eff_rank = effective_rank_for_compilation(&state.db, &claims, id).await;
    if let Some(rank) = classification_rank {
        if eff_rank < rank {
            crate::services::audit::log_access(&state.db, &claims, "graph.read",
                "compilation", &id.to_string(), eff_rank, None, false,
                Some("insufficient clearance")).await;
            return Err(AppError::Forbidden("Insufficient clearance".into()));
        }
    }

    // Validate node_type before interpolating it into the Cypher string.
    // A malicious value like `Foo}) MATCH (n) DETACH DELETE n //` would
    // otherwise allow arbitrary Cypher injection via the label position.
    if let Some(ref nt) = q.node_type {
        if !is_valid_neo4j_label(nt) {
            return Err(AppError::BadRequest("Invalid node_type".into()));
        }
    }

    // Return the WHOLE graph by default (degree-ordered) so the explorer can show
    // every node — the client bounds what's drawn per viewport via zoom, not a
    // server-side truncation. A high hard ceiling (20000) protects the payload
    // against pathological graphs; only then does `truncated` flip true.
    let limit = q.limit.unwrap_or(20000).clamp(1, 20000);
    let user_id_str = claims.sub.to_string();
    let job_strs: Vec<String> = source_job_ids.iter().map(|u| u.to_string()).collect();

    // Build the WHERE clause based on whether this compilation has explicit
    // source jobs (merge result) or not (default = full user graph). The
    // optional `node_type` label is validated above and safe to interpolate.
    //
    // `NOT n:Compilation` excludes the structural FUSE metadata node (one per
    // compilation, no `name`, links to every member entity so it would otherwise
    // top the degree ranking). It is not a knowledge entity and must never show
    // in the explorer — including it made the "core" an empty unlabeled hub.
    let scope = if source_job_ids.is_empty() {
        "n._owner = $uid AND NOT n:Compilation"
    } else {
        "n._source_job IN $jobIds AND NOT n:Compilation"
    };
    let label_pat = match &q.node_type {
        Some(label) => format!("(n:{label})"),
        None => "(n)".to_string(),
    };

    // ── True totals (scoped + clearance-filtered) ─────────────────────────────
    // nodeCount: nodes in scope the viewer may see.
    // edgeCount: relationships whose BOTH endpoints (and the edge) are in scope
    //            and visible — matches what the UI could ever render.
    let node_count_cypher = format!(
        "MATCH {label_pat} WHERE {scope} AND coalesce(n._min_rank,0) <= $rank \
         RETURN count(n) AS c"
    );
    let edge_count_cypher = format!(
        "MATCH {label_pat}-[r]->(m) \
         WHERE {scope} AND coalesce(n._min_rank,0) <= $rank \
           AND coalesce(m._min_rank,0) <= $rank AND coalesce(r._min_rank,0) <= $rank \
         RETURN count(r) AS c"
    );
    let node_count: i64 = match state.neo
        .execute(neo_query(&node_count_cypher)
            .param("uid", user_id_str.clone())
            .param("jobIds", job_strs.clone())
            .param("rank", eff_rank as i64)).await
    {
        Ok(mut s) => match s.next().await { Ok(Some(row)) => row.get::<i64>("c").unwrap_or(0), _ => 0 },
        Err(e) => return Err(AppError::Internal(e.to_string())),
    };
    let edge_count: i64 = match state.neo
        .execute(neo_query(&edge_count_cypher)
            .param("uid", user_id_str.clone())
            .param("jobIds", job_strs.clone())
            .param("rank", eff_rank as i64)).await
    {
        Ok(mut s) => match s.next().await { Ok(Some(row)) => row.get::<i64>("c").unwrap_or(0), _ => 0 },
        Err(e) => return Err(AppError::Internal(e.to_string())),
    };

    // ── Meaningful subset: top-N nodes BY DEGREE, then their induced edges ─────
    // Degree is computed over the FULL graph (all adjacent rels, clearance-gated)
    // so the most-connected entities — the graph's core — are chosen. We then
    // return only the edges whose BOTH endpoints are in that chosen set, so the
    // rendered subgraph is coherent instead of a random row slice.
    let core_cypher = format!(
        "MATCH {label_pat} WHERE {scope} AND coalesce(n._min_rank,0) <= $rank \
         OPTIONAL MATCH (n)-[rel]-(nb) \
           WHERE coalesce(rel._min_rank,0) <= $rank AND coalesce(nb._min_rank,0) <= $rank \
         WITH n, count(rel) AS deg \
         ORDER BY deg DESC \
         LIMIT $limit \
         RETURN n"
    );

    let mut core_stream = state.neo
        .execute(neo_query(&core_cypher)
            .param("uid", user_id_str.clone())
            .param("jobIds", job_strs.clone())
            .param("rank", eff_rank as i64)
            .param("limit", limit))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let mut nodes: Vec<Value> = Vec::new();
    let mut core_ids: Vec<i64> = Vec::new();
    let mut seen_nodes: std::collections::HashSet<i64> = std::collections::HashSet::new();
    while let Ok(Some(row)) = core_stream.next().await {
        if let Ok(n) = row.get::<Node>("n") {
            if seen_nodes.insert(n.id()) {
                core_ids.push(n.id());
                nodes.push(node_to_json(&n));
            }
        }
    }

    // Induced edges: relationships among the chosen core nodes only. Match by the
    // Neo4j internal ids we just collected (id(a)/id(b)) so we never pull in a
    // node outside the subset. Clearance on the edge itself is still enforced.
    let mut edges: Vec<Value> = Vec::new();
    let mut seen_edges: std::collections::HashSet<i64> = std::collections::HashSet::new();
    if !core_ids.is_empty() {
        let edge_cypher =
            "MATCH (a)-[r]->(b) \
             WHERE id(a) IN $ids AND id(b) IN $ids AND coalesce(r._min_rank,0) <= $rank \
             RETURN r";
        let mut edge_stream = state.neo
            .execute(neo_query(edge_cypher)
                .param("ids", core_ids.clone())
                .param("rank", eff_rank as i64))
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        while let Ok(Some(row)) = edge_stream.next().await {
            if let Ok(r) = row.get::<Relation>("r") {
                if seen_edges.insert(r.id()) {
                    edges.push(relation_to_json(&r));
                }
            }
        }
    }

    let truncated = (nodes.len() as i64) < node_count || (edges.len() as i64) < edge_count;

    crate::services::audit::log_access(&state.db, &claims, "graph.read",
        "compilation", &id.to_string(), eff_rank, None, true, None).await;
    Ok(Json(json!({
        "nodes": nodes,
        "edges": edges,
        "nodeCount": node_count,
        "edgeCount": edge_count,
        "truncated": truncated,
    })))
}

#[derive(Deserialize)]
struct SearchQuery {
    q:     String,
    limit: Option<i64>,
}

/// GET /graph/search
/// Full-text search across all nodes belonging to the authenticated user.
async fn graph_search(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Value>> {
    if q.q.is_empty() {
        return Err(AppError::BadRequest("Query parameter 'q' is required".into()));
    }
    let limit = q.limit.unwrap_or(20).min(100);
    let uid   = claims.sub.to_string();
    // Cross-graph search uses the token's base clearance (per-graph grants are
    // scoped to a specific compilation and don't widen a global search).
    let base_rank = get_user_clearance_rank(&state.db, &claims).await;

    let cypher = "MATCH (n) \
                  WHERE (n.name CONTAINS $q OR n.label CONTAINS $q) \
                  AND n.user_id = $uid \
                  AND coalesce(n._min_rank,0) <= $rank \
                  RETURN n LIMIT $limit";

    let mut stream = state.neo
        .execute(neo_query(cypher).param("q", q.q.clone()).param("uid", uid.clone()).param("rank", base_rank as i64).param("limit", limit))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let mut nodes: Vec<Value> = Vec::new();
    while let Ok(Some(row)) = stream.next().await {
        if let Ok(n) = row.get::<Node>("n") {
            nodes.push(node_to_json(&n));
        }
    }

    // If no results came back, the most likely cause is that `n.user_id` doesn't
    // exist on graph nodes for this deployment (schema mismatch).  Log a debug
    // hint so operators can diagnose without enabling full query tracing.
    if nodes.is_empty() {
        tracing::debug!(
            query = q.q.as_str(),
            user_id = uid.as_str(),
            "graph_search returned 0 results — verify that graph nodes carry a \
             `user_id` property matching the authenticated user's UUID"
        );
    }

    Ok(Json(json!({ "nodes": nodes })))
}

#[derive(Deserialize)]
struct NeighborQuery {
    depth: Option<i64>,
    limit: Option<i64>,
}

/// GET /graph/entity/:name/neighbors
/// Returns a named entity and its direct neighbors (depth 1 or 2).
/// Uses explicit single-hop MATCH patterns so each row yields exactly one
/// (n, r, m) tuple — avoids variable-length path deserialization complexity.
async fn entity_neighbors(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(name): Path<String>,
    Query(q): Query<NeighborQuery>,
) -> Result<Json<Value>> {
    let depth = q.depth.unwrap_or(1).min(2).max(1);
    let limit = q.limit.unwrap_or(50).min(500);
    let uid   = claims.sub.to_string();
    let base_rank = get_user_clearance_rank(&state.db, &claims).await;

    let mut nodes: Vec<Value>        = Vec::new();
    let mut edges: Vec<Value>        = Vec::new();
    let mut seen_nodes: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut seen_rels:  std::collections::HashSet<i64> = std::collections::HashSet::new();

    // Depth-1: anchor → direct neighbour. Both endpoints + the edge must be
    // within the viewer's clearance (legacy elements default to PUBLIC).
    let mut stream = state.neo
        .execute(
            neo_query("MATCH (n {name: $name, user_id: $uid})-[r]-(m) \
                       WHERE coalesce(n._min_rank,0) <= $rank AND coalesce(m._min_rank,0) <= $rank AND coalesce(r._min_rank,0) <= $rank \
                       RETURN n, r, m LIMIT $limit")
                .param("name", name.clone())
                .param("uid", uid.clone())
                .param("rank", base_rank as i64)
                .param("limit", limit),
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    while let Ok(Some(row)) = stream.next().await {
        if let Ok(n) = row.get::<Node>("n") {
            if seen_nodes.insert(n.id()) { nodes.push(node_to_json(&n)); }
        }
        if let Ok(r) = row.get::<Relation>("r") {
            if seen_rels.insert(r.id()) { edges.push(relation_to_json(&r)); }
        }
        if let Ok(m) = row.get::<Node>("m") {
            if seen_nodes.insert(m.id()) { nodes.push(node_to_json(&m)); }
        }
    }

    // Depth-2: extend one more hop from each depth-1 neighbour.
    if depth >= 2 {
        let mut stream2 = state.neo
            .execute(
                neo_query("MATCH (n {name: $name, user_id: $uid})-[]-(mid)-[r2]-(m) \
                           WHERE coalesce(mid._min_rank,0) <= $rank AND coalesce(m._min_rank,0) <= $rank AND coalesce(r2._min_rank,0) <= $rank \
                           RETURN mid AS n, r2 AS r, m LIMIT $limit")
                    .param("name", name.clone())
                    .param("uid", uid.clone())
                    .param("rank", base_rank as i64)
                    .param("limit", limit),
            )
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        while let Ok(Some(row)) = stream2.next().await {
            if let Ok(n) = row.get::<Node>("n") {
                if seen_nodes.insert(n.id()) { nodes.push(node_to_json(&n)); }
            }
            if let Ok(r) = row.get::<Relation>("r") {
                if seen_rels.insert(r.id()) { edges.push(relation_to_json(&r)); }
            }
            if let Ok(m) = row.get::<Node>("m") {
                if seen_nodes.insert(m.id()) { nodes.push(node_to_json(&m)); }
            }
        }
    }

    Ok(Json(json!({ "nodes": nodes, "edges": edges })))
}

/// GET /compilations/:id/entity/:name
/// Returns full detail for a single entity within a compilation's scope:
/// properties, in/out degree, chunk count, and last source-job metadata.
/// Powers the Obsidian-style Node Detail drawer (Overview + Source tabs).
async fn entity_detail(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path((id, name)): Path<(Uuid, String)>,
) -> Result<Json<Value>> {
    // 1. Verify compilation ownership AND fetch its source_job_ids.
    //    Same scoping rules as `get_graph` — empty source_job_ids means
    //    "default compilation = the user's full graph".
    let row: Option<(Vec<Uuid>,)> = sqlx::query_as(
        "SELECT COALESCE(source_job_ids, '{}'::uuid[])
         FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    let Some((source_job_ids,)) = row else { return Err(AppError::NotFound); };

    // Clearance check: if a classification level is assigned, verify the user
    // has sufficient clearance_rank to access this compilation's entity data.
    let classification_rank: Option<i32> = sqlx::query_scalar(
        "SELECT cl.rank FROM compilations c
         JOIN classification_levels cl ON c.classification_level_id = cl.id
         WHERE c.id = $1 AND c.user_id = $2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await.ok().flatten();

    let eff_rank = effective_rank_for_compilation(&state.db, &claims, id).await;
    if let Some(rank) = classification_rank {
        if eff_rank < rank {
            crate::services::audit::log_access(&state.db, &claims, "entity.read",
                "entity", &name, eff_rank, None, false, Some("insufficient clearance")).await;
            return Err(AppError::Forbidden("Insufficient clearance".into()));
        }
    }
    crate::services::audit::log_access(&state.db, &claims, "entity.read",
        "entity", &name, eff_rank, None, true, None).await;

    let user_id_str = claims.sub.to_string();
    let job_strs: Vec<String> = source_job_ids.iter().map(|u| u.to_string()).collect();

    // 2. Build scope clause — mirrors get_graph.
    let where_clause = if source_job_ids.is_empty() {
        "n._owner = $uid"
    } else {
        "n._source_job IN $jobIds"
    };

    // 3. Run the Cypher. `name` is bound as a parameter — never interpolated, so
    //    spaces / slashes / newlines / unicode in the name are all safe.
    //    Per-element clearance gates the entity itself. When several nodes share
    //    the same name (common after extraction before fusion), pick the
    //    CANONICAL one DETERMINISTICALLY: highest total degree first, then lowest
    //    internal id as a stable tie-break — never an arbitrary `LIMIT 1`.
    let cypher = format!(
        "MATCH (n {{name: $name}}) WHERE {where_clause} AND coalesce(n._min_rank,0) <= $rank \
         OPTIONAL MATCH (n)-[ro]->() \
         OPTIONAL MATCH ()-[ri]->(n) \
         WITH n, count(DISTINCT ro) AS outDegree, count(DISTINCT ri) AS inDegree \
         ORDER BY (outDegree + inDegree) DESC, id(n) ASC \
         RETURN n, outDegree, inDegree LIMIT 1"
    );

    let mut stream = state.neo
        .execute(
            neo_query(&cypher)
                .param("name", name.clone())
                .param("uid", user_id_str)
                .param("jobIds", job_strs)
                .param("rank", eff_rank as i64),
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let row = stream.next().await.map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(row) = row else { return Err(AppError::NotFound); };

    let n: Node = row.get::<Node>("n").map_err(|_| AppError::NotFound)?;
    let out_degree: i64 = row.get::<i64>("outDegree").unwrap_or(0);
    let in_degree:  i64 = row.get::<i64>("inDegree").unwrap_or(0);

    let node_json = node_to_json(&n);
    let props     = node_props(&n);

    // Extract `_source_job` from node properties for the postgres enrichment
    // step. Neo4j only stores the most-recent extraction — that's by design.
    let source_job_uuid: Option<Uuid> = props.get("_source_job")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok());

    // 4. Postgres enrichment — file name + created_at for the source job.
    let last_source_job: Value = if let Some(sj_id) = source_job_uuid {
        let row: Option<(Uuid, String, Option<String>, Option<String>, chrono::DateTime<chrono::Utc>)> =
            sqlx::query_as(
                "SELECT id, type,
                        input->>'fileName' AS file_name,
                        input->>'text'     AS text_input,
                        created_at
                   FROM jobs
                  WHERE id = $1 AND user_id = $2"
            ).bind(sj_id).bind(claims.sub).fetch_optional(&state.db).await?;
        match row {
            Some((jid, jtype, file_name, text_input, created_at)) => {
                // Fall back to a truncated text preview when no fileName
                // (i.e. raw text extraction, not file upload).
                let source = file_name.unwrap_or_else(|| {
                    text_input
                        .map(|t| {
                            let trimmed: String = t.chars().take(60).collect();
                            if t.chars().count() > 60 { format!("{trimmed}…") } else { trimmed }
                        })
                        .unwrap_or_else(|| "(unknown source)".into())
                });
                json!({ "id": jid, "type": jtype, "source": source, "createdAt": created_at })
            }
            None => Value::Null,
        }
    } else {
        Value::Null
    };

    // 5. Chunk count — text chunks mentioning this entity that the caller may
    //    see (same structured-OR-ILIKE match + clearance filter as /kex/chunks).
    let chunk_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM text_chunks
          WHERE user_id = $1
            AND COALESCE(min_rank, 0) <= $3
            AND (
                 entity_mentions @> jsonb_build_array(jsonb_build_object('name', $2))
              OR content ILIKE '%' || $2 || '%'
            )"
    ).bind(claims.sub).bind(&name).bind(eff_rank).fetch_one(&state.db).await.unwrap_or(0);

    // 6. Compose the response — reuse fields from node_to_json, add the extras.
    Ok(Json(json!({
        "entity": {
            "id":            node_json.get("id").cloned().unwrap_or(Value::Null),
            "name":          name,
            "label":         node_json.get("label").cloned().unwrap_or(Value::Null),
            "type":          node_json.get("type").cloned().unwrap_or(Value::Null),
            "properties":    node_json.get("properties").cloned().unwrap_or(Value::Null),
            "inDegree":      in_degree,
            "outDegree":     out_degree,
            "chunkCount":    chunk_count,
            "lastSourceJob": last_source_job,
        }
    })))
}

// ── A2 + A3: Entity dossiers (the HOT memory tier) ────────────────────────────
//
// A dossier is a compiled, authoritative per-entity memory: an LLM-synthesized
// summary, the entity's relations as key_facts (with confidence), the origin
// files it came from, and a timeline. It is the highest-trust block injected at
// the TOP of the RAG/agent prompt (A3) so "who is X / where does X come from" is
// answered directly, never hedged.
//
// `GET /api/kg/dossier?name=X` returns the dossier, building it on-the-fly via
// FUSE when missing (owner + clearance scoped). `POST /api/kg/dossier/pin`
// toggles the `pinned` flag.

#[derive(serde::Serialize, sqlx::FromRow)]
pub(crate) struct Dossier {
    pub id:            Uuid,
    pub entity_uri:    String,
    pub entity_name:   String,
    pub summary:       String,
    pub key_facts:     Value,
    pub origin_files:  Vec<String>,
    pub timeline:      Value,
    pub trust:         f32,
    pub pinned:        bool,
    pub heat:          f32,
    pub access_count:  i32,
}

/// Fetch a stored dossier for (user, entity name), case-insensitive. Returns the
/// highest-heat match when several share a name (different source discriminators).
pub(crate) async fn fetch_dossier_row(
    db: &sqlx::PgPool,
    user_id: Uuid,
    name: &str,
) -> Option<Dossier> {
    sqlx::query_as::<_, Dossier>(
        "SELECT id, entity_uri, entity_name, summary, key_facts, origin_files, \
                timeline, trust, pinned, heat, access_count \
           FROM entity_dossiers \
          WHERE user_id = $1 AND lower(entity_name) = lower($2) \
            AND archived = false \
          ORDER BY pinned DESC, heat DESC, updated_at DESC LIMIT 1"
    ).bind(user_id).bind(name).fetch_optional(db).await.ok().flatten()
}

/// Ask FUSE to build/refresh a dossier for one named entity (on-the-fly path).
/// Returns Ok(Some) when built, Ok(None) when the user owns no such entity.
pub(crate) async fn build_dossier_via_fuse(
    state: &Arc<crate::models::AppState>,
    user_id: Uuid,
    name: &str,
) -> Result<Option<()>> {
    let url = format!("{}/dossier/build", state.cfg.fuse_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&json!({ "user_id": user_id.to_string(), "entity_name": name }))
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("FUSE unreachable: {e}")))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let st = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("FUSE dossier build failed ({st}): {body}")));
    }
    Ok(Some(()))
}

/// Bump heat / access_count / last_accessed on a dossier that was just injected
/// or read. A3 calls this on every hot-block injection so A4's decay worker has
/// live signal. Best-effort — never fails the request.
pub(crate) async fn bump_dossier_heat(db: &sqlx::PgPool, dossier_id: Uuid) {
    // A4: a fresh access also REVIVES a soft-archived dossier (archived → false),
    // so eviction is reversible the moment a cold entity becomes relevant again.
    let _ = sqlx::query(
        "UPDATE entity_dossiers \
            SET heat = heat + 1.0, access_count = access_count + 1, \
                last_accessed = NOW(), archived = false \
          WHERE id = $1"
    ).bind(dossier_id).execute(db).await;
}

#[derive(Deserialize)]
struct DossierQuery { name: String }

async fn get_dossier(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<DossierQuery>,
) -> Result<Json<Value>> {
    let name = q.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }

    // 1. Try the stored dossier. 2. Build on-the-fly via FUSE if missing. 3. Re-read.
    let mut row = fetch_dossier_row(&state.db, claims.sub, &name).await;
    if row.is_none() {
        match build_dossier_via_fuse(&state, claims.sub, &name).await? {
            Some(()) => { row = fetch_dossier_row(&state.db, claims.sub, &name).await; }
            None => return Err(AppError::NotFound),
        }
    }
    let Some(d) = row else { return Err(AppError::NotFound); };

    // Reading a dossier counts as a hot access (drives A4 heat/decay).
    bump_dossier_heat(&state.db, d.id).await;
    crate::services::audit::log_access(&state.db, &claims, "dossier.read",
        "dossier", &d.entity_name, 0, None, true, None).await;

    Ok(Json(json!({
        "id":           d.id,
        "entityUri":    d.entity_uri,
        "entityName":   d.entity_name,
        "summary":      d.summary,
        "keyFacts":     d.key_facts,
        "originFiles":  d.origin_files,
        "timeline":     d.timeline,
        "trust":        d.trust,
        "pinned":       d.pinned,
        "heat":         d.heat,
        "accessCount":  d.access_count + 1,
    })))
}

#[derive(Deserialize)]
struct PinReq {
    name: String,
    #[serde(default)] pinned: Option<bool>,
}

async fn pin_dossier(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<PinReq>,
) -> Result<Json<Value>> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let Some(d) = fetch_dossier_row(&state.db, claims.sub, &name).await else {
        return Err(AppError::NotFound);
    };
    // Explicit value, or toggle the current state.
    let new_pinned = req.pinned.unwrap_or(!d.pinned);
    sqlx::query("UPDATE entity_dossiers SET pinned = $1, updated_at = NOW() WHERE id = $2")
        .bind(new_pinned).bind(d.id).execute(&state.db).await?;
    crate::services::audit::log_access(&state.db, &claims, "dossier.pin",
        "dossier", &d.entity_name, 0, None, true, None).await;
    Ok(Json(json!({ "entityName": d.entity_name, "pinned": new_pinned })))
}

// ── A3: hot-block rendering for prompt injection ──────────────────────────────

/// Render a dossier as a labeled HOT, authoritative prompt block. Used by both the
/// RAG fast path and the agent/deep path so the trust tier is explicit + STRUCTURAL
/// (the block is ordered above retrieved chunks AND labeled with its trust tier),
/// not just prompt wording.
pub(crate) fn render_dossier_block(d: &Dossier) -> String {
    let mut s = String::new();
    let tier = if d.pinned { "PINNED / DOSSIER (authoritative)" } else { "DOSSIER (authoritative)" };
    s.push_str(&format!(
        "=== HOT BLOCK · TRUST TIER 1 · {tier} · trust={:.2} ===\n",
        d.trust
    ));
    s.push_str(&format!("Entity: {}\n", d.entity_name));
    if !d.summary.is_empty() {
        s.push_str(&format!("Summary: {}\n", d.summary));
    }
    if let Some(facts) = d.key_facts.as_array() {
        if !facts.is_empty() {
            s.push_str("Key facts:\n");
            for f in facts.iter().take(15) {
                let rel = f.get("rel").and_then(|v| v.as_str()).unwrap_or("");
                let tgt = f.get("target").and_then(|v| v.as_str()).unwrap_or("");
                let dir = f.get("direction").and_then(|v| v.as_str()).unwrap_or("out");
                let conf = f.get("confidence").and_then(|v| v.as_f64());
                let arrow = if dir == "in" { "←" } else { "→" };
                let rel_h = rel.replace('_', " ").to_lowercase();
                match conf {
                    Some(c) => s.push_str(&format!(
                        "  - {} {rel_h} {arrow} {} (confidence {:.2})\n", d.entity_name, tgt, c)),
                    None => s.push_str(&format!(
                        "  - {} {rel_h} {arrow} {}\n", d.entity_name, tgt)),
                }
            }
        }
    }
    if !d.origin_files.is_empty() {
        s.push_str(&format!("Origin files: {}\n", d.origin_files.join(", ")));
    }
    if let Some(tl) = d.timeline.as_array() {
        if !tl.is_empty() {
            s.push_str("Timeline:\n");
            for t in tl.iter().take(10) {
                let fact = t.get("fact").and_then(|v| v.as_str()).unwrap_or("");
                s.push_str(&format!("  - {fact}\n"));
            }
        }
    }
    s.push_str("=== END HOT BLOCK ===\n");
    s
}

/// Resolve which of the caller's dossiers a free-text query REFERENCES, by
/// case-insensitive word-boundary match of each dossier's entity_name against the
/// query. Returns the matched dossier entity names (longest first, so "Ground
/// Control" wins over "Control"). This is the A3 query→dossier linker; it runs
/// BEFORE retrieval so the hot block can be injected at the top of the prompt.
pub(crate) async fn dossiers_referenced_by_query(
    db: &sqlx::PgPool,
    user_id: Uuid,
    query: &str,
) -> Vec<String> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT entity_name FROM entity_dossiers \
          WHERE user_id = $1 AND archived = false"
    ).bind(user_id).fetch_all(db).await.unwrap_or_default();
    let q_lower = query.to_lowercase();
    let mut matched: Vec<String> = names
        .into_iter()
        .filter(|n| {
            let nl = n.to_lowercase();
            if nl.is_empty() { return false; }
            // Word-boundary-ish containment: the name appears, bounded by non-alnum.
            match q_lower.find(&nl) {
                Some(idx) => {
                    let before_ok = idx == 0
                        || !q_lower.as_bytes()[idx - 1].is_ascii_alphanumeric();
                    let after = idx + nl.len();
                    let after_ok = after >= q_lower.len()
                        || !q_lower.as_bytes()[after].is_ascii_alphanumeric();
                    before_ok && after_ok
                }
                None => false,
            }
        })
        .collect();
    matched.sort_by_key(|n| std::cmp::Reverse(n.len()));
    matched
}

/// A3 entry point for the RAG/agent paths: given the caller and a set of candidate
/// entity names referenced by the query, return the rendered hot block(s) for any
/// that HAVE a dossier (or pinned fact), most-trusted first, and bump their heat.
/// Returns (rendered_block, matched_entity_names). Empty when none match — the
/// caller then falls through to ordinary hybrid retrieval (no regression).
pub(crate) async fn collect_hot_blocks(
    state: &Arc<crate::models::AppState>,
    user_id: Uuid,
    candidate_names: &[String],
    max_blocks: usize,
) -> (String, Vec<String>) {
    let mut blocks: Vec<(f32, bool, String, Uuid)> = Vec::new();
    let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    for name in candidate_names {
        if name.trim().is_empty() { continue; }
        if let Some(d) = fetch_dossier_row(&state.db, user_id, name).await {
            if seen.insert(d.id) {
                let rendered = render_dossier_block(&d);
                blocks.push((d.trust, d.pinned, rendered, d.id));
            }
        }
    }
    // Rank: pinned first, then trust desc.
    blocks.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)));
    blocks.truncate(max_blocks);

    let mut matched: Vec<String> = Vec::new();
    let mut out = String::new();
    for (_, _, rendered, id) in &blocks {
        out.push_str(rendered);
        out.push('\n');
        bump_dossier_heat(&state.db, *id).await;
    }
    // Extract matched entity names from the blocks for logging/trace.
    for name in candidate_names {
        if fetch_dossier_row(&state.db, user_id, name).await.is_some() {
            matched.push(name.clone());
        }
    }
    (out, matched)
}

// ── Graph mutation: correct / edit the knowledge graph ────────────────────────
//
// These endpoints let a user (or the Pi agent on their behalf) FIX the graph
// when it carries a falsehood — e.g. a hallucinated `Fabio -[co_founder_of]->
// Codex` edge. Deleting a relationship/node:
//   1. removes it from Neo4j immediately (scoped to the caller's owned graph), and
//   2. records the correction in `knowledge_corrections` so re-extraction of the
//      same source never re-introduces it ("remember").
// All mutations are owner-or-admin only and audited. Relationship types are
// matched via `type(r) = $rel` (parameter-safe) for deletes; for ADD the type
// must be interpolated, so it is validated with `is_valid_neo4j_label` first.

/// Resolve the Neo4j mutation scope for a compilation the caller may EDIT.
/// Owner, or admin (who may edit any user's graph). Returns the compilation's
/// `source_job_ids` (empty = the owner's full graph) plus the owner's uid — node
/// scoping uses the OWNER's uid because that is what `_owner` carries, and any
/// recorded correction is tied to the owner (re-extraction runs as them).
async fn resolve_mutation_scope(
    db: &sqlx::PgPool,
    claims: &JwtClaims,
    compilation_id: Uuid,
) -> Result<(Vec<Uuid>, Uuid)> {
    // KB-scope gate (covers BOTH the REST handlers and the agent-tool wrappers,
    // since add/delete-relationship and delete-node both route through here): a
    // KB-scoped access token may only mutate compilations in its grant set.
    enforce_kb_write_scope(db, claims, compilation_id).await?;
    let owned: Option<(Vec<Uuid>,)> = sqlx::query_as(
        "SELECT COALESCE(source_job_ids,'{}'::uuid[]) FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(compilation_id).bind(claims.sub).fetch_optional(db).await?;
    if let Some((jobs,)) = owned {
        return Ok((jobs, claims.sub));
    }
    if claims.role == "admin" {
        let any: Option<(Vec<Uuid>, Uuid)> = sqlx::query_as(
            "SELECT COALESCE(source_job_ids,'{}'::uuid[]), user_id FROM compilations WHERE id=$1"
        ).bind(compilation_id).fetch_optional(db).await?;
        if let Some((jobs, owner)) = any { return Ok((jobs, owner)); }
    }
    Err(AppError::NotFound)
}

#[derive(Deserialize)]
struct RelMutation {
    #[serde(rename = "compilationId")] compilation_id: Uuid,
    head: String,
    #[serde(rename = "relType")] rel_type: String,
    tail: String,
    reason: Option<String>,
}

/// Core: delete a (head)-[rel]->(tail) edge from the owner's graph and remember
/// the correction. Shared by the HTTP handler and the Pi agent tool. Returns the
/// number of edges deleted (0 if it wasn't there — the correction is still kept).
pub(crate) async fn delete_relationship_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    compilation_id: Uuid,
    head: &str,
    rel: &str,
    tail: &str,
    reason: Option<&str>,
) -> Result<i64> {
    let (head, tail, rel) = (head.trim(), tail.trim(), rel.trim());
    if head.is_empty() || tail.is_empty() || rel.is_empty() {
        return Err(AppError::BadRequest("head, relType and tail are required".into()));
    }
    let (jobs, owner) = resolve_mutation_scope(&state.db, claims, compilation_id).await?;
    let owner_str = owner.to_string();
    let job_strs: Vec<String> = jobs.iter().map(|u| u.to_string()).collect();
    let scope = if jobs.is_empty() { "a._owner = $uid" } else { "a._source_job IN $jobIds" };

    // Match the edge, collect, FOREACH-delete, return the count (clean even after delete).
    let cypher = format!(
        "MATCH (a {{name: $head}})-[r]->(b {{name: $tail}}) \
         WHERE type(r) = $rel AND {scope} \
         WITH collect(r) AS rels \
         FOREACH (x IN rels | DELETE x) \
         RETURN size(rels) AS deleted"
    );
    let mut stream = state.neo.execute(
        neo_query(&cypher)
            .param("head", head.to_string())
            .param("tail", tail.to_string())
            .param("rel",  rel.to_string())
            .param("uid",  owner_str)
            .param("jobIds", job_strs),
    ).await.map_err(|e| AppError::Internal(e.to_string()))?;
    let deleted: i64 = match stream.next().await.map_err(|e| AppError::Internal(e.to_string()))? {
        Some(row) => row.get::<i64>("deleted").unwrap_or(0),
        None => 0,
    };

    // Remember the correction (always — the caller asserted it is false) so the KEX
    // relation writer skips it on every future extraction.
    sqlx::query(
        "INSERT INTO knowledge_corrections
            (user_id, compilation_id, element_kind, head, rel_type, tail, action, reason)
         VALUES ($1,$2,'edge',$3,$4,$5,'delete',$6)"
    ).bind(owner).bind(compilation_id)
     .bind(head).bind(rel).bind(tail).bind(reason)
     .execute(&state.db).await?;

    let eff = effective_rank_for_compilation(&state.db, claims, compilation_id).await;
    crate::services::audit::log_access(&state.db, claims, "graph.delete_relationship",
        "compilation", &compilation_id.to_string(), eff, None, true, None).await;
    Ok(deleted)
}

/// DELETE /api/kg/relationship  — remove a (head)-[relType]->(tail) edge and
/// remember the correction so it is never re-extracted. Idempotent.
async fn delete_relationship(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<RelMutation>,
) -> Result<Json<Value>> {
    let deleted = delete_relationship_core(
        &state, &claims, req.compilation_id, &req.head, &req.rel_type, &req.tail,
        req.reason.as_deref(),
    ).await?;
    Ok(Json(json!({ "ok": true, "deleted": deleted, "remembered": true })))
}

/// Core: add a (head)-[rel]->(tail) edge between two existing entities. Shared by
/// the HTTP handler and the agent tool. Returns the number of edges created.
pub(crate) async fn add_relationship_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    compilation_id: Uuid,
    head: &str,
    rel: &str,
    tail: &str,
) -> Result<i64> {
    let (head, tail, rel) = (head.trim(), tail.trim(), rel.trim());
    if head.is_empty() || tail.is_empty() || rel.is_empty() {
        return Err(AppError::BadRequest("head, relType and tail are required".into()));
    }
    // Relationship type cannot be parametrised in Cypher — validate to prevent injection.
    if !is_valid_neo4j_label(rel) {
        return Err(AppError::BadRequest(
            "Invalid relType (letters, digits, underscore; must start with a letter)".into()));
    }
    let (jobs, owner) = resolve_mutation_scope(&state.db, claims, compilation_id).await?;
    let owner_str = owner.to_string();
    let job_strs: Vec<String> = jobs.iter().map(|u| u.to_string()).collect();
    let scope = if jobs.is_empty() {
        "a._owner = $uid AND b._owner = $uid"
    } else {
        "a._source_job IN $jobIds AND b._source_job IN $jobIds"
    };

    let cypher = format!(
        "MATCH (a {{name: $head}}), (b {{name: $tail}}) WHERE {scope} \
         MERGE (a)-[r:{rel}]->(b) \
         ON CREATE SET r._owner = $uid, r._min_rank = 0, r._manual = true \
         RETURN count(r) AS created"
    );
    let mut stream = state.neo.execute(
        neo_query(&cypher)
            .param("head", head.to_string())
            .param("tail", tail.to_string())
            .param("uid",  owner_str)
            .param("jobIds", job_strs),
    ).await.map_err(|e| AppError::Internal(e.to_string()))?;
    let created: i64 = match stream.next().await.map_err(|e| AppError::Internal(e.to_string()))? {
        Some(row) => row.get::<i64>("created").unwrap_or(0),
        None => 0,
    };
    if created == 0 {
        return Err(AppError::BadRequest(
            "Could not add relationship — head or tail entity not found in this graph".into()));
    }
    let eff = effective_rank_for_compilation(&state.db, claims, compilation_id).await;
    crate::services::audit::log_access(&state.db, claims, "graph.add_relationship",
        "compilation", &compilation_id.to_string(), eff, None, true, None).await;
    Ok(created)
}

/// POST /api/kg/relationship  — manually add a (head)-[relType]->(tail) edge
/// between two existing entities the caller owns.
async fn add_relationship(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<RelMutation>,
) -> Result<Json<Value>> {
    let created = add_relationship_core(
        &state, &claims, req.compilation_id, &req.head, &req.rel_type, &req.tail,
    ).await?;
    Ok(Json(json!({ "ok": true, "created": created })))
}

#[derive(Deserialize)]
struct NodeMutation {
    #[serde(rename = "compilationId")] compilation_id: Uuid,
    name: String,
    reason: Option<String>,
}

/// Core: detach-delete an entity from the owner's graph and remember it. Shared
/// by the HTTP handler and the agent tool. Returns the number of nodes deleted.
pub(crate) async fn delete_node_core(
    state: &Arc<crate::models::AppState>,
    claims: &JwtClaims,
    compilation_id: Uuid,
    name: &str,
    reason: Option<&str>,
) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let (jobs, owner) = resolve_mutation_scope(&state.db, claims, compilation_id).await?;
    let owner_str = owner.to_string();
    let job_strs: Vec<String> = jobs.iter().map(|u| u.to_string()).collect();
    let scope = if jobs.is_empty() { "n._owner = $uid" } else { "n._source_job IN $jobIds" };

    let cypher = format!(
        "MATCH (n {{name: $name}}) WHERE {scope} \
         WITH collect(n) AS ns \
         FOREACH (x IN ns | DETACH DELETE x) \
         RETURN size(ns) AS deleted"
    );
    let mut stream = state.neo.execute(
        neo_query(&cypher)
            .param("name", name.to_string())
            .param("uid",  owner_str)
            .param("jobIds", job_strs),
    ).await.map_err(|e| AppError::Internal(e.to_string()))?;
    let deleted: i64 = match stream.next().await.map_err(|e| AppError::Internal(e.to_string()))? {
        Some(row) => row.get::<i64>("deleted").unwrap_or(0),
        None => 0,
    };

    sqlx::query(
        "INSERT INTO knowledge_corrections
            (user_id, compilation_id, element_kind, head, action, reason)
         VALUES ($1,$2,'node',$3,'delete',$4)"
    ).bind(owner).bind(compilation_id).bind(name).bind(reason)
     .execute(&state.db).await?;

    let eff = effective_rank_for_compilation(&state.db, claims, compilation_id).await;
    crate::services::audit::log_access(&state.db, claims, "graph.delete_node",
        "compilation", &compilation_id.to_string(), eff, None, true, None).await;
    Ok(deleted)
}

/// DELETE /api/kg/node  — detach-delete an entity (and remember it).
async fn delete_node(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<NodeMutation>,
) -> Result<Json<Value>> {
    let deleted = delete_node_core(
        &state, &claims, req.compilation_id, &req.name, req.reason.as_deref(),
    ).await?;
    Ok(Json(json!({ "ok": true, "deleted": deleted, "remembered": true })))
}

/// GET /api/kg/corrections  — list the caller's recorded corrections (audit/UI).
async fn list_corrections(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (
        Uuid, Option<Uuid>, String, String, Option<String>, Option<String>, String, Option<String>,
        chrono::DateTime<chrono::Utc>
    )>(
        "SELECT id, compilation_id, element_kind, head, rel_type, tail, action, reason, created_at
           FROM knowledge_corrections WHERE user_id = $1
          ORDER BY created_at DESC LIMIT 200"
    ).bind(claims.sub).fetch_all(&state.db).await?;
    let items: Vec<Value> = rows.into_iter().map(
        |(id, comp, kind, head, rel, tail, action, reason, created)| json!({
            "id": id, "compilationId": comp, "elementKind": kind,
            "head": head, "relType": rel, "tail": tail,
            "action": action, "reason": reason, "createdAt": created,
        })
    ).collect();
    Ok(Json(json!({ "corrections": items })))
}

// ── Data lineage endpoints ────────────────────────────────────────────────────

/// GET /compilations/:id/lineage
/// Returns the provenance chain for a compilation — which jobs contributed to
/// it, and what sources those jobs came from.  Response is a node/edge graph
/// suitable for direct rendering in the LineagePage DAG visualiser.
async fn get_compilation_lineage(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // Clearance check first: ensure the user can access this compilation
    // (base clearance raised by any per-graph grant on the token).
    let clearance_rank = effective_rank_for_compilation(&state.db, &claims, id).await;

    let comp = sqlx::query_as::<_, (Uuid, String, Option<Uuid>)>(
        "SELECT c.id, c.name, c.classification_level_id FROM compilations c
         LEFT JOIN classification_levels cl ON c.classification_level_id = cl.id
         WHERE c.id = $1 AND c.user_id = $2
           AND (cl.rank IS NULL OR cl.rank <= $3)"
    ).bind(id).bind(claims.sub).bind(clearance_rank)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;

    // Jobs that contributed to this compilation (via compilationId in input or result).
    let jobs = sqlx::query_as::<_, (Uuid, String, String, Value, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, type, status, input, created_at FROM jobs
         WHERE user_id = $1 AND (
           (input->>'compilationId' = $2) OR
           (result->>'compilationId' = $2)
         )
         ORDER BY created_at DESC LIMIT 50"
    ).bind(claims.sub).bind(id.to_string())
    .fetch_all(&state.db).await.unwrap_or_default();

    let compilation_node = json!({
        "id":   format!("comp:{}", comp.0),
        "type": "compilation",
        "label": comp.1,
        "data": { "compilationId": comp.0 }
    });

    let job_nodes: Vec<Value> = jobs.iter().map(|(jid, jtype, status, input, created)| {
        let source = input.get("fileName")
            .or_else(|| input.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        json!({
            "id":    format!("job:{}", jid),
            "type":  "job",
            "label": format!("{}: {}", jtype.replace("kex_", ""), source),
            "data":  { "jobId": jid, "jobType": jtype, "status": status, "createdAt": created }
        })
    }).collect();

    let mut nodes = vec![compilation_node];
    nodes.extend(job_nodes);

    let edges: Vec<Value> = jobs.iter().map(|(jid, _, _, _, _)| json!({
        "id":     format!("job:{}-comp:{}", jid, comp.0),
        "source": format!("job:{}", jid),
        "target": format!("comp:{}", comp.0),
        "label":  "contributed_to"
    })).collect();

    Ok(Json(json!({
        "nodes":           nodes,
        "edges":           edges,
        "compilationId":   comp.0,
        "compilationName": comp.1,
    })))
}

// ── KG export endpoint ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ExportQuery {
    format: Option<String>,
}

/// GET /compilations/:id/export?format=jsonld|rdf-turtle|graphml
/// Exports the compilation's knowledge graph in the requested format.
/// Default format is JSON-LD.
async fn export_compilation(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Query(q): Query<ExportQuery>,
) -> Result<axum::response::Response> {
    use axum::response::IntoResponse;
    use axum::http::header;

    let clearance_rank = effective_rank_for_compilation(&state.db, &claims, id).await;

    // Fetch compilation + clearance check
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT c.name FROM compilations c
         LEFT JOIN classification_levels cl ON c.classification_level_id = cl.id
         WHERE c.id = $1 AND c.user_id = $2 AND (cl.rank IS NULL OR cl.rank <= $3)"
    )
    .bind(id)
    .bind(claims.sub)
    .bind(clearance_rank)
    .fetch_optional(&state.db)
    .await?;

    let (comp_name,) = row.ok_or(AppError::NotFound)?;

    // Fetch graph data from Neo4j — per-element clearance gates the export too.
    let mut rows = state.neo.execute(
        neo4rs::query(
            "MATCH (n {compilation_id: $cid}) WHERE coalesce(n._min_rank,0) <= $rank \
             OPTIONAL MATCH (n)-[r]->(m {compilation_id: $cid}) \
               WHERE coalesce(m._min_rank,0) <= $rank AND coalesce(r._min_rank,0) <= $rank \
             RETURN n, r, m LIMIT 5000"
        ).param("cid", id.to_string().as_str()).param("rank", clearance_rank as i64)
    ).await.map_err(|e| AppError::Internal(e.to_string()))?;

    let mut nodes: Vec<(String, String, String)> = vec![]; // (id, name, type)
    let mut edges: Vec<(String, String, String)> = vec![]; // (from_id, to_id, rel_type)
    let mut seen_nodes: std::collections::HashSet<i64> = std::collections::HashSet::new();

    while let Ok(Some(row)) = rows.next().await {
        if let Ok(n) = row.get::<neo4rs::Node>("n") {
            if seen_nodes.insert(n.id()) {
                let nid = n.id().to_string();
                let name = n.get::<String>("name").unwrap_or_else(|_| nid.clone());
                let ntype = n.labels().first().copied().unwrap_or("Node").to_string();
                nodes.push((nid, name, ntype));
            }
        }
        if let Ok(r) = row.get::<neo4rs::Relation>("r") {
            if let Ok(m) = row.get::<neo4rs::Node>("m") {
                edges.push((
                    r.start_node_id().to_string(),
                    m.id().to_string(),
                    r.typ().to_string(),
                ));
            }
        }
    }

    let format = q.format.as_deref().unwrap_or("jsonld");
    match format {
        "jsonld" => {
            let graph: Vec<serde_json::Value> = nodes.iter().map(|(nid, name, ntype)| {
                serde_json::json!({
                    "@id":   format!("gctrl:{nid}"),
                    "@type": ntype,
                    "name":  name,
                })
            }).collect();
            let body = serde_json::to_string_pretty(&serde_json::json!({
                "@context": { "@vocab": "https://schema.org/" },
                "@graph": graph,
            })).unwrap_or_default();
            let disposition = format!("attachment; filename=\"{comp_name}.jsonld\"");
            Ok((
                [
                    (header::CONTENT_TYPE, "application/ld+json".to_string()),
                    (header::CONTENT_DISPOSITION, disposition),
                ],
                body,
            ).into_response())
        }
        "rdf-turtle" => {
            let mut ttl = format!(
                "@prefix gctrl: <https://gctrl.tech/kg/> .\n\
                 @prefix schema: <https://schema.org/> .\n\n"
            );
            for (nid, name, ntype) in &nodes {
                ttl.push_str(&format!(
                    "gctrl:{nid} a schema:{ntype} ;\n  schema:name \"{name}\" .\n\n"
                ));
            }
            for (from, to, rel) in &edges {
                ttl.push_str(&format!("gctrl:{from} gctrl:{rel} gctrl:{to} .\n"));
            }
            let disposition = format!("attachment; filename=\"{comp_name}.ttl\"");
            Ok((
                [
                    (header::CONTENT_TYPE, "text/turtle".to_string()),
                    (header::CONTENT_DISPOSITION, disposition),
                ],
                ttl,
            ).into_response())
        }
        "graphml" => {
            let mut xml = String::from(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
                 <graphml xmlns=\"http://graphml.graphdrawing.org/graphml\">\n\
                 <graph id=\"G\" edgedefault=\"directed\">\n"
            );
            for (nid, name, ntype) in &nodes {
                let safe_name = name
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;");
                xml.push_str(&format!(
                    "<node id=\"{nid}\"><data key=\"name\">{safe_name}</data>\
                     <data key=\"type\">{ntype}</data></node>\n"
                ));
            }
            for (i, (from, to, rel)) in edges.iter().enumerate() {
                xml.push_str(&format!(
                    "<edge id=\"e{i}\" source=\"{from}\" target=\"{to}\">\
                     <data key=\"type\">{rel}</data></edge>\n"
                ));
            }
            xml.push_str("</graph>\n</graphml>");
            let disposition = format!("attachment; filename=\"{comp_name}.graphml\"");
            Ok((
                [
                    (header::CONTENT_TYPE, "application/xml".to_string()),
                    (header::CONTENT_DISPOSITION, disposition),
                ],
                xml,
            ).into_response())
        }
        _ => Err(AppError::BadRequest("format must be jsonld, rdf-turtle, or graphml".into())),
    }
}

/// GET /graph/entity/:name/lineage
/// Light provenance view — finds which compilations in Neo4j contain this
/// entity name and returns a simple node/edge graph.
async fn entity_lineage(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(name): Path<String>,
) -> Result<Json<Value>> {
    let clearance_rank = get_user_clearance_rank(&state.db, &claims).await;
    let uid = claims.sub.to_string();

    // Filter to compilations owned by this user AND within clearance.
    // Prevents cross-tenant entity enumeration.
    let cypher = "MATCH (e {name: $name})-[:PART_OF]->(c) \
                  WHERE c.user_id = $uid \
                  OPTIONAL MATCH (c)-[:HAS_LEVEL]->(cl) \
                  WITH e, c WHERE cl IS NULL OR cl.rank <= $rank \
                  RETURN e.name AS entity_name, collect(c.compilation_id) AS comp_ids LIMIT 1";

    let comp_ids: Vec<String> = match state.neo
        .execute(
            neo_query(cypher)
                .param("name", name.as_str())
                .param("uid", uid.as_str())
                .param("rank", clearance_rank as i64),
        )
        .await
    {
        Ok(mut rows) => match rows.next().await {
            Ok(Some(row)) => row.get::<Vec<String>>("comp_ids").unwrap_or_default(),
            _ => vec![],
        },
        Err(_) => vec![],
    };

    // Entity node (root of the lineage).
    let entity_node = json!({
        "id":    format!("entity:{name}"),
        "type":  "entity",
        "label": name,
    });

    // One compilation node per containing graph.
    let comp_nodes: Vec<Value> = comp_ids.iter().map(|cid| json!({
        "id":    format!("comp:{cid}"),
        "type":  "compilation",
        "label": cid,
    })).collect();

    // Edges: entity → compilation.
    let edges: Vec<Value> = comp_ids.iter().map(|cid| json!({
        "id":     format!("entity:{name}-comp:{cid}"),
        "source": format!("entity:{name}"),
        "target": format!("comp:{cid}"),
        "label":  "in_graph",
    })).collect();

    let mut nodes = vec![entity_node];
    nodes.extend(comp_nodes);

    Ok(Json(json!({ "nodes": nodes, "edges": edges })))
}

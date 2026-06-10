use axum::{extract::{Extension, Path, Query, State}, routing::{delete, get, post, put}, Json, Router};
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

#[derive(Deserialize)]
struct CreateComp {
    name: String,
    description: Option<String>,
    classification: Option<String>,
    #[serde(rename = "sourceJobIds")] source_job_ids: Option<Vec<Uuid>>,
}

#[derive(Deserialize)]
struct ListQuery { limit: Option<i64>, offset: Option<i64> }

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/compilations",                         get(list).post(create))
        .route("/compilations/:id",                     get(get_one).put(update).delete(delete_one))
        .route("/compilations/:id/refresh",             post(refresh))
        .route("/compilations/:id/schedule",            put(set_schedule))
        .route("/compilations/:id/audit",               get(get_audit))
        .route("/compilations/:id/acl",                 get(get_acl).put(set_acl))
        .route("/compilations/:id/graph",               get(get_graph))
        .route("/compilations/:id/entity/:name",        get(entity_detail))
        .route("/graph/search",                         get(graph_search))
        .route("/graph/entity/:name/neighbors",         get(entity_neighbors))
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
    json!({
        "id":         n.id().to_string(),
        "label":      label,
        "type":       node_type,
        "properties": props,
    })
}

/// Serialize a Relation into the canonical graph edge shape:
/// `{ "source": "...", "target": "...", "type": "...", "properties": {...} }`
fn relation_to_json(r: &Relation) -> Value {
    json!({
        "source":     r.start_node_id().to_string(),
        "target":     r.end_node_id().to_string(),
        "type":       r.typ(),
        "properties": rel_props(r),
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
    let limit  = q.limit.unwrap_or(20).min(100);
    let offset = q.offset.unwrap_or(0);
    let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Vec<Uuid>, Option<i32>, Option<i32>, Option<Uuid>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, name, description, classification, COALESCE(source_job_ids, '{}'::uuid[]),
                node_count, edge_count, folder_id, created_at
         FROM compilations WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    ).bind(claims.sub).bind(limit).bind(offset).fetch_all(&state.db).await?;

    let user_id_str = claims.sub.to_string();
    let mut comps: Vec<Value> = Vec::with_capacity(rows.len());
    for (id, n, d, cls, sji, nc, ec, fid, c) in rows {
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
        }));
    }
    Ok(Json(json!({ "compilations": comps })))
}

async fn create(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateComp>,
) -> Result<Json<Value>> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO compilations (id, user_id, name, description, classification, source_job_ids, version) VALUES ($1,$2,$3,$4,$5,$6,1)")
        .bind(id).bind(claims.sub).bind(&req.name).bind(&req.description)
        .bind(req.classification.unwrap_or_else(|| "INTERNAL".into()))
        .bind(req.source_job_ids.unwrap_or_default())
        .execute(&state.db).await?;
    Ok(Json(json!({ "id": id, "name": req.name })))
}

// Frontend KGDetailPage expects `{ compilation: ... }` wrapper with full row fields.
async fn get_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, (
        Uuid, Uuid, String, Option<String>, String, Vec<Uuid>,
        i32, Option<String>, Option<String>, Option<chrono::DateTime<chrono::Utc>>,
        Option<i32>, Option<i32>, Option<Uuid>,
        chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>,
    )>(
        "SELECT id, user_id, name, description, classification,
                COALESCE(source_job_ids, '{}'::uuid[]),
                version, cron_schedule, cron_mode, last_refresh_at,
                node_count, edge_count, folder_id,
                created_at, updated_at
         FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let (
        id, user_id, n, d, cls, sji,
        version, cron_schedule, cron_mode, last_refresh_at,
        nc, ec, fid, created_at, updated_at,
    ) = row;

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
    } })))
}

async fn update(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
    if let Some(name) = req.get("name").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE compilations SET name=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3")
            .bind(name).bind(id).bind(claims.sub).execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM compilations WHERE id=$1 AND user_id=$2").bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn refresh(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
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

// PUT /compilations/:id/schedule  →  update cron schedule + mode.
// Frontend ScheduleTab posts `{ schedule, mode }`; either may be null.
async fn set_schedule(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<Value>,
) -> Result<Json<Value>> {
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
/// Returns all nodes and edges for a compilation, up to `limit` (default 200).
/// Optional `node_type` filters by Neo4j label.
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

    // Validate node_type before interpolating it into the Cypher string.
    // A malicious value like `Foo}) MATCH (n) DETACH DELETE n //` would
    // otherwise allow arbitrary Cypher injection via the label position.
    if let Some(ref nt) = q.node_type {
        if !is_valid_neo4j_label(nt) {
            return Err(AppError::BadRequest("Invalid node_type".into()));
        }
    }

    let limit = q.limit.unwrap_or(200).min(1000);
    let user_id_str = claims.sub.to_string();
    let job_strs: Vec<String> = source_job_ids.iter().map(|u| u.to_string()).collect();

    // Build the WHERE clause based on whether this compilation has explicit
    // source jobs (merge result) or not (default = full user graph).
    let where_clause = if source_job_ids.is_empty() {
        "n._owner = $uid"
    } else {
        "n._source_job IN $jobIds"
    };

    let cypher = match &q.node_type {
        Some(label) => format!(
            "MATCH (n:{label}) WHERE {where_clause} \
             OPTIONAL MATCH (n)-[r]->(m) \
             RETURN n, r, m LIMIT $limit"
        ),
        None => format!(
            "MATCH (n) WHERE {where_clause} \
             OPTIONAL MATCH (n)-[r]->(m) \
             RETURN n, r, m LIMIT $limit"
        ),
    };

    let query_with_params = neo_query(&cypher)
        .param("uid", user_id_str)
        .param("jobIds", job_strs)
        .param("limit", limit);

    let mut stream = state.neo
        .execute(query_with_params)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let mut nodes: Vec<Value>        = Vec::new();
    let mut edges: Vec<Value>        = Vec::new();
    let mut seen_nodes: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut seen_edges: std::collections::HashSet<i64> = std::collections::HashSet::new();

    while let Ok(Some(row)) = stream.next().await {
        // Source node (always present)
        if let Ok(n) = row.get::<Node>("n") {
            if seen_nodes.insert(n.id()) {
                nodes.push(node_to_json(&n));
            }
        }
        // Relationship (optional — NULL when node has no outgoing edges)
        if let Ok(r) = row.get::<Relation>("r") {
            if seen_edges.insert(r.id()) {
                edges.push(relation_to_json(&r));
            }
        }
        // Target node (optional)
        if let Ok(m) = row.get::<Node>("m") {
            if seen_nodes.insert(m.id()) {
                nodes.push(node_to_json(&m));
            }
        }
    }

    Ok(Json(json!({ "nodes": nodes, "edges": edges })))
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

    let cypher = "MATCH (n) \
                  WHERE (n.name CONTAINS $q OR n.label CONTAINS $q) \
                  AND n.user_id = $uid \
                  RETURN n LIMIT $limit";

    let mut stream = state.neo
        .execute(neo_query(cypher).param("q", q.q.clone()).param("uid", uid.clone()).param("limit", limit))
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

    let mut nodes: Vec<Value>        = Vec::new();
    let mut edges: Vec<Value>        = Vec::new();
    let mut seen_nodes: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut seen_rels:  std::collections::HashSet<i64> = std::collections::HashSet::new();

    // Depth-1: anchor → direct neighbour.
    let mut stream = state.neo
        .execute(
            neo_query("MATCH (n {name: $name, user_id: $uid})-[r]-(m) \
                       RETURN n, r, m LIMIT $limit")
                .param("name", name.clone())
                .param("uid", uid.clone())
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
                           RETURN mid AS n, r2 AS r, m LIMIT $limit")
                    .param("name", name.clone())
                    .param("uid", uid.clone())
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

    let user_id_str = claims.sub.to_string();
    let job_strs: Vec<String> = source_job_ids.iter().map(|u| u.to_string()).collect();

    // 2. Build scope clause — mirrors get_graph.
    let where_clause = if source_job_ids.is_empty() {
        "n._owner = $uid"
    } else {
        "n._source_job IN $jobIds"
    };

    // 3. Run the Cypher. `name` is bound as a parameter — never interpolated.
    let cypher = format!(
        "MATCH (n {{name: $name}}) WHERE {where_clause} \
         OPTIONAL MATCH (n)-[ro]->() \
         OPTIONAL MATCH ()-[ri]->(n) \
         WITH n, count(DISTINCT ro) AS outDegree, count(DISTINCT ri) AS inDegree \
         RETURN n, outDegree, inDegree LIMIT 1"
    );

    let mut stream = state.neo
        .execute(
            neo_query(&cypher)
                .param("name", name.clone())
                .param("uid", user_id_str)
                .param("jobIds", job_strs),
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
            Some((jid, _jtype, file_name, text_input, created_at)) => {
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
                json!({ "id": jid, "source": source, "createdAt": created_at })
            }
            None => Value::Null,
        }
    } else {
        Value::Null
    };

    // 5. Chunk count — how many text chunks mention this entity (user-scoped).
    let chunk_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM text_chunks
          WHERE user_id = $1
            AND entity_mentions @> jsonb_build_array(jsonb_build_object('name', $2))"
    ).bind(claims.sub).bind(&name).fetch_one(&state.db).await.unwrap_or(0);

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

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
        .route("/compilations/:id/acl",                 get(get_acl).put(set_acl))
        .route("/compilations/:id/graph",               get(get_graph))
        .route("/graph/search",                         get(graph_search))
        .route("/graph/entity/:name/neighbors",         get(entity_neighbors))
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

async fn list(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit  = q.limit.unwrap_or(20).min(100);
    let offset = q.offset.unwrap_or(0);
    let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<i32>, Option<i32>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, name, description, classification, node_count, edge_count, created_at
         FROM compilations WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    ).bind(claims.sub).bind(limit).bind(offset).fetch_all(&state.db).await?;
    let comps: Vec<Value> = rows.into_iter().map(|(id,n,d,cls,nc,ec,c)| {
        json!({ "id":id,"name":n,"description":d,"classification":cls,"nodeCount":nc,"edgeCount":ec,"createdAt":c })
    }).collect();
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

async fn get_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>, String, Option<i32>, Option<i32>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, name, description, classification, node_count, edge_count, created_at FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let (id,n,d,cls,nc,ec,c) = row;
    Ok(Json(json!({ "id":id,"name":n,"description":d,"classification":cls,"nodeCount":nc,"edgeCount":ec,"createdAt":c })))
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
    Ok(Json(json!({ "jobId": job_id })))
}

async fn get_acl(
    Extension(_claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, Uuid, String)>(
        "SELECT id, user_id, permission FROM compilation_acl WHERE compilation_id=$1"
    ).bind(id).fetch_all(&state.db).await?;
    let entries: Vec<Value> = rows.into_iter().map(|(id,uid,perm)| json!({ "id":id,"userId":uid,"permission":perm })).collect();
    Ok(Json(json!({ "entries": entries })))
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
    // Verify the compilation belongs to this user.
    let exists: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM compilations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?;
    if exists.is_none() { return Err(AppError::NotFound); }

    // Validate node_type before interpolating it into the Cypher string.
    // A malicious value like `Foo}) MATCH (n) DETACH DELETE n //` would
    // otherwise allow arbitrary Cypher injection via the label position.
    if let Some(ref nt) = q.node_type {
        if !is_valid_neo4j_label(nt) {
            return Err(AppError::BadRequest("Invalid node_type".into()));
        }
    }

    let limit = q.limit.unwrap_or(200).min(1000);
    let cid   = id.to_string();

    // Build cypher — optionally filter by node label.
    let cypher = match &q.node_type {
        Some(label) => format!(
            "MATCH (n:{label} {{compilation_id: $cid}}) \
             OPTIONAL MATCH (n)-[r]->(m {{compilation_id: $cid}}) \
             RETURN n, r, m LIMIT $limit"
        ),
        None => "MATCH (n {compilation_id: $cid}) \
                 OPTIONAL MATCH (n)-[r]->(m {compilation_id: $cid}) \
                 RETURN n, r, m LIMIT $limit"
            .to_string(),
    };

    let mut stream = state.neo
        .execute(neo_query(&cypher).param("cid", cid).param("limit", limit))
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

use axum::{extract::{Extension, Path, State}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;
use crate::{error::{AppError, Result}, middleware::auth::JwtClaims};
use neo4rs::Node;

#[derive(Deserialize)]
struct QueryReq {
    message: String,
    #[serde(rename = "compilationId")] compilation_id: Option<Uuid>,
    mode: Option<String>,
    #[serde(rename = "llmConfig")] llm_config: Option<Value>,
    #[serde(rename = "conversationId")] conversation_id: Option<Uuid>,
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/query",             post(query))
        .route("/conversations",     get(list_conversations))
        .route("/conversations/:id", get(get_conversation).delete(delete_conversation))
        .route("/models",            get(list_models))
}

async fn query(
    State(state): State<Arc<crate::models::AppState>>,
    Extension(claims): Extension<Option<JwtClaims>>,
    Json(req): Json<QueryReq>,
) -> Result<Json<Value>> {
    // Bug 1: Auth check — unauthenticated users cannot query specific compilations
    if claims.is_none() && req.compilation_id.is_some() {
        return Err(AppError::Unauthorized);
    }

    // Bug 1 (cont): If authenticated, verify the compilation belongs to this user
    if let (Some(ref c), Some(cid)) = (&claims, req.compilation_id) {
        let found = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM compilations WHERE id=$1 AND user_id=$2"
        )
        .bind(cid)
        .bind(c.sub)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        if found == 0 {
            return Err(AppError::Forbidden("Compilation not found or access denied".into()));
        }
    }

    if req.message.trim().is_empty() || req.message.len() > 4000 {
        return Err(AppError::BadRequest("Message must be 1-4000 chars".into()));
    }

    let client = reqwest::Client::new();

    // ── 1. Semantic search via KEX ────────────────────────────────────────────
    #[derive(serde::Deserialize)]
    struct KexChunk {
        text:             String,
        score:            f64,
        entity_mentions:  Option<Vec<String>>,
        source:           Option<String>,
        chunk_id:         Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct KexSearchResp {
        chunks: Vec<KexChunk>,
    }

    let kex_url = format!("{}/search", state.cfg.kex_worker_url);
    let kex_body = json!({
        "query":          req.message,
        "limit":          5,
        "compilation_id": req.compilation_id,
    });

    let chunks: Vec<KexChunk> = match client
        .post(&kex_url)
        .json(&kex_body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => match resp.json::<KexSearchResp>().await {
            Ok(body) => body.chunks,
            Err(e) => {
                tracing::warn!("KEX response parse error: {e}");
                vec![]
            }
        },
        Err(e) => {
            tracing::warn!("KEX search unreachable: {e}");
            vec![]
        }
    };

    // ── 2. Graph context via Neo4j ────────────────────────────────────────────
    // Collect unique entity names from all chunk entity_mentions
    let mut entity_names: Vec<String> = chunks
        .iter()
        .flat_map(|c| c.entity_mentions.iter().flatten().cloned())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .take(15)
        .collect();
    entity_names.sort(); // deterministic ordering

    #[derive(Debug)]
    struct GraphTriple {
        from:     String,
        relation: String,
        to:       String,
    }

    // Bug 2: Scope Neo4j queries to the authenticated user's nodes (plus shared nodes
    // with no user_id) to prevent cross-user data leakage.
    let uid = claims.as_ref().map(|c| c.sub.to_string()).unwrap_or_default();

    let (graph_triples, cypher_used) = if entity_names.is_empty() {
        (vec![], None)
    } else {
        let cypher = format!(
            "MATCH (n) WHERE n.name IN $names AND (n.user_id IS NULL OR n.user_id = $uid) \
             OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100"
        );
        let mut triples: Vec<GraphTriple> = vec![];

        match state
            .neo
            .execute(
                neo4rs::query(&cypher)
                    .param("names", entity_names.clone())
                    .param("uid", uid.clone()),
            )
            .await
        {
            Ok(mut result) => {
                while let Ok(Some(row)) = result.next().await {
                    let from_name = row
                        .get::<Node>("n")
                        .ok()
                        .and_then(|n| n.get::<String>("name").ok())
                        .unwrap_or_default();

                    let rel_type = row
                        .get::<neo4rs::Relation>("r")
                        .ok()
                        .map(|r| r.typ().to_string());

                    let to_name = row
                        .get::<Node>("m")
                        .ok()
                        .and_then(|n| n.get::<String>("name").ok());

                    if let (Some(rel), Some(to)) = (rel_type, to_name) {
                        if !from_name.is_empty() && !to.is_empty() {
                            triples.push(GraphTriple {
                                from:     from_name,
                                relation: rel,
                                to,
                            });
                        }
                    }
                }
                (triples, Some(cypher))
            }
            Err(e) => {
                tracing::warn!("Neo4j query error: {e}");
                (vec![], None)
            }
        }
    };

    // ── 3. Assemble context string ────────────────────────────────────────────
    let mut context_parts: Vec<String> = Vec::new();

    if !chunks.is_empty() {
        context_parts.push("Relevant context from knowledge base:\n".to_string());
        for (i, chunk) in chunks.iter().enumerate() {
            let source_str = chunk.source.as_deref().unwrap_or("unknown");
            context_parts.push(format!(
                "[{}] {} (source: {}, relevance: {:.2})",
                i + 1,
                chunk.text,
                source_str,
                chunk.score
            ));
        }
    }

    if !graph_triples.is_empty() {
        context_parts.push("\nGraph relationships:".to_string());
        for t in &graph_triples {
            context_parts.push(format!("{} -[{}]-> {}", t.from, t.relation, t.to));
        }
    }

    let context = context_parts.join("\n");

    // ── 4. LLM call with context ──────────────────────────────────────────────
    // TODO: add `ollama_base: String` to Config (loaded from OLLAMA_BASE env var)
    //       so this is consistent with the rest of the config-driven setup.
    let ollama_base = std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://localhost:11434".into());
    let model = req
        .llm_config
        .as_ref()
        .and_then(|c| c["model"].as_str())
        .unwrap_or("qwen2.5:7b")
        .to_string();

    let user_content = if context.is_empty() {
        req.message.clone()
    } else {
        format!("Context:\n{context}\n\nQuestion: {}", req.message)
    };

    let llm_payload = json!({
        "model": model,
        "messages": [
            {
                "role":    "system",
                "content": "You are a knowledge graph assistant. Answer based on the provided context. Be concise and cite your sources using [1], [2], etc."
            },
            {
                "role":    "user",
                "content": user_content
            }
        ],
        "stream": false,
    });

    let llm_resp = client
        .post(format!("{}/api/chat", ollama_base))
        .json(&llm_payload)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("LLM unreachable: {e}")))?;

    let llm_body: Value = llm_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("LLM parse error: {e}")))?;

    let answer = llm_body["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // ── 5. (Removed) Message persistence
    // GDPR/DSGVO design requirement: RAG sessions are browser-memory-only.
    // No conversation data is written server-side during query execution.
    // The `conversation_id` field in QueryReq is kept for API backwards
    // compatibility but intentionally unused here.
    // The GET/LIST/DELETE /conversations endpoints remain for future opt-in
    // persistence features — they do not write and are user-scoped.

    // ── 6. Build response ─────────────────────────────────────────────────────
    let confidence: f64 = if chunks.is_empty() {
        0.5
    } else {
        let sum: f64 = chunks.iter().map(|c| c.score).sum();
        sum / chunks.len() as f64
    };

    let sources: Vec<Value> = chunks
        .iter()
        .map(|c| {
            json!({
                "text":    c.text,
                "score":   c.score,
                "source":  c.source.as_deref().unwrap_or(""),
                "chunkId": c.chunk_id.as_deref().unwrap_or(""),
            })
        })
        .collect();

    let graph_trace: Vec<Value> = graph_triples
        .iter()
        .map(|t| json!({ "from": t.from, "relation": t.relation, "to": t.to }))
        .collect();

    let cypher_val: Value = match cypher_used {
        Some(_) => {
            // Embed the actual entity names into a readable cypher string for the response
            let names_repr: Vec<Value> = entity_names.iter().map(|n| json!(n)).collect();
            json!(format!("MATCH (n) WHERE n.name IN {:?} OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100", names_repr))
        }
        None => Value::Null,
    };

    Ok(Json(json!({
        "answer":     answer,
        "sources":    sources,
        "confidence": confidence,
        "cypher":     cypher_val,
        "graphTrace": graph_trace,
    })))
}

async fn list_conversations(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, (Uuid, Option<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, title, updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50"
    ).bind(claims.sub).fetch_all(&state.db).await?;
    let convs: Vec<Value> = rows.into_iter().map(|(id,t,u)| json!({ "id":id,"title":t,"updatedAt":u })).collect();
    Ok(Json(json!({ "conversations": convs })))
}

async fn get_conversation(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let conv = sqlx::query_as::<_, (Uuid, Option<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, title, updated_at FROM conversations WHERE id=$1 AND user_id=$2"
    ).bind(id).bind(claims.sub).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let messages = sqlx::query_as::<_, (Uuid, String, String, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, role, content, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at"
    ).bind(id).fetch_all(&state.db).await?;
    let (cid, title, updated) = conv;
    let msgs: Vec<Value> = messages.into_iter().map(|(mid,r,c,cr)| json!({ "id":mid,"role":r,"content":c,"createdAt":cr })).collect();
    Ok(Json(json!({ "id":cid,"title":title,"updatedAt":updated,"messages":msgs })))
}

async fn delete_conversation(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM conversations WHERE id=$1 AND user_id=$2").bind(id).bind(claims.sub).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_models(State(_state): State<Arc<crate::models::AppState>>) -> Json<Value> {
    let ollama_base = std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://localhost:11434".into());
    let client = reqwest::Client::new();
    let models = match client.get(format!("{}/api/tags", ollama_base))
        .timeout(std::time::Duration::from_secs(3)).send().await {
        Ok(r) => r.json::<Value>().await.ok()
            .and_then(|v| v["models"].as_array().cloned())
            .unwrap_or_default(),
        Err(_) => vec![],
    };
    Json(json!({ "ollama": models, "cloud": [] }))
}

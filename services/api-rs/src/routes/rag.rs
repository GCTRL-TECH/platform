use axum::{extract::{Extension, Path, State}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;
use crate::{error::{AppError, Result}, middleware::auth::JwtClaims};

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
    State(_state): State<Arc<crate::models::AppState>>,
    Json(req): Json<QueryReq>,
) -> Result<Json<Value>> {
    if req.message.is_empty() || req.message.len() > 4000 {
        return Err(AppError::BadRequest("Message must be 1-4000 chars".into()));
    }

    let ollama_base = std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://localhost:11434".into());
    let system_prompt = "You are a knowledge graph assistant. Answer based on the provided context. Be concise and cite your sources.";

    let llm_payload = json!({
        "model": req.llm_config.as_ref().and_then(|c| c["model"].as_str()).unwrap_or("qwen2.5:7b"),
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user",   "content": req.message }
        ],
        "stream": false,
    });

    let client = reqwest::Client::new();
    let llm_resp = client
        .post(format!("{}/api/chat", ollama_base))
        .json(&llm_payload)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("LLM unreachable: {e}")))?;

    let llm_body: Value = llm_resp.json().await
        .map_err(|e| AppError::Internal(format!("LLM parse error: {e}")))?;

    let answer = llm_body["message"]["content"].as_str().unwrap_or("").to_string();

    Ok(Json(json!({
        "answer":     answer,
        "sources":    [],
        "confidence": 0.7,
        "cypher":     null,
        "graphTrace": null,
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

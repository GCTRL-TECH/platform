//! Classification-conflict resolver.
//!
//! When a merge (or re-ingest) leaves a graph element carrying ≥2 distinct
//! classification labels, we never auto-escalate. Instead this resolver
//! *suggests* a resolution for a human to approve:
//!
//!   * LIMES (entity-match confidence — wired in 1.6b) tells us whether the two
//!     labelled elements are really the same real-world entity, and
//!   * Ollama performs a semantic check over the element's surrounding content
//!     to distinguish a genuinely sensitive fact from an incidental mention
//!     (the "Table" vs "the secret on the table" distinction).
//!
//! The output is advisory only — `routes::classification` applies a resolution
//! solely on an explicit admin action.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct Suggestion {
    /// "keep" (most-permissive label wins — likely an incidental mention) or
    /// "remove_label" (drop the label of `rank` so the element settles on the
    /// remaining classification).
    pub action: String,
    /// For "remove_label": which label rank to drop.
    pub rank: Option<i32>,
    pub rationale: String,
    /// LIMES same-entity confidence in [0,1] when available (1.6b).
    pub match_score: Option<f64>,
}

impl Suggestion {
    fn keep(rationale: impl Into<String>) -> Self {
        Suggestion { action: "keep".into(), rank: None, rationale: rationale.into(), match_score: None }
    }
    pub fn to_json(&self) -> Value {
        json!({
            "action": self.action,
            "rank": self.rank,
            "rationale": self.rationale,
            "matchScore": self.match_score,
        })
    }
}

/// Produce a resolution suggestion for a conflicting element.
///
/// `element_name` is the entity/edge surface form; `labels` is the conflicting
/// label set (each `{rank, level_name, ...}`). Best-effort: any failure falls
/// back to the safe "keep most-permissive" default so the review queue still
/// gets an actionable, non-escalating suggestion.
pub async fn suggest_resolution(element_name: &str, labels: &Value) -> Suggestion {
    let mut ranks: Vec<i32> = labels
        .as_array()
        .map(|a| a.iter().filter_map(|l| l.get("rank").and_then(|r| r.as_i64()).map(|r| r as i32)).collect())
        .unwrap_or_default();
    ranks.sort_unstable();
    ranks.dedup();
    if ranks.len() < 2 {
        return Suggestion::keep("Single classification — no conflict to resolve.");
    }
    let level_names: Vec<String> = labels
        .as_array()
        .map(|a| a.iter().filter_map(|l| l.get("level_name").and_then(|v| v.as_str()).map(String::from)).collect())
        .unwrap_or_default();

    let ollama_base = std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://localhost:11434".into());
    let model = std::env::var("AGENT_DEFAULT_MODEL").unwrap_or_else(|_| "llama3.2".into());

    let prompt = format!(
        "An entity in a knowledge graph carries CONFLICTING data-classification labels \
         after merging two sources.\n\nEntity: \"{element_name}\"\nLabels: {levels}\n\n\
         Decide whether the entity is a genuinely sensitive item (so the higher \
         classification should win) or an incidental/generic mention (so the most \
         permissive classification should win and no escalation is needed).\n\n\
         Reply with ONLY a compact JSON object: \
         {{\"keep_permissive\": true|false, \"rationale\": \"one sentence\"}}.",
        element_name = element_name,
        levels = level_names.join(", "),
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{ollama_base}/api/chat"))
        .json(&json!({
            "model": model,
            "stream": false,
            "messages": [{ "role": "user", "content": prompt }],
            "format": "json",
        }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let parsed = match resp {
        Ok(r) => r.json::<Value>().await.ok(),
        Err(e) => {
            tracing::warn!("classify_resolver: ollama unreachable: {e}");
            None
        }
    };

    // Ollama /api/chat returns { message: { content: "<json string>" } }.
    let content = parsed
        .as_ref()
        .and_then(|v| v.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let decision: Option<Value> = serde_json::from_str(content).ok();

    let keep_permissive = decision
        .as_ref()
        .and_then(|d| d.get("keep_permissive"))
        .and_then(|b| b.as_bool());
    let rationale = decision
        .as_ref()
        .and_then(|d| d.get("rationale"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    match keep_permissive {
        Some(true) | None => {
            // Keep the most-permissive label (no escalation) — the safe default.
            let r = if rationale.is_empty() {
                format!("Treat \"{element_name}\" as an incidental mention; keep the most-permissive label.")
            } else { rationale };
            Suggestion::keep(r)
        }
        Some(false) => {
            // Escalate: drop the most-permissive label so the element settles on
            // the higher classification. (Applied only on admin approval.)
            let drop_rank = *ranks.first().unwrap();
            let r = if rationale.is_empty() {
                format!("\"{element_name}\" appears genuinely sensitive; drop the lowest label to escalate.")
            } else { rationale };
            Suggestion { action: "remove_label".into(), rank: Some(drop_rank), rationale: r, match_score: None }
        }
    }
}

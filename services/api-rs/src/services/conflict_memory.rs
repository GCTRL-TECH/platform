//! Conflict decision memory — learning loop, stage 1 (migration 086).
//!
//! What it is: a COUNTER-BASED memory of how humans resolved conflicts, keyed
//! by a normalised signature of the conflict TYPE (never the data). It is not a
//! trained model and uses no ML library: the "prediction" for a new conflict is
//! the majority decision among earlier conflicts with the identical signature,
//! reported with its counters (`support` = decisions seen, `confidence` =
//! majority share) so the reviewer can weigh it.
//!
//! Three touch points:
//!   1. `record` — every HUMAN resolve (classification + fact) writes one row.
//!      Automatic resolutions are never recorded (they would reinforce
//!      themselves).
//!   2. `verdicts` — suggest / list consult the memory: same signature → the
//!      majority decision; `routes::classification::suggest_conflict` answers
//!      `source: "history"` when a strict majority exists, else asks the LLM.
//!   3. `auto_resolve_for_user` — the ingest hook (background job-result
//!      subscriber, after every completed KEX/FUSE job): open conflicts whose
//!      signature has >= GCTRL_CONFLICT_AUTO_MIN_SUPPORT decisions (default 5;
//!      < 1 switches auto-resolution off) with a majority >= 80 % are resolved
//!      the same way and marked `auto_resolved`. Only generalisable choices are
//!      applied (see `is_generalizable`); a fact conflict resolved by picking an
//!      arbitrary value ("pick_other") is remembered but never replayed.

use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

use crate::models::AppState;

pub const DEFAULT_AUTO_MIN_SUPPORT: i64 = 5;
/// Majority share a signature needs before the memory may act on its own.
pub const AUTO_MIN_SHARE: f64 = 0.8;

/// `GCTRL_CONFLICT_AUTO_MIN_SUPPORT`, default 5. Unparsable → default.
pub fn auto_min_support() -> i64 {
    parse_min_support(std::env::var("GCTRL_CONFLICT_AUTO_MIN_SUPPORT").ok().as_deref())
}

pub fn parse_min_support(raw: Option<&str>) -> i64 {
    raw.and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_AUTO_MIN_SUPPORT)
}

// ── Signatures (pure) ─────────────────────────────────────────────────────────

/// `classification:<node|edge>:<level names, lowercased, deduped, sorted, '|'>`.
/// The label SET is the dimension of the conflict ("PUBLIC vs CONFIDENTIAL");
/// the element itself never enters the signature.
pub fn classification_signature(element_kind: &str, labels: &Value) -> String {
    let mut names: Vec<String> = labels
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| l.get("level_name").and_then(|v| v.as_str()))
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.dedup();
    let kind = element_kind.trim().to_lowercase();
    if names.is_empty() {
        format!("classification:{kind}:-")
    } else {
        format!("classification:{kind}:{}", names.join("|"))
    }
}

/// `fact:<relation>:<key_side>` — the functional relation (which implies the
/// entity type it is keyed on, see relation_registry) and the key side.
pub fn fact_signature(relation: &str, key_side: &str) -> String {
    format!(
        "fact:{}:{}",
        relation.trim().to_lowercase(),
        key_side.trim().to_lowercase()
    )
}

// ── Chosen (pure) ─────────────────────────────────────────────────────────────

/// The remembered form of a classification decision. None = not a decision
/// worth remembering (unknown action, remove_label without a rank).
pub fn classification_choice(action: &str, rank: Option<i32>) -> Option<String> {
    match action {
        "keep" => Some("keep".into()),
        "dismiss" => Some("dismiss".into()),
        "remove_label" => rank.map(|r| format!("remove_label:{r}")),
        _ => None,
    }
}

/// The rank a remembered `remove_label:<rank>` choice drops.
pub fn remove_label_rank(chosen: &str) -> Option<i32> {
    chosen.strip_prefix("remove_label:").and_then(|r| r.parse().ok())
}

/// The value with the strictly highest `confidence` among a conflict's tails
/// (None when absent, or when the top two tie — nothing to generalise then).
pub fn highest_confidence_tail(tails: &Value) -> Option<String> {
    let mut best: Option<(f64, String)> = None;
    let mut tied = false;
    for t in tails.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let Some(v) = t.get("value").and_then(|v| v.as_str()).filter(|v| !v.is_empty()) else { continue };
        let c = t.get("confidence").and_then(|c| c.as_f64()).unwrap_or(0.0);
        match &best {
            Some((bc, bv)) if c < *bc => {}
            Some((bc, bv)) if c == *bc => { if bv != v { tied = true; } }
            _ => { best = Some((c, v.to_string())); tied = false; }
        }
    }
    if tied { None } else { best.map(|(_, v)| v) }
}

/// The remembered form of a fact decision. `winner` None = dismissed. A value
/// choice is generalised to WHY it won: the recency-authority winner
/// ("accept_winner"), the most confident assertion ("keep_higher_confidence"),
/// or neither ("pick_other" — remembered, never replayed).
pub fn fact_choice(winner: Option<&str>, authority_winner: Option<&str>, tails: &Value) -> String {
    let Some(w) = winner else { return "dismiss".into() };
    if authority_winner.map(str::trim).is_some_and(|a| !a.is_empty() && a == w) {
        return "accept_winner".into();
    }
    if highest_confidence_tail(tails).as_deref() == Some(w) {
        return "keep_higher_confidence".into();
    }
    "pick_other".into()
}

/// Can this remembered choice be replayed on a NEW conflict of the same
/// signature? Everything but an arbitrary value pick.
pub fn is_generalizable(chosen: &str) -> bool {
    chosen != "pick_other"
}

// ── Majority (pure) ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// The most frequent choice (ties → the lexicographically smaller, so the
    /// result is deterministic; a tie never has a majority anyway).
    pub chosen: String,
    /// Decisions for `chosen`.
    pub votes: i64,
    /// All decisions for the signature.
    pub support: i64,
    /// votes / support.
    pub confidence: f64,
}

impl Verdict {
    /// A STRICT majority (> 50 %) — what the suggest path requires before it
    /// prefers memory over the LLM.
    pub fn has_majority(&self) -> bool {
        self.votes * 2 > self.support
    }

    /// May the ingest hook act on this alone? Needs the configured support and
    /// an 80 % majority; `min_support < 1` switches auto-resolution off.
    pub fn auto_allowed(&self, min_support: i64) -> bool {
        min_support >= 1
            && self.support >= min_support
            && self.confidence >= AUTO_MIN_SHARE
            && is_generalizable(&self.chosen)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "chosen": self.chosen,
            "votes": self.votes,
            "support": self.support,
            "confidence": self.confidence,
        })
    }
}

/// Pure: fold `(chosen, count)` rows of ONE signature into a verdict.
pub fn majority(counts: &[(String, i64)]) -> Option<Verdict> {
    let support: i64 = counts.iter().map(|(_, n)| n).sum();
    if support <= 0 {
        return None;
    }
    let mut sorted: Vec<&(String, i64)> = counts.iter().filter(|(_, n)| *n > 0).collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let (chosen, votes) = sorted.first().map(|(c, n)| (c.clone(), *n))?;
    Some(Verdict {
        chosen,
        votes,
        support,
        confidence: votes as f64 / support as f64,
    })
}

// ── Storage ───────────────────────────────────────────────────────────────────

/// Remember one HUMAN decision. Best-effort: a failure is logged, never
/// surfaced — the resolve itself already succeeded.
pub async fn record(
    db: &sqlx::PgPool,
    kind: &str,
    signature: &str,
    chosen: &str,
    features: Value,
    decided_by: Uuid,
    compilation_id: Option<Uuid>,
) {
    if let Err(e) = sqlx::query(
        "INSERT INTO conflict_resolutions
             (conflict_kind, signature, chosen, features, decided_by, compilation_id)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(kind)
    .bind(signature)
    .bind(chosen)
    .bind(features)
    .bind(decided_by)
    .bind(compilation_id)
    .execute(db)
    .await
    {
        tracing::warn!("conflict memory: could not record {kind} decision for {signature}: {e}");
    }
}

/// The verdict per signature (absent = no decision seen yet). One query.
pub async fn verdicts(
    db: &sqlx::PgPool,
    kind: &str,
    signatures: &[String],
) -> HashMap<String, Verdict> {
    if signatures.is_empty() {
        return HashMap::new();
    }
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT signature, chosen, COUNT(*)
         FROM conflict_resolutions
         WHERE conflict_kind = $1 AND signature = ANY($2)
         GROUP BY signature, chosen",
    )
    .bind(kind)
    .bind(signatures)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let mut per_sig: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    for (sig, chosen, n) in rows {
        per_sig.entry(sig).or_default().push((chosen, n));
    }
    per_sig
        .into_iter()
        .filter_map(|(sig, counts)| majority(&counts).map(|v| (sig, v)))
        .collect()
}

pub fn verdict_json(v: Option<&Verdict>) -> Value {
    v.map(Verdict::to_json).unwrap_or(Value::Null)
}

// ── Ingest hook: automatic resolution ─────────────────────────────────────────

/// Resolve the user's OPEN conflicts whose signature the memory has decided
/// often and consistently enough (see module docs). Called after every
/// completed job; returns quickly when the memory is empty or auto-resolution
/// is switched off.
pub async fn auto_resolve_for_user(state: &AppState, user_id: Uuid) {
    let min_support = auto_min_support();
    if min_support < 1 {
        return;
    }
    let any: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM conflict_resolutions)")
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);
    if !any {
        return;
    }
    let n_class = auto_resolve_classification(state, user_id, min_support).await;
    let n_fact = auto_resolve_facts(state, user_id, min_support).await;
    if n_class + n_fact > 0 {
        tracing::info!(
            "conflict memory: auto-resolved {n_class} classification + {n_fact} fact conflict(s) for user {user_id}"
        );
    }
}

fn auto_suggestion(v: &Verdict, action: &str, rank: Option<i32>) -> Value {
    json!({
        "action": action,
        "rank": rank,
        "rationale": format!(
            "Auto-resolved from decision memory: {} of {} conflicts with this signature were resolved this way.",
            v.votes, v.support
        ),
        "matchScore": Value::Null,
        "source": "history",
        "support": v.support,
        "confidence": v.confidence,
    })
}

async fn auto_resolve_classification(state: &AppState, user_id: Uuid, min_support: i64) -> usize {
    let rows: Vec<(Uuid, Option<Uuid>, String, String, Value)> = sqlx::query_as(
        "SELECT cc.id, cc.compilation_id, cc.element_kind, cc.element_key, cc.labels
         FROM classification_conflicts cc
         JOIN compilations c ON c.id = cc.compilation_id
         WHERE c.user_id = $1 AND cc.status = 'open'",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    if rows.is_empty() {
        return 0;
    }
    let sigs: Vec<String> = rows.iter().map(|r| classification_signature(&r.2, &r.4)).collect();
    let verdicts = verdicts(&state.db, "classification", &sigs).await;

    let mut done = 0usize;
    for ((id, comp_id, kind, key, _labels), sig) in rows.into_iter().zip(sigs) {
        let Some(v) = verdicts.get(&sig) else { continue };
        if !v.auto_allowed(min_support) {
            continue;
        }
        let (action, rank) = match v.chosen.as_str() {
            "keep" => ("keep", None),
            "dismiss" => ("dismiss", None),
            c => match remove_label_rank(c) {
                Some(r) => ("remove_label", Some(r)),
                None => continue,
            },
        };
        if let Some(r) = rank {
            if let Err(e) = crate::routes::classification::remove_element_label(state, &kind, &key, comp_id, r).await {
                tracing::warn!("conflict memory: remove_label on {id} failed, left open: {e:?}");
                continue;
            }
        }
        let ok = sqlx::query(
            "UPDATE classification_conflicts
             SET status = 'auto_resolved', suggestion = $1, resolved_by = NULL, resolved_at = NOW()
             WHERE id = $2 AND status = 'open'",
        )
        .bind(auto_suggestion(v, action, rank))
        .bind(id)
        .execute(&state.db)
        .await;
        match ok {
            Ok(r) if r.rows_affected() > 0 => done += 1,
            Ok(_) => {}
            Err(e) => tracing::warn!("conflict memory: could not mark {id} auto_resolved: {e}"),
        }
    }
    done
}

async fn auto_resolve_facts(state: &AppState, user_id: Uuid, min_support: i64) -> usize {
    let rows: Vec<(Uuid, Option<Uuid>, String, String, String, Value, Option<String>)> = sqlx::query_as(
        "SELECT id, compilation_id, relation, key_name, key_side, tails, authority_winner
         FROM fact_conflicts
         WHERE user_id = $1 AND status = 'open'",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    if rows.is_empty() {
        return 0;
    }
    let sigs: Vec<String> = rows.iter().map(|r| fact_signature(&r.2, &r.4)).collect();
    let verdicts = verdicts(&state.db, "fact", &sigs).await;

    let mut done = 0usize;
    for ((id, comp_id, relation, key_name, key_side, tails, authority), sig) in rows.into_iter().zip(sigs) {
        let Some(v) = verdicts.get(&sig) else { continue };
        if !v.auto_allowed(min_support) {
            continue;
        }
        let tail_values = crate::routes::kg::conflict_tail_values(&tails);
        let winner: Option<String> = match v.chosen.as_str() {
            "dismiss" => None,
            "accept_winner" => match authority.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
                Some(a) if tail_values.iter().any(|t| t == a) => Some(a.to_string()),
                _ => continue, // no usable authority winner on this row
            },
            "keep_higher_confidence" => match highest_confidence_tail(&tails) {
                Some(t) => Some(t),
                None => continue, // confidences tie — nothing to replay
            },
            _ => continue,
        };

        let applied = match &winner {
            None => sqlx::query(
                "UPDATE fact_conflicts SET status = 'auto_resolved', last_evaluated_at = NOW()
                 WHERE id = $1 AND status = 'open'",
            )
            .bind(id)
            .execute(&state.db)
            .await
            .map(|r| r.rows_affected() > 0)
            .map_err(|e| e.to_string()),
            Some(w) => {
                let reason = format!(
                    "auto-resolved from decision memory ({} of {} '{}' conflicts): '{w}' kept as current for {relation}({key_name})",
                    v.votes, v.support, sig
                );
                crate::routes::kg::apply_fact_resolution(
                    state, id, user_id, comp_id, &relation, &key_name, &key_side,
                    &tail_values, w, &reason, "auto_resolved",
                )
                .await
                .map(|_| true)
                .map_err(|e| format!("{e:?}"))
            }
        };
        match applied {
            Ok(true) => done += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!("conflict memory: auto-resolving fact conflict {id} failed: {e}"),
        }
    }
    done
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const MIGRATION: &str = include_str!("../../migrations/086_conflict_resolutions.sql");

    // signatures ────────────────────────────────────────────────────────────

    #[test]
    fn classification_signature_is_order_case_and_duplicate_insensitive() {
        let a = json!([
            { "rank": 2, "level_name": "CONFIDENTIAL" },
            { "rank": 0, "level_name": "public" },
        ]);
        let b = json!([
            { "rank": 0, "level_name": " Public " },
            { "rank": 2, "level_name": "Confidential" },
            { "rank": 2, "level_name": "confidential" },
        ]);
        assert_eq!(classification_signature("node", &a), "classification:node:confidential|public");
        assert_eq!(classification_signature("Node", &b), classification_signature("node", &a));
        assert_ne!(classification_signature("edge", &a), classification_signature("node", &a));
    }

    #[test]
    fn classification_signature_without_labels_is_still_stable() {
        assert_eq!(classification_signature("node", &json!([])), "classification:node:-");
        assert_eq!(classification_signature("node", &json!(null)), "classification:node:-");
        assert_eq!(classification_signature("node", &json!([{ "rank": 1 }])), "classification:node:-");
    }

    #[test]
    fn fact_signature_normalises_relation_and_side() {
        assert_eq!(fact_signature("CEO_OF", "Tail"), "fact:ceo_of:tail");
        assert_eq!(fact_signature("  located_in ", "head"), "fact:located_in:head");
        assert_ne!(fact_signature("ceo_of", "head"), fact_signature("ceo_of", "tail"));
    }

    // chosen ────────────────────────────────────────────────────────────────

    #[test]
    fn classification_choice_encodes_the_dropped_rank() {
        assert_eq!(classification_choice("keep", None).as_deref(), Some("keep"));
        assert_eq!(classification_choice("dismiss", Some(3)).as_deref(), Some("dismiss"));
        assert_eq!(classification_choice("remove_label", Some(0)).as_deref(), Some("remove_label:0"));
        assert_eq!(classification_choice("remove_label", None), None);
        assert_eq!(classification_choice("escalate", None), None);
        assert_eq!(remove_label_rank("remove_label:2"), Some(2));
        assert_eq!(remove_label_rank("keep"), None);
    }

    fn tails(values: &[(&str, f64)]) -> Value {
        Value::Array(values.iter().map(|(v, c)| json!({ "value": v, "confidence": c })).collect())
    }

    #[test]
    fn highest_confidence_tail_requires_a_unique_maximum() {
        assert_eq!(highest_confidence_tail(&tails(&[("A", 0.9), ("B", 0.5)])).as_deref(), Some("A"));
        assert_eq!(highest_confidence_tail(&tails(&[("A", 0.7), ("B", 0.7)])), None);
        // The same value asserted twice at the top is not a tie.
        assert_eq!(highest_confidence_tail(&tails(&[("A", 0.7), ("A", 0.7), ("B", 0.2)])).as_deref(), Some("A"));
        assert_eq!(highest_confidence_tail(&json!([])), None);
        assert_eq!(highest_confidence_tail(&json!([{ "value": "A" }])).as_deref(), Some("A"));
    }

    #[test]
    fn fact_choice_generalises_why_a_value_won() {
        let t = tails(&[("Newer", 0.4), ("Confident", 0.95), ("Other", 0.6)]);
        assert_eq!(fact_choice(None, Some("Newer"), &t), "dismiss");
        assert_eq!(fact_choice(Some("Newer"), Some("Newer"), &t), "accept_winner");
        assert_eq!(fact_choice(Some("Confident"), Some("Newer"), &t), "keep_higher_confidence");
        assert_eq!(fact_choice(Some("Other"), Some("Newer"), &t), "pick_other");
        // Authority beats confidence when both describe the same pick.
        assert_eq!(fact_choice(Some("Confident"), Some("Confident"), &t), "accept_winner");
        assert!(is_generalizable("accept_winner"));
        assert!(!is_generalizable("pick_other"));
    }

    // majority ──────────────────────────────────────────────────────────────

    fn counts(c: &[(&str, i64)]) -> Vec<(String, i64)> {
        c.iter().map(|(k, n)| (k.to_string(), *n)).collect()
    }

    #[test]
    fn majority_counts_votes_and_support() {
        let v = majority(&counts(&[("keep", 4), ("remove_label:0", 1)])).unwrap();
        assert_eq!(v.chosen, "keep");
        assert_eq!(v.votes, 4);
        assert_eq!(v.support, 5);
        assert!((v.confidence - 0.8).abs() < 1e-9);
        assert!(v.has_majority());
        assert_eq!(majority(&[]), None);
        assert_eq!(majority(&counts(&[("keep", 0)])), None);
    }

    #[test]
    fn a_tie_is_deterministic_and_has_no_majority() {
        let v = majority(&counts(&[("remove_label:0", 2), ("keep", 2)])).unwrap();
        assert_eq!(v.chosen, "keep", "lexicographically smaller wins the tie-break");
        assert!(!v.has_majority());
        assert!(!v.auto_allowed(1));
    }

    #[test]
    fn plurality_without_majority_never_auto_resolves() {
        let v = majority(&counts(&[("keep", 3), ("dismiss", 2), ("remove_label:0", 2)])).unwrap();
        assert_eq!(v.chosen, "keep");
        assert!(!v.has_majority());
        assert!(!v.auto_allowed(1));
    }

    #[test]
    fn auto_resolution_needs_support_share_and_a_generalizable_choice() {
        let strong = majority(&counts(&[("accept_winner", 4), ("dismiss", 1)])).unwrap();
        assert!(strong.auto_allowed(5), "5 decisions, 80 % — exactly the default threshold");
        assert!(!strong.auto_allowed(6), "one decision short of the configured support");
        assert!(!strong.auto_allowed(0), "min_support < 1 switches auto-resolution off");

        let weak = majority(&counts(&[("accept_winner", 7), ("dismiss", 3)])).unwrap();
        assert!(weak.has_majority());
        assert!(!weak.auto_allowed(5), "70 % is below the 80 % share");

        let arbitrary = majority(&counts(&[("pick_other", 10)])).unwrap();
        assert!(arbitrary.has_majority());
        assert!(!arbitrary.auto_allowed(5), "an arbitrary value pick is never replayed");
    }

    #[test]
    fn min_support_env_parsing_falls_back_to_default() {
        assert_eq!(parse_min_support(None), 5);
        assert_eq!(parse_min_support(Some(" 3 ")), 3);
        assert_eq!(parse_min_support(Some("0")), 0);
        assert_eq!(parse_min_support(Some("many")), 5);
    }

    // migration ─────────────────────────────────────────────────────────────

    #[test]
    fn migration_adds_memory_table_and_auto_resolved_status() {
        assert!(MIGRATION.contains("CREATE TABLE IF NOT EXISTS conflict_resolutions"));
        assert!(MIGRATION.contains("CHECK (conflict_kind IN ('classification', 'fact'))"));
        assert!(MIGRATION.contains("ALTER COLUMN status TYPE TEXT"), "VARCHAR(12) cannot hold 'auto_resolved'");
        for table in ["classification_conflicts", "fact_conflicts"] {
            assert!(MIGRATION.contains(&format!("DROP CONSTRAINT IF EXISTS {table}_status_check")));
        }
        assert_eq!(
            MIGRATION.matches("CHECK (status IN ('open', 'resolved', 'dismissed', 'auto_resolved'))").count(),
            2
        );
    }
}

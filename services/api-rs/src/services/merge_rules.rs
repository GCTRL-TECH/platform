//! Merge rules (migration 097): the readable rule the fusion applies per
//! entity type, as a small structured schema that maps 1:1 onto a LIMES link
//! specification and onto one English sentence.
//!
//! Pure parts (schema, LS string, sentence, threshold learning) live here with
//! unit tests; the routes in `routes::kg` do the storage and the LLM call that
//! turns a person's own words into the schema.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Measures a rule may use. All are LIMES measure names on a string property;
/// `koeln` is Cologne phonetics (German names), the rest are string similarities.
pub const MEASURES: &[&str] = &[
    "trigrams", "qgrams", "jaccard", "cosine", "levenshtein", "jarowinkler", "jaro",
    "exactmatch", "koeln", "soundex",
];
/// Properties every exported entity carries (the resolver's CSV columns).
pub const PROPERTIES: &[&str] = &["name", "label", "type"];
/// The resolver build evaluates at most two thresholded leaves.
pub const MAX_LEAVES: usize = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Leaf {
    pub measure: String,
    pub property: String,
    pub threshold: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    /// "AND" or "OR"; irrelevant with one leaf.
    pub operator: String,
    pub leaves: Vec<Leaf>,
}

impl Rule {
    /// The rule the fusion applies when nobody set one: character trigrams on
    /// the name at the given floor, and an equal type.
    pub fn default_name_rule(floor: f64) -> Rule {
        Rule {
            operator: "AND".into(),
            leaves: vec![
                Leaf { measure: "trigrams".into(), property: "name".into(), threshold: floor },
                Leaf { measure: "exactmatch".into(), property: "type".into(), threshold: 1.0 },
            ],
        }
    }

    /// Parse and validate a rule from JSON. Err = a sentence for the user.
    pub fn parse(v: &Value) -> Result<Rule, String> {
        let raw: Rule = serde_json::from_value(v.clone())
            .map_err(|e| format!("rule must have 'operator' and 'leaves' ({e})"))?;
        // "ATOM" is how the LIMES learner labels a single-leaf spec.
        let operator = match raw.operator.trim().to_uppercase().as_str() {
            "ATOM" if raw.leaves.len() == 1 => "AND".to_string(),
            other => other.to_string(),
        };
        if operator != "AND" && operator != "OR" {
            return Err(format!("operator must be AND or OR, not '{}'", raw.operator));
        }
        if raw.leaves.is_empty() {
            return Err("a rule needs at least one condition".into());
        }
        if raw.leaves.len() > MAX_LEAVES {
            return Err(format!("a rule may have at most {MAX_LEAVES} conditions"));
        }
        let mut leaves = Vec::new();
        for l in raw.leaves {
            let measure = l.measure.trim().to_lowercase();
            let property = l.property.trim().to_lowercase();
            if !MEASURES.contains(&measure.as_str()) {
                return Err(format!("unknown measure '{}' (allowed: {})", l.measure, MEASURES.join(", ")));
            }
            if !PROPERTIES.contains(&property.as_str()) {
                return Err(format!("unknown property '{}' (allowed: {})", l.property, PROPERTIES.join(", ")));
            }
            if !(l.threshold.is_finite() && (0.0..=1.0).contains(&l.threshold)) {
                return Err("thresholds must be between 0 and 1".into());
            }
            let threshold = if measure == "exactmatch" { 1.0 } else { (l.threshold * 100.0).round() / 100.0 };
            leaves.push(Leaf { measure, property, threshold });
        }
        Ok(Rule { operator, leaves })
    }

    /// The LIMES link specification: `AND(trigrams(x.name, y.name)|0.4, exactmatch(x.type, y.type)|1.0)`.
    pub fn to_ls(&self) -> String {
        let leaf = |l: &Leaf| format!("{}(x.{p}, y.{p})|{}", l.measure, fmt_threshold(l.threshold), p = l.property);
        match self.leaves.as_slice() {
            [one] => leaf(one),
            [a, b] => format!("{}({}, {})", self.operator, leaf(a), leaf(b)),
            _ => self.leaves.iter().map(leaf).collect::<Vec<_>>().join(", "),
        }
    }

    /// The threshold of the first non-exact leaf (the "how similar" knob).
    pub fn similarity_threshold(&self) -> Option<f64> {
        self.leaves.iter().find(|l| l.measure != "exactmatch").map(|l| l.threshold)
    }

    /// The same rule with its similarity threshold replaced.
    pub fn with_similarity_threshold(&self, t: f64) -> Rule {
        let mut r = self.clone();
        if let Some(l) = r.leaves.iter_mut().find(|l| l.measure != "exactmatch") {
            l.threshold = (t * 100.0).round() / 100.0;
        }
        r
    }

    /// One English sentence, e.g. "Organizations are treated as the same when
    /// their names are at least 40 % similar (character trigrams) and their
    /// types are identical."
    pub fn sentence(&self, entity_type: &str) -> String {
        let joiner = if self.operator == "OR" { " or " } else { " and " };
        let clauses: Vec<String> = self.leaves.iter().map(leaf_phrase).collect();
        format!("{} are treated as the same when {}.", type_plural(entity_type), clauses.join(joiner))
    }
}

fn fmt_threshold(t: f64) -> String {
    let s = format!("{t:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() { "0".into() } else { s }
}

fn leaf_phrase(l: &Leaf) -> String {
    let prop = match l.property.as_str() {
        "name" => "names",
        "label" => "labels",
        "type" => "types",
        other => other,
    };
    if l.measure == "exactmatch" || l.threshold >= 1.0 {
        return format!("their {prop} are identical");
    }
    let how = match l.measure.as_str() {
        "trigrams" | "qgrams" => "character trigrams",
        "jaccard" => "word overlap",
        "cosine" => "word overlap, cosine",
        "levenshtein" => "edit distance",
        "jarowinkler" | "jaro" => "Jaro-Winkler",
        "koeln" => "Cologne phonetics",
        "soundex" => "Soundex phonetics",
        other => other,
    };
    format!("their {prop} are at least {} % similar ({how})", (l.threshold * 100.0).round() as i64)
}

pub fn type_plural(entity_type: &str) -> String {
    match entity_type.trim().to_lowercase().as_str() {
        "person" => "People".into(),
        "organization" | "company" => "Organizations".into(),
        "location" => "Locations".into(),
        "event" => "Events".into(),
        "product" => "Products".into(),
        "technology" => "Technologies".into(),
        "work" => "Works".into(),
        "" | "other" => "Entities".into(),
        t => {
            let mut c = t.chars();
            match c.next() {
                Some(f) => format!("{}{} entities", f.to_uppercase(), c.as_str()),
                None => "Entities".into(),
            }
        }
    }
}

/// The instruction for the model that turns a person's words into a rule.
pub fn translation_system_prompt() -> String {
    format!(
        "You convert a plain-language rule about when two knowledge-graph entities of one type \
         count as the same entity into JSON. Answer with JSON only, no prose, exactly this shape: \
         {{\"operator\": \"AND\"|\"OR\", \"leaves\": [{{\"measure\": <measure>, \"property\": <property>, \"threshold\": <0..1>}}]}}. \
         Allowed measures: {}. Allowed properties: {}. At most {} leaves. \
         Use 'exactmatch' with threshold 1 for 'identical' / 'exactly the same'; 'trigrams' for typos and \
         spelling variants; 'jaccard' or 'cosine' for word-order or word-overlap wording; 'koeln' or 'soundex' \
         for 'sounds like'. Percentages map to thresholds (80 % = 0.8). The input may be German or English. \
         If the request cannot be expressed, answer {{\"error\": \"<one short English sentence why>\"}}.",
        MEASURES.join(", "), PROPERTIES.join(", "), MAX_LEAVES
    )
}

/// Pull the JSON object out of a model answer (which may be fenced or wrapped).
pub fn extract_json(answer: &str) -> Option<Value> {
    let start = answer.find('{')?;
    let end = answer.rfind('}')?;
    if end <= start { return None; }
    serde_json::from_str(&answer[start..=end]).ok()
}

/// F1 for "same" when everything at or above `t` counts as the same.
pub fn f1_at(samples: &[(f64, bool)], t: f64) -> f64 {
    let (mut tp, mut fp, mut fn_) = (0usize, 0usize, 0usize);
    for (score, same) in samples {
        match (*score >= t, *same) {
            (true, true) => tp += 1,
            (true, false) => fp += 1,
            (false, true) => fn_ += 1,
            (false, false) => {}
        }
    }
    if tp == 0 { 0.0 } else { 2.0 * tp as f64 / (2 * tp + fp + fn_) as f64 }
}

/// Learned rules go live on their own when `GCTRL_LEARN_AUTO_APPLY` is not
/// "0"/"false"/"off" (Fabio, 07.10.2026: as little human interaction as
/// possible; a rule that passes the gate applies, the rest is proposed).
pub fn auto_apply_enabled(raw: Option<&str>) -> bool {
    !matches!(raw.map(|s| s.trim().to_lowercase()).as_deref(), Some("0") | Some("false") | Some("off") | Some("no"))
}

/// The gate a learned threshold must pass to apply without a click: at least
/// this F1 on the decisions it was learned from, and better than the rule in
/// force on the same decisions.
pub const AUTO_APPLY_MIN_F1: f64 = 0.8;

pub fn passes_gate(learned_f1: f64, current_f1: f64) -> bool {
    learned_f1 >= AUTO_APPLY_MIN_F1 && learned_f1 > current_f1
}

/// Learn the similarity threshold that separates the review decisions best.
/// `samples` = (score, same?). Needs at least `min_samples` with both answers
/// present. Candidates are the observed scores; the one with the highest F1 for
/// "same" wins, ties going to the higher threshold (precision first, since a
/// wrong merge is the costlier mistake).
pub fn learn_threshold(samples: &[(f64, bool)], min_samples: usize) -> Option<f64> {
    if samples.len() < min_samples.max(2) {
        return None;
    }
    let positives = samples.iter().filter(|(_, s)| *s).count();
    if positives == 0 || positives == samples.len() {
        return None;
    }
    let mut candidates: Vec<f64> = samples.iter().map(|(s, _)| *s).collect();
    candidates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    candidates.dedup();
    let mut best: Option<(f64, f64)> = None; // (f1, threshold)
    for t in candidates {
        let (mut tp, mut fp, mut fn_) = (0usize, 0usize, 0usize);
        for (score, same) in samples {
            let predicted = *score >= t;
            match (predicted, *same) {
                (true, true) => tp += 1,
                (true, false) => fp += 1,
                (false, true) => fn_ += 1,
                (false, false) => {}
            }
        }
        let f1 = if tp == 0 { 0.0 } else { 2.0 * tp as f64 / (2 * tp + fp + fn_) as f64 };
        match best {
            Some((bf, bt)) if f1 < bf || (f1 == bf && t <= bt) => {}
            _ => best = Some((f1, t)),
        }
    }
    best.map(|(_, t)| (t * 100.0).round() / 100.0)
}

/// Estimate what a changed similarity threshold would do to the last merge:
/// `scores` are the LIMES scores of the links the trail recorded for this type.
pub fn preview_from_scores(scores: &[f64], old_threshold: f64, new_threshold: f64) -> Value {
    let would_split = scores.iter().filter(|s| **s >= old_threshold && **s < new_threshold).count();
    let kept = scores.iter().filter(|s| **s >= new_threshold).count();
    json!({
        "basedOn": scores.len(),
        "wouldSplit": would_split,
        "wouldKeep": kept,
        "oldThreshold": old_threshold,
        "newThreshold": new_threshold,
        "note": if new_threshold < old_threshold {
            "A lower threshold merges more; new merges only show after a re-merge."
        } else {
            "Estimated from the scores of the last merge; new rules apply on the next merge."
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(v: Value) -> Rule { Rule::parse(&v).unwrap() }

    #[test]
    fn default_rule_renders_the_known_ls_and_a_sentence() {
        let r = Rule::default_name_rule(0.4);
        assert_eq!(r.to_ls(), "AND(trigrams(x.name, y.name)|0.4, exactmatch(x.type, y.type)|1)");
        assert_eq!(
            r.sentence("organization"),
            "Organizations are treated as the same when their names are at least 40 % similar (character trigrams) and their types are identical."
        );
        assert_eq!(r.sentence("person").split(' ').next(), Some("People"));
    }

    #[test]
    fn parse_normalises_and_rejects() {
        let r = rule(json!({"operator": "and", "leaves": [{"measure": "Jaccard", "property": "Name", "threshold": 0.8765}]}));
        assert_eq!(r.operator, "AND");
        assert_eq!(r.leaves[0], Leaf { measure: "jaccard".into(), property: "name".into(), threshold: 0.88 });
        assert_eq!(r.to_ls(), "jaccard(x.name, y.name)|0.88");
        assert!(Rule::parse(&json!({"operator": "XOR", "leaves": [{"measure": "jaccard", "property": "name", "threshold": 0.5}]})).is_err());
        // the LIMES learner's single-leaf form, with its extra global threshold key
        let atom = rule(json!({"operator": "ATOM", "threshold": 1.0, "leaves": [{"measure": "jaccard", "property": "label", "threshold": 1.0}]}));
        assert_eq!(atom.to_ls(), "jaccard(x.label, y.label)|1");
        assert!(Rule::parse(&json!({"operator": "AND", "leaves": []})).is_err());
        assert!(Rule::parse(&json!({"operator": "AND", "leaves": [{"measure": "embedding", "property": "name", "threshold": 0.5}]})).is_err());
        assert!(Rule::parse(&json!({"operator": "AND", "leaves": [{"measure": "jaccard", "property": "name", "threshold": 1.5}]})).is_err());
        let three = json!({"operator": "AND", "leaves": [
            {"measure": "jaccard", "property": "name", "threshold": 0.5},
            {"measure": "koeln", "property": "name", "threshold": 0.9},
            {"measure": "exactmatch", "property": "type", "threshold": 1}]});
        assert!(Rule::parse(&three).is_err());
    }

    #[test]
    fn exactmatch_is_always_identical_and_or_reads_as_or() {
        let r = rule(json!({"operator": "OR", "leaves": [
            {"measure": "exactmatch", "property": "name", "threshold": 0.3},
            {"measure": "koeln", "property": "name", "threshold": 0.9}]}));
        assert_eq!(r.leaves[0].threshold, 1.0);
        assert_eq!(r.sentence("person"),
            "People are treated as the same when their names are identical or their names are at least 90 % similar (Cologne phonetics).");
        assert_eq!(r.to_ls(), "OR(exactmatch(x.name, y.name)|1, koeln(x.name, y.name)|0.9)");
    }

    #[test]
    fn similarity_threshold_knob() {
        let r = Rule::default_name_rule(0.4);
        assert_eq!(r.similarity_threshold(), Some(0.4));
        assert_eq!(r.with_similarity_threshold(0.555).similarity_threshold(), Some(0.56));
    }

    #[test]
    fn extract_json_tolerates_fences_and_prose() {
        let v = extract_json("Sure:\n```json\n{\"operator\":\"AND\",\"leaves\":[]}\n```").unwrap();
        assert_eq!(v["operator"], "AND");
        assert!(extract_json("no json here").is_none());
    }

    #[test]
    fn learned_threshold_separates_decisions_precision_first() {
        // 0.62 keeps every "same" and admits one "not_same" (F1 0.91); 0.70 loses one
        // "same" (F1 0.89). The best F1 wins; a tie would go to the higher threshold.
        let samples = [(0.55, false), (0.60, false), (0.62, false), (0.62, true), (0.70, true), (0.80, true),
                       (0.90, true), (0.50, false), (0.45, false), (0.75, true)];
        assert_eq!(learn_threshold(&samples, 10), Some(0.62));
        // a clean separation picks the first "same" score
        assert_eq!(learn_threshold(&[(0.3, false), (0.4, false), (0.7, true), (0.9, true)], 2), Some(0.7));
        assert_eq!(learn_threshold(&samples, 11), None);
        assert_eq!(learn_threshold(&[(0.5, true), (0.6, true)], 2), None);
    }

    #[test]
    fn gate_and_switch() {
        let samples = [(0.5, false), (0.6, false), (0.7, true), (0.9, true)];
        assert_eq!(f1_at(&samples, 0.7), 1.0);
        assert!((f1_at(&samples, 0.4) - 2.0 / 3.0).abs() < 1e-9);
        assert!(passes_gate(1.0, 0.67));
        assert!(!passes_gate(0.79, 0.5));
        assert!(!passes_gate(0.9, 0.9));
        assert!(auto_apply_enabled(None));
        assert!(auto_apply_enabled(Some("1")));
        assert!(!auto_apply_enabled(Some("0")));
        assert!(!auto_apply_enabled(Some(" off ")));
    }

    #[test]
    fn preview_counts_links_the_new_floor_would_drop() {
        let p = preview_from_scores(&[0.45, 0.62, 0.70, 0.90], 0.40, 0.65);
        assert_eq!(p["wouldSplit"], 2);
        assert_eq!(p["wouldKeep"], 2);
        assert_eq!(p["basedOn"], 4);
    }

    #[test]
    fn migration_097_has_the_single_active_rule_invariant() {
        let m = include_str!("../../migrations/097_merge_rules.sql");
        assert!(m.contains("uq_merge_rules_active"));
        assert!(m.contains("WHERE status = 'active'"));
        assert!(m.contains("CHECK (origin IN ('default', 'human', 'learned'))"));
    }
}

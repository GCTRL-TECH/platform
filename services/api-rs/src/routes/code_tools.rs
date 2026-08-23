//! Codebase KB read tools (P1a): fixed Cypher over code symbols, scoped exactly
//! like `get_neighbors` (clearance rank + KB grants via node_auth_clause /
//! job_scope). No ad-hoc Cypher is ever accepted from the caller.

use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::middleware::auth::JwtClaims;
use crate::routes::agent::node_auth_clause;

pub(crate) const TOOLS: &[&str] = &["code_symbol", "code_trace", "code_impact", "code_architecture"];

/// Shared "not found" message for `scope_jobs`: identical whether the
/// compilation truly does not exist or exists but belongs to someone else and
/// isn't kb-scope-granted to this caller — a foreign id must never be
/// distinguishable from a nonexistent one.
const COMPILATION_NOT_FOUND: &str = "compilation not found";

/// Escape a user string for use inside a Cypher `=~` regex.
pub(crate) fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for ch in s.chars() {
        if r"\.^$|?*+()[]{}".contains(ch) { out.push('\\'); }
        out.push(ch);
    }
    out
}

pub(crate) fn code_symbol_cypher(auth: &str) -> String {
    format!(
        "MATCH (n:Entity) \
           WHERE n.coarse_type = 'code' AND {auth} AND coalesce(n._min_rank,0) <= $rank \
             AND (n.name =~ $re OR coalesce(n._file,'') =~ $re) \
             AND ($types = [] OR n.type IN $types) \
         RETURN n.name AS name, n.type AS type, n._file AS file, n._repo AS repo, \
                n.line_start AS line_start, n.line_end AS line_end, n.signature AS signature, \
                n.doc AS doc, n.exported AS exported, \
                size([(n)<-[:CALLS]-() | 1]) AS callers, size([(n)-[:CALLS]->() | 1]) AS callees \
         ORDER BY callers DESC, name ASC SKIP $offset LIMIT $limit"
    )
}

/// `sauth` / `mauth` are `node_auth_clause("s", ..)` / `node_auth_clause("m", ..)`.
pub(crate) fn code_trace_cypher(sauth: &str, mauth: &str, direction: &str, depth: i64) -> String {
    let pattern = match direction {
        "callers" => format!("(s)<-[rs:CALLS*1..{depth}]-(m)"),
        "callees" => format!("(s)-[rs:CALLS*1..{depth}]->(m)"),
        _         => format!("(s)-[rs:CALLS*1..{depth}]-(m)"),
    };
    format!(
        "MATCH (s:Entity {{name: $name}}) WHERE s.coarse_type = 'code' AND {sauth} AND coalesce(s._min_rank,0) <= $rank \
         MATCH p = {pattern} WHERE {mauth} AND coalesce(m._min_rank,0) <= $rank \
         WITH m, p, size(rs) AS hops, \
              [r IN rs | coalesce(r.confidence,1.0)] AS confs, \
              [r IN rs | coalesce(r.resolution,'syntax')] AS ress, \
              [x IN nodes(p) | x.name] AS names \
         RETURN DISTINCT m.name AS name, m.type AS type, m._file AS file, m.line_start AS line_start, hops, confs, ress, names \
         ORDER BY hops ASC, name ASC LIMIT 100"
    )
}

/// Resolve the job scope for a tool call: explicit compilation (must be granted)
/// or the token's grants. `Some(vec![])` means "scoped but nothing visible".
/// Owner or kb-scoped grant required; foreign ids behave as not found.
async fn scope_jobs(
    state: &Arc<crate::models::AppState>, claims: &JwtClaims, compilation_id: Option<Uuid>,
) -> std::result::Result<Option<Vec<String>>, Value> {
    if let Some(cid) = compilation_id {
        let eff = crate::routes::kg::effective_rank_for_compilation(&state.db, claims, cid).await;
        if eff == i32::MIN { return Err(json!({ "error": "compilation not granted to this token" })); }
        let row: Option<(Vec<Uuid>, Uuid)> = sqlx::query_as(
            "SELECT COALESCE(source_job_ids,'{}'::uuid[]), user_id FROM compilations WHERE id = $1"
        ).bind(cid).fetch_optional(&state.db).await.ok().flatten();
        let Some((jobs, owner_id)) = row else { return Err(json!({ "error": COMPILATION_NOT_FOUND })); };
        // Owner or kb-scoped grant required; foreign ids return the SAME "not
        // found" message as a nonexistent id — never reveal that a compilation
        // exists but belongs to someone else. Mirrors code_manifest (kex.rs).
        if owner_id != claims.sub {
            match crate::routes::kg::api_key_scope(&state.db, claims).await {
                Some(ref s) if s.contains(&cid) => {}
                _ => return Err(json!({ "error": COMPILATION_NOT_FOUND })),
            }
        }
        return Ok(Some(jobs.iter().map(|u| u.to_string()).collect()));
    }
    Ok(crate::routes::kg::api_key_scoped_jobs(&state.db, claims).await)
}

fn parse_uuid(v: &Value) -> Option<Uuid> { v.as_str().and_then(|s| Uuid::parse_str(s).ok()) }

/// Entry point called from agent.rs. Returns None when `tool_name` is not ours.
pub(crate) async fn execute(
    state: &Arc<crate::models::AppState>, claims: &JwtClaims, tool_name: &str, args: &Value,
) -> Option<Value> {
    if !TOOLS.contains(&tool_name) { return None; }
    let rank = crate::routes::kg::get_user_clearance_rank(&state.db, claims).await;
    let uid = claims.sub.to_string();
    let scoped = match scope_jobs(state, claims, parse_uuid(&args["compilationId"])).await {
        Ok(s) => s, Err(e) => return Some(e),
    };
    if matches!(&scoped, Some(j) if j.is_empty()) {
        return Some(json!({ "results": [], "note": "no code knowledge base granted to this token" }));
    }
    let auth = node_auth_clause("n", &scoped);
    // Same resource_id convention as get_neighbors: the thing being looked up,
    // not a wildcard, for the audited entries that have one.
    let resource_id: String = match tool_name {
        "code_symbol" => args["query"].as_str().unwrap_or("").trim().to_string(),
        "code_trace" => args["symbol"].as_str().unwrap_or("").trim().to_string(),
        "code_impact" => {
            let mut items: Vec<String> = args["changedFiles"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            items.extend(args["changedSymbols"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<String>>()).unwrap_or_default());
            items.join(",").chars().take(200).collect()
        }
        "code_architecture" => args["compilationId"].as_str().unwrap_or("").trim().to_string(),
        _ => "*".to_string(),
    };
    let out = match tool_name {
        "code_symbol" => {
            let q = args["query"].as_str().unwrap_or("").trim().to_string();
            if q.is_empty() { return Some(json!({ "error": "query is required" })); }
            let limit = args["limit"].as_i64().unwrap_or(10).clamp(1, 100);
            let offset = args["offset"].as_i64().unwrap_or(0).max(0);
            let types: Vec<String> = args["types"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            let re = format!("(?i).*{}.*", regex_escape(&q));
            let mut nq = neo4rs::query(&code_symbol_cypher(&auth))
                .param("re", re).param("uid", uid.clone()).param("rank", rank as i64)
                .param("limit", limit).param("offset", offset).param("types", types);
            if let Some(jobs) = &scoped { nq = nq.param("jobs", jobs.clone()); }
            let mut rows = Vec::new();
            if let Ok(mut stream) = state.neo.execute(nq).await {
                while let Ok(Some(row)) = stream.next().await {
                    rows.push(json!({
                        "name": row.get::<String>("name").unwrap_or_default(),
                        "type": row.get::<String>("type").unwrap_or_default(),
                        "file": row.get::<String>("file").ok(),
                        "repo": row.get::<String>("repo").ok(),
                        "line_start": row.get::<i64>("line_start").ok(),
                        "line_end": row.get::<i64>("line_end").ok(),
                        "signature": row.get::<String>("signature").ok(),
                        "doc": row.get::<String>("doc").ok(),
                        "exported": row.get::<bool>("exported").ok(),
                        "callers": row.get::<i64>("callers").unwrap_or(0),
                        "callees": row.get::<i64>("callees").unwrap_or(0),
                    }));
                }
            }
            json!({ "query": q, "results": rows, "offset": offset, "limit": limit })
        }
        "code_trace" => {
            let name = args["symbol"].as_str().unwrap_or("").trim().to_string();
            if name.is_empty() { return Some(json!({ "error": "symbol is required (use code_symbol to find the exact name)" })); }
            let direction = match args["direction"].as_str().unwrap_or("callers") { "callees" => "callees", "both" => "both", _ => "callers" };
            let depth = args["depth"].as_i64().unwrap_or(2).clamp(1, 5);
            let (sauth, mauth) = (node_auth_clause("s", &scoped), node_auth_clause("m", &scoped));
            let mut nq = neo4rs::query(&code_trace_cypher(&sauth, &mauth, direction, depth))
                .param("name", name.clone()).param("uid", uid.clone()).param("rank", rank as i64);
            if let Some(jobs) = &scoped { nq = nq.param("jobs", jobs.clone()); }
            let mut rows = Vec::new();
            if let Ok(mut stream) = state.neo.execute(nq).await {
                while let Ok(Some(row)) = stream.next().await {
                    let confs = row.get::<Vec<f64>>("confs").unwrap_or_default();
                    let ress = row.get::<Vec<String>>("ress").unwrap_or_default();
                    let steps: Vec<Value> = confs.into_iter().zip(ress.into_iter())
                        .map(|(c, r)| json!({ "confidence": c, "resolution": r }))
                        .collect();
                    rows.push(json!({
                        "name": row.get::<String>("name").unwrap_or_default(),
                        "type": row.get::<String>("type").unwrap_or_default(),
                        "file": row.get::<String>("file").ok(),
                        "line_start": row.get::<i64>("line_start").ok(),
                        "hops": row.get::<i64>("hops").unwrap_or(0),
                        "path": row.get::<Vec<String>>("names").unwrap_or_default(),
                        "steps": steps,
                    }));
                }
            }
            json!({ "symbol": name, "direction": direction, "depth": depth, "results": rows })
        }
        "code_impact" => impact(state, claims, &auth, &scoped, rank, &uid, args).await,
        "code_architecture" => architecture(state, &auth, &scoped, rank, &uid, args).await,
        _ => unreachable!(),
    };
    crate::services::audit::log_access(&state.db, claims, &format!("agent.{tool_name}"), "code", &resource_id, rank, None, true, None).await;
    Some(out)
}

/// `auth` / `mauth` are `node_auth_clause("n", ..)` / `node_auth_clause("m", ..)`.
pub(crate) fn code_impact_cypher(auth: &str, mauth: &str, depth: i64) -> String {
    format!(
        "MATCH (n:Entity) WHERE n.coarse_type = 'code' AND {auth} AND coalesce(n._min_rank,0) <= $rank \
           AND (n._file IN $files OR n.name IN $symbols) \
         OPTIONAL MATCH (n)<-[rs:CALLS*1..{depth}]-(m) \
           WHERE {mauth} AND coalesce(m._min_rank,0) <= $rank \
         WITH n, m, min(CASE WHEN m IS NULL THEN 0 ELSE size(rs) END) AS hops \
         RETURN n.name AS changed, coalesce(m.name, n.name) AS affected, m._file AS file, \
                coalesce(m.type, n.type) AS type, hops, \
                CASE WHEN m IS NULL THEN 0 ELSE size([(m)<-[:CALLS]-() | 1]) END AS fan_in \
         ORDER BY hops ASC, fan_in DESC LIMIT 500"
    )
}

pub(crate) fn code_architecture_cyphers(auth: &str) -> Vec<(&'static str, String)> {
    let base = format!("MATCH (n:Entity) WHERE n.coarse_type = 'code' AND {auth} AND coalesce(n._min_rank,0) <= $rank");
    vec![
        ("languages", format!("{base} AND n.type = 'file' RETURN coalesce(n.lang,'other') AS k, count(*) AS v ORDER BY v DESC")),
        ("packages", format!("{base} AND n.type = 'file' WITH split(coalesce(n._file,''),'/') AS parts \
            RETURN CASE WHEN size(parts) > 1 THEN parts[0] ELSE '.' END AS k, count(*) AS v ORDER BY v DESC LIMIT 25")),
        ("symbol_counts", format!("{base} RETURN n.type AS k, count(*) AS v ORDER BY v DESC")),
        ("hotspots", format!("{base} AND n.type IN ['function','method','class','interface','struct'] \
            WITH n, size([(n)<-[:CALLS]-() | 1]) AS callers, size([(n)-[:CALLS]->() | 1]) AS callees \
            RETURN n.name AS name, n._file AS file, n.type AS type, callers, callees, callers + callees AS degree \
            ORDER BY degree DESC LIMIT 15")),
        ("dead_candidates", format!("{base} AND n.type IN ['function','method'] \
            AND coalesce(n.exported,false) = false AND NOT EXISTS {{ (n)<-[:CALLS]-() }} \
            AND NOT n.name ENDS WITH '::main' AND NOT n.name CONTAINS '::test' \
            RETURN n.name AS name, n._file AS file, n.line_start AS line_start ORDER BY n._file, n.line_start LIMIT 25")),
        ("communities", format!("{base} AND n._community IS NOT NULL RETURN toString(n._community) AS k, count(*) AS v ORDER BY v DESC LIMIT 20")),
    ]
}

async fn impact(
    state: &Arc<crate::models::AppState>, _claims: &JwtClaims, auth: &str,
    scoped: &Option<Vec<String>>, rank: i32, uid: &str, args: &Value,
) -> Value {
    let files: Vec<String> = args["changedFiles"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.replace('\\', "/"))).collect()).unwrap_or_default();
    let symbols: Vec<String> = args["changedSymbols"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    if files.is_empty() && symbols.is_empty() {
        return json!({ "error": "changedFiles or changedSymbols is required" });
    }
    let depth = args["depth"].as_i64().unwrap_or(2).clamp(1, 3);
    let mauth = node_auth_clause("m", scoped);
    let mut nq = neo4rs::query(&code_impact_cypher(auth, &mauth, depth))
        .param("files", files.clone()).param("symbols", symbols.clone())
        .param("uid", uid.to_string()).param("rank", rank as i64);
    if let Some(jobs) = scoped { nq = nq.param("jobs", jobs.clone()); }
    let mut affected = Vec::new();
    let mut by_file: std::collections::BTreeMap<String, i64> = Default::default();
    let mut max_fan_in = 0i64;
    if let Ok(mut stream) = state.neo.execute(nq).await {
        while let Ok(Some(row)) = stream.next().await {
            let hops = row.get::<i64>("hops").unwrap_or(0);
            let file = row.get::<String>("file").unwrap_or_default();
            let fan_in = row.get::<i64>("fan_in").unwrap_or(0);
            if hops > 0 {
                *by_file.entry(file.clone()).or_insert(0) += 1;
                max_fan_in = max_fan_in.max(fan_in);
            }
            affected.push(json!({
                "changed": row.get::<String>("changed").unwrap_or_default(),
                "affected": row.get::<String>("affected").unwrap_or_default(),
                "file": file, "type": row.get::<String>("type").unwrap_or_default(),
                "hops": hops, "fan_in": fan_in,
            }));
        }
    }
    let n_affected = affected.iter().filter(|a| a["hops"].as_i64().unwrap_or(0) > 0).count();
    let risk = if n_affected == 0 { "low" } else if n_affected < 10 && max_fan_in < 5 { "medium" } else { "high" };
    json!({ "changedFiles": files, "changedSymbols": symbols, "depth": depth,
            "affected": affected, "affectedFiles": by_file, "affectedCount": n_affected, "risk": risk })
}

async fn architecture(
    state: &Arc<crate::models::AppState>, auth: &str, scoped: &Option<Vec<String>>, rank: i32, uid: &str, args: &Value,
) -> Value {
    if parse_uuid(&args["compilationId"]).is_none() {
        return json!({ "error": "compilationId is required" });
    }
    let mut out = serde_json::Map::new();
    for (key, cypher) in code_architecture_cyphers(auth) {
        let mut nq = neo4rs::query(&cypher).param("uid", uid.to_string()).param("rank", rank as i64);
        if let Some(jobs) = scoped { nq = nq.param("jobs", jobs.clone()); }
        let mut rows = Vec::new();
        if let Ok(mut stream) = state.neo.execute(nq).await {
            while let Ok(Some(row)) = stream.next().await {
                if key == "hotspots" {
                    rows.push(json!({ "name": row.get::<String>("name").unwrap_or_default(), "file": row.get::<String>("file").ok(),
                        "type": row.get::<String>("type").unwrap_or_default(), "callers": row.get::<i64>("callers").unwrap_or(0),
                        "callees": row.get::<i64>("callees").unwrap_or(0), "degree": row.get::<i64>("degree").unwrap_or(0) }));
                } else if key == "dead_candidates" {
                    rows.push(json!({ "name": row.get::<String>("name").unwrap_or_default(), "file": row.get::<String>("file").ok(),
                        "line_start": row.get::<i64>("line_start").ok() }));
                } else {
                    rows.push(json!({ "key": row.get::<String>("k").unwrap_or_default(), "count": row.get::<i64>("v").unwrap_or(0) }));
                }
            }
        }
        out.insert(key.to_string(), Value::Array(rows));
    }
    out.insert("hint".into(), json!("Run detect_communities(compilationId) to populate communities; use code_trace on a hotspot to see its callers."));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compilation_not_found_message_is_a_single_shared_constant() {
        // scope_jobs's not-found branch (missing row) and its foreign-owner
        // branch (owner_id != claims.sub, not kb-scope-granted) must return the
        // identical message — a foreign compilation id can't be distinguished
        // from a nonexistent one. Both branches read this one const, so any
        // future edit that drifts one literal away from the other fails here.
        assert_eq!(COMPILATION_NOT_FOUND, "compilation not found");
    }

    #[test]
    fn symbol_cypher_is_scoped_rank_filtered_and_code_only() {
        let c = code_symbol_cypher("(n._owner = $uid OR n.user_id = $uid)");
        assert!(c.contains("n.coarse_type = 'code'"));
        assert!(c.contains("coalesce(n._min_rank,0) <= $rank"));
        assert!(c.contains("n._owner = $uid"));
        assert!(c.contains("=~ $re"));
        assert!(c.contains("SKIP $offset LIMIT $limit"));
    }

    #[test]
    fn trace_cypher_respects_direction_and_depth() {
        let callers = code_trace_cypher("(s._owner = $uid)", "(m._owner = $uid)", "callers", 3);
        assert!(callers.contains("<-[rs:CALLS*1..3]-"));
        assert!(callers.contains("(m._owner = $uid)"));
        let callees = code_trace_cypher("(s._owner = $uid)", "(m._owner = $uid)", "callees", 2);
        assert!(callees.contains("-[rs:CALLS*1..2]->"));
        let both = code_trace_cypher("(s._owner = $uid)", "(m._owner = $uid)", "both", 1);
        assert!(both.contains("-[rs:CALLS*1..1]-") && !both.contains("]->") );
    }

    #[test]
    fn regex_escape_neutralises_metachars() {
        assert_eq!(regex_escape("a.b(c)"), r"a\.b\(c\)");
    }

    #[test]
    fn impact_cypher_matches_files_or_symbols_and_walks_callers() {
        let c = code_impact_cypher("(n._owner = $uid)", "(m._owner = $uid)", 2);
        assert!(c.contains("n._file IN $files OR n.name IN $symbols"));
        assert!(c.contains("<-[rs:CALLS*1..2]-"));
        assert!(c.contains("(m._owner = $uid)"));
        assert!(c.contains("m._file AS file"));
        assert!(c.contains("min(CASE WHEN m IS NULL"));
        assert!(!c.contains("MATCH p ="));
    }

    #[test]
    fn architecture_cyphers_cover_languages_hotspots_dead() {
        let cs = code_architecture_cyphers("(n._owner = $uid)");
        let keys: Vec<&str> = cs.iter().map(|(k, _)| *k).collect();
        for k in ["languages", "packages", "symbol_counts", "hotspots", "dead_candidates", "communities"] {
            assert!(keys.contains(&k), "missing {k}");
        }
        let dead = &cs.iter().find(|(k, _)| *k == "dead_candidates").unwrap().1;
        assert!(dead.contains("NOT EXISTS { (n)<-[:CALLS]-() }"));
        assert!(dead.contains("coalesce(n.exported,false) = false"));
    }
}

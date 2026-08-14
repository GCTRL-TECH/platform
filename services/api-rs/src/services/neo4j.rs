//! Neo4j connection + graph provenance/lifecycle helpers.
//!
//! ## Provenance model
//!
//! Two families of nodes live in the graph:
//!
//! * **Raw** `(:Entity)`, written by KEX. URI-merged across jobs, so several
//!   extractions can contribute to the same node. `_source_job` names only the
//!   LATEST contributor (kept for display/lineage); `_source_jobs` is the full
//!   membership list and is what scoping and deletion go by.
//! * **Merged** `(:Entity:Merged {_compilation})`, written by FUSE, plus the
//!   `(:Compilation {compilation_id})` container they hang off. These belong to
//!   exactly one compilation by construction.
//!
//! A raw node is garbage exactly when its `_source_jobs` list is empty: no job
//! claims it, so no compilation can reach it (membership resolves
//! compilation → `source_job_ids` → `_source_jobs`) and no unscoped query
//! should surface it either. That is the rule both purge paths below encode.

use std::sync::Arc;
use uuid::Uuid;

pub async fn connect(uri: &str, user: &str, password: &str) -> Arc<neo4rs::Graph> {
    let config = neo4rs::ConfigBuilder::default()
        .uri(uri)
        .user(user)
        .password(password)
        .max_connections(50)
        .build()
        .expect("Neo4j config error");
    Arc::new(neo4rs::Graph::connect(config).await.expect("Neo4j connection failed"))
}

/// Cypher expression yielding an element's full job membership as a list.
///
/// The inner CASE is the fallback for elements written before `_source_jobs`
/// existed. Migration 075 backfills them, but a query must stay correct while
/// that backfill is still running (and on a graph restored from an old dump).
pub fn source_jobs_expr(alias: &str) -> String {
    format!(
        "coalesce({alias}._source_jobs, \
         CASE WHEN {alias}._source_job IS NULL THEN [] ELSE [{alias}._source_job] END)"
    )
}

/// Predicate: does this element belong to any of the jobs in `$<param>`?
///
/// Replaces the old `alias._source_job IN $jobs`, which only ever tested the
/// latest contributor and therefore hid nodes that a scoped token legitimately
/// owns (and, worse, made deletion unable to tell shared nodes from private ones).
pub fn job_scope(alias: &str, param: &str) -> String {
    format!("any(__sj IN {} WHERE __sj IN ${param})", source_jobs_expr(alias))
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PurgeStats {
    pub nodes_deleted: i64,
    pub rels_deleted: i64,
}

impl PurgeStats {
    pub fn total(&self) -> i64 {
        self.nodes_deleted + self.rels_deleted
    }
}

/// Drop `jobs` from the membership of every element that carries them, then
/// delete whatever is left with no membership at all.
///
/// Relationships go first: an edge can lose its last contributor while both
/// endpoints survive, and that edge has to go on its own account. Nodes follow,
/// and `DETACH DELETE` takes their remaining edges with them — an edge whose
/// endpoint is claimed by nobody cannot outlive it.
///
/// Callers must pass only jobs that are genuinely going away. For a compilation
/// delete that means its `source_job_ids` MINUS every job another compilation
/// still references; see `orphaned_jobs`.
pub async fn purge_jobs(neo: &neo4rs::Graph, jobs: &[Uuid]) -> PurgeStats {
    let mut stats = PurgeStats::default();
    if jobs.is_empty() {
        return stats;
    }
    let job_strs: Vec<String> = jobs.iter().map(|j| j.to_string()).collect();
    stats.rels_deleted = run_count(neo, &purge_rels_cypher(), &job_strs).await;
    stats.nodes_deleted = run_count(neo, &purge_nodes_cypher(), &job_strs).await;
    stats
}

/// Relationship half of `purge_jobs`, as a pure string so it can be exercised
/// against a real database without a live service.
pub fn purge_rels_cypher() -> String {
    format!(
        "MATCH ()-[r]->() WHERE {scope} \
         WITH r, [__sj IN {expr} WHERE NOT __sj IN $jobs] AS keep \
         SET r._source_jobs = keep, \
             r._source_job = CASE WHEN size(keep) = 0 THEN NULL ELSE last(keep) END \
         WITH r, keep WHERE size(keep) = 0 \
         DELETE r \
         RETURN count(*) AS deleted",
        scope = job_scope("r", "jobs"),
        expr = source_jobs_expr("r"),
    )
}

/// Node half of `purge_jobs`. Runs after the relationship half: `DETACH DELETE`
/// would otherwise take edges whose own membership was never re-evaluated.
pub fn purge_nodes_cypher() -> String {
    format!(
        "MATCH (n) WHERE {scope} \
         WITH n, [__sj IN {expr} WHERE NOT __sj IN $jobs] AS keep \
         SET n._source_jobs = keep, \
             n._source_job = CASE WHEN size(keep) = 0 THEN NULL ELSE last(keep) END \
         WITH n, keep WHERE size(keep) = 0 \
         DETACH DELETE n \
         RETURN count(*) AS deleted",
        scope = job_scope("n", "jobs"),
        expr = source_jobs_expr("n"),
    )
}

/// Delete the graph-side footprint that belongs to exactly one compilation: the
/// FUSE-merged entities (`:Entity:Merged {_compilation}`) and the `(:Compilation)`
/// container node. Raw entities are NOT touched here — they are shared across
/// compilations via jobs and are handled by `purge_jobs`.
pub async fn purge_compilation(neo: &neo4rs::Graph, compilation_id: Uuid) -> PurgeStats {
    let cid = compilation_id.to_string();
    let mut stats = PurgeStats::default();

    stats.nodes_deleted += run_count_cid(
        neo,
        "MATCH (n:Merged {_compilation: $cid}) DETACH DELETE n RETURN count(*) AS deleted",
        &cid,
    ).await;

    stats.nodes_deleted += run_count_cid(
        neo,
        "MATCH (c:Compilation {compilation_id: $cid}) DETACH DELETE c RETURN count(*) AS deleted",
        &cid,
    ).await;

    stats
}

async fn run_count(neo: &neo4rs::Graph, cypher: &str, jobs: &[String]) -> i64 {
    match neo.execute(neo4rs::query(cypher).param("jobs", jobs.to_vec())).await {
        Ok(mut stream) => match stream.next().await {
            Ok(Some(row)) => row.get::<i64>("deleted").unwrap_or(0),
            _ => 0,
        },
        Err(e) => {
            tracing::warn!("neo4j purge failed: {e}");
            0
        }
    }
}

async fn run_count_cid(neo: &neo4rs::Graph, cypher: &str, cid: &str) -> i64 {
    match neo.execute(neo4rs::query(cypher).param("cid", cid)).await {
        Ok(mut stream) => match stream.next().await {
            Ok(Some(row)) => row.get::<i64>("deleted").unwrap_or(0),
            _ => 0,
        },
        Err(e) => {
            tracing::warn!("neo4j purge failed: {e}");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_reads_the_list_not_the_latest_contributor() {
        let clause = job_scope("n", "jobIds");
        assert!(clause.contains("n._source_jobs"), "must consult the membership list");
        assert!(clause.starts_with("any("), "must be an ANY predicate, not an IN test");
        assert!(clause.contains("$jobIds"), "must bind the caller's parameter name");
    }

    #[test]
    fn scope_falls_back_to_the_legacy_single_job() {
        // A node written before migration 075 has only `_source_job`. It must stay
        // visible to its owner, otherwise the backfill window silently hides data.
        let expr = source_jobs_expr("e");
        assert!(expr.contains("e._source_job IS NULL"));
        assert!(expr.contains("[e._source_job]"));
    }

    #[test]
    fn scope_aliases_do_not_collide() {
        // Both sides of an edge predicate are built independently and get ANDed
        // together; a shared bare variable name would shadow.
        let a = job_scope("a", "jobs");
        let b = job_scope("b", "jobs");
        assert_ne!(a, b);
        assert!(a.contains("a._source_jobs") && !a.contains("b._source_jobs"));
    }

    #[test]
    fn purge_keeps_the_jobs_it_was_not_asked_to_remove() {
        // Verified against a real Neo4j 2026.x on 2026-08-14 with these exact
        // statements: a node owned by jobs [A,B], purged for [A], survives as [B]
        // with `_source_job` rewritten to B; a node owned by [A] alone is deleted.
        // The shape below is what makes that true — subtract, then delete only the
        // elements whose membership actually ran out.
        let nodes = purge_nodes_cypher();
        assert!(nodes.contains("WHERE NOT __sj IN $jobs] AS keep"), "must subtract, not match-all");
        assert!(nodes.contains("WHERE size(keep) = 0"), "must delete only exhausted membership");
        assert!(nodes.contains("DETACH DELETE n"));

        let rels = purge_rels_cypher();
        assert!(rels.contains("WHERE size(keep) = 0"));
        // Relationships are deleted plainly; DETACH is meaningless for an edge and
        // would be a syntax error.
        assert!(rels.contains("DELETE r") && !rels.contains("DETACH DELETE r"));
    }

    #[test]
    fn purge_rewrites_the_latest_contributor_pointer() {
        // Leaving a stale `_source_job` behind would point display/lineage at a job
        // that no longer exists.
        for cypher in [purge_nodes_cypher(), purge_rels_cypher()] {
            assert!(cypher.contains("CASE WHEN size(keep) = 0 THEN NULL ELSE last(keep) END"),
                    "got: {cypher}");
        }
    }

    #[test]
    fn purge_stats_add_up() {
        let s = PurgeStats { nodes_deleted: 3, rels_deleted: 4 };
        assert_eq!(s.total(), 7);
    }
}

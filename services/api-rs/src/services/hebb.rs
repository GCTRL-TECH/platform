//! Hebbian memory dynamics — "use strengthens, disuse forgets".
//!
//! One module owns every heat write on the HOT (entity_dossiers) and COLD
//! (text_chunks) tiers, so every read path reinforces the same way:
//!
//! - **Reinforcement**: an access adds `weight(signal) / (1 + 0.3·rank)` heat,
//!   bumps `access_count`, revives a soft-archived row (unless it was archived by
//!   A5 dedup — those vectors are gone) and lengthens the row's half-life.
//! - **Association** (`fire together, wire together`): the chunks returned
//!   together in one retrieval are linked in `memory_coactivation` with a bounded
//!   Hebbian update `w += η·(1 − w)`. KEX reads those pairs at search time and
//!   pulls a strong neighbour into the result (kex/src/hebb.py).
//! - **Consolidation**: every use multiplies the item's half-life by 1.5 up to a
//!   cap, so knowledge that keeps being used decays on a scale of months while a
//!   one-off passage is back near zero after a couple of weeks. The governance
//!   cycle (background/mod.rs) decays with `0.5^(tick / half_life)`.
//!
//! Everything here is best-effort: a DB hiccup never fails the caller's request.

use uuid::Uuid;

/// Why an item was touched. The weight is the heat a rank-1 hit receives.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Signal {
    /// The item grounded a RAG answer (rag.rs `query`), or a dossier was injected
    /// as the HOT block / read explicitly.
    Answer,
    /// An agent saw the item in `search_chunks` / resolved the entity in
    /// `get_entity` — it may or may not have used it.
    Search,
    /// An explicit `memory_feedback` vote up.
    Feedback,
}

impl Signal {
    pub fn weight(self) -> f64 {
        match self {
            Signal::Answer => 1.0,
            Signal::Search => 0.7,
            Signal::Feedback => 5.0,
        }
    }
}

/// Rank damping: rank 0 gets the full weight, rank 3 about half, rank 10 a quarter.
pub const RANK_DAMPING: f64 = 0.3;
/// Bounded Hebbian learning rate for co-activation weights.
pub const COACT_ETA: f64 = 0.3;
/// Only the strongest hits of one retrieval are wired together (≤ 28 pairs).
pub const COACT_MAX_IDS: usize = 8;
/// Pairs below this weight are pruned by the governance cycle.
pub const COACT_PRUNE_BELOW: f64 = 0.05;
/// Half-life of a co-activation pair that stops firing.
pub const COACT_HALF_LIFE_SECS: i64 = 30 * 86_400;
/// Half-life growth per use and its cap (180 days).
pub const HALF_LIFE_GROWTH: f64 = 1.5;
pub const HALF_LIFE_CAP_SECS: i64 = 180 * 86_400;
/// Initial half-life (must match the column default in migration 083).
pub const HALF_LIFE_INITIAL_SECS: i64 = 7 * 86_400;

/// Heat added to the item at `rank` (0-based) for `signal`.
pub fn rank_delta(rank: usize, signal: Signal) -> f64 {
    signal.weight() / (1.0 + RANK_DAMPING * rank as f64)
}

/// Multiplicative decay over `elapsed_secs` for an item with `half_life_secs`.
pub fn decay_factor(elapsed_secs: f64, half_life_secs: f64) -> f64 {
    if half_life_secs <= 0.0 { return 0.0; }
    0.5f64.powf(elapsed_secs / half_life_secs)
}

/// Half-life after one more use.
pub fn grown_half_life(current_secs: i64) -> i64 {
    ((current_secs as f64 * HALF_LIFE_GROWTH) as i64).min(HALF_LIFE_CAP_SECS)
}

/// Canonical unordered pairs `(a < b)` over the first `COACT_MAX_IDS` distinct ids.
pub fn coactivation_pairs(ids: &[Uuid]) -> Vec<(Uuid, Uuid)> {
    let mut seen: Vec<Uuid> = Vec::with_capacity(COACT_MAX_IDS);
    for id in ids {
        if seen.len() >= COACT_MAX_IDS { break; }
        if !seen.contains(id) { seen.push(*id); }
    }
    let mut pairs = Vec::with_capacity(seen.len() * (seen.len().saturating_sub(1)) / 2);
    for i in 0..seen.len() {
        for j in (i + 1)..seen.len() {
            let (a, b) = if seen[i] < seen[j] { (seen[i], seen[j]) } else { (seen[j], seen[i]) };
            pairs.push((a, b));
        }
    }
    // Sorted, so every upsert locks its conflicting rows in the same order (see
    // `reinforce_chunks` for why the order matters).
    pairs.sort_unstable();
    pairs
}

/// `(ids, deltas)` for `reinforce_chunks`: each id once with the delta of its BEST
/// rank, sorted by id. The sort is the deadlock fix: two retrievals that share
/// chunks lock those rows in the same order, so neither can wait on the other.
pub fn reinforcement_rows(ids_in_rank_order: &[Uuid], signal: Signal) -> (Vec<Uuid>, Vec<f32>) {
    let mut rows: Vec<(Uuid, f32)> = Vec::with_capacity(ids_in_rank_order.len());
    for (rank, id) in ids_in_rank_order.iter().enumerate() {
        if rows.iter().any(|(r, _)| r == id) { continue; }
        rows.push((*id, rank_delta(rank, signal) as f32));
    }
    rows.sort_unstable_by(|x, y| x.0.cmp(&y.0));
    rows.into_iter().unzip()
}

/// Postgres deadlock (40P01) or serialization failure (40001): a lost race that is
/// safe to run again.
pub fn is_retryable_conflict(code: Option<&str>) -> bool {
    matches!(code, Some("40P01") | Some("40001"))
}

const WRITE_ATTEMPTS: usize = 3;

/// Run a best-effort heat write, retrying a lost lock race a couple of times.
async fn with_conflict_retry<F, Fut>(what: &str, mut op: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<sqlx::postgres::PgQueryResult, sqlx::Error>>,
{
    for attempt in 1..=WRITE_ATTEMPTS {
        match op().await {
            Ok(_) => return,
            Err(e) => {
                let code = e.as_database_error().and_then(|d| d.code()).map(|c| c.to_string());
                if attempt < WRITE_ATTEMPTS && is_retryable_conflict(code.as_deref()) {
                    tokio::time::sleep(std::time::Duration::from_millis(20 * attempt as u64)).await;
                    continue;
                }
                tracing::debug!("hebb: {what} failed: {e}");
                return;
            }
        }
    }
}

/// Reinforce + wire the chunks of one retrieval WITHOUT holding up the response.
/// The writes wait on row locks whenever several searches touch the same chunks;
/// on the request path that wait (and, before the lock-order fix, a 1 s deadlock
/// timeout) landed on the caller's latency. The answer never depends on these
/// writes, so they run detached.
pub fn reinforce_retrieval_detached(db: &sqlx::PgPool, user_id: Uuid, ids_in_rank_order: &[Uuid], signal: Signal) {
    if ids_in_rank_order.is_empty() { return; }
    let db = db.clone();
    let ids = ids_in_rank_order.to_vec();
    tokio::spawn(async move {
        reinforce_chunks(&db, user_id, &ids, signal).await;
        record_coactivation(&db, user_id, &ids).await;
    });
}

/// Reinforce the chunks a retrieval returned, in rank order. Owner-scoped: an id
/// can never bump another user's row. Revives evicted rows, leaves A5-dedup
/// duplicates archived (their vectors are gone).
pub async fn reinforce_chunks(db: &sqlx::PgPool, user_id: Uuid, ids_in_rank_order: &[Uuid], signal: Signal) {
    if ids_in_rank_order.is_empty() { return; }
    let (ids, deltas) = reinforcement_rows(ids_in_rank_order, signal);
    // Lock first, in id order, then update. A plain `UPDATE ... FROM unnest(...)`
    // locks rows in whatever order the join yields them, so two concurrent searches
    // sharing chunks deadlocked (Asgard 2026-10-17 01:52/01:54 UTC, 40P01).
    with_conflict_retry("reinforce_chunks", || {
        sqlx::query(
            "WITH locked AS MATERIALIZED ( \
                 SELECT id FROM text_chunks \
                  WHERE id = ANY($1::uuid[]) AND user_id = $3 \
                  ORDER BY id FOR UPDATE \
             ) \
             UPDATE text_chunks tc \
                SET heat = tc.heat + u.delta, \
                    access_count = tc.access_count + 1, \
                    last_accessed = NOW(), \
                    half_life_secs = LEAST($4, (tc.half_life_secs::float8 * $5)::int), \
                    archived = CASE WHEN tc.archived_reason IN ('dedup', 'superseded') THEN tc.archived ELSE false END, \
                    archived_reason = CASE WHEN tc.archived_reason IN ('dedup', 'superseded') THEN tc.archived_reason ELSE NULL END \
               FROM unnest($1::uuid[], $2::real[]) AS u(id, delta), locked l \
              WHERE tc.id = u.id AND tc.id = l.id AND tc.user_id = $3"
        )
        .bind(&ids)
        .bind(&deltas)
        .bind(user_id)
        .bind(HALF_LIFE_CAP_SECS as i32)
        .bind(HALF_LIFE_GROWTH)
        .execute(db)
    }).await;
}

/// Reinforce one dossier (HOT tier) with the full signal weight (rank 0).
pub async fn reinforce_dossier(db: &sqlx::PgPool, dossier_id: Uuid, signal: Signal) {
    let _ = sqlx::query(
        "UPDATE entity_dossiers \
            SET heat = heat + $2, access_count = access_count + 1, \
                last_accessed = NOW(), \
                half_life_secs = LEAST($3, (half_life_secs::float8 * $4)::int), \
                archived = false, archived_reason = NULL \
          WHERE id = $1"
    )
    .bind(dossier_id)
    .bind(rank_delta(0, signal) as f32)
    .bind(HALF_LIFE_CAP_SECS as i32)
    .bind(HALF_LIFE_GROWTH)
    .execute(db)
    .await
    .map_err(|e| tracing::debug!("hebb: reinforce_dossier failed: {e}"));
}

/// Reinforce the caller's own dossier for `name`, if one exists. Used by read
/// paths that resolve an entity by name without loading its dossier (get_entity).
pub async fn reinforce_dossier_by_name(db: &sqlx::PgPool, user_id: Uuid, name: &str, signal: Signal) -> bool {
    if name.trim().is_empty() { return false; }
    sqlx::query(
        "UPDATE entity_dossiers \
            SET heat = heat + $3, access_count = access_count + 1, \
                last_accessed = NOW(), \
                half_life_secs = LEAST($4, (half_life_secs::float8 * $5)::int), \
                archived = false, archived_reason = NULL \
          WHERE user_id = $1 AND lower(entity_name) = lower($2)"
    )
    .bind(user_id)
    .bind(name)
    .bind(rank_delta(0, signal) as f32)
    .bind(HALF_LIFE_CAP_SECS as i32)
    .bind(HALF_LIFE_GROWTH)
    .execute(db)
    .await
    .map(|r| r.rows_affected() > 0)
    .unwrap_or(false)
}

/// A rejected fact leaves the hot set: heat 0 (trust is handled by the caller).
pub async fn forget_dossier(db: &sqlx::PgPool, dossier_id: Uuid) {
    let _ = sqlx::query("UPDATE entity_dossiers SET heat = 0, updated_at = NOW() WHERE id = $1")
        .bind(dossier_id).execute(db).await;
}

/// Wire the chunks of one retrieval together (bounded Hebbian update).
pub async fn record_coactivation(db: &sqlx::PgPool, user_id: Uuid, ids_in_rank_order: &[Uuid]) {
    let pairs = coactivation_pairs(ids_in_rank_order);
    if pairs.is_empty() { return; }
    let a: Vec<Uuid> = pairs.iter().map(|p| p.0).collect();
    let b: Vec<Uuid> = pairs.iter().map(|p| p.1).collect();
    with_conflict_retry("record_coactivation", || {
        sqlx::query(
            "INSERT INTO memory_coactivation (user_id, a, b, weight, fired, last_fired) \
             SELECT $1, u.a, u.b, $4, 1, NOW() FROM unnest($2::uuid[], $3::uuid[]) AS u(a, b) \
             ON CONFLICT (user_id, a, b) DO UPDATE \
                SET weight = memory_coactivation.weight + $4 * (1.0 - memory_coactivation.weight), \
                    fired = memory_coactivation.fired + 1, \
                    last_fired = NOW()"
        )
        .bind(user_id)
        .bind(&a)
        .bind(&b)
        .bind(COACT_ETA as f32)
        .execute(db)
    }).await;
}

/// Governance step: decay pairs idle ≥ `idle_secs` by one tick, prune the faded
/// ones. Returns (decayed, pruned).
pub async fn decay_coactivation(db: &sqlx::PgPool, tick_secs: f64, idle_secs: i64) -> (i64, i64) {
    let factor = decay_factor(tick_secs, COACT_HALF_LIFE_SECS as f64) as f32;
    let decayed = sqlx::query(
        "UPDATE memory_coactivation SET weight = weight * $1 \
          WHERE last_fired < NOW() - ($2 || ' seconds')::interval"
    )
    .bind(factor)
    .bind(idle_secs.to_string())
    .execute(db).await.map(|r| r.rows_affected() as i64).unwrap_or(0);
    let pruned = sqlx::query("DELETE FROM memory_coactivation WHERE weight < $1")
        .bind(COACT_PRUNE_BELOW as f32)
        .execute(db).await.map(|r| r.rows_affected() as i64).unwrap_or(0);
    (decayed, pruned)
}

/// Chunk ids in rank order out of a KEX `/search` response (`chunks[].chunk_id`).
pub fn chunk_ids_from_search(resp: &serde_json::Value) -> Vec<Uuid> {
    resp.get("chunks")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter()
            .filter_map(|c| c.get("chunk_id").and_then(|v| v.as_str()).and_then(|s| Uuid::parse_str(s).ok()))
            .collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rank_delta_damps_with_rank_and_scales_with_signal() {
        assert!((rank_delta(0, Signal::Answer) - 1.0).abs() < 1e-9);
        assert!((rank_delta(0, Signal::Search) - 0.7).abs() < 1e-9);
        assert!((rank_delta(0, Signal::Feedback) - 5.0).abs() < 1e-9);
        // rank 10 → 1 / (1 + 3) = 0.25
        assert!((rank_delta(10, Signal::Answer) - 0.25).abs() < 1e-9);
        assert!(rank_delta(3, Signal::Answer) < rank_delta(2, Signal::Answer));
    }

    #[test]
    fn decay_factor_halves_at_one_half_life() {
        assert!((decay_factor(7.0 * 86_400.0, 7.0 * 86_400.0) - 0.5).abs() < 1e-9);
        // One 600 s tick on a 7-day half-life barely moves the needle.
        let f = decay_factor(600.0, 7.0 * 86_400.0);
        assert!(f > 0.999 && f < 1.0, "{f}");
        // Twelve hours on a 7-day half-life is still > 0.95 (the old rule lost ~5 % every 10 min).
        assert!(decay_factor(12.0 * 3600.0, 7.0 * 86_400.0) > 0.95);
        assert_eq!(decay_factor(1.0, 0.0), 0.0);
    }

    #[test]
    fn half_life_grows_and_caps() {
        assert_eq!(grown_half_life(HALF_LIFE_INITIAL_SECS), (HALF_LIFE_INITIAL_SECS as f64 * 1.5) as i64);
        let mut h = HALF_LIFE_INITIAL_SECS;
        for _ in 0..50 { h = grown_half_life(h); }
        assert_eq!(h, HALF_LIFE_CAP_SECS);
    }

    #[test]
    fn coactivation_pairs_are_canonical_bounded_and_deduped() {
        let ids: Vec<Uuid> = (0..12).map(|_| Uuid::new_v4()).collect();
        let pairs = coactivation_pairs(&ids);
        assert_eq!(pairs.len(), 28, "8 ids → 28 pairs");
        assert!(pairs.iter().all(|(a, b)| a < b));
        // Deduped input
        let dup = vec![ids[0], ids[0], ids[1]];
        assert_eq!(coactivation_pairs(&dup).len(), 1);
        assert!(coactivation_pairs(&[ids[0]]).is_empty());
        assert!(coactivation_pairs(&[]).is_empty());
    }

    #[test]
    fn reinforcement_rows_are_sorted_deduped_and_keep_the_best_rank() {
        let ids: Vec<Uuid> = (0..6).map(|_| Uuid::new_v4()).collect();
        let ranked = vec![ids[3], ids[1], ids[3], ids[5], ids[0]];
        let (rows, deltas) = reinforcement_rows(&ranked, Signal::Search);
        let mut want = vec![ids[0], ids[1], ids[3], ids[5]];
        want.sort();
        assert_eq!(rows, want, "each id once, in id order");
        let delta_of = |id: Uuid| deltas[rows.iter().position(|r| *r == id).unwrap()] as f64;
        // ids[3] first appears at rank 0: it keeps the rank-0 delta, not rank 2's.
        assert!((delta_of(ids[3]) - rank_delta(0, Signal::Search)).abs() < 1e-6);
        assert!((delta_of(ids[0]) - rank_delta(4, Signal::Search)).abs() < 1e-6);
        // Two retrievals over the same chunks in a different rank order lock them
        // in the SAME order - the property that removes the deadlock.
        let (other, _) = reinforcement_rows(&[ids[0], ids[5], ids[1], ids[3]], Signal::Answer);
        assert_eq!(rows, other);
        assert!(reinforcement_rows(&[], Signal::Search).0.is_empty());
    }

    #[test]
    fn coactivation_pairs_come_out_in_one_global_order() {
        let ids: Vec<Uuid> = (0..5).map(|_| Uuid::new_v4()).collect();
        let mut rev = ids.clone();
        rev.reverse();
        let p = coactivation_pairs(&ids);
        assert_eq!(p, coactivation_pairs(&rev));
        assert!(p.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn only_lock_races_are_retried() {
        assert!(is_retryable_conflict(Some("40P01")));
        assert!(is_retryable_conflict(Some("40001")));
        assert!(!is_retryable_conflict(Some("23505")));
        assert!(!is_retryable_conflict(None));
    }

    /// Source guard: the row locks are taken in id order before the update.
    #[test]
    fn reinforce_locks_rows_in_id_order() {
        let src = include_str!("hebb.rs");
        let start = src.find("pub async fn reinforce_chunks(").unwrap();
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        assert!(body.contains("ORDER BY id FOR UPDATE"));
        assert!(body.contains("reinforcement_rows("));
    }

    #[test]
    fn chunk_ids_parse_from_kex_response() {
        let a = Uuid::new_v4();
        let v = serde_json::json!({ "chunks": [
            { "chunk_id": a.to_string(), "text": "x" },
            { "chunk_id": "not-a-uuid" },
            { "text": "no id" },
        ]});
        assert_eq!(chunk_ids_from_search(&v), vec![a]);
        assert!(chunk_ids_from_search(&serde_json::json!({})).is_empty());
    }
}

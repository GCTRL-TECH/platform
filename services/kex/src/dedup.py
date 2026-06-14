"""
A5 — Semantic dedup-merge for the COLD (chunk) memory tier.

A governance pass that finds near-duplicate chunks by embedding cosine similarity
and merges each near-dup cluster into ONE canonical chunk: the canonical keeps the
UNION of provenance (source_job ids + entity_mentions + class_labels) and the most
RESTRICTIVE clearance of the cluster; the duplicates are soft-archived (archived =
true) so retrieval skips them but nothing is hard-deleted.

Why it lives in KEX (not api-rs):
  KEX owns the Qdrant vectors AND the text_chunks Postgres rows. The cheapest way
  to find near-dups is to reuse the vectors already in Qdrant: for each live chunk
  we pull its stored vector and query its nearest neighbors (cosine). api-rs has no
  Qdrant client; it calls this endpoint over HTTP from the maintenance cycle —
  exactly mirroring how it calls FUSE /dossier/build for promotion.

Safety invariants (conservative by design — a false merge in a KG is hard to undo):
  * τ default 0.92 — only TRUE near-dups merge. Tunable per request.
  * NEVER merge across user_id (each chunk's owner is matched in the Qdrant filter
    AND re-checked in SQL).
  * Clearance-preserving: the canonical inherits the MOST RESTRICTIVE min_rank of
    the cluster (max rank) — a CONFIDENTIAL chunk is never folded into a PUBLIC one;
    the surviving record is at least as protected as every duplicate it absorbs.
  * Idempotent: a second pass finds nothing new (dups are archived + skipped).
  * dry_run returns the clusters it WOULD merge without mutating anything.

Returns a structured summary: scanned, clusters, merged (duplicates archived).
"""

import logging
from typing import Optional

import psycopg2
import psycopg2.extras
from qdrant_client.models import (
    Filter, FieldCondition, MatchValue, IsEmptyCondition, PayloadField,
)

from . import config

logger = logging.getLogger(__name__)

# Default cosine threshold. 0.92 is deliberately high — at nomic-embed-text scale,
# 0.92+ means "essentially the same passage" (re-ingested file, duplicate note),
# not merely "topically related". Below this we leave chunks alone.
DEFAULT_TAU = 0.92

# Bound the work per pass so a huge corpus can't pin a CPU. The cycle runs every
# 600s, so a partial sweep converges over a few ticks; archived dups drop out of
# the live set each pass, so the working set shrinks.
MAX_SCAN = 2000          # live chunks examined per pass
NEIGHBORS = 8            # nearest neighbors fetched per chunk


def _pg(pg_url: str):
    conn = psycopg2.connect(pg_url, connect_timeout=5)
    conn.autocommit = False
    return conn


def run_dedup(
    qc,
    pg_url: str,
    collection: str,
    tau: float = DEFAULT_TAU,
    user_id: Optional[str] = None,
    compilation_id: Optional[str] = None,
    dry_run: bool = False,
) -> dict:
    """
    Find near-duplicate live chunks via Qdrant cosine NN and merge each cluster.

    Parameters
    ----------
    qc : QdrantClient        (caller supplies the shared client; None → no-op)
    pg_url : str             Postgres DSN for text_chunks.
    collection : str         Qdrant collection name.
    tau : float              Cosine threshold; pairs strictly above τ are dups.
    user_id : str | None     Scope to one owner (else sweep all, still per-user safe).
    compilation_id : str | None  Optional narrower scope.
    dry_run : bool           If True, compute clusters but mutate nothing.

    Returns {"scanned", "clusters", "merged", "tau", "dry_run", "examples": [...]}.
    """
    if qc is None:
        return {"scanned": 0, "clusters": 0, "merged": 0, "tau": tau,
                "dry_run": dry_run, "error": "qdrant unavailable"}

    conn = None
    try:
        conn = _pg(pg_url)
    except Exception as exc:
        logger.warning("dedup: Postgres unavailable: %s", exc)
        return {"scanned": 0, "clusters": 0, "merged": 0, "tau": tau,
                "dry_run": dry_run, "error": "postgres unavailable"}

    try:
        # 1. Pull the LIVE (non-archived) chunk ids in scope, newest first. We only
        #    ever consider chunks that have a Qdrant vector (qdrant_point_id set).
        with conn.cursor() as cur:
            clauses = ["archived = false", "qdrant_point_id IS NOT NULL"]
            params: list = []
            if user_id:
                clauses.append("user_id = %s"); params.append(user_id)
            if compilation_id:
                clauses.append("compilation_id = %s"); params.append(compilation_id)
            cur.execute(
                "SELECT id::text, user_id::text, qdrant_point_id::text, "
                "       COALESCE(min_rank,0), heat, entity_mentions, class_labels "
                "FROM text_chunks WHERE " + " AND ".join(clauses) + " "
                "ORDER BY created_at DESC NULLS LAST LIMIT %s",
                params + [MAX_SCAN],
            )
            rows = cur.fetchall()

        # Index chunk metadata by point id (Qdrant id) and by chunk id.
        by_point: dict[str, dict] = {}
        for cid, uid, pid, rank, heat, mentions, labels in rows:
            by_point[pid] = {
                "chunk_id": cid, "user_id": uid, "point_id": pid,
                "rank": int(rank or 0), "heat": float(heat or 0.0),
                "mentions": mentions or [], "labels": labels or [],
            }

        scanned = len(by_point)
        if scanned == 0:
            return {"scanned": 0, "clusters": 0, "merged": 0, "tau": tau,
                    "dry_run": dry_run, "examples": []}

        # 2. Union-Find over near-dup pairs discovered via Qdrant NN search.
        parent: dict[str, str] = {pid: pid for pid in by_point}

        def find(x: str) -> str:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a: str, b: str) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        # For each chunk, fetch its vector + nearest neighbors. Same-user filter is
        # enforced IN the Qdrant query so a NN can never be another user's chunk.
        point_ids = list(by_point.keys())
        # Retrieve vectors in bulk (avoids a per-point round trip).
        vectors: dict[str, list] = {}
        try:
            recs = qc.retrieve(collection_name=collection, ids=point_ids, with_vectors=True)
            for r in recs:
                if r.vector is not None:
                    vectors[str(r.id)] = r.vector
        except Exception as exc:
            logger.warning("dedup: vector retrieve failed: %s", exc)
            return {"scanned": scanned, "clusters": 0, "merged": 0, "tau": tau,
                    "dry_run": dry_run, "error": "vector retrieve failed"}

        def _nn_filter(uid: str) -> Filter:
            must = [FieldCondition(key="user_id", match=MatchValue(value=uid))]
            return Filter(must=must)

        for pid, meta in by_point.items():
            vec = vectors.get(pid)
            if vec is None:
                continue
            try:
                if hasattr(qc, "query_points"):
                    hits = qc.query_points(
                        collection_name=collection, query=vec,
                        limit=NEIGHBORS + 1, query_filter=_nn_filter(meta["user_id"]),
                        with_payload=False,
                    ).points
                else:
                    hits = qc.search(
                        collection_name=collection, query_vector=vec,
                        limit=NEIGHBORS + 1, query_filter=_nn_filter(meta["user_id"]),
                        with_payload=False,
                    )
            except Exception as exc:
                logger.debug("dedup: NN search failed for %s: %s", pid, exc)
                continue
            for h in hits:
                npid = str(h.id)
                if npid == pid or npid not in by_point:
                    continue
                # Cosine similarity in Qdrant cosine space == hit.score (0..1).
                if float(h.score) > tau:
                    # Same-user already guaranteed by the filter; double-check.
                    if by_point[npid]["user_id"] == meta["user_id"]:
                        union(pid, npid)

        # 3. Group into clusters; only clusters of size ≥ 2 are dup groups.
        clusters: dict[str, list[str]] = {}
        for pid in by_point:
            clusters.setdefault(find(pid), []).append(pid)
        dup_clusters = [members for members in clusters.values() if len(members) >= 2]

        merged = 0
        examples: list[dict] = []
        for members in dup_clusters:
            metas = [by_point[p] for p in members]
            # Canonical pick: MOST RESTRICTIVE clearance first (max rank), then
            # hottest, then most-recent (rows were ORDER BY created_at DESC, so the
            # earliest index = newest). Deterministic.
            canonical = max(
                metas,
                key=lambda m: (m["rank"], m["heat"], -members.index(m["point_id"])),
            )
            dups = [m for m in metas if m["point_id"] != canonical["point_id"]]
            if not dups:
                continue

            # UNION provenance for the canonical: merge entity_mentions (dedup by
            # name) and class_labels (dedup by source_job), and lift clearance to the
            # most restrictive rank in the cluster.
            union_mentions = _union_mentions([m["mentions"] for m in metas])
            union_labels = _union_labels([m["labels"] for m in metas])
            max_rank = max(m["rank"] for m in metas)

            examples.append({
                "canonical": canonical["chunk_id"],
                "archived": [d["chunk_id"] for d in dups],
                "min_rank": max_rank,
                "union_mentions": len(union_mentions),
            })

            if dry_run:
                merged += len(dups)
                continue

            with conn.cursor() as cur:
                # Update canonical provenance + clearance.
                cur.execute(
                    "UPDATE text_chunks SET entity_mentions = %s::jsonb, "
                    "    class_labels = %s::jsonb, min_rank = %s "
                    "WHERE id = %s",
                    (psycopg2.extras.Json(union_mentions),
                     psycopg2.extras.Json(union_labels),
                     max_rank, canonical["chunk_id"]),
                )
                # Soft-archive the duplicates (lexical retrieval skips archived rows).
                # id is UUID — cast the text[] param so `id = ANY(...)` type-matches.
                cur.execute(
                    "UPDATE text_chunks SET archived = true "
                    "WHERE id = ANY(%s::uuid[])",
                    ([d["chunk_id"] for d in dups],),
                )
            # Also remove the duplicates' vectors from Qdrant so the DENSE channel
            # (which has no `archived` payload field to filter on) can't return them.
            # The Postgres row stays (archived) for provenance/revival; only the
            # vector is dropped. point_id == chunk_id (store_chunks shares the UUID).
            try:
                qc.delete(
                    collection_name=collection,
                    points_selector=[d["point_id"] for d in dups],
                )
            except Exception as exc:
                logger.warning("dedup: Qdrant point delete failed (rows still archived): %s", exc)
            merged += len(dups)

        if not dry_run and merged:
            conn.commit()
        else:
            conn.rollback()

        logger.info(
            "dedup: scanned=%d clusters=%d merged=%d (tau=%.2f, dry_run=%s, user=%s)",
            scanned, len(dup_clusters), merged, tau, dry_run, user_id,
        )
        return {
            "scanned": scanned, "clusters": len(dup_clusters), "merged": merged,
            "tau": tau, "dry_run": dry_run, "examples": examples[:20],
        }
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _union_mentions(lists: list) -> list:
    """Union of entity_mentions across a cluster, deduped by (name, type)."""
    out: list = []
    seen: set = set()
    for ml in lists:
        for m in (ml or []):
            if not isinstance(m, dict):
                continue
            key = (str(m.get("name", "")).lower(), str(m.get("type", "")))
            if key[0] and key not in seen:
                seen.add(key)
                out.append(m)
    return out


def _union_labels(lists: list) -> list:
    """Union of class_labels (provenance) across a cluster, deduped by source_job."""
    out: list = []
    seen: set = set()
    for ll in lists:
        for lab in (ll or []):
            if not isinstance(lab, dict):
                continue
            sj = str(lab.get("source_job", ""))
            key = sj or repr(sorted(lab.items()))
            if key not in seen:
                seen.add(key)
                out.append(lab)
    return out

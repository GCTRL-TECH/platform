"""
Three-Stage Entity Merger for GCTRL FUSE

Stage 1: Neo4j APOC — exact/near-exact pre-filter (fast, high confidence)
Stage 2: LIMES — fuzzy multi-property matching with blocking (precise)
Stage 3: ConEx — knowledge graph embedding link prediction (structural patterns)

Each stage catches what the previous misses. Results are tagged with the
discovery method (apoc/limes/conex) and confidence score.
"""

import csv
import io
import logging
import os
import tempfile
from typing import Optional

from neo4j import GraphDatabase, Driver

from . import config
from .limes_client import get_limes_client
from .config_builder import build_neo4j_config, build_simple_metric

logger = logging.getLogger(__name__)


class ThreeStageEntityMerger:
    """Merge entities across knowledge graphs using three-stage pipeline."""

    def __init__(self) -> None:
        self._driver: Optional[Driver] = None
        self.threshold_accept = 0.85
        self.threshold_review = 0.70

    def connect(self) -> None:
        self._driver = GraphDatabase.driver(
            config.NEO4J_URI,
            auth=(config.NEO4J_USER, config.NEO4J_PASSWORD),
        )
        self._driver.verify_connectivity()
        logger.info(f"Connected to Neo4j at {config.NEO4J_URI}")

    @property
    def driver(self) -> Driver:
        if not self._driver:
            self.connect()
        assert self._driver is not None
        return self._driver

    @property
    def is_connected(self) -> bool:
        return self._driver is not None

    def close(self) -> None:
        if self._driver:
            self._driver.close()
            self._driver = None

    def merge(
        self,
        compilation_id: str,
        source_job_ids: list[str],
        user_id: str,
        classification: str = "PUBLIC",
        enable_conex: bool = False,
    ) -> dict:
        """
        Run three-stage merge pipeline.

        Returns stats dict with breakdown by stage.
        """
        logger.info(
            f"[{compilation_id}] Three-stage merge — {len(source_job_ids)} sources"
        )

        # Collect all entities
        all_entities = self._collect_entities(source_job_ids)
        logger.info(f"[{compilation_id}] Collected {len(all_entities)} entities")

        if not all_entities:
            return self._empty_stats()

        # ── Stage 1: Neo4j APOC Pre-filter ────────────────────────────
        stage1_links = self._stage1_apoc(source_job_ids)
        logger.info(
            f"[{compilation_id}] Stage 1 (APOC): {len(stage1_links)} exact matches"
        )

        # ── Stage 2: LIMES Link Discovery ──────────────────────────────
        matched_uris = self._extract_matched_uris(stage1_links)
        stage2_links = self._stage2_limes(source_job_ids, exclude_uris=matched_uris)
        logger.info(
            f"[{compilation_id}] Stage 2 (LIMES): {len(stage2_links)} fuzzy matches"
        )

        # ── Stage 3: ConEx Link Prediction (optional) ─────────────────
        stage3_links: list[dict] = []
        if enable_conex:
            all_matched = matched_uris | self._extract_matched_uris(stage2_links)
            stage3_links = self._stage3_conex(
                source_job_ids, exclude_uris=all_matched
            )
            logger.info(
                f"[{compilation_id}] Stage 3 (ConEx): {len(stage3_links)} predicted links"
            )

        # ── Merge Results ──────────────────────────────────────────────
        all_links = stage1_links + stage2_links + stage3_links
        all_links = self._deduplicate_links(all_links)

        # Write merged graph to Neo4j
        stats = self._write_merged_graph(
            compilation_id, all_entities, all_links,
            source_job_ids, user_id, classification
        )

        # Merge relations
        rel_count = self._merge_relations(
            compilation_id, source_job_ids, user_id, classification
        )

        stats.update({
            "relations_merged": rel_count,
            "stage1_apoc": len(stage1_links),
            "stage2_limes": len(stage2_links),
            "stage3_conex": len(stage3_links),
            "total_links": len(all_links),
        })

        logger.info(f"[{compilation_id}] Merge complete: {stats}")
        return stats

    # ── Stage 1: Neo4j APOC ─────────────────────────────────────────

    def _stage1_apoc(self, source_job_ids: list[str]) -> list[dict]:
        """
        Fast pre-filter: find entities with identical/near-identical names
        across different source jobs using Neo4j Cypher.
        """
        query = """
        MATCH (a:Entity), (b:Entity)
        WHERE a._source_job IN $job_ids
          AND b._source_job IN $job_ids
          AND a._source_job <> b._source_job
          AND a.type = b.type
          AND toLower(a.name) = toLower(b.name)
          AND elementId(a) < elementId(b)
        RETURN a.uri AS source, b.uri AS target,
               a.name AS source_name, b.name AS target_name,
               1.0 AS confidence
        """
        links = []
        try:
            with self.driver.session() as session:
                result = session.run(query, job_ids=source_job_ids)
                for record in result:
                    links.append({
                        "source": record["source"],
                        "target": record["target"],
                        "confidence": record["confidence"],
                        "method": "apoc",
                        "source_name": record["source_name"],
                        "target_name": record["target_name"],
                    })
        except Exception as exc:
            logger.warning(f"Stage 1 (APOC) failed: {exc}")

        return links

    # ── Stage 2: LIMES ──────────────────────────────────────────────

    def _stage2_limes(
        self, source_job_ids: list[str], exclude_uris: set[str] | None = None
    ) -> list[dict]:
        """
        Fuzzy multi-property matching via LIMES server.
        Exports entities to CSV, uploads to LIMES, submits config, parses results.
        Falls back to enhanced string similarity if LIMES is unavailable.
        """
        limes = get_limes_client()

        entities = self._collect_entities(source_job_ids)
        if exclude_uris:
            entities = [e for e in entities if e.get("uri") not in exclude_uris]

        if len(entities) < 2:
            return []

        # Split into source/target (different source jobs)
        mid = len(source_job_ids) // 2
        source_jobs = set(source_job_ids[:max(mid, 1)])
        source_ents = [e for e in entities if e.get("source_job") in source_jobs]
        target_ents = [e for e in entities if e.get("source_job") not in source_jobs]

        if not target_ents:
            mid_e = len(entities) // 2
            source_ents = entities[:mid_e]
            target_ents = entities[mid_e:]

        if not limes.is_healthy():
            logger.warning("LIMES server not available — falling back to string similarity")
            return self._stage2_fallback(source_job_ids, exclude_uris)

        try:
            links = limes.discover_links(
                source_entities=source_ents,
                target_entities=target_ents,
                metric="trigrams(x.name, y.name)|0.70",
                acceptance_threshold=self.threshold_accept,
                review_threshold=self.threshold_review,
            )
            if links:
                logger.info(f"LIMES discovered {len(links)} links")
                return links
            else:
                logger.info("LIMES returned no links — using fallback")
                return self._stage2_fallback(source_job_ids, exclude_uris)
        except Exception as exc:
            logger.warning(f"LIMES error: {exc} — falling back")
            return self._stage2_fallback(source_job_ids, exclude_uris)

    def _stage2_fallback(
        self, source_job_ids: list[str], exclude_uris: set[str] | None = None
    ) -> list[dict]:
        """
        Enhanced string similarity fallback when LIMES is unavailable.
        Uses multiple metrics: JaroWinkler, trigram, and type matching.
        """
        from difflib import SequenceMatcher

        entities = self._collect_entities(source_job_ids)
        if exclude_uris:
            entities = [e for e in entities if e.get("uri") not in exclude_uris]

        links = []
        seen = set()

        for i, e1 in enumerate(entities):
            for j, e2 in enumerate(entities):
                if j <= i:
                    continue
                if e1.get("source_job") == e2.get("source_job"):
                    continue
                if e1.get("type") != e2.get("type"):
                    continue

                pair_key = (
                    min(e1.get("uri", ""), e2.get("uri", "")),
                    max(e1.get("uri", ""), e2.get("uri", "")),
                )
                if pair_key in seen:
                    continue

                name1 = (e1.get("name") or "").lower().strip()
                name2 = (e2.get("name") or "").lower().strip()

                if not name1 or not name2:
                    continue

                # Multiple similarity measures
                ratio = SequenceMatcher(None, name1, name2).ratio()

                # Also check containment (e.g., "VW" in "Volkswagen")
                containment = 0.0
                if name1 in name2 or name2 in name1:
                    shorter = min(len(name1), len(name2))
                    longer = max(len(name1), len(name2))
                    containment = shorter / longer if longer > 0 else 0

                # Combined score
                score = max(ratio, containment * 0.9)

                if score >= self.threshold_review:
                    seen.add(pair_key)
                    links.append({
                        "source": e1.get("uri", ""),
                        "target": e2.get("uri", ""),
                        "confidence": round(score, 4),
                        "method": "limes_fallback",
                        "source_name": e1.get("name", ""),
                        "target_name": e2.get("name", ""),
                    })

        return links

    # ── Stage 3: ConEx ──────────────────────────────────────────────

    def _stage3_conex(
        self, source_job_ids: list[str], exclude_uris: set[str] | None = None
    ) -> list[dict]:
        """
        Knowledge graph embedding-based link prediction.
        Trains ConEx on the graph structure and predicts missing links.
        """
        try:
            from .conex import get_conex_predictor
        except Exception as exc:
            logger.warning(f"ConEx not available: {exc}")
            return []

        # Collect all triples from source jobs
        triples = self._collect_triples(source_job_ids)
        if len(triples) < 10:
            logger.info("Not enough triples for ConEx training — skipping Stage 3")
            return []

        # Train ConEx
        predictor = get_conex_predictor(epochs=30, embedding_dim=50)
        train_stats = predictor.train(triples)
        logger.info(f"ConEx training: {train_stats}")

        if "error" in train_stats:
            return []

        # Predict links between unmatched entities
        entities = self._collect_entities(source_job_ids)
        unmatched = [
            e.get("uri", "") for e in entities
            if e.get("uri") and (not exclude_uris or e.get("uri") not in exclude_uris)
        ]

        predictions = predictor.predict_links(
            unmatched, unmatched, top_k=50, threshold=0.6
        )

        return predictions

    # ── Helpers ──────────────────────────────────────────────────────

    def _collect_entities(self, source_job_ids: list[str]) -> list[dict]:
        query = """
        MATCH (e:Entity)
        WHERE e._source_job IN $job_ids
        RETURN e.name AS name, e.type AS type, e.label AS label,
               e.uri AS uri, e._source_job AS source_job,
               e._classification AS classification
        """
        with self.driver.session() as session:
            result = session.run(query, job_ids=source_job_ids)
            return [dict(record) for record in result]

    def _collect_triples(self, source_job_ids: list[str]) -> list[tuple[str, str, str]]:
        """Collect (head_uri, relation_type, tail_uri) triples."""
        query = """
        MATCH (a:Entity)-[r]->(b:Entity)
        WHERE a._source_job IN $job_ids
          AND b._source_job IN $job_ids
          AND NOT type(r) IN ['CONTAINS', 'SIMILAR_TO']
        RETURN a.uri AS head, type(r) AS rel, b.uri AS tail
        """
        triples = []
        with self.driver.session() as session:
            result = session.run(query, job_ids=source_job_ids)
            for record in result:
                if record["head"] and record["tail"]:
                    triples.append((record["head"], record["rel"], record["tail"]))
        return triples

    def _extract_matched_uris(self, links: list[dict]) -> set[str]:
        uris = set()
        for link in links:
            uris.add(link.get("source", ""))
            uris.add(link.get("target", ""))
        uris.discard("")
        return uris

    def _deduplicate_links(self, links: list[dict]) -> list[dict]:
        """Remove duplicate links, keeping highest confidence."""
        seen: dict[tuple[str, str], dict] = {}
        for link in links:
            key = (
                min(link["source"], link["target"]),
                max(link["source"], link["target"]),
            )
            if key not in seen or link["confidence"] > seen[key]["confidence"]:
                seen[key] = link
        return list(seen.values())

    def _write_merged_graph(
        self,
        compilation_id: str,
        all_entities: list[dict],
        all_links: list[dict],
        source_job_ids: list[str],
        user_id: str,
        classification: str,
    ) -> dict:
        """Write merged entities and sameAs links to Neo4j."""
        entities_created = 0

        # Build a union-find to cluster linked entities
        uri_to_cluster: dict[str, int] = {}
        clusters: dict[int, list[str]] = {}
        next_cluster = 0

        # Every entity starts in its own cluster
        for e in all_entities:
            uri = e.get("uri", "")
            if uri and uri not in uri_to_cluster:
                uri_to_cluster[uri] = next_cluster
                clusters[next_cluster] = [uri]
                next_cluster += 1

        # Merge clusters based on links
        for link in all_links:
            src = link["source"]
            tgt = link["target"]
            if src not in uri_to_cluster or tgt not in uri_to_cluster:
                continue

            c1 = uri_to_cluster[src]
            c2 = uri_to_cluster[tgt]
            if c1 != c2:
                # Merge smaller into larger
                if len(clusters.get(c1, [])) < len(clusters.get(c2, [])):
                    c1, c2 = c2, c1
                for uri in clusters.get(c2, []):
                    uri_to_cluster[uri] = c1
                    clusters.setdefault(c1, []).append(uri)
                clusters.pop(c2, None)

        # Build entity lookup
        entity_by_uri: dict[str, dict] = {}
        for e in all_entities:
            uri = e.get("uri", "")
            if uri:
                entity_by_uri[uri] = e

        # Create merged entities in Neo4j
        unique_clusters = set(uri_to_cluster.values())

        with self.driver.session() as session:
            # Create compilation node
            session.run(
                """
                MERGE (c:Compilation {compilation_id: $cid})
                SET c.updated_at = datetime(),
                    c._owner = $user_id,
                    c._classification = $classification
                """,
                cid=compilation_id, user_id=user_id, classification=classification,
            )

            for cluster_id in unique_clusters:
                members = clusters.get(cluster_id, [])
                if not members:
                    continue

                # Pick canonical entity (highest scoring or first)
                canonical_uri = members[0]
                canonical = entity_by_uri.get(canonical_uri, {})

                source_jobs = list({
                    entity_by_uri.get(uri, {}).get("source_job", "")
                    for uri in members
                })
                source_jobs = [s for s in source_jobs if s]

                session.run(
                    """
                    MERGE (e:Entity:Merged {
                        name: $name,
                        type: $type,
                        _compilation: $cid
                    })
                    SET e.label = $label,
                        e.uri = $name + '_' + $type + '_' + $cid,
                        e._classification = $classification,
                        e._owner = $user_id,
                        e._source_jobs = $source_jobs,
                        e._merge_count = $merge_count
                    WITH e
                    MATCH (c:Compilation {compilation_id: $cid})
                    MERGE (c)-[:CONTAINS]->(e)
                    """,
                    name=canonical.get("name", ""),
                    type=canonical.get("type", ""),
                    label=canonical.get("label", ""),
                    cid=compilation_id,
                    classification=classification,
                    user_id=user_id,
                    source_jobs=source_jobs,
                    merge_count=len(members),
                )
                entities_created += 1

        duplicates_found = sum(1 for c in unique_clusters if len(clusters.get(c, [])) > 1)

        return {
            "entities_merged": entities_created,
            "duplicates_found": duplicates_found,
            "nodes_total": entities_created,
        }

    def _merge_relations(
        self,
        compilation_id: str,
        source_job_ids: list[str],
        user_id: str,
        classification: str,
    ) -> int:
        """Copy relations from source jobs to merged entities."""
        query = """
        MATCH (a:Entity)-[r]->(b:Entity)
        WHERE a._source_job IN $job_ids
          AND b._source_job IN $job_ids
          AND NOT type(r) IN ['CONTAINS', 'SIMILAR_TO']
        RETURN a.name AS head_name, a.type AS head_type,
               type(r) AS rel_type,
               b.name AS tail_name, b.type AS tail_type
        """
        relations = []
        with self.driver.session() as session:
            result = session.run(query, job_ids=source_job_ids)
            relations = [dict(record) for record in result]

        count = 0
        with self.driver.session() as session:
            for rel in relations:
                safe_type = rel["rel_type"].replace("`", "``")
                result = session.run(
                    f"""
                    MATCH (a:Entity:Merged {{_compilation: $cid}})
                    WHERE a.name = $head_name AND a.type = $head_type
                    MATCH (b:Entity:Merged {{_compilation: $cid}})
                    WHERE b.name = $tail_name AND b.type = $tail_type
                    MERGE (a)-[r:`{safe_type}`]->(b)
                    SET r._compilation = $cid,
                        r._classification = $classification,
                        r._owner = $user_id
                    RETURN count(r) AS cnt
                    """,
                    cid=compilation_id,
                    head_name=rel["head_name"],
                    head_type=rel["head_type"],
                    tail_name=rel["tail_name"],
                    tail_type=rel["tail_type"],
                    classification=classification,
                    user_id=user_id,
                )
                record = result.single()
                if record and record["cnt"] > 0:
                    count += 1

        return count

    def _empty_stats(self) -> dict:
        return {
            "entities_merged": 0,
            "duplicates_found": 0,
            "relations_merged": 0,
            "nodes_total": 0,
            "stage1_apoc": 0,
            "stage2_limes": 0,
            "stage3_conex": 0,
            "total_links": 0,
        }


_merger: Optional[ThreeStageEntityMerger] = None


def get_merger() -> ThreeStageEntityMerger:
    global _merger
    if _merger is None:
        _merger = ThreeStageEntityMerger()
    return _merger


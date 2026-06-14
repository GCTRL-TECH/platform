"""
Knowledge Graph Builder for KEX Service
Writes NER entities and relations to Neo4j using transactional Cypher.
Enforces classification and ownership properties for access control.
"""

import logging
import re
from typing import Optional

from neo4j import GraphDatabase, Driver

from . import config
from .classification import make_label, encode_label

logger = logging.getLogger(__name__)


def _make_uri(name: str, entity_type: str, user_id: str = "") -> str:
    """Generate a stable URI for a node from its name and Wikidata type.

    Scoped to the user so each user has their own copy of "Microsoft", "Steve
    Jobs", etc. Without this, the FIRST user to extract a given entity owns
    it forever — subsequent users' extractions just bump the existing node's
    `_source_job` but the node count for *their* graph stays at 0.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    if user_id:
        # 12 chars of the UUID is plenty for collision-resistance per-user.
        scope = user_id.replace("-", "")[:12]
        return f"databorg:{scope}/{entity_type}/{slug}"
    return f"databorg:{entity_type}/{slug}"


def _safe_rel_type(relation_type: str) -> str:
    """
    Convert an arbitrary relation label to a valid Neo4j relationship type.
    Neo4j relationship types must match [A-Z][A-Z0-9_]*.
    """
    upper = relation_type.upper()
    safe = re.sub(r"[^A-Z0-9]+", "_", upper).strip("_")
    if not safe:
        safe = "RELATED_TO"
    # Must start with a letter
    if safe[0].isdigit():
        safe = "REL_" + safe
    return safe


class KGBuilder:
    """Writes entities and relations to Neo4j as a knowledge graph."""

    def __init__(self) -> None:
        self._driver: Optional[Driver] = None

    def connect(self) -> None:
        """Open Neo4j driver connection."""
        if self._driver is None:
            self._driver = GraphDatabase.driver(
                config.NEO4J_URI,
                auth=(config.NEO4J_USER, config.NEO4J_PASSWORD),
            )
            # Verify connectivity immediately
            self._driver.verify_connectivity()
            logger.info(f"Connected to Neo4j at {config.NEO4J_URI}")

    def close(self) -> None:
        """Close the driver and release connections."""
        if self._driver:
            self._driver.close()
            self._driver = None
            logger.info("Neo4j driver closed")

    @property
    def is_connected(self) -> bool:
        return self._driver is not None

    def build_graph(
        self,
        job_id: str,
        user_id: str,
        entities: list[dict],
        relations: list[dict],
        classification: Optional[dict] = None,
        origin: Optional[str] = None,
    ) -> dict:
        """
        Write entities and relations to Neo4j.

        Each entity node / relation carries its classification provenance:
          - uri             : stable identifier (nodes)
          - name/type/label : entity surface form + Wikidata type + human label
          - _classification : level name (legacy display marker)
          - _class_labels   : list of JSON-encoded provenance labels
          - _label_ranks    : parallel list of label ranks (dedup + conflict key)
          - _min_rank       : most-permissive rank — the value reads filter on
          - _class_conflict : true once ≥2 distinct ranks are present
          - _owner          : user_id
          - _source_job     : job_id
          - _origin         : file name or short text-preview the entity came from
                              (provenance signal the A2 dossier layer cites)

        `classification` is the resolved {id, name, rank} for this ingest; when
        omitted it defaults to PUBLIC (rank 0).

        `origin` is an optional human-readable provenance signal (the source file
        name, note path, or a short text preview) recorded on every node so a
        dossier can cite where a fact came from.

        Returns:
          { entities_created, relations_created, nodes_total }
        """
        if not self._driver:
            self.connect()

        resolved = classification or {"id": None, "name": "PUBLIC", "rank": 0}
        label = make_label(resolved, job_id, user_id)
        label_json = encode_label(label)
        rank = int(resolved.get("rank", 0))
        level_name = resolved.get("name", "PUBLIC")

        # "Remember" corrections: load the triples this user has explicitly marked
        # as false (knowledge_corrections, action='delete') so we never re-introduce
        # a relationship they already corrected. Keyed by (head, sanitised_rel, tail).
        corrected = self._load_corrected_triples(user_id)

        # Build a stable surface-name -> uri map ONCE, from the (already
        # type-consolidated) entity list. Relations are matched by this uri so
        # the write can never cartesian-fan-out over same-named duplicate nodes.
        name_to_uri: dict[str, str] = {}
        for ent in entities:
            name = (ent.get("text") or "").strip()
            if not name:
                continue
            etype = ent.get("type") or ent.get("coarse_type") or "other"
            # First mention wins; types are consolidated so this is stable.
            name_to_uri.setdefault(name.lower(), _make_uri(name, etype, user_id))

        with self._driver.session() as session:
            entities_created = session.execute_write(
                self._write_entities, job_id, user_id, entities,
                label_json, rank, level_name, origin,
            )
            relations_created = session.execute_write(
                self._write_relations, job_id, relations,
                label_json, rank, level_name, corrected, name_to_uri,
            )
            nodes_total = session.execute_read(self._count_nodes)

        return {
            "entities_created": entities_created,
            "relations_created": relations_created,
            "nodes_total": nodes_total,
        }

    @staticmethod
    def _load_corrected_triples(user_id: str) -> set:
        """Return the set of (head, sanitised_rel_type, tail) the user has marked
        as false via knowledge_corrections (action='delete', element_kind='edge').

        These are skipped on every (re-)extraction so a corrected falsehood never
        comes back. Postgres unavailability degrades gracefully to "no skips".
        """
        triples: set = set()
        try:
            import psycopg2
            conn = psycopg2.connect(config.PG_URL, connect_timeout=5)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT head, rel_type, tail FROM knowledge_corrections
                         WHERE user_id = %s AND action = 'delete'
                           AND element_kind = 'edge' AND rel_type IS NOT NULL
                        """,
                        (user_id,),
                    )
                    for head, rel_type, tail in cur.fetchall():
                        if head and rel_type and tail:
                            triples.add((head.strip(), _safe_rel_type(rel_type), tail.strip()))
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001 — non-fatal, just means no skips
            logger.warning(f"KGBuilder: could not load corrections for {user_id}: {exc}")
        return triples

    # ── transaction functions ─────────────────────────────────────────

    @staticmethod
    def _write_entities(
        tx,
        job_id: str,
        user_id: str,
        entities: list[dict],
        label_json: str,
        rank: int,
        level_name: str,
        origin: Optional[str] = None,
    ) -> int:
        """MERGE entity nodes; return count of newly created nodes.

        ON MATCH unions the new classification label only when its rank is not
        already present (dedup by rank), recomputes the most-permissive
        `_min_rank`, and flags a conflict once ≥2 distinct ranks coexist.
        """
        created = 0
        for ent in entities:
            name = ent.get("text", "").strip()
            # `type` is now the STABLE, human-readable coarse bucket (set by the
            # NER consolidation pass), NOT a noisy fine QID. Keying the uri on it
            # means every mention of the same name -> the same uri -> one node.
            entity_type = ent.get("type") or ent.get("coarse_type") or "other"
            human_label = ent.get("label", "entity")
            coarse_type = ent.get("coarse_type") or entity_type
            # Precise Wikidata QID retained as secondary metadata only.
            fine_qid = ent.get("fine_qid", "Q35120")

            if not name:
                continue

            uri = _make_uri(name, entity_type, user_id)

            result = tx.run(
                """
                MERGE (n:Entity {uri: $uri})
                ON CREATE SET
                    n.name            = $name,
                    n.type            = $type,
                    n.coarse_type     = $coarse_type,
                    n.fine_qid        = $fine_qid,
                    n.label           = $label,
                    n._classification = $level_name,
                    n._class_labels   = [$label_json],
                    n._label_ranks    = [$rank],
                    n._min_rank       = $rank,
                    n._class_conflict = false,
                    n._owner          = $owner,
                    n._source_job     = $job_id,
                    n._origin         = $origin,
                    n.created_at      = timestamp()
                ON MATCH SET
                    n._source_job  = $job_id,
                    n._origin      = coalesce($origin, n._origin),
                    n.coarse_type  = coalesce(n.coarse_type, $coarse_type),
                    n._class_labels = CASE WHEN $rank IN coalesce(n._label_ranks, [])
                                           THEN coalesce(n._class_labels, [$label_json])
                                           ELSE coalesce(n._class_labels, []) + [$label_json] END,
                    n._label_ranks  = CASE WHEN $rank IN coalesce(n._label_ranks, [])
                                           THEN coalesce(n._label_ranks, [$rank])
                                           ELSE coalesce(n._label_ranks, []) + [$rank] END
                SET n._min_rank       = CASE WHEN $rank < coalesce(n._min_rank, 2147483647)
                                             THEN $rank ELSE coalesce(n._min_rank, $rank) END,
                    n._class_conflict = (size(coalesce(n._label_ranks, [$rank])) > 1)
                RETURN n.uri AS uri
                """,
                uri=uri,
                name=name,
                type=entity_type,
                coarse_type=coarse_type,
                fine_qid=fine_qid,
                label=human_label,
                level_name=level_name,
                label_json=label_json,
                rank=rank,
                owner=user_id,
                job_id=job_id,
                origin=origin,
            )
            summary = result.consume()
            created += summary.counters.nodes_created

        return created

    @staticmethod
    def _write_relations(
        tx,
        job_id: str,
        relations: list[dict],
        label_json: str,
        rank: int,
        level_name: str,
        corrected: Optional[set] = None,
        name_to_uri: Optional[dict] = None,
    ) -> int:
        """Create relationships between existing Entity nodes; return count created.

        Relations carry the same per-element classification labels as nodes, with
        the same union-on-match / most-permissive `_min_rank` semantics, plus the
        memory-layer provenance properties:
          - confidence        : per-triple trust score 0..1 (from relex/validation)
          - extraction_method : 'EXTRACTED' (INFERRED/AMBIGUOUS reserved for later)
          - _source_job       : KEX job uuid that produced the edge
          - _source_chunk     : originating chunk id, when the extractor supplies it
        The MERGE stays idempotent (by head_uri, rel_type, tail_uri): re-extraction
        keeps the most-confident reading and never multiplies edges.

        `corrected` is the set of (head, rel_type, tail) the user has marked false;
        any matching triple is skipped so it can never be re-introduced.

        Head/tail are resolved to the node's stable `uri` via `name_to_uri`, and
        matched on uri. This is the fix for the duplicate-edge bug: matching on
        `{name}` cartesian-products over every same-named node, so one fact
        became N×M edges. Matching on the unique uri writes exactly one edge,
        and the MERGE makes re-ingesting the same fact idempotent.
        """
        corrected = corrected or set()
        name_to_uri = name_to_uri or {}
        created = 0
        skipped = 0
        for rel in relations:
            head_text = rel.get("head", "").strip()
            tail_text = rel.get("tail", "").strip()
            rel_type_raw = rel.get("type", "RELATED_TO")

            if not head_text or not tail_text:
                continue

            rel_type = _safe_rel_type(rel_type_raw)

            # Per-edge trust + provenance for the memory layer (A4 heat/trust,
            # A2 dossiers, A3 ground-truth ranking).
            #   confidence        : 0..1 from the extractor/validation (default
            #                       0.9 for a clean in-vocab type-checked triple).
            #   extraction_method : always "EXTRACTED" now; INFERRED / AMBIGUOUS
            #                       are reserved for later graph-inference passes.
            #   _source_chunk     : the chunk this relation came from, if the
            #                       extractor threaded one through (per-chunk
            #                       extraction); absent for whole-doc extraction.
            try:
                confidence = float(rel.get("confidence", 0.9))
            except (TypeError, ValueError):
                confidence = 0.9
            confidence = max(0.0, min(1.0, confidence))
            source_chunk = rel.get("source_chunk") or rel.get("chunk_id")

            # "Remember": never re-create a relationship the user corrected away.
            if (head_text, rel_type, tail_text) in corrected:
                skipped += 1
                logger.info(
                    f"KGBuilder: skipping corrected triple "
                    f"({head_text})-[{rel_type}]->({tail_text})"
                )
                continue

            head_uri = name_to_uri.get(head_text.lower())
            tail_uri = name_to_uri.get(tail_text.lower())

            # We need to use dynamic relationship types - build the query string
            # Neo4j does not allow parameterised relationship types, so we
            # embed the (already-sanitised) type string directly.
            #
            # Prefer matching on the unique uri (no fan-out). Fall back to a
            # deterministic single-node name match (ORDER BY uri, LIMIT 1) only
            # if the entity wasn't in this job's map (defensive).
            if head_uri and tail_uri:
                match_clause = (
                    "MATCH (h:Entity {uri: $head_uri})\n"
                    "                MATCH (t:Entity {uri: $tail_uri})"
                )
            else:
                match_clause = (
                    "MATCH (h:Entity {name: $head}) WITH h ORDER BY h.uri LIMIT 1\n"
                    "                MATCH (t:Entity {name: $tail}) WITH h, t ORDER BY t.uri LIMIT 1"
                )

            cypher = f"""
                {match_clause}
                MERGE (h)-[r:{rel_type}]->(t)
                ON CREATE SET
                    r._source_job      = $job_id,
                    r._source_chunk    = $source_chunk,
                    r.confidence       = $confidence,
                    r.extraction_method = 'EXTRACTED',
                    r._classification  = $level_name,
                    r._class_labels    = [$label_json],
                    r._label_ranks     = [$rank],
                    r._min_rank        = $rank,
                    r._class_conflict  = false,
                    r.created_at       = timestamp()
                ON MATCH SET
                    r._source_job   = $job_id,
                    r._source_chunk = coalesce($source_chunk, r._source_chunk),
                    // Idempotent re-extraction: keep the most-confident reading,
                    // never multiply edges (MERGE already dedups by h,rel,t).
                    r.confidence    = CASE WHEN $confidence > coalesce(r.confidence, 0.0)
                                           THEN $confidence ELSE coalesce(r.confidence, $confidence) END,
                    r.extraction_method = coalesce(r.extraction_method, 'EXTRACTED'),
                    r._class_labels = CASE WHEN $rank IN coalesce(r._label_ranks, [])
                                           THEN coalesce(r._class_labels, [$label_json])
                                           ELSE coalesce(r._class_labels, []) + [$label_json] END,
                    r._label_ranks  = CASE WHEN $rank IN coalesce(r._label_ranks, [])
                                           THEN coalesce(r._label_ranks, [$rank])
                                           ELSE coalesce(r._label_ranks, []) + [$rank] END
                SET r._min_rank       = CASE WHEN $rank < coalesce(r._min_rank, 2147483647)
                                             THEN $rank ELSE coalesce(r._min_rank, $rank) END,
                    r._class_conflict = (size(coalesce(r._label_ranks, [$rank])) > 1)
                RETURN r
            """
            result = tx.run(
                cypher,
                head=head_text,
                tail=tail_text,
                head_uri=head_uri,
                tail_uri=tail_uri,
                job_id=job_id,
                source_chunk=source_chunk,
                confidence=confidence,
                level_name=level_name,
                label_json=label_json,
                rank=rank,
            )
            summary = result.consume()
            created += summary.counters.relationships_created

        if skipped:
            logger.info(f"KGBuilder: skipped {skipped} corrected relationship(s)")
        return created

    @staticmethod
    def _count_nodes(tx) -> int:
        result = tx.run("MATCH (n:Entity) RETURN count(n) AS total")
        record = result.single()
        return record["total"] if record else 0


# Module-level singleton
_kg_builder = KGBuilder()


def get_kg_builder() -> KGBuilder:
    return _kg_builder

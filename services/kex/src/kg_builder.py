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

logger = logging.getLogger(__name__)


def _make_uri(name: str, entity_type: str) -> str:
    """Generate a stable URI for a node from its name and Wikidata type."""
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
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
    ) -> dict:
        """
        Write entities and relations to Neo4j.

        Each entity node gets:
          - uri             : stable identifier
          - name            : surface form
          - type            : Wikidata entity ID (e.g. Q5)
          - label           : human-readable label (e.g. "human")
          - _classification : "PUBLIC" (data access control marker)
          - _owner          : user_id
          - _source_job     : job_id

        Each relation becomes a directed Neo4j relationship between the
        corresponding entity nodes.

        Returns:
          { entities_created, relations_created, nodes_total }
        """
        if not self._driver:
            self.connect()

        with self._driver.session() as session:
            entities_created = session.execute_write(
                self._write_entities, job_id, user_id, entities
            )
            relations_created = session.execute_write(
                self._write_relations, job_id, relations
            )
            nodes_total = session.execute_read(self._count_nodes)

        return {
            "entities_created": entities_created,
            "relations_created": relations_created,
            "nodes_total": nodes_total,
        }

    # ── transaction functions ─────────────────────────────────────────

    @staticmethod
    def _write_entities(
        tx,
        job_id: str,
        user_id: str,
        entities: list[dict],
    ) -> int:
        """MERGE entity nodes; return count of newly created nodes."""
        created = 0
        for ent in entities:
            name = ent.get("text", "").strip()
            entity_type = ent.get("type", "Q35120")
            human_label = ent.get("label", "entity")

            if not name:
                continue

            uri = _make_uri(name, entity_type)

            result = tx.run(
                """
                MERGE (n:Entity {uri: $uri})
                ON CREATE SET
                    n.name            = $name,
                    n.type            = $type,
                    n.label           = $label,
                    n._classification = $classification,
                    n._owner          = $owner,
                    n._source_job     = $job_id,
                    n.created_at      = timestamp()
                ON MATCH SET
                    n._source_job     = $job_id
                RETURN n.uri AS uri, (n.created_at = timestamp()) AS was_created
                """,
                uri=uri,
                name=name,
                type=entity_type,
                label=human_label,
                classification="PUBLIC",
                owner=user_id,
                job_id=job_id,
            )
            # Count newly created nodes
            for record in result:
                # ON CREATE fires when the node didn't exist before
                # We detect creation by checking if name was just set
                pass
            # Simpler: use CREATE vs MATCH counters from summary
            summary = result.consume()
            created += summary.counters.nodes_created

        return created

    @staticmethod
    def _write_relations(
        tx,
        job_id: str,
        relations: list[dict],
    ) -> int:
        """Create relationships between existing Entity nodes; return count created."""
        created = 0
        for rel in relations:
            head_text = rel.get("head", "").strip()
            tail_text = rel.get("tail", "").strip()
            rel_type_raw = rel.get("type", "RELATED_TO")

            if not head_text or not tail_text:
                continue

            rel_type = _safe_rel_type(rel_type_raw)

            # We need to use dynamic relationship types - build the query string
            # Neo4j does not allow parameterised relationship types, so we
            # embed the (already-sanitised) type string directly.
            cypher = f"""
                MATCH (h:Entity {{name: $head}})
                MATCH (t:Entity {{name: $tail}})
                MERGE (h)-[r:{rel_type}]->(t)
                ON CREATE SET
                    r._source_job     = $job_id,
                    r._classification = 'PUBLIC',
                    r.created_at      = timestamp()
                RETURN r
            """
            result = tx.run(
                cypher,
                head=head_text,
                tail=tail_text,
                job_id=job_id,
            )
            summary = result.consume()
            created += summary.counters.relationships_created

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

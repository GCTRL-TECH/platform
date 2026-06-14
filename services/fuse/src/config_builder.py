"""
Semantic Resolver Configuration Builder
Generates XML configurations for link discovery from Python dicts.
Supports Neo4j/SPARQL endpoints and CSV data sources.

RDF namespace
-------------
The default RDF namespace for Ground Control entity URIs is
``http://gctrl.tech/entity/`` and can be overridden at runtime via the
``GCTRL_RDF_NAMESPACE`` environment variable. Legacy graphs created
under the previous ``http://borghive.dev/entity/`` namespace must be
rewritten with ``scripts/migrate-rdf-namespace.cypher`` before cutover.
"""

import logging
import os
import xml.etree.ElementTree as ET
from xml.dom.minidom import parseString

logger = logging.getLogger(__name__)

# Default RDF namespace for entity URIs. Overridable via environment so
# that historical deployments can pin the legacy namespace while data is
# migrated with scripts/migrate-rdf-namespace.cypher.
DEFAULT_RDF_NAMESPACE = os.environ.get(
    "GCTRL_RDF_NAMESPACE", "http://gctrl.tech/entity/"
)

# Per-entity-type link-spec presets. These are the GENERIC, conservative defaults
# shipped with the open-source service — a single uniform cosine-name family that
# is functional but measurably below the tuned profile. The tuned per-type specs
# (the real entity-resolution edge) are NOT in this repo: they are delivered to
# licensed deployments over the license channel and applied at runtime through
# `tuning.load_tuning()` (which mutates this dict in place). Any tuning miss falls
# back to exactly these defaults — see services/fuse/src/tuning.py.
DEFAULT_METRICS: dict[str, str] = {
    "person": "AND(cosine(x.name, y.name)|0.80, exactmatch(x.type, y.type)|1.0)",
    "company": "AND(cosine(x.name, y.name)|0.80, exactmatch(x.type, y.type)|1.0)",
    "organization": "AND(cosine(x.name, y.name)|0.80, exactmatch(x.type, y.type)|1.0)",
    "location": "AND(cosine(x.name, y.name)|0.80, exactmatch(x.type, y.type)|1.0)",
    "default": "AND(cosine(x.name, y.name)|0.80, exactmatch(x.type, y.type)|1.0)",
}

# Snapshot of the generic baseline so the tuning seam can always restore it if a
# delivered profile is later revoked/cleared without a service restart.
GENERIC_DEFAULT_METRICS: dict[str, str] = dict(DEFAULT_METRICS)


def build_neo4j_config(
    source_job_ids: list[str],
    target_job_ids: list[str] | None = None,
    neo4j_uri: str = "bolt://neo4j:7687",
    neo4j_user: str = "neo4j",
    neo4j_password: str = "password",
    metric: str | None = None,
    acceptance_threshold: float = 0.85,
    review_threshold: float = 0.70,
    entity_type: str | None = None,
    properties: list[str] | None = None,
) -> str:
    """
    Build an XML config for matching entities from Neo4j.

    Generates a CSV-based config where source/target data is exported from Neo4j
    by the FUSE service before calling the resolver.

    Args:
        source_job_ids: Job IDs to use as source entities
        target_job_ids: Job IDs to use as target entities (if None, self-join source)
        neo4j_uri: Neo4j Bolt URI
        metric: resolver metric expression (e.g., "trigrams(x.name, y.name)|0.8")
        acceptance_threshold: Min similarity to auto-accept as match
        review_threshold: Min similarity for human review queue
        entity_type: Filter to specific entity type (e.g., "company")
        properties: Which properties to use for matching

    Returns:
        XML config string
    """
    if target_job_ids is None:
        target_job_ids = source_job_ids

    props = properties or ["name", "type", "label"]

    # Determine metric
    if metric is None:
        if entity_type and entity_type.lower() in DEFAULT_METRICS:
            metric = DEFAULT_METRICS[entity_type.lower()]
        else:
            metric = DEFAULT_METRICS["default"]

    # Build XML
    root = ET.Element("LIMES")

    # Prefixes
    _add_prefix(root, "rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#")
    _add_prefix(root, "owl", "http://www.w3.org/2002/07/owl#")
    _add_prefix(root, "bg", DEFAULT_RDF_NAMESPACE)

    # Source
    source = ET.SubElement(root, "SOURCE")
    ET.SubElement(source, "ID").text = "source"
    ET.SubElement(source, "ENDPOINT").text = "source.csv"
    ET.SubElement(source, "VAR").text = "?x"
    ET.SubElement(source, "PAGESIZE").text = "-1"
    ET.SubElement(source, "TYPE").text = "CSV"
    for prop in props:
        p = ET.SubElement(source, "PROPERTY")
        p.text = f"{prop} AS lowercase"

    # Target
    target = ET.SubElement(root, "TARGET")
    ET.SubElement(target, "ID").text = "target"
    ET.SubElement(target, "ENDPOINT").text = "target.csv"
    ET.SubElement(target, "VAR").text = "?y"
    ET.SubElement(target, "PAGESIZE").text = "-1"
    ET.SubElement(target, "TYPE").text = "CSV"
    for prop in props:
        p = ET.SubElement(target, "PROPERTY")
        p.text = f"{prop} AS lowercase"

    # Metric
    ET.SubElement(root, "METRIC").text = metric

    # Acceptance (auto-match)
    acceptance = ET.SubElement(root, "ACCEPTANCE")
    ET.SubElement(acceptance, "THRESHOLD").text = str(acceptance_threshold)
    ET.SubElement(acceptance, "FILE").text = "accepted.nt"
    ET.SubElement(acceptance, "RELATION").text = "owl:sameAs"

    # Review (human review zone)
    review = ET.SubElement(root, "REVIEW")
    ET.SubElement(review, "THRESHOLD").text = str(review_threshold)
    ET.SubElement(review, "FILE").text = "review.nt"
    ET.SubElement(review, "RELATION").text = "owl:sameAs"

    # Execution
    execution = ET.SubElement(root, "EXECUTION")
    ET.SubElement(execution, "REWRITER").text = "default"
    ET.SubElement(execution, "PLANNER").text = "default"
    ET.SubElement(execution, "ENGINE").text = "default"

    # Output
    ET.SubElement(root, "OUTPUT").text = "N3"

    # Pretty print
    xml_str = ET.tostring(root, encoding="unicode")
    pretty = parseString(xml_str).toprettyxml(indent="  ")
    # Remove extra XML declaration
    lines = pretty.split("\n")
    if lines[0].startswith("<?xml"):
        lines = lines[1:]
    return "\n".join(lines)


def build_simple_metric(
    property_pairs: list[tuple[str, str, str, float]],
    operator: str = "AND",
) -> str:
    """
    Build a resolver metric expression from property pairs.

    Args:
        property_pairs: List of (source_prop, target_prop, measure, threshold)
            measure: "trigrams", "cosine", "jaro", "jarowinkler", "levenshtein",
                     "exactmatch", "soundex", "mongeelkan"
        operator: "AND", "OR", "MAX", "MIN"

    Returns:
        resolver metric expression string
    """
    if len(property_pairs) == 1:
        sp, tp, measure, threshold = property_pairs[0]
        return f"{measure}(x.{sp}, y.{tp})|{threshold}"

    parts = []
    for sp, tp, measure, threshold in property_pairs:
        parts.append(f"{measure}(x.{sp}, y.{tp})|{threshold}")

    return f"{operator}({', '.join(parts)})"


def build_field_metric(
    field_specs: list[tuple[str, str, float]],
    operator: str = "AND",
) -> str:
    """Build an ATTRIBUTE-AWARE (per-field) LIMES metric from field specs.

    Each spec is ``(property, measure, threshold)`` and emits one thresholded
    measure ``measure(x.property, y.property)|threshold``. The specs are combined
    with ``operator`` (``AND`` = conjunctive blocking, the precise choice for
    multi-attribute entity resolution; ``OR``/``MAX``/``MIN`` also valid).

    This is the lever that breaks the single-composite-name precision ceiling:
    instead of one fuzzy match over ``title | authors | venue year`` (where two
    distinct papers sharing domain boilerplate over-merge), every field is scored
    on its OWN axis and ALL must clear their floor, e.g.

        AND(trigrams(x.title,y.title)|0.7, jaccard(x.authors,y.authors)|0.6,
            exactmatch(x.year,y.year)|1.0)

    A near-duplicate that shares boilerplate in the title but has a different
    year / author set now fails the conjunction and stays apart.

    Example::

        >>> build_field_metric([("title","trigrams",0.7),
        ...                      ("authors","jaccard",0.6),
        ...                      ("year","exactmatch",1.0)])
        'AND(trigrams(x.title, y.title)|0.7, jaccard(x.authors, y.authors)|0.6, exactmatch(x.year, y.year)|1.0)'
    """
    if not field_specs:
        raise ValueError("build_field_metric requires at least one field spec")
    parts = [
        f"{measure}(x.{prop}, y.{prop})|{threshold}"
        for prop, measure, threshold in field_specs
    ]
    if len(parts) == 1:
        return parts[0]
    return f"{operator}({', '.join(parts)})"


def _add_prefix(root: ET.Element, label: str, namespace: str) -> None:
    prefix = ET.SubElement(root, "PREFIX")
    ET.SubElement(prefix, "NAMESPACE").text = namespace
    ET.SubElement(prefix, "LABEL").text = label

"""
B2 — Community detection + centrality ("god nodes") for GCTRL graphs.

Turns a flat compilation subgraph into a STRUCTURED one: every node gets a
`_community` id, a `_centrality` score (degree), and a `_god_node` flag for the
most central nodes overall. The web canvas can then colour by community and
highlight the god nodes ("what matters most / top concepts").

Fully LOCAL and dependency-free: community detection is **Louvain modularity
optimisation** (the standard method; one local-moving level) implemented in pure
stdlib — no igraph / networkx / GDS, no token cost, no image rebuild for new C
deps. Leiden is a marginal future upgrade; Louvain gives proper communities now.

Writeback is idempotent: re-running re-labels in place. Communities are auto-named
after their highest-degree member so the UI has a human handle per cluster.
"""

import logging
from collections import Counter, defaultdict
from typing import Optional

from neo4j import GraphDatabase

from . import config

logger = logging.getLogger(__name__)

# Structural/derived edges that would swamp real semantic structure are skipped.
_SKIP_EDGE_TYPES = ["SIMILAR_TO"]

# Hard ceiling on nodes analysed in one pass (perf-safe; loud-logged if exceeded).
_MAX_NODES = 8000

# God nodes = the most-central ~5% of nodes (degree), capped, min 1.
_GOD_NODE_FRACTION = 0.05
_GOD_NODE_MAX = 25

# Louvain local-moving sweep cap (converges fast in practice).
_MAX_ITERS = 50


def _read_subgraph(driver, source_job_ids: list[str], user_id: str) -> tuple[list[str], list[tuple[str, str]]]:
    """Return (node_names, edges) for the compilation's scope.

    Scoped to `_source_job IN job_ids` when the compilation has source jobs,
    else to the user's whole owned graph (`_owner = user_id`). Skips SIMILAR_TO
    (a fusion artifact) so communities reflect real relationships.
    """
    if source_job_ids:
        node_q = (
            "MATCH (e:Entity) WHERE e._source_job IN $jobs "
            "RETURN e.name AS name LIMIT $cap"
        )
        edge_q = (
            "MATCH (a:Entity)-[r]->(b:Entity) "
            "WHERE a._source_job IN $jobs AND b._source_job IN $jobs "
            "  AND NOT type(r) IN $skip "
            "RETURN a.name AS a, b.name AS b"
        )
        params = {"jobs": source_job_ids, "skip": _SKIP_EDGE_TYPES, "cap": _MAX_NODES}
    else:
        node_q = (
            "MATCH (e:Entity) WHERE e._owner = $uid "
            "RETURN e.name AS name LIMIT $cap"
        )
        edge_q = (
            "MATCH (a:Entity)-[r]->(b:Entity) "
            "WHERE a._owner = $uid AND b._owner = $uid "
            "  AND NOT type(r) IN $skip "
            "RETURN a.name AS a, b.name AS b"
        )
        params = {"uid": user_id, "skip": _SKIP_EDGE_TYPES, "cap": _MAX_NODES}

    names: list[str] = []
    edges: list[tuple[str, str]] = []
    with driver.session() as session:
        for rec in session.run(node_q, **params):
            n = rec["name"]
            if n:
                names.append(n)
        allowed = set(names)
        for rec in session.run(edge_q, **params):
            a, b = rec["a"], rec["b"]
            if a and b and a != b and a in allowed and b in allowed:
                edges.append((a, b))
    if len(names) >= _MAX_NODES:
        logger.warning(
            f"[communities] node cap {_MAX_NODES} hit — analysing the first "
            f"{_MAX_NODES} nodes only (graph is larger)"
        )
    return names, edges


def _louvain(names: list[str], adj: dict[str, set[str]], degree: dict[str, int]) -> dict[str, int]:
    """Louvain modularity optimisation — one local-moving level (enough for good
    communities; the dominant quality gain). Deterministic: nodes are swept in
    sorted order and a move is taken only on a strictly-positive modularity gain,
    ties favouring the lowest community id. Returns name → dense community index.

    Modularity gain of moving node i into community C (unweighted, undirected):
        ΔQ ∝ k_{i,C} − k_i · Σ_tot(C) / (2m)
    where k_{i,C} = #edges from i to C, k_i = degree(i), Σ_tot(C) = Σ degrees in C.
    """
    m = sum(degree.values()) / 2.0  # total undirected edges
    if m <= 0:
        # No edges: every node is its own singleton community.
        return {n: i for i, n in enumerate(sorted(names))}
    two_m = 2.0 * m

    comm: dict[str, str] = {n: n for n in names}          # community id == a member name
    tot: dict[str, float] = {n: float(degree[n]) for n in names}  # Σ degrees per community
    order = sorted(names)

    for _ in range(_MAX_ITERS):
        improved = False
        for i in order:
            ki = degree[i]
            ci = comm[i]
            # Detach i from its community.
            tot[ci] -= ki
            # Edges from i to each neighbouring community.
            links: Counter = Counter()
            for j in adj[i]:
                links[comm[j]] += 1
            # Staying put is always a candidate.
            links.setdefault(ci, 0)
            # Pick the community with the best modularity gain (ties → lowest id).
            best_c, best_gain = ci, -1.0
            for c in sorted(links):
                gain = links[c] - ki * tot[c] / two_m
                if gain > best_gain:
                    best_gain, best_c = gain, c
            comm[i] = best_c
            tot[best_c] += ki
            if best_c != ci:
                improved = True
        if not improved:
            break

    # Renumber to dense 0..K-1, largest community first (community 0 = biggest).
    # Untyped: the Cython prod build rejects a defaultdict under a `dict`
    # annotation (PyDict_CheckExact → "Expected dict, got collections.defaultdict").
    members = defaultdict(list)
    for n, c in comm.items():
        members[c].append(n)
    ordered = sorted(members.values(), key=lambda ms: (-len(ms), min(ms)))
    out: dict[str, int] = {}
    for idx, ms in enumerate(ordered):
        for n in ms:
            out[n] = idx
    return out


def detect_communities(
    compilation_id: str,
    user_id: str,
    source_job_ids: Optional[list[str]] = None,
) -> dict:
    """Detect communities + centrality for a compilation and write them back onto
    the Neo4j nodes (`_community`, `_centrality`, `_god_node`).

    Returns a summary the api/UI can show:
      { communityCount, nodeCount, edgeCount,
        communities: [{id, name, size}],
        godNodes:    [{name, degree, community}] }
    """
    source_job_ids = source_job_ids or []
    driver = GraphDatabase.driver(
        config.NEO4J_URI, auth=(config.NEO4J_USER, config.NEO4J_PASSWORD)
    )
    try:
        names, edges = _read_subgraph(driver, source_job_ids, user_id)
        if not names:
            return {"communityCount": 0, "nodeCount": 0, "edgeCount": 0,
                    "communities": [], "godNodes": []}

        # Build undirected adjacency + degree centrality.
        adj: dict[str, set[str]] = {n: set() for n in names}
        for a, b in edges:
            adj[a].add(b)
            adj[b].add(a)
        degree = {n: len(adj[n]) for n in names}

        community = _louvain(names, adj, degree)

        # God nodes: the most-central ~5% of nodes by degree (min 1, capped),
        # excluding isolated nodes. These are the "what matters most" anchors.
        k = min(_GOD_NODE_MAX, max(1, round(len(names) * _GOD_NODE_FRACTION)))
        god = sorted(names, key=lambda n: (-degree[n], n))[:k]
        god_set = set(g for g in god if degree[g] > 0)

        # Auto-name each community after its highest-degree member.
        by_comm = defaultdict(list)  # untyped (Cython rejects defaultdict-as-dict)
        for n in names:
            by_comm[community[n]].append(n)
        comm_summary = []
        for cid, ms in sorted(by_comm.items()):
            lead = max(ms, key=lambda n: (degree[n], n))
            comm_summary.append({"id": cid, "name": lead, "size": len(ms)})

        # Writeback (batched, idempotent).
        rows = [{
            "name": n, "community": community[n],
            "degree": degree[n], "god": n in god_set,
        } for n in names]
        write_q = (
            "UNWIND $rows AS row "
            "MATCH (e:Entity {name: row.name}) "
            + ("WHERE e._source_job IN $jobs " if source_job_ids else "WHERE e._owner = $uid ")
            + "SET e._community = row.community, e._centrality = row.degree, "
            "    e._god_node = row.god"
        )
        with driver.session() as session:
            session.run(write_q, rows=rows, jobs=source_job_ids, uid=user_id)

        logger.info(
            f"[communities {compilation_id}] {len(by_comm)} communities over "
            f"{len(names)} nodes / {len(edges)} edges; {len(god_set)} god nodes"
        )
        return {
            "communityCount": len(by_comm),
            "nodeCount": len(names),
            "edgeCount": len(edges),
            "communities": comm_summary,
            "godNodes": [
                {"name": g, "degree": degree[g], "community": community[g]}
                for g in god if g in god_set
            ],
        }
    finally:
        driver.close()

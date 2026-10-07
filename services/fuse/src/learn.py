"""Learned entity matching: LIMES learns the link rule from confirmed merges.

Why
---
Every merge so far ran a HAND-WRITTEN link specification (a trigram floor on
the name plus a type guard, or a licensed per-type preset). The merge trail
(`merge_links`) and the review queue (`review_queue`) now record which pairs
were confirmed to be the same entity — by a person, or by two independent
matchers agreeing at high confidence. That is training data. LIMES ships the
WOMBAT learner, which refines a link specification until it best reproduces a
given set of positive pairs. So after a merge, when an owner has enough
confirmed pairs of one coarse entity type, we let WOMBAT learn a rule for that
type and record it in `merge_rules`, where the merge reads its active rules.

Nothing here touches the merge itself: this module only PRODUCES rules. The
fuse worker applies the active rows of `merge_rules` (see main.run_merge).

Safety gates before a learned rule is written as ``active``
---------------------------------------------------------
1. It is run exactly as the merge would run it (an ordinary LIMES job with the
   learned expression and threshold) and must reproduce the confirmed pairs
   better than today's default rule on the same entities (F1), and at least
   ``GCTRL_LEARN_MIN_F1``.
2. It must not link a pair a person marked "not the same".
3. It must fit this resolver build (at most two leaves — a three-leaf metric
   returns nothing here, see merger.MAX_METRIC_LEAVES).
A rule that is valid but not better than the default is written as
``proposed`` (visible, not applied). ``GCTRL_LEARN_AUTO_APPLY=0`` turns every
passing rule into a proposal as well, for owners who want the click.

Everything is best-effort: a learning failure is logged and never fails the
merge that triggered it.
"""

import json
import logging
import os
import re

from . import config

logger = logging.getLogger(__name__)

EXPORT_PROPS = ["name", "type", "label"]

# ── Tunables (environment) ───────────────────────────────────────────────────

_OFF = {"0", "false", "off", "no"}


def _enabled():
    return os.environ.get("GCTRL_LEARN_ENABLED", "1").strip().lower() not in _OFF


def _auto_apply():
    # Same switch and spelling as the threshold learner in main.py.
    return os.environ.get("GCTRL_LEARN_AUTO_APPLY", "1").strip().lower() not in _OFF


def _min_pairs():
    return int(os.environ.get("GCTRL_LEARN_MIN_PAIRS", "8"))


def _min_f1():
    return float(os.environ.get("GCTRL_LEARN_MIN_F1", "0.8"))


def _storage_dir():
    # LIMES stores uploads under its working directory's `.server-storage/files`;
    # the fusion-engine image runs with WORKDIR / (see services/fusion-engine).
    return os.environ.get("RESOLVER_STORAGE_DIR", "/.server-storage").rstrip("/")


MAX_LEAVES = 2          # what this resolver build evaluates (merger.MAX_METRIC_LEAVES)
WOMBAT_TREE_SIZE = 500  # refinement nodes; the default 2000 is sized for benchmarks
WOMBAT_MAX_MINUTES = 2

# ── Pure helpers (unit-tested) ───────────────────────────────────────────────

def pair_key(a, b):
    return (a, b) if a <= b else (b, a)


def method_family(method):
    """``resolver``/``resolver_review``/``resolver_fallback`` are ONE opinion
    (the same name similarity), as are the ``embedding-*`` variants."""
    m = str(method or "").lower()
    if m.startswith("resolver"):
        return "resolver"
    if m.startswith("embedding"):
        return "embedding"
    return m


def pick_positives(link_rows, review_rows, threshold_accept):
    """Confirmed same-entity pairs per coarse type.

    ``link_rows``: ``(source_uri, target_uri, entity_type, methods, score)``
    from merge_links. A pair counts when a person confirmed it (``human``) or
    when at least two INDEPENDENT matchers found it and the best score reached
    the acceptance threshold (silver label: two unrelated signals agreeing).
    ``review_rows``: ``(entity_a_uri, entity_b_uri, entity_type, decision)``
    from review_queue; ``same`` adds a pair, ``not_same`` removes it everywhere.

    Returns ``({type: set(pairs)}, {type: set(cannot_pairs)})``.
    """
    cannot = {}
    for a, b, typ, decision in review_rows:
        if decision == "not_same" and a and b:
            cannot.setdefault(_norm_type(typ), set()).add(pair_key(a, b))
    positives = {}
    for a, b, typ, methods, score in link_rows:
        if not a or not b or a == b:
            continue
        methods = list(methods or [])
        families = {method_family(m) for m in methods}
        human = "human" in families
        agreed = len(families - {"human"}) >= 2 and float(score or 0.0) >= float(threshold_accept)
        if human or agreed:
            positives.setdefault(_norm_type(typ), set()).add(pair_key(a, b))
    for a, b, typ, decision in review_rows:
        if decision == "same" and a and b and a != b:
            positives.setdefault(_norm_type(typ), set()).add(pair_key(a, b))
    for typ, pairs in cannot.items():
        if typ in positives:
            positives[typ] -= pairs
    return positives, cannot


def _norm_type(typ):
    return str(typ or "").strip().lower() or "default"


def training_csv(pairs):
    """Two-column CSV for LIMES's CSVMappingReader (header skipped because it
    starts with ``id``; commas in ids are folded exactly like the entity export)."""
    lines = ["id_source,id_target"]
    for a, b in sorted(pairs):
        lines.append(f"{_csv_id(a)},{_csv_id(b)}")
    return "\n".join(lines) + "\n"


def _csv_id(uri):
    return str(uri).replace(",", " ").replace("\n", " ")


def default_name_metric(names):
    """Today's default rule for a batch of names (mirrors the length-adaptive
    floor in merger._stage2_resolver), the baseline a learned rule must beat."""
    lens = sorted(len(n) for n in names if n)
    median = lens[len(lens) // 2] if lens else 0
    floor = 0.55 if median >= 40 else 0.40
    return f"AND(trigrams(x.name, y.name)|{floor}, exactmatch(x.type, y.type)|1.0)"


def ml_config_xml(source_id, target_id, training_path, properties, acceptance, review,
                  tree_size=WOMBAT_TREE_SIZE, max_minutes=WOMBAT_MAX_MINUTES):
    """A LIMES config that LEARNS instead of running a METRIC. Same DOCTYPE and
    element order as the merge config (the server validates against limes.dtd);
    MLALGORITHM takes METRIC's place, TRAINING is the uploaded pair file's
    absolute path on the resolver (the server rewrites only SOURCE/TARGET)."""
    props = "\n".join(f"    <PROPERTY>{p} AS lowercase</PROPERTY>" for p in properties)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE LIMES SYSTEM "limes.dtd">
<LIMES>
  <PREFIX><NAMESPACE>http://www.w3.org/2002/07/owl#</NAMESPACE><LABEL>owl</LABEL></PREFIX>
  <SOURCE>
    <ID>source</ID>
    <ENDPOINT>{source_id}</ENDPOINT>
    <VAR>?x</VAR>
    <PAGESIZE>-1</PAGESIZE>
    <RESTRICTION></RESTRICTION>
{props}
    <TYPE>CSV</TYPE>
  </SOURCE>
  <TARGET>
    <ID>target</ID>
    <ENDPOINT>{target_id}</ENDPOINT>
    <VAR>?y</VAR>
    <PAGESIZE>-1</PAGESIZE>
    <RESTRICTION></RESTRICTION>
{props}
    <TYPE>CSV</TYPE>
  </TARGET>
  <MLALGORITHM>
    <NAME>wombat simple</NAME>
    <TYPE>supervised batch</TYPE>
    <TRAINING>{training_path}</TRAINING>
    <PARAMETER><NAME>max refinement tree size</NAME><VALUE>{int(tree_size)}</VALUE></PARAMETER>
    <PARAMETER><NAME>max execution time in minutes</NAME><VALUE>{int(max_minutes)}</VALUE></PARAMETER>
  </MLALGORITHM>
  <ACCEPTANCE>
    <THRESHOLD>{acceptance}</THRESHOLD>
    <FILE>accepted.tsv</FILE>
    <RELATION>owl:sameAs</RELATION>
  </ACCEPTANCE>
  <REVIEW>
    <THRESHOLD>{review}</THRESHOLD>
    <FILE>review.tsv</FILE>
    <RELATION>owl:sameAs</RELATION>
  </REVIEW>
  <EXECUTION>
    <REWRITER>default</REWRITER>
    <PLANNER>default</PLANNER>
    <ENGINE>default</ENGINE>
  </EXECUTION>
  <OUTPUT>TAB</OUTPUT>
</LIMES>"""


_LEARNED = re.compile(r"Learned:\s*(.+?)\s+with threshold:\s*([0-9.]+)")
_LEAF = re.compile(r"([a-zA-Z_]+)\(x\.([A-Za-z0-9_]+)\s*,\s*y\.([A-Za-z0-9_]+)\)\|([0-9.]+)")


def parse_learned(log_text):
    """The learned link specification from the resolver's job log, or None.
    The last ``Learned:`` line wins (WOMBAT logs intermediate ones too)."""
    found = None
    for m in _LEARNED.finditer(log_text or ""):
        try:
            found = (m.group(1).strip(), float(m.group(2)))
        except ValueError:
            continue
    return found


def ls_to_rule(ls, threshold):
    """Structured form of a LIMES expression for merge_rules.rule:
    ``{operator, leaves: [{measure, property, threshold}], threshold}``."""
    leaves = [
        {"measure": m.lower(), "property": px, "threshold": float(t)}
        for m, px, py, t in _LEAF.findall(ls or "")
    ]
    head = re.match(r"\s*([A-Z]+)\s*\(", ls or "")
    operator = head.group(1) if head and head.group(1) in ("AND", "OR", "MINUS", "XOR", "MIN", "MAX") else "ATOM"
    return {"operator": operator, "leaves": leaves, "threshold": float(threshold)}


def prf(predicted, gold):
    """Precision, recall, F1 of unordered pair sets."""
    pred = {pair_key(a, b) for a, b in predicted}
    gold = {pair_key(a, b) for a, b in gold}
    if not pred or not gold:
        return 0.0, 0.0, 0.0
    tp = len(pred & gold)
    p = tp / len(pred)
    r = tp / len(gold)
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


SUPPORTED_MEASURES = frozenset({
    "trigrams", "qgrams", "jaccard", "cosine", "levenshtein", "jarowinkler",
    "jaro", "exactmatch", "koeln", "soundex",
})
SUPPORTED_PROPERTIES = frozenset(EXPORT_PROPS)


def rule_supported(rule):
    """Whether the merge (and the rule card) can run this rule: known measures
    over exported properties only, one to MAX_LEAVES leaves."""
    leaves = rule.get("leaves") or []
    if not leaves or len(leaves) > MAX_LEAVES:
        return False
    return all(
        leaf.get("measure") in SUPPORTED_MEASURES and leaf.get("property") in SUPPORTED_PROPERTIES
        for leaf in leaves
    )


def preview(rule, learned_f1, baseline_f1, training_pairs):
    """One line for the rule card: what the rule compares, and the evidence."""
    joiner = " OR " if rule.get("operator") == "OR" else " AND "
    parts = joiner.join(
        f"{leaf['measure']}({leaf['property']}) ≥ {leaf['threshold']:.2f}" for leaf in rule.get("leaves") or []
    )
    return (
        f"{parts} · learned from {training_pairs} confirmed pairs · "
        f"F1 {learned_f1:.2f} vs {baseline_f1:.2f} for the default rule"
    )


def decide(learned_f1, baseline_f1, violations, leaves, min_f1, auto_apply):
    """Pure verdict: ``active`` (apply), ``proposed`` (show), or None (drop).
    Returns ``(status, reason)``."""
    if leaves == 0 or leaves > MAX_LEAVES:
        return None, f"{leaves} leaves — this resolver build evaluates 1 to {MAX_LEAVES}"
    if violations:
        return None, f"links {violations} pair(s) a person marked not the same"
    if learned_f1 < min_f1:
        return None, f"F1 {learned_f1:.2f} on the confirmed pairs is below {min_f1:.2f}"
    if learned_f1 <= baseline_f1:
        return "proposed", f"F1 {learned_f1:.2f} does not beat the default rule ({baseline_f1:.2f})"
    if not auto_apply:
        return "proposed", f"F1 {learned_f1:.2f} beats the default ({baseline_f1:.2f}); auto-apply is off"
    return "active", f"F1 {learned_f1:.2f} beats the default rule ({baseline_f1:.2f})"


# ── Data access (best-effort, never raises past maybe_learn) ─────────────────

def _fetch_rows(pg_url, owner):
    import psycopg2
    conn = psycopg2.connect(pg_url, connect_timeout=5)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT source_uri, target_uri, entity_type, methods, score
                FROM merge_links WHERE user_id = %s::uuid
                """,
                (owner,),
            )
            link_rows = cur.fetchall()
            cur.execute(
                """
                SELECT entity_a_uri, entity_b_uri, entity_a_type, decision
                FROM review_queue
                WHERE user_id = %s::uuid AND decision IN ('same', 'not_same')
                """,
                (owner,),
            )
            review_rows = cur.fetchall()
    finally:
        conn.close()
    return link_rows, review_rows


def _fetch_entities(uris):
    """Raw entities by URI, exported like the merge exports them (coarse type
    projected onto ``type``)."""
    from .merger import get_merger
    driver = get_merger().driver
    out = {}
    with driver.session() as session:
        result = session.run(
            """
            MATCH (e:Entity) WHERE e.uri IN $uris AND NOT e:Merged
            RETURN e.uri AS uri, e.name AS name,
                   coalesce(e.coarse_type, e.type) AS type, e.label AS label
            """,
            uris=list(uris),
        )
        for rec in result:
            out[rec["uri"]] = {
                "uri": rec["uri"], "name": rec["name"] or "",
                "type": rec["type"] or "", "label": rec["label"] or "",
            }
    return out


def _fetch_log(base_url, request_id):
    import requests
    try:
        resp = requests.get(f"{base_url}/logs/{request_id}", timeout=60)
        return resp.text if resp.status_code == 200 else ""
    except Exception as exc:  # noqa: BLE001
        logger.warning("learn: could not read resolver log %s: %s", request_id, exc)
        return ""


def _run_ls(client, source_id, target_id, metric, acceptance, review):
    """Run an ordinary (metric) LIMES job on already uploaded CSVs; returns
    the linked pairs of both bands, or None when the engine failed."""
    xml = client._build_config(source_id, target_id, EXPORT_PROPS, metric, acceptance, review)
    request_id = client.submit_config(xml)
    if not request_id or not client.wait_for_completion(request_id):
        return None
    links = client.get_results(request_id, accepted_only=False)
    if not links and client.last_error:
        return None
    return {pair_key(l["source"], l["target"]) for l in links}


def _store_rule(pg_url, owner, entity_type, ls, rule, evidence, status):
    """One row in merge_rules (migration 097, owned by the review-queue work).

    One rule is active per owner, scope and type (unique index). An ``active``
    learned rule retires whatever was active before — EXCEPT a rule a person
    wrote (origin ``human``): that one is never overridden silently, the
    learned rule is written as a proposal next to it. Returns
    ``(version, status)`` with the status actually written."""
    import psycopg2
    conn = psycopg2.connect(pg_url, connect_timeout=5)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT coalesce(max(version), 0) FROM merge_rules
                WHERE user_id = %s::uuid AND compilation_id IS NULL
                  AND entity_type = %s AND origin = 'learned'
                """,
                (owner, entity_type),
            )
            version = int(cur.fetchone()[0]) + 1
            if status == "active":
                cur.execute(
                    """
                    SELECT count(*) FROM merge_rules
                    WHERE user_id = %s::uuid AND compilation_id IS NULL
                      AND entity_type = %s AND status = 'active' AND origin = 'human'
                    """,
                    (owner, entity_type),
                )
                if int(cur.fetchone()[0]) > 0:
                    status = "proposed"
                    evidence = {**evidence, "verdict": "proposed",
                                "reason": evidence.get("reason", "") + " — a rule written by a person is active and stays"}
            if status == "active":
                cur.execute(
                    """
                    UPDATE merge_rules SET status = 'retired', decided_at = NOW()
                    WHERE user_id = %s::uuid AND compilation_id IS NULL
                      AND entity_type = %s AND status = 'active'
                    """,
                    (owner, entity_type),
                )
            cur.execute(
                """
                INSERT INTO merge_rules
                    (user_id, compilation_id, entity_type, rule, ls, origin, status,
                     evidence, version, decided_at)
                VALUES (%s::uuid, NULL, %s, %s::jsonb, %s, 'learned', %s, %s::jsonb, %s,
                        CASE WHEN %s = 'active' THEN NOW() ELSE NULL END)
                """,
                (owner, entity_type, json.dumps(rule), ls, status, json.dumps(evidence),
                 version, status),
            )
    finally:
        conn.close()
    return version, status


# ── The learning run ─────────────────────────────────────────────────────────

# (owner, type) → number of confirmed pairs at the last attempt. Learning is
# repeated only when new evidence arrived; the worker's lifetime is the memory.
_last_attempt = {}


def learn_type(owner, entity_type, pairs, cannot, threshold_accept, threshold_review):
    """Learn and gate one rule. Returns the evidence dict (also logged)."""
    from .limes_client import ResolverClient
    client = ResolverClient(config.RESOLVER_URL)
    if not client.is_healthy():
        return {"outcome": "skipped", "reason": "resolver unreachable"}

    uris = sorted({u for p in pairs for u in p} | {u for p in cannot for u in p})
    entities = _fetch_entities(uris)
    usable = {p for p in pairs if p[0] in entities and p[1] in entities}
    if len(usable) < _min_pairs():
        return {"outcome": "skipped", "reason": f"only {len(usable)} confirmed pairs still in the graph"}

    # Source = first member of every pair, target = second, exactly what the
    # training file says (WOMBAT samples both caches from the pairs).
    src = [entities[a] for a, _ in sorted(usable)]
    tgt = [entities[b] for _, b in sorted(usable)]
    for a, b in sorted(cannot):
        # Forbidden pairs ride along so the learned rule is tested against them.
        if a in entities and b in entities:
            src.append(entities[a])
            tgt.append(entities[b])
    src = list({e["uri"]: e for e in src}.values())
    tgt = list({e["uri"]: e for e in tgt}.values())

    source_id = client.upload_csv(client._entities_to_csv(src, EXPORT_PROPS), "source.csv")
    target_id = client.upload_csv(client._entities_to_csv(tgt, EXPORT_PROPS), "target.csv")
    train_id = client.upload_csv(training_csv(usable), "training.csv")
    if not (source_id and target_id and train_id):
        return {"outcome": "failed", "reason": "upload to resolver failed"}

    xml = ml_config_xml(
        source_id, target_id, f"{_storage_dir()}/files/{train_id}.csv",
        EXPORT_PROPS, threshold_accept, threshold_review,
    )
    request_id = client.submit_config(xml)
    if not request_id or not client.wait_for_completion(request_id, max_wait=WOMBAT_MAX_MINUTES * 60 + 30):
        return {"outcome": "failed", "reason": "learning job failed or timed out", "requestId": request_id}
    learned = parse_learned(_fetch_log(client.base_url, request_id))
    if not learned:
        return {"outcome": "failed", "reason": "no learned specification in the job log", "requestId": request_id}
    ls, threshold = learned
    rule = ls_to_rule(ls, threshold)
    if not rule_supported(rule):
        return {"outcome": "dropped", "reason": "learned rule uses a measure or property the merge cannot run",
                "requestId": request_id, "ls": ls}

    # Gate: run the learned rule AS THE MERGE WOULD, and the default rule on
    # the same entities; compare on the confirmed pairs.
    review_floor = max(float(threshold_review), float(threshold))
    accept_floor = max(float(threshold_accept), review_floor)
    learned_pairs = _run_ls(client, source_id, target_id, ls, accept_floor, review_floor)
    baseline_ls = default_name_metric([e["name"] for e in src + tgt])
    baseline_pairs = _run_ls(client, source_id, target_id, baseline_ls, threshold_accept, threshold_review)
    if learned_pairs is None or baseline_pairs is None:
        return {"outcome": "failed", "reason": "verification run failed", "requestId": request_id, "ls": ls}
    _, _, learned_f1 = prf(learned_pairs, usable)
    _, _, baseline_f1 = prf(baseline_pairs, usable)
    violations = len(learned_pairs & cannot)
    status, reason = decide(learned_f1, baseline_f1, violations, len(rule["leaves"]), _min_f1(), _auto_apply())

    evidence = {
        "source": "wombat", "requestId": request_id, "ls": ls, "threshold": threshold,
        "trainingPairs": len(usable), "cannotPairs": len(cannot),
        "learnedF1": round(learned_f1, 4), "baselineF1": round(baseline_f1, 4),
        "baselineLs": baseline_ls, "cannotLinkViolations": violations,
        "verdict": status or "dropped", "reason": reason,
        "preview": preview(rule, learned_f1, baseline_f1, len(usable)),
    }
    if status is None:
        evidence["outcome"] = "dropped"
        return evidence
    try:
        version, written = _store_rule(config.PG_URL, owner, entity_type, ls, rule, evidence, status)
        evidence["version"] = version
        evidence["outcome"] = written
    except Exception as exc:  # noqa: BLE001 — merge_rules may not exist yet
        evidence["outcome"] = "unstored"
        evidence["storeError"] = str(exc)[:200]
    return evidence


def maybe_learn(owner, compilation_id=None):
    """After a merge: learn a rule for every coarse type of this owner that has
    enough confirmed pairs and new evidence since the last attempt. Never raises."""
    if not _enabled():
        return []
    import uuid
    try:
        owner = str(uuid.UUID(str(owner)))
    except (ValueError, TypeError, AttributeError):
        return []
    results = []
    try:
        from .merger import get_merger
        merger = get_merger()
        link_rows, review_rows = _fetch_rows(config.PG_URL, owner)
        positives, cannot = pick_positives(link_rows, review_rows, merger.threshold_accept)
        for entity_type, pairs in sorted(positives.items()):
            if len(pairs) < _min_pairs():
                continue
            key = (owner, entity_type)
            if _last_attempt.get(key) == len(pairs):
                continue
            _last_attempt[key] = len(pairs)
            logger.info("[%s] learn: %d confirmed %s pairs — asking WOMBAT for a rule",
                        compilation_id or owner, len(pairs), entity_type)
            evidence = learn_type(
                owner, entity_type, pairs, cannot.get(entity_type, set()),
                merger.threshold_accept, merger.threshold_review,
            )
            evidence["entityType"] = entity_type
            logger.info("[%s] learn %s: %s", compilation_id or owner, entity_type, evidence)
            results.append(evidence)
    except Exception as exc:  # noqa: BLE001 — never fail the merge
        logger.warning("[%s] learn: skipped after error: %s", compilation_id or owner, exc)
    return results

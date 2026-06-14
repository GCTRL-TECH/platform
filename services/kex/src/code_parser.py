"""
Code/Repo ingestion for KEX Service (B1).

Parses a Python codebase into a knowledge graph of its STRUCTURE — files,
modules, classes, functions/methods — and the relations between them
(CONTAINS, IMPORTS, CALLS, INHERITS). Output is the EXACT entity/relation
dict shape KGBuilder.build_graph() expects, so a code graph is written to
Neo4j by the same code path as text extraction and inherits the same
classification (_min_rank / _class_labels), provenance (_source_job /
_origin / _owner), and idempotent MERGE behaviour for free.

Fully LOCAL and DETERMINISTIC: uses only the standard-library `ast` module.
ZERO LLM calls, ZERO network, ZERO new dependencies — code structure is
syntactic, so none of the NER / RelEx / chunking / embedding machinery is
needed (or invoked). Re-ingesting the same repo MERGEs cleanly because every
symbol name is qualified by its file path (collision-resistant, stable).

Entity dict shape (matches relex.py / kg_builder._write_entities):
    {"text": <name>, "type": <code type>, "coarse_type": "code",
     "label": <human label>}
Relation dict shape (matches relex.py output / kg_builder._write_relations):
    {"head": <name>, "type": <UPPER_SNAKE>, "tail": <name>, "confidence": 1.0}
The relation-type key is `type` (NOT `relation_type`) — confirmed against
_write_relations which reads rel.get("type", "RELATED_TO").
"""

import ast
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Cap on files parsed in one repo ingest. A pathological monorepo dump should
# not be able to wedge the synchronous endpoint; we log loudly when we truncate
# so it is never a SILENT cut.
_MAX_FILES = 5000

# coarse_type for every code symbol — the stable bucket the KG builder keys the
# node uri on (so a function's uri is built from its qualified name, not a QID).
_CODE_COARSE = "code"


def parse_python_repo(files: list[dict]) -> tuple[list[dict], list[dict]]:
    """Parse a Python repo into (entities, relations) for KGBuilder.build_graph.

    `files` = [{"path": "src/foo.py", "content": "<source>"}].

    Returns (entities, relations) where each entity is
    {"text", "type", "coarse_type": "code", "label"} and each relation is
    {"head", "type", "tail", "confidence"} — the exact shapes the KG builder
    reads. Names are qualified by file path so a re-ingest MERGEs onto the same
    nodes rather than spawning duplicates.

    Robust by design: a syntax error in ONE file is logged and skipped, never
    aborting the whole repo. Non-`.py` files are skipped. The file list is
    capped at _MAX_FILES (logged, never silent).
    """
    # ── First pass: collect every Python file, build the symbol universe ──
    py_files: list[dict] = []
    for f in files or []:
        path = (f.get("path") or "").strip()
        if not path or not path.endswith(".py"):
            continue
        py_files.append({"path": path, "content": f.get("content") or ""})

    if len(py_files) > _MAX_FILES:
        logger.warning(
            "parse_python_repo: %d .py files exceeds cap %d — truncating "
            "(remaining %d files NOT parsed)",
            len(py_files), _MAX_FILES, len(py_files) - _MAX_FILES,
        )
        py_files = py_files[:_MAX_FILES]

    entities: list[dict] = []
    relations: list[dict] = []
    seen_entities: set[str] = set()  # entity name -> dedup across files
    seen_relations: set[tuple[str, str, str]] = set()

    # Global indexes built across ALL files in pass 1, used in pass 2 to resolve
    # call/inherit targets to known nodes (best-effort, intra-repo only):
    #   func_by_simple[bare_name]   -> [qualified function names]
    #   class_by_simple[ClassName]  -> [qualified class names]
    #   methods_by_class[qual_cls]  -> {method_name: qualified method name}
    func_by_simple: dict[str, list[str]] = {}
    class_by_simple: dict[str, list[str]] = {}
    methods_by_class: dict[str, dict[str, str]] = {}

    # Per-file parsed trees kept for the second (relation) pass so we parse once.
    parsed: list[tuple[str, ast.AST]] = []
    skipped_files = 0

    def _add_entity(name: str, etype: str, label: str) -> None:
        if name in seen_entities:
            return
        seen_entities.add(name)
        entities.append({
            "text": name,
            "type": etype,
            "coarse_type": _CODE_COARSE,
            "label": label,
        })

    def _add_relation(head: str, rel_type: str, tail: str) -> None:
        key = (head, rel_type, tail)
        if head == tail or key in seen_relations:
            return
        seen_relations.add(key)
        # Code structure is deterministic ground truth — full confidence.
        relations.append({
            "head": head,
            "type": rel_type,
            "tail": tail,
            "confidence": 1.0,
        })

    # ── Pass 1: parse each file, emit File/Class/Function entities + index ──
    for f in py_files:
        path = f["path"]
        try:
            tree = ast.parse(f["content"], filename=path)
        except (SyntaxError, ValueError) as exc:
            # A single un-parseable file must NOT abort the repo (it may be
            # Python 2, a template, or genuinely broken). Log and move on.
            skipped_files += 1
            logger.warning("parse_python_repo: skipping %s — %s", path, exc)
            continue

        parsed.append((path, tree))

        # File entity — name IS the path (e.g. "src/foo.py").
        _add_entity(path, "file", path)

        # Walk only the TOP-LEVEL body so File CONTAINS top-level defs and
        # Class CONTAINS its own methods (nesting handled explicitly).
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                fq = f"{path}::{node.name}"
                _add_entity(fq, "function", node.name)
                func_by_simple.setdefault(node.name, []).append(fq)
            elif isinstance(node, ast.ClassDef):
                cls_fq = f"{path}::{node.name}"
                _add_entity(cls_fq, "class", node.name)
                class_by_simple.setdefault(node.name, []).append(cls_fq)
                methods_by_class.setdefault(cls_fq, {})
                # Methods: name = path::ClassName.method
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        m_fq = f"{path}::{node.name}.{item.name}"
                        _add_entity(m_fq, "function", item.name)
                        methods_by_class[cls_fq][item.name] = m_fq
                        # also reachable by bare name for cross-file call resolve
                        func_by_simple.setdefault(item.name, []).append(m_fq)

    # ── Pass 2: relations (CONTAINS / IMPORTS / INHERITS / CALLS) ──
    for path, tree in parsed:
        for node in tree.body:
            # --- imports: File IMPORTS Module ---
            if isinstance(node, ast.Import):
                for alias in node.names:
                    mod = alias.name
                    if mod:
                        _add_entity(mod, "module", mod)
                        _add_relation(path, "IMPORTS", mod)
            elif isinstance(node, ast.ImportFrom):
                # `from y import z` — record the module `y`. Relative imports
                # (node.level > 0, e.g. `from . import x`) have module=None; we
                # punt on resolving those to a repo path and skip rather than
                # invent a node.
                if node.module and node.level == 0:
                    _add_entity(node.module, "module", node.module)
                    _add_relation(path, "IMPORTS", node.module)

            # --- top-level function: File CONTAINS function, + its calls ---
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                fq = f"{path}::{node.name}"
                _add_relation(path, "CONTAINS", fq)
                _emit_calls(fq, node, None, path,
                            func_by_simple, methods_by_class, _add_relation)

            # --- class: File CONTAINS class, class INHERITS bases, methods ---
            elif isinstance(node, ast.ClassDef):
                cls_fq = f"{path}::{node.name}"
                _add_relation(path, "CONTAINS", cls_fq)

                # INHERITS — resolve each base to a known repo class (best-effort).
                for base in node.bases:
                    base_name = _base_name(base)
                    if not base_name:
                        continue
                    target = _resolve_class(base_name, class_by_simple)
                    if target:
                        _add_relation(cls_fq, "INHERITS", target)

                # Methods: Class CONTAINS method, method CALLS ...
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        m_fq = f"{path}::{node.name}.{item.name}"
                        _add_relation(cls_fq, "CONTAINS", m_fq)
                        _emit_calls(m_fq, item, cls_fq, path,
                                    func_by_simple, methods_by_class, _add_relation)

    if skipped_files:
        logger.info("parse_python_repo: skipped %d unparseable file(s)", skipped_files)
    logger.info(
        "parse_python_repo: %d files -> %d entities, %d relations",
        len(parsed), len(entities), len(relations),
    )
    return entities, relations


# ── helpers ───────────────────────────────────────────────────────────────


def _base_name(node: ast.expr) -> Optional[str]:
    """Best-effort name for a base class / call target expression.

    Returns the bare identifier for `Foo`, the attribute tail for `mod.Foo`
    (-> "Foo") or `self.method` (handled by caller). None for anything we can't
    name (subscripts, calls, etc.) so the caller skips it rather than inventing.
    """
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _resolve_class(name: str, class_by_simple: dict[str, list[str]]) -> Optional[str]:
    """Resolve a bare class name to a qualified repo class, if UNAMBIGUOUS.

    Only resolves when exactly one repo class carries that name — multiple
    same-named classes across files are ambiguous, so we skip rather than guess.
    """
    candidates = class_by_simple.get(name)
    if candidates and len(candidates) == 1:
        return candidates[0]
    return None


def _emit_calls(
    caller_fq: str,
    fn_node: ast.AST,
    class_fq: Optional[str],
    path: str,
    func_by_simple: dict[str, list[str]],
    methods_by_class: dict[str, dict[str, str]],
    add_relation,
) -> None:
    """Walk a function body and emit `caller CALLS callee` for resolvable calls.

    Resolution is best-effort and intra-repo only:
      * bare call `foo()`         -> the unique repo function/method named `foo`
      * `self.method()`           -> a method on the SAME class (when class_fq given)
    Unresolvable calls (external libs, dynamic dispatch, attribute chains on
    other objects, ambiguous names) are SKIPPED — we never invent a node.
    """
    for sub in ast.walk(fn_node):
        if not isinstance(sub, ast.Call):
            continue
        func = sub.func

        # self.method(...) — resolve against the enclosing class's own methods.
        if (
            class_fq is not None
            and isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "self"
        ):
            target = methods_by_class.get(class_fq, {}).get(func.attr)
            if target:
                add_relation(caller_fq, "CALLS", target)
            continue

        # bare name call foo(...) — resolve to a unique repo function by name.
        if isinstance(func, ast.Name):
            candidates = func_by_simple.get(func.id)
            if candidates and len(candidates) == 1:
                add_relation(caller_fq, "CALLS", candidates[0])
            # ambiguous / unknown -> skip (do not invent a node)
            continue

        # mod.func(...) / obj.method(...) — only resolve if the bare attribute
        # name uniquely identifies one repo function; otherwise skip. This is
        # conservative on purpose (avoids wiring every `.append`/`.get` call).
        if isinstance(func, ast.Attribute):
            candidates = func_by_simple.get(func.attr)
            if candidates and len(candidates) == 1:
                add_relation(caller_fq, "CALLS", candidates[0])
            continue

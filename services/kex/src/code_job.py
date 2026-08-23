"""Codebase KB worker path (P1a).

Turns an IndexBatch (spec §10) into the entity/relation dict contract that
KGBuilder.build_graph already understands, with extra per-node/per-edge `props`,
and orchestrates: purge owned edges of changed files -> write graph -> drop stale
symbols by uri set-difference -> re-embed and store one chunk per symbol.

Fully LOCAL and deterministic except embeddings. Zero LLM calls.

CYTHON NOTE: the prod kex build is Cython-compiled - no bare dict/list/set
annotations on params or locals in this module.
"""

import logging
import time

from .kg_builder import entity_uri

logger = logging.getLogger(__name__)

CODE_COARSE = "code"
MAX_CHUNK_CHARS = 2000
_SYMBOL_PROP_KEYS = ("line_start", "line_end", "signature", "doc", "exported", "lang")


def _symbol_props(sym, repo_name, file_path, lang):
    props = {"_repo": repo_name, "_file": sym.get("file") or file_path, "lang": sym.get("lang") or lang}
    for k in _SYMBOL_PROP_KEYS:
        v = sym.get(k)
        if v is not None and k not in props:
            props[k] = v
    if sym.get("doc") is not None:
        props["doc"] = str(sym.get("doc"))[:300]
    if sym.get("signature") is not None:
        props["signature"] = str(sym.get("signature"))[:500]
    return props


def build_entities_relations(payload):
    """IndexBatch -> (entities, relations, keep_uris_per_changed_file)."""
    user_id = payload.get("user_id", "")
    repo = payload.get("repo") or {}
    repo_name = repo.get("name") or "repo"
    entities = []
    relations = []
    by_key = {}
    keep = {}

    def add_entity(name, etype, props):
        key = (name, etype)
        existing = by_key.get(key)
        if existing is not None:
            # Merge, but never let a stub (no line_start) erase a real symbol's
            # richer props that arrived earlier in the batch from another file.
            ex_props = existing["props"]
            if "line_start" in ex_props and "line_start" not in props:
                return
            for k, v in props.items():
                if v is not None:
                    ex_props[k] = v
            return
        entity = {"text": name, "type": etype, "coarse_type": CODE_COARSE,
                  "label": etype, "props": props}
        by_key[key] = entity
        entities.append(entity)

    # Repo node (one per batch; MERGE keeps it single per user+name).
    add_entity(repo_name, "repo", {
        "_repo": repo_name, "commit": repo.get("commit") or "", "root": repo.get("root") or "",
        "indexed_at": int(time.time() * 1000),
    })

    for f in payload.get("files") or []:
        path = f.get("path") or ""
        if not path:
            continue
        lang = f.get("lang") or "other"
        file_keep = set()
        # File node: sha256 lives here (manifest reads it).
        add_entity(path, "file", {"_repo": repo_name, "_file": path, "lang": lang,
                                  "sha256": f.get("sha256") or ""})
        file_keep.add(entity_uri(user_id, "file", path))
        relations.append({"head": repo_name, "type": "CONTAINS", "tail": path, "confidence": 1.0,
                          "props": {"_repo": repo_name, "_file": path, "resolution": "syntax"}})

        for sym in f.get("symbols") or []:
            name = sym.get("name") or ""
            kind = sym.get("kind") or "function"
            if not name or kind == "file":
                continue
            if kind == "module":
                add_entity(name, "module", {"_repo": repo_name, "lang": lang})
                continue
            add_entity(name, kind, _symbol_props(sym, repo_name, path, lang))
            if not sym.get("stub"):
                file_keep.add(entity_uri(user_id, kind, name))

        for e in f.get("edges") or []:
            head, tail, rtype = e.get("head") or "", e.get("tail") or "", e.get("type") or ""
            if not head or not tail or not rtype or head == tail:
                continue
            # NOTE: unresolved IMPORTS targets arrive as explicit {"kind":"module"} symbols
            # from the indexer (contract §10) - no guessing here.
            relations.append({
                "head": head, "type": rtype, "tail": tail,
                "confidence": float(e.get("confidence", 1.0)),
                "props": {"_repo": repo_name, "_file": path,
                          "resolution": e.get("resolution") or "syntax"},
            })
        keep[path] = file_keep
    return entities, relations, keep


def build_chunk_dicts(file_obj, user_id):
    """One store_chunks-compatible chunk per symbol chunk; mentions link the symbol uri."""
    chunks = []
    mentions = []
    for i, c in enumerate(file_obj.get("chunks") or []):
        content = (c.get("content") or "")[:MAX_CHUNK_CHARS]
        if not content.strip():
            continue
        sym_name = c.get("symbol") or file_obj.get("path") or ""
        kind = c.get("kind") or "function"
        chunks.append({"content": content, "start_char": 0, "end_char": len(content),
                       "chunk_sequence": len(chunks)})
        mentions.append([{"text": sym_name, "type": kind, "label": kind,
                          "uri": entity_uri(user_id, kind, sym_name)}])
    return chunks, mentions


def run_code_job(payload, kg, vs, embedder, classification):
    """Orchestrate one code job. Returns the result dict written to jobs.result."""
    job_id = payload.get("job_id", "unknown")
    user_id = payload.get("user_id", "system")
    compilation_id = payload.get("compilation_id")
    repo = payload.get("repo") or {}
    repo_name = repo.get("name") or "repo"
    files = payload.get("files") or []
    removed = [p for p in (payload.get("removed") or []) if p]
    changed_paths = [f.get("path") for f in files if f.get("path")]
    all_paths = changed_paths + [p for p in removed if p not in changed_paths]
    warnings = []

    # 1) Purge owned edges + chunks of every touched file (changed and removed).
    edges_purged = kg.purge_code_file_edges(user_id, repo_name, all_paths) if all_paths else 0
    chunks_purged = vs.delete_chunks_by_source(user_id, compilation_id, all_paths) if all_paths else {"pg_deleted": 0}
    # 2) Removed files: every symbol goes.
    symbols_purged = 0
    for p in removed:
        symbols_purged += kg.purge_code_symbols(user_id, repo_name, p, [])

    # 3) Write the fresh graph.
    entities, relations, keep = build_entities_relations(payload)
    stats = {"entities_created": 0, "relations_created": 0, "nodes_total": 0, "graph_uris": []}
    if files:
        stats = kg.build_graph(job_id, user_id, entities, relations,
                               classification=classification, origin=repo_name)
        # 4) Changed files: drop symbols that did not come back.
        for p in changed_paths:
            symbols_purged += kg.purge_code_symbols(user_id, repo_name, p, sorted(keep.get(p, set())))

    # 5) Chunks: embed + store per file (non-fatal).
    chunks_created = chunks_embedded = chunks_stored = 0
    for f in files:
        chunks, mentions = build_chunk_dicts(f, user_id)
        if not chunks:
            continue
        chunks_created += len(chunks)
        try:
            embeddings = embedder.embed_batch([c["content"] for c in chunks])
            chunks_embedded += sum(1 for v in embeddings if v is not None)
            chunks_stored += vs.store_chunks(
                chunks, embeddings, job_id, user_id,
                compilation_id=compilation_id, entity_mentions=mentions,
                source_document_id=f.get("path"), classification=classification,
            )
        except Exception as exc:  # noqa: BLE001 - chunks are non-fatal like the text pipeline
            logger.warning(f"[{job_id}] code chunks for {f.get('path')} failed: {exc}")
            warnings.append(f"chunks for {f.get('path')} not stored")

    result = {
        "job_id": job_id,
        "status": "completed",
        "repo": repo_name,
        "commit": repo.get("commit"),
        "files_indexed": len(changed_paths),
        "files_removed": len(removed),
        "symbols": sum(len(f.get("symbols") or []) for f in files),
        "edges": sum(len(f.get("edges") or []) for f in files),
        "edges_purged": edges_purged,
        "symbols_purged": symbols_purged,
        "chunks_purged": chunks_purged.get("pg_deleted", 0),
        "graph_stats": {k: v for k, v in stats.items() if k != "graph_uris"},
        "vector_stats": {"chunks_created": chunks_created, "chunks_embedded": chunks_embedded,
                         "chunks_stored": chunks_stored},
    }
    if warnings:
        result["degraded"] = True
        result["warning"] = "; ".join(warnings)
    return result

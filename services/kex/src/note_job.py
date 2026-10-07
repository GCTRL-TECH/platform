"""Note jobs: store short, already-distilled text as retrievable chunks WITHOUT
entity extraction.

Used for project lessons (``kind='lesson'``): conventions, recipes, pitfalls and
decisions that Anvil distils from chat and terminal sessions. A lesson is a
procedure, not a set of facts about people or companies — running it through
NER/RelEx would shred it into entities and, worse, feed unconfirmed text into
the entity graph that the wiki LLM writes pages from. Stored as a plain chunk it
stays whole, is found by semantic and lexical search, and takes part in the
Hebbian hot/cold layer (heat, decay, eviction, revival) like any chunk.

CYTHON NOTE: the prod build is Cython-compiled, where dict/list annotations
enforce exact types. Locals and params here are deliberately unannotated.
"""

import logging

logger = logging.getLogger(__name__)

LESSON_TYPES = ("convention", "recipe", "pitfall", "decision")

TYPE_LABEL = {
    "convention": "Konvention",
    "recipe": "Rezept",
    "pitfall": "Falle",
    "decision": "Entscheidung",
}


def lesson_content(meta):
    """The searchable text of a lesson: type, title, body and evidence in one
    short paragraph, so a search for the problem finds the lesson."""
    label = TYPE_LABEL.get(meta.get("lessonType"), "Lehre")
    title = (meta.get("title") or "").strip()
    body = (meta.get("text") or "").strip()
    evidence = (meta.get("evidence") or "").strip()
    head = f"Lehre ({label}): {title}" if title else f"Lehre ({label})"
    parts = [head, body]
    if evidence:
        parts.append(f"Beleg: {evidence}")
    return "\n".join(p for p in parts if p)


def run_note_job(payload, vector_store, embedder, classification):
    """Embed and store one note. Returns the job result dict."""
    job_id = payload.get("job_id", "unknown")
    user_id = payload.get("user_id", "system")
    kind = payload.get("kind") or "note"
    meta = payload.get("meta") or {}
    text = lesson_content(meta) if kind == "lesson" else (payload.get("input") or "").strip()
    if not text:
        return {"job_id": job_id, "status": "completed", "chunks": 0, "warning": "empty note"}

    chunk = {"content": text, "start_char": 0, "end_char": len(text), "chunk_sequence": 0}
    vectors = embedder.embed_batch([text])
    stored = vector_store.store_chunks(
        [chunk],
        vectors,
        job_id,
        user_id,
        compilation_id=None,
        entity_mentions=[[]],
        source_document_id=payload.get("source_document_id"),
        classification=classification,
        kind=kind,
        meta=meta,
    )
    result = {"job_id": job_id, "status": "completed", "chunks": stored, "kind": kind,
              "entities": 0, "relationships": 0}
    if vectors and vectors[0] is None:
        result["warning"] = "No embedding was produced — the note is only found by keyword search."
    logger.info(f"[{job_id}] note ({kind}) stored: {stored} chunk(s)")
    return result

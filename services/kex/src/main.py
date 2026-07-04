"""
KEX Service - FastAPI Server + Redis Job Consumer
Provides HTTP endpoints for direct extraction calls and a background
thread that processes jobs pushed to the Redis 'kex:jobs' queue.

Endpoints:
  POST /extract   - Run extraction pipeline on raw text
  POST /upload    - Run extraction pipeline on an uploaded file
  GET  /health    - Service and dependency health check
"""

import json
import logging
import os
import threading
import time
import traceback
from contextlib import asynccontextmanager
from typing import Optional

import redis as redis_lib
import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from qdrant_client import QdrantClient
from qdrant_client.http.exceptions import UnexpectedResponse
from qdrant_client.models import (
    Filter, FieldCondition, MatchValue, Range, IsEmptyCondition, PayloadField,
)

from . import config
from .chunking import get_chunker
from .classification import resolve_classification
from .code_parser import parse_python_repo
from .embedding import get_embedding_client, build_embedding_client
from .entity_verify import verify_entities
from .kg_builder import get_kg_builder, entity_uri
from .middleware.license_check import check_credits, report_usage
from .ner import get_ner_pipeline
from .pii_detector import detect_pii, redact_pii
from .relex import get_extractor
from . import reranker
from .sources.file_handler import extract_text
from .sources.url_handler import extract_from_url, crawl_website
from .sources.sharepoint_handler import fetch_sharepoint_file
from .sources.obsidian_handler import fetch_note
from .timeutil import iso_to_ms
from .vector_store import get_vector_store
from .reindex_worker import drain_reindex_queue

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ── Redis client (module-level, re-used by worker thread) ────────────

_redis_client: Optional[redis_lib.Redis] = None


def get_redis() -> Optional[redis_lib.Redis]:
    global _redis_client
    if _redis_client is None:
        try:
            _redis_client = redis_lib.from_url(
                config.REDIS_URL,
                decode_responses=True,
                socket_connect_timeout=5,
            )
            _redis_client.ping()
            logger.info(f"Redis connected: {config.REDIS_URL}")
        except Exception as exc:
            logger.warning(f"Redis not available: {exc}")
            _redis_client = None
    return _redis_client


# ── Qdrant client (module-level, re-used by /search handler) ─────────

_qdrant_client: Optional[QdrantClient] = None


def get_qdrant_client() -> Optional[QdrantClient]:
    global _qdrant_client
    if _qdrant_client is None:
        try:
            _qdrant_client = QdrantClient(url=config.QDRANT_URL)
            logger.info(f"Qdrant client initialized: {config.QDRANT_URL}")
        except Exception as exc:
            logger.warning(f"Qdrant not available: {exc}")
            _qdrant_client = None
    return _qdrant_client


# ── PostgreSQL client (module-level, re-used by lexical /search) ─────
# Separate, autocommit, read-only connection so the lexical (BM25) channel of
# hybrid retrieval never contends with the dual-write store's transactional conn.

import psycopg2 as _psycopg2  # noqa: E402  (kept local to the search subsystem)

_pg_search_conn = None


def get_search_pg():
    """Lazy autocommit psycopg2 connection used only for lexical chunk search.
    Returns None if Postgres is unreachable (lexical channel degrades to empty,
    dense still answers)."""
    global _pg_search_conn
    if _pg_search_conn is not None:
        try:
            with _pg_search_conn.cursor() as cur:
                cur.execute("SELECT 1")
            return _pg_search_conn
        except Exception:
            _pg_search_conn = None
    try:
        conn = _psycopg2.connect(config.PG_URL, connect_timeout=5)
        conn.autocommit = True
        _pg_search_conn = conn
        logger.info("Lexical search: PostgreSQL connected")
    except Exception as exc:
        logger.warning(f"Lexical search: PostgreSQL unavailable: {exc}")
        _pg_search_conn = None
    return _pg_search_conn


# ── Core extraction pipeline ─────────────────────────────────────────

def run_pipeline(
    text: str,
    job_id: str,
    user_id: str,
    entity_types: list[str] | None = None,
    auto_redact: bool = False,
    classification_level_id: str | None = None,
    classification_name: str | None = None,
    origin: str | None = None,
    source_document_id: str | None = None,
    source_modified_at: str | None = None,
    ollama_base: str | None = None,
    embedding_base_url: str | None = None,
    embedding_provider: str | None = None,
    embedding_model: str | None = None,
    relex_model: str | None = None,
    generation_kind: str = "ollama",
    generation_base: str | None = None,
    generation_api_key: str | None = None,
) -> dict:
    """
    Full extraction pipeline: NER -> RelEx -> KG Builder -> Chunking -> Embedding -> Vector Store.
    Returns a result dict suitable for direct HTTP response or Redis publish.

    `classification_*` carry the ISO 27001 level chosen at ingest; every graph
    element and chunk is tagged with it for per-element access control.

    `source_document_id` / `source_modified_at` (P2b) are the stable document
    identity + source-side modified time resolved by the API from (user, path).
    They are threaded into every relation edge (`_source_doc`,
    `_source_doc_modified_at`) and every stored chunk (`source_document_id`) so
    a later phase can rank fact authority by source recency. Both are optional
    and default to None — absent fields behave exactly as before this feature.

    `ollama_base` / `embedding_base_url` / `embedding_provider` are optional
    per-job overrides for the LLM + embedding endpoints (the owner's runtime
    Settings → Infrastructure base URL, passed through by the API). When absent
    the env-based `config.*` defaults are used, so the default install is
    unchanged and KEX never crashes on a missing/empty value.
    """
    logger.info(f"[{job_id}] Pipeline start — {len(text)} chars")

    # Resolve the ingest classification once ({id, name, rank}); defaults PUBLIC.
    classification = resolve_classification(classification_level_id, classification_name)
    logger.info(f"[{job_id}] Classification: {classification['name']} (rank {classification['rank']})")

    # 0. PII detection / redaction — runs before NER so sensitive values are never extracted
    pii_findings: dict = {}
    try:
        if auto_redact:
            text, pii_findings = redact_pii(text)
            if pii_findings.get("has_pii"):
                logger.info(f"[{job_id}] PII redacted: {pii_findings['total_count']} occurrences")
        else:
            pii_findings = detect_pii(text)
            if pii_findings.get("has_pii"):
                logger.info(f"[{job_id}] PII detected (not redacted): {pii_findings['total_count']} occurrences")
    except Exception as exc:
        logger.warning(f"[{job_id}] PII detection failed (non-fatal): {exc}")

    # 1. Named Entity Recognition (GLiNER zero-shot). The GPU/CPU-bound inference
    # is serialized INSIDE the NER pipeline at chunk granularity, so a large
    # document yields the lock between chunks instead of blocking the whole
    # worker pool for minutes (no doc-level lock held here anymore).
    ner = get_ner_pipeline()
    entities = ner.extract_entities(text, entity_types=entity_types)
    logger.info(f"[{job_id}] NER: {len(entities)} entities")

    # 2. Relation Extraction (Ollama HTTP — can run in parallel)
    # Resilient: a failure of the LLM (Ollama down / crash / timeout / 5xx) MUST
    # NOT fail the whole job. We keep the entities already extracted by NER and
    # complete the extraction as a successful-but-degraded result (no relations),
    # surfacing a concise human-readable warning the dashboard can show.
    warnings: list[str] = []
    extraction_report = None
    relex = get_extractor()
    try:
        # Use generation_base for the generation step when provided;
        # otherwise fall through to ollama_base (default install unchanged).
        relex_base = generation_base if generation_base else ollama_base
        relex_result = relex.extract_relations(
            text, entities,
            ollama_base=relex_base,
            model=relex_model,
            kind=generation_kind,
            api_key=generation_api_key,
        )
        # extract_relations returns (relations, report) tuple.
        if isinstance(relex_result, tuple) and len(relex_result) == 2:
            relations, extraction_report = relex_result
        else:
            # Defensive: older cached singleton or unexpected shape.
            relations = relex_result if isinstance(relex_result, list) else []
        if getattr(relex, "last_degraded", False) and relex.last_degraded_reason:
            warnings.append(relex.last_degraded_reason)
            logger.warning(f"[{job_id}] RelEx degraded: {relex.last_degraded_reason}")
    except Exception as exc:
        logger.warning(f"[{job_id}] RelEx failed (non-fatal, continuing with entities only): {exc}")
        relations = []
        warnings.append(
            "Relation extraction skipped — LLM unavailable. Connect a working "
            "Ollama in Settings → Infrastructure to enable relation extraction."
        )
    logger.info(f"[{job_id}] RelEx: {len(relations)} relations")

    # 2b. Entity Verify/Retype (opt-in precision tier, config.ENTITY_VERIFY_ENABLED).
    # Runs AFTER NER+RelEx (reuses the SAME resolved generation runtime as relex —
    # relex_base/relex_model/generation_kind/generation_api_key) and BEFORE the
    # KG builder / chunk mapping, so a dropped-junk or retyped entity is reflected
    # everywhere downstream. GLiNER remains the only span producer: this tier can
    # only drop or retype a candidate, never invent one. Failure-safe — any error
    # leaves `entities` unchanged.
    entity_verify_report = None
    if config.ENTITY_VERIFY_ENABLED:
        try:
            verify_model = config.ENTITY_VERIFY_MODEL or relex_model or config.RELEX_MODEL
            entities, entity_verify_report = verify_entities(
                entities, text,
                model=verify_model,
                base=relex_base,
                kind=generation_kind,
                api_key=generation_api_key,
            )
            logger.info(f"[{job_id}] Entity verify: {entity_verify_report}")
        except Exception as exc:
            logger.warning(f"[{job_id}] Entity verify failed (non-fatal, entities unchanged): {exc}")

    # 3. Write to Knowledge Graph
    # Origin provenance for A2 dossiers: prefer the caller-supplied source (file
    # name / note path); fall back to a short preview of the extracted text so a
    # dossier can always cite where a fact came from.
    if not origin:
        preview = " ".join(text[:120].split())
        origin = (preview + "…") if len(text) > 120 else preview
    source_modified_at_ms = iso_to_ms(source_modified_at)
    kg = get_kg_builder()
    stats = kg.build_graph(
        job_id, user_id, entities, relations,
        classification=classification, origin=origin,
        source_document_id=source_document_id,
        source_modified_at_ms=source_modified_at_ms,
    )
    logger.info(f"[{job_id}] KG: {stats}")

    # 3b. Annotate each entity mention with its graph URI (P2a — grounded nodes).
    # Recomputes via the SAME pure fn kg_builder used to write the node, so a
    # mention's uri always matches the node actually in Neo4j. Entities pruned
    # from the graph (GRAPH_PRUNE_ISOLATED — isolated non-core concepts) get no
    # uri here; they're marked `pruned` instead so a grounding lookup never
    # points at a node that doesn't exist. Additive-only: existing readers of
    # `entities`/`entity_mentions` that don't know about `uri`/`pruned` are
    # unaffected.
    graph_uris = set(stats.get("graph_uris") or [])
    for mention in entities:
        mention_name = (mention.get("text") or "").strip()
        if not mention_name:
            continue
        mention_type = mention.get("type") or mention.get("coarse_type") or "other"
        mention_uri = entity_uri(user_id, mention_type, mention_name)
        if mention_uri in graph_uris:
            mention["uri"] = mention_uri
        else:
            mention["pruned"] = True

    # 4. Chunk text for vector store
    logger.info(f"[{job_id}] Chunker: starting on {len(text)} chars")
    chunker = get_chunker()
    try:
        chunks = chunker.chunk(text)
    except Exception as exc:
        logger.error(f"[{job_id}] Chunker FAILED: {exc}", exc_info=True)
        chunks = [{"content": text[:8000], "start_char": 0, "end_char": min(8000, len(text)), "chunk_sequence": 0}]
    logger.info(f"[{job_id}] Chunked: {len(chunks)} chunks")

    # 5. Embed chunks (graceful degradation: failed embeddings become None)
    embedder = build_embedding_client(
        embedding_base_url=embedding_base_url,
        embedding_provider=embedding_provider,
        ollama_base=ollama_base,
        embedding_model=embedding_model,
    )
    embeddings = embedder.embed_batch([c["content"] for c in chunks])
    successful_embeddings = sum(1 for v in embeddings if v is not None)
    logger.info(f"[{job_id}] Embedded: {successful_embeddings}/{len(embeddings)} vectors")

    # 6. Map entity mentions to chunks by character offset
    chunk_entities: list[list[dict]] = []
    for chunk in chunks:
        mentions = [
            e for e in entities
            if (
                isinstance(e.get("start"), int)
                and isinstance(e.get("end"), int)
                and e["start"] >= chunk["start_char"]
                and e["end"] <= chunk["end_char"]
            )
        ]
        chunk_entities.append(mentions)

    # 7. Store in Qdrant + PostgreSQL (graceful degradation: unavailability is logged, not fatal)
    chunks_stored = 0
    try:
        vs = get_vector_store()
        chunks_stored = vs.store_chunks(
            chunks,
            embeddings,
            job_id,
            user_id,
            compilation_id=None,  # set later by API result handler
            entity_mentions=chunk_entities,
            source_document_id=source_document_id,
            classification=classification,
        )
        logger.info(f"[{job_id}] Vector store: {chunks_stored} chunks stored")
    except Exception as exc:
        logger.warning(f"[{job_id}] Vector store failed (non-fatal): {exc}")

    # A concise human-readable note for the dashboard when the extraction
    # completed but a step degraded (e.g. relation extraction skipped because the
    # LLM was unavailable). The job is still 'completed'/'success', not 'failed'.
    degraded = len(warnings) > 0
    warning_msg = None
    if degraded:
        warning_msg = (
            f"Extracted {len(entities)} entities; " + " ".join(warnings)
        )

    result = {
        "job_id": job_id,
        "status": "completed",
        "entities": entities,
        "relations": relations,
        "graph_stats": stats,
        "vector_stats": {
            "chunks_created": len(chunks),
            "chunks_embedded": successful_embeddings,
            "chunks_stored": chunks_stored,
        },
        "pii_findings": pii_findings,
    }
    if extraction_report is not None:
        result["extraction_report"] = extraction_report
    if entity_verify_report is not None:
        result["entity_verify_report"] = entity_verify_report
    if degraded:
        result["degraded"] = True
        result["warning"] = warning_msg
    return result


# ── Redis background worker ──────────────────────────────────────────

_worker_running = False
_worker_threads: list[tuple[threading.Thread, threading.Event]] = []
# NER inference is serialized inside src/ner.py (per-chunk), not here — so a
# single huge document can't hold a doc-level lock and stall the whole pool.


def _worker_loop(worker_id: int, stop_event: threading.Event) -> None:
    """
    Background thread: BLPOP from 'kex:jobs', process each job,
    publish result/error to 'kex:results'.

    Job payload (JSON string):
      { job_id: str, user_id: str, type: "text"|"url", input: str }
    """
    logger.info(f"KEX worker-{worker_id} started")

    while _worker_running and not stop_event.is_set():
        r = get_redis()
        if r is None:
            logger.warning("Worker: Redis unavailable, retrying in 5s")
            time.sleep(5)
            continue

        try:
            # BLPOP blocks for up to 2 seconds, then loops (allows clean shutdown)
            item = r.blpop("kex:jobs", timeout=2)
        except redis_lib.exceptions.ConnectionError:
            logger.warning("Worker: Redis connection lost, retrying in 5s")
            global _redis_client
            _redis_client = None  # force reconnect on next iteration
            time.sleep(5)
            continue
        except Exception as exc:
            logger.error(f"Worker: BLPOP error: {exc}")
            time.sleep(2)
            continue

        if item is None:
            # Timeout — just loop
            continue

        _queue_name, raw_payload = item
        logger.info(f"Worker: received job from queue")

        job_id = "unknown"
        try:
            payload = json.loads(raw_payload)
            job_id = payload.get("job_id", "unknown")
            user_id = payload.get("user_id", "system")
            job_type = payload.get("type", "text")
            job_input = payload.get("input", "")
            entity_types = payload.get("entity_types")  # from ontology, or None for defaults
            ontology_id = payload.get("ontology_id")  # write-back target: extend it with newly-seen types
            auto_redact = bool(payload.get("auto_redact", False))
            classification_name = payload.get("classification")            # level name (legacy field)
            classification_level_id = payload.get("classification_level_id")  # level UUID (preferred)
            # Optional per-job LLM/embedding endpoint overrides resolved by the API
            # from the owner's Settings → Infrastructure config. Absent/empty →
            # fall back to env-based config (default install unchanged).
            ollama_base = payload.get("ollama_base")
            embedding_base_url = payload.get("embedding_base_url")
            embedding_provider = payload.get("embedding_provider")
            # Per-purpose model choices (Settings → AI Models → Models). Absent →
            # the worker uses its env defaults (EMBEDDING_MODEL / RELEX_MODEL).
            embedding_model = payload.get("embedding_model")
            relex_model = payload.get("relex_model")
            # LLM runtime kind + optional API key for OpenAI-compatible providers.
            # Defaults to "ollama" so existing jobs are unchanged.
            generation_kind = payload.get("generation_kind") or "ollama"
            generation_api_key = payload.get("generation_api_key")
            generation_base = payload.get("generation_base")
            # P2b document identity, resolved by the API from (user, path):
            # the source_documents row id + the full source path + the
            # source-side modified time (when known). All optional — absent
            # (older jobs / direct KEX callers) behaves exactly as before.
            source_document_id = payload.get("source_document_id")
            source_path = payload.get("source_path")
            source_modified_at = payload.get("source_modified_at")

            # Authoritative state: write to Postgres BEFORE the fire-and-forget pubsub.
            _update_job_status(job_id, "processing")
            # Publish 'processing' status immediately so the UI shows it
            try:
                r.publish("kex:results", json.dumps({"job_id": job_id, "status": "processing"}))
            except Exception:
                pass  # non-fatal

            # Resolve text content based on job type. `origin` is the human-readable
            # source signal (file name / note path / URL) recorded on every node so
            # A2 dossiers can cite where a fact came from.
            origin: str | None = None
            crawled_urls: list[str] | None = None
            if job_type == "url":
                text = extract_from_url(job_input)
                origin = job_input if isinstance(job_input, str) else None
            elif job_type in ("crawl", "url_crawl"):
                # Website-crawl job: BOUNDED, same-domain BFS. `input` is the seed
                # URL (string) or a dict carrying url + crawl params. The Rust API
                # mirrors the text/url extract payload, so url/max_pages/max_depth
                # may live either at top level or inside `input`.
                inp = job_input if isinstance(job_input, dict) else {}
                seed_url = (inp.get("url") if isinstance(inp, dict) else None) or \
                    payload.get("url") or (job_input if isinstance(job_input, str) else "")
                max_pages = int(inp.get("max_pages") or payload.get("max_pages") or 1)
                max_depth = int(inp.get("max_depth") or payload.get("max_depth") or 2)
                logger.info(f"[{job_id}] Crawl start: {seed_url} (max_pages={max_pages}, max_depth={max_depth})")
                text, crawled_urls = crawl_website(seed_url, max_pages=max_pages, max_depth=max_depth)
                # Provenance: cite the crawled pages. Single page → that URL;
                # multi-page → seed plus a count so a dossier can attribute facts.
                if crawled_urls:
                    origin = crawled_urls[0] if len(crawled_urls) == 1 else \
                        f"{seed_url} (+{len(crawled_urls) - 1} more pages)"
                else:
                    origin = seed_url
                if not text or not text.strip():
                    logger.warning(f"[{job_id}] Crawl found no extractable content for {seed_url}")
            elif job_type == "text":
                text = job_input
            elif job_type == "file":
                # File uploaded as base64 JSON: {"fileBase64": "...", "mimetype": "...", "originalFilename": "..."}
                import base64
                file_data = json.loads(job_input)
                file_bytes = base64.b64decode(file_data["fileBase64"])
                mimetype = file_data.get("mimetype", "application/octet-stream")
                _fname = file_data.get("originalFilename") or file_data.get("fileName") or "document"
                text = extract_text(file_bytes, mimetype, filename=_fname)
                origin = file_data.get("originalFilename") or file_data.get("fileName")
                logger.info(f"[{job_id}] Extracted {len(text)} chars from file ({mimetype})")
            elif job_type == "kex_sharepoint":
                inp = payload.get("input", {})
                file_bytes, mimetype = fetch_sharepoint_file(
                    tenant_id=inp["tenantId"],
                    client_id=inp["clientId"],
                    client_secret=inp["clientSecret"],
                    drive_id=inp["driveId"],
                    item_id=inp["itemId"],
                )
                text = extract_text(file_bytes, mimetype, filename=inp.get("fileName") or "document")
                origin = inp.get("fileName")
                logger.info(f"[{job_id}] SharePoint: extracted {len(text)} chars from {inp.get('fileName','<unknown>')} ({mimetype})")
            elif job_type == "kex_obsidian":
                inp = payload.get("input", {})
                text = fetch_note(
                    vault_url=inp["vaultUrl"],
                    api_token=inp.get("apiToken"),
                    note_path=inp["notePath"],
                )
                origin = inp.get("notePath")
                logger.info(f"[{job_id}] Obsidian: extracted {len(text)} chars from {inp.get('notePath','<unknown>')}")
            else:
                raise ValueError(f"Unknown job type: {job_type}")

            # P2b: prefer the FULL source path (resolved server-side by the
            # API) over the bare file/note name each job_type branch set
            # above — origin should cite the whole path, not just the name.
            if source_path:
                origin = source_path

            # A crawl (or any source) that found nothing extractable completes as
            # a clear, successful "no content" result — NOT a hard failure.
            if job_type in ("crawl", "url_crawl") and (not text or not text.strip()):
                empty_result = {
                    "job_id": job_id,
                    "status": "completed",
                    "entities": [],
                    "relations": [],
                    "graph_stats": {},
                    "vector_stats": {"chunks_created": 0, "chunks_embedded": 0, "chunks_stored": 0},
                    "pii_findings": {},
                    "degraded": True,
                    "warning": "Crawl found no extractable content (no readable pages on this domain).",
                    "crawled_urls": crawled_urls or [],
                }
                _publish_result(r, job_id, empty_result)
                continue

            check_result = check_credits("kex_extract", len(text))
            result = run_pipeline(
                text, job_id, user_id,
                entity_types=entity_types, auto_redact=auto_redact,
                classification_level_id=classification_level_id,
                classification_name=classification_name,
                origin=origin,
                source_document_id=source_document_id,
                source_modified_at=source_modified_at,
                ollama_base=ollama_base,
                embedding_base_url=embedding_base_url,
                embedding_provider=embedding_provider,
                embedding_model=embedding_model,
                relex_model=relex_model,
                generation_kind=generation_kind,
                generation_base=generation_base,
                generation_api_key=generation_api_key,
            )
            # Record crawl provenance on the result for the dashboard.
            if crawled_urls:
                result["crawled_urls"] = crawled_urls
            report_usage("kex_extract", len(text), check_result["credits_spent"])
            _extend_ontology(ontology_id, result)
            _publish_result(r, job_id, result)

        except Exception as exc:
            logger.error(f"Worker: job {job_id} failed: {exc}\n{traceback.format_exc()}")
            _publish_error(r, job_id, str(exc))

    logger.info(f"KEX worker-{worker_id} stopped")


def _update_job_status(job_id: str, status: str, result: dict | None = None, error: str | None = None) -> None:
    """Update jobs.status in Postgres directly. The api-rs read this column,
    so this is the authoritative status, not the redis pubsub."""
    try:
        import psycopg2
        conn = psycopg2.connect(config.PG_URL, connect_timeout=5)
        with conn:
            with conn.cursor() as cur:
                if status == "completed":
                    import json as _json
                    cur.execute(
                        "UPDATE jobs SET status='completed', result=%s::jsonb, completed_at=NOW(), updated_at=NOW() WHERE id=%s",
                        (_json.dumps(result or {}), job_id),
                    )
                elif status == "processing":
                    cur.execute(
                        "UPDATE jobs SET status='processing', updated_at=NOW() WHERE id=%s",
                        (job_id,),
                    )
                else:  # failed
                    cur.execute(
                        "UPDATE jobs SET status='failed', error=%s, completed_at=NOW(), updated_at=NOW() WHERE id=%s",
                        (error or "Unknown error", job_id),
                    )
        conn.close()
    except Exception as exc:
        logger.warning(f"Failed to update jobs.status for {job_id}: {exc}")


def _extend_ontology(ontology_id: str | None, result: dict) -> None:
    """Extend the resolved ontology in place with any newly-discovered entity types.

    Additive only: each distinct entity type found in this extraction is inserted
    if not already present (ON CONFLICT DO NOTHING) — existing types are never
    removed or renamed. This is how the shared default "General Knowledge" ontology
    grows as more documents are ingested, instead of a new ontology being created
    per run. No-op when there is no ontology target (e.g. anonymous extraction).
    """
    if not ontology_id:
        return

    # Distinct (name, qid) pairs from the extracted entities.
    seen: dict[str, str | None] = {}
    for ent in result.get("entities", []) or []:
        name = (ent.get("label") or "").strip()
        if not name:
            continue
        # First-seen QID wins; keep it stable.
        seen.setdefault(name, ent.get("type"))
    if not seen:
        return

    try:
        import psycopg2
        conn = psycopg2.connect(config.PG_URL, connect_timeout=5)
        with conn:
            with conn.cursor() as cur:
                for name, qid in seen.items():
                    cur.execute(
                        "INSERT INTO ontology_entity_types (ontology_id, qid, name, confidence_threshold) "
                        "VALUES (%s, %s, %s, 0.3) "
                        "ON CONFLICT (ontology_id, name) DO NOTHING",
                        (ontology_id, qid, name),
                    )
                # Keep the denormalized count + updated_at in sync.
                cur.execute(
                    "UPDATE ontologies SET "
                    "entity_type_count = (SELECT COUNT(*) FROM ontology_entity_types WHERE ontology_id = %s), "
                    "updated_at = NOW() WHERE id = %s",
                    (ontology_id, ontology_id),
                )
        conn.close()
    except Exception as exc:
        logger.warning(f"Failed to extend ontology {ontology_id}: {exc}")


def _publish_result(r: redis_lib.Redis, job_id: str, result: dict) -> None:
    # Authoritative state: write to Postgres BEFORE the fire-and-forget pubsub.
    _update_job_status(job_id, "completed", result=result)
    payload = json.dumps({
        "job_id": job_id,
        "status": "completed",
        "result": result,
    })
    try:
        r.publish("kex:results", payload)
    except Exception as exc:
        logger.error(f"Failed to publish result for {job_id}: {exc}")


def _publish_error(r: redis_lib.Redis, job_id: str, error: str) -> None:
    # Authoritative state: write to Postgres BEFORE the fire-and-forget pubsub.
    _update_job_status(job_id, "failed", error=error)
    payload = json.dumps({
        "job_id": job_id,
        "status": "failed",
        "error": error,
    })
    try:
        r.publish("kex:results", payload)
    except Exception as exc:
        logger.error(f"Failed to publish error for {job_id}: {exc}")


def _scale_workers(target: int) -> None:
    """Scale worker threads up or down to match target count."""
    global _worker_threads

    current = len(_worker_threads)
    if target == current:
        return

    if target > current:
        # Start new workers
        for i in range(current, target):
            stop_event = threading.Event()
            t = threading.Thread(target=_worker_loop, args=(i, stop_event), name=f"kex-worker-{i}", daemon=True)
            t.start()
            _worker_threads.append((t, stop_event))
        logger.info(f"Scaled workers: {current} → {target}")
    else:
        # Stop excess workers (from the end)
        for _ in range(current - target):
            if _worker_threads:
                t, stop_event = _worker_threads.pop()
                stop_event.set()
        logger.info(f"Scaled workers: {current} → {target}")


def _config_watcher() -> None:
    """Polls Redis for desired thread count and scales workers accordingly."""
    while _worker_running:
        try:
            r = get_redis()
            if r:
                val = r.get("kex:config:threads")
                if val:
                    desired = max(1, min(10, int(val)))
                    current = len(_worker_threads)
                    if desired != current:
                        _scale_workers(desired)
        except Exception:
            pass  # non-fatal
        time.sleep(10)


def _reindex_loop(stop_event: threading.Event) -> None:
    """Background thread: drain kex:reindex every 10 seconds.

    Runs independently of the kex:jobs worker pool so a large reindex
    does not starve incoming extraction jobs.
    """
    logger.info("KEX reindex loop started")
    while _worker_running and not stop_event.is_set():
        try:
            r = get_redis()
            if r is not None:
                count = drain_reindex_queue(
                    redis_client=r,
                    pg_url=config.PG_URL,
                    qdrant_url=config.QDRANT_URL,
                    collection=config.QDRANT_COLLECTION,
                )
                if count > 0:
                    logger.info(f"KEX reindex: processed {count} KB(s) this pass")
        except Exception as exc:
            logger.warning(f"KEX reindex loop error (non-fatal): {exc}")
        stop_event.wait(10)
    logger.info("KEX reindex loop stopped")


def start_worker() -> None:
    global _worker_running
    _worker_running = True

    # Start initial workers
    initial = config.WORKER_THREADS
    _scale_workers(initial)
    logger.info(f"KEX worker pool started ({initial} thread{'s' if initial > 1 else ''})")

    # Start config watcher
    watcher = threading.Thread(target=_config_watcher, name="kex-config-watcher", daemon=True)
    watcher.start()

    # Start reindex loop (drains kex:reindex, runs independently of extraction workers)
    reindex_stop = threading.Event()
    reindex_thread = threading.Thread(
        target=_reindex_loop,
        args=(reindex_stop,),
        name="kex-reindex-loop",
        daemon=True,
    )
    reindex_thread.start()
    _worker_threads.append((reindex_thread, reindex_stop))


def stop_worker() -> None:
    global _worker_running
    _worker_running = False
    for t, stop_event in _worker_threads:
        stop_event.set()
    for t, stop_event in _worker_threads:
        t.join(timeout=10)
    _worker_threads.clear()
    logger.info("KEX worker pool stopped")


# ── Lifespan (startup / shutdown) ────────────────────────────────────

# ── NER model warmup status (drives the dashboard "engine initialising" UI) ────
# The NER model (~1.5GB) downloads on first start. We load it in the BACKGROUND so
# the API serves immediately, expose progress via /model-status, and auto-retry a
# stalled/failed download. State: starting | downloading | loading | ready |
# retrying | error. `progress` is a best-effort 0..100 from the on-disk cache size.
_model_status = {"state": "starting", "progress": 0, "attempt": 0, "detail": ""}
_model_status_lock = threading.Lock()
# Best-effort total bytes of the NER model cache, for the progress bar.
_MODEL_EXPECTED_BYTES = 1_500_000_000


def _set_model_status(**kw):
    with _model_status_lock:
        _model_status.update(kw)


def get_model_status():
    with _model_status_lock:
        s = dict(_model_status)
    # The worker can lazy-load the model independently of warmup; reflect that.
    try:
        if get_ner_pipeline().is_loaded:
            s["state"] = "ready"
            s["progress"] = 100
    except Exception:
        pass
    return s


def _model_cache_bytes():
    base = os.environ.get("HF_HOME") or "/app/models"
    total = 0
    try:
        for root, _dirs, files in os.walk(base):
            for fn in files:
                try:
                    total += os.path.getsize(os.path.join(root, fn))
                except OSError:
                    pass
    except Exception:
        pass
    return total


def _model_progress_loop(stop_event):
    """Update `progress` from the growing cache while a download attempt runs."""
    while not stop_event.wait(2.0):
        pct = int(_model_cache_bytes() * 100 / _MODEL_EXPECTED_BYTES)
        pct = max(0, min(99, pct))
        cur = get_model_status()
        # Once bytes are basically all there but the call hasn't returned, we're in
        # the local load phase — show "loading" instead of a stuck 99%.
        new_state = "loading" if pct >= 98 and cur.get("state") == "downloading" else None
        if new_state:
            _set_model_status(progress=pct, state=new_state)
        else:
            _set_model_status(progress=pct)


def _warmup_model():
    """Download + load the NER model in the background, auto-retrying a stalled or
    failed download (HF_HUB_DOWNLOAD_TIMEOUT turns a stall into an exception, and
    huggingface_hub resumes partial files on the next attempt)."""
    max_attempts = 8
    for attempt in range(1, max_attempts + 1):
        _set_model_status(
            state=("downloading" if attempt == 1 else "retrying"),
            attempt=attempt,
            detail="",
        )
        stop = threading.Event()
        pt = threading.Thread(target=_model_progress_loop, args=(stop,), daemon=True)
        pt.start()
        try:
            get_ner_pipeline()._get_model()  # download (resumable) + local load
            stop.set()
            _set_model_status(state="ready", progress=100, detail="")
            logger.info("KEX NER model ready")
            return
        except Exception as exc:
            stop.set()
            logger.warning(f"KEX model init attempt {attempt}/{max_attempts} failed/stalled: {exc}")
            _set_model_status(state="retrying", detail=str(exc)[:200])
            time.sleep(min(5 * attempt, 30))
    _set_model_status(state="error", detail="model initialisation failed after retries")
    logger.error("KEX NER model failed to initialise after retries")


def _warmup_relation_model():
    """Proactively pull the relation-extraction model into Ollama in the BACKGROUND
    so the first PDF doesn't block on a multi-GB download. Best-effort and silent on
    failure: relex.py also self-heals (pull-on-demand) if this hasn't finished or was
    skipped. Honors OLLAMA_BASE."""
    import requests as _rq

    base = (config.OLLAMA_BASE or "").rstrip("/")
    model = config.RELEX_MODEL
    if not base or not model:
        return
    try:
        tags = _rq.get(f"{base}/api/tags", timeout=10)
        present = {m.get("name", "") for m in (tags.json().get("models") or [])} if tags.ok else set()
        if model in present:
            logger.info(f"KEX relation model '{model}' already present")
            return
        logger.info(f"KEX: pulling relation model '{model}' in background (one-time)…")
        r = _rq.post(f"{base}/api/pull", json={"name": model, "stream": False}, timeout=1800)
        if r.ok and "error" not in (r.text or "").lower():
            logger.info(f"KEX relation model '{model}' ready")
        else:
            logger.warning(f"KEX: background pull of '{model}' unconfirmed — relex will self-heal on demand")
    except Exception as exc:
        logger.warning(f"KEX: background relation-model pull skipped ({exc}); relex self-heals on demand")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("KEX service starting up...")

    # Eagerly connect to Neo4j so we fail fast if unavailable
    try:
        kg = get_kg_builder()
        kg.connect()
    except Exception as exc:
        logger.warning(f"Neo4j not available at startup: {exc}")

    # Warm up the NER model in the BACKGROUND so the API serves immediately (the
    # model is ~1.5GB on a fresh install). Progress + auto-retry are reported via
    # /model-status, which the dashboard polls to show an "engine initialising" UI.
    threading.Thread(target=_warmup_model, name="kex-model-warmup", daemon=True).start()

    # Proactively pull the relation-extraction model in the BACKGROUND so the first
    # extraction produces a LINKED graph without a multi-GB download mid-job. RelEx
    # also self-heals (pull-on-demand) if this is still running or was skipped.
    threading.Thread(target=_warmup_relation_model, name="kex-relmodel-warmup", daemon=True).start()

    # Ensure the Qdrant collection exists at startup (create-if-missing). This is
    # what makes a fresh install / post-purge work turnkey: without it the first
    # KEX extraction's vector upsert silently no-ops against a non-existent
    # collection and the RAG has nothing to retrieve. Idempotent + non-fatal.
    try:
        vs = get_vector_store()
        if vs._get_qdrant() is not None:
            logger.info(f"KEX: Qdrant collection '{config.QDRANT_COLLECTION}' ready")
        else:
            logger.warning("KEX: Qdrant unavailable at startup (collection deferred to first upsert)")
    except Exception as exc:
        logger.warning(f"KEX: Qdrant collection ensure failed at startup: {exc}")

    # Probe Redis and start background worker
    get_redis()
    start_worker()

    logger.info("KEX service ready")
    yield

    # Shutdown
    logger.info("KEX service shutting down...")
    stop_worker()
    get_kg_builder().close()
    logger.info("KEX service stopped")


# ── FastAPI app ───────────────────────────────────────────────────────

app = FastAPI(
    title="Databorg KEX Service",
    version="1.0.0",
    description="Knowledge Extraction: NER + Relation Extraction + Neo4j graph writing",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


from fastapi.responses import JSONResponse


@app.exception_handler(PermissionError)
async def permission_error_handler(request, exc):
    return JSONResponse(status_code=402, content={"error": str(exc), "code": "INSUFFICIENT_CREDITS"})


# ── Request / Response models ────────────────────────────────────────

class ExtractRequest(BaseModel):
    text: str
    job_id: str
    user_id: str
    entity_types: list[str] | None = None


class ExtractResponse(BaseModel):
    job_id: str
    status: str
    entities: list[dict]
    relations: list[dict]
    graph_stats: dict
    vector_stats: dict = {}
    # Set when the extraction completed but a step degraded (e.g. relation
    # extraction skipped because the LLM was unavailable). Job is still success.
    degraded: bool = False
    warning: Optional[str] = None
    # Provenance: URLs crawled (website-crawl jobs) so the dashboard can show them.
    crawled_urls: Optional[list[str]] = None


class RepoRequest(BaseModel):
    """B1 code/repo ingest: a list of Python source files -> a structure graph.

    Mirrors ExtractRequest's style. `classification_level_id` is the ISO 27001
    level UUID (resolved to {id, name, rank} exactly like text ingest) so code
    entities are classified identically to text. `repo_name` is the provenance
    origin recorded on every node (defaults to "repo")."""
    files: list[dict]
    job_id: str
    user_id: str
    classification_level_id: Optional[str] = None
    repo_name: Optional[str] = None


class SearchReq(BaseModel):
    query: str
    limit: int = 5
    compilation_id: Optional[str] = None
    # Scope retrieval to one owner. REQUIRED for grounded, non-leaking search —
    # the chunk collection is shared across all users.
    user_id: Optional[str] = None
    # Most-permissive classification rank the caller may retrieve. Chunks with a
    # higher min_rank are filtered out of vector search. None = no clearance cap.
    max_rank: Optional[int] = None


# ── Endpoints ────────────────────────────────────────────────────────

@app.post("/extract", response_model=ExtractResponse)
async def extract_endpoint(req: ExtractRequest):
    """
    Run the full KEX pipeline on provided text.
    Synchronous: blocks until NER + RelEx + KG write completes.
    """
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail={
            "error": "empty_input",
            "message": "text field is empty",
        })

    check_result = check_credits("kex_extract", len(text))

    try:
        result = run_pipeline(text, req.job_id, req.user_id, entity_types=req.entity_types)
        report_usage("kex_extract", len(text), check_result["credits_spent"])
        return ExtractResponse(**result)
    except Exception as exc:
        logger.error(f"/extract error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail={
            "error": "pipeline_failed",
            "message": str(exc),
        })


@app.post("/repo")
async def repo_endpoint(req: RepoRequest):
    """
    B1 — ingest a Python codebase into a governed structure graph.

    Parses the supplied .py files into entities (file/class/function/module) and
    relations (CONTAINS / IMPORTS / CALLS / INHERITS) with the stdlib `ast`
    module — fully LOCAL, deterministic, ZERO LLM calls — then writes them via
    the SAME KGBuilder.build_graph() the text pipeline uses, so the code graph
    inherits identical classification (_min_rank / _class_labels), provenance
    (_source_job / _origin / _owner), and idempotent MERGE behaviour.

    Bypasses NER / RelEx / chunking / embedding entirely: code structure is
    syntactic, not natural language.

    Synchronous (like /extract): blocks until the graph write completes.
    """
    files = req.files or []
    if not files:
        raise HTTPException(status_code=400, detail={
            "error": "empty_input",
            "message": "files list is empty",
        })

    try:
        # Parse to the exact dict shapes KGBuilder expects (deterministic, local).
        entities, relations = parse_python_repo(files)

        # Resolve the ingest classification once ({id, name, rank}) — identical
        # path to the text worker so code is classified the same as text.
        classification = resolve_classification(req.classification_level_id, None)
        logger.info(
            f"[{req.job_id}] /repo classification: {classification['name']} "
            f"(rank {classification['rank']})"
        )

        # Count parsed vs skipped from the input for the response contract.
        py_total = sum(
            1 for f in files
            if isinstance(f, dict) and (f.get("path") or "").endswith(".py")
        )
        files_parsed = len({e["text"] for e in entities if e.get("type") == "file"})
        files_skipped = max(0, py_total - files_parsed)

        kg = get_kg_builder()
        stats = kg.build_graph(
            req.job_id, req.user_id, entities, relations,
            classification=classification, origin=req.repo_name or "repo",
        )
        logger.info(f"[{req.job_id}] /repo KG: {stats}")

        return {
            "entities_created": stats["entities_created"],
            "relations_created": stats["relations_created"],
            "nodes_total": stats["nodes_total"],
            "files_parsed": files_parsed,
            "files_skipped": files_skipped,
        }
    except Exception as exc:
        logger.error(f"/repo error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail={
            "error": "repo_parse_failed",
            "message": str(exc),
        })


@app.post("/upload", response_model=ExtractResponse)
async def upload_endpoint(
    file: UploadFile = File(...),
    job_id: str = Form(...),
    user_id: str = Form(...),
):
    """
    Accept a file upload, extract its text, then run the full KEX pipeline.
    Supports PDF, DOCX, CSV, JSON, XML, plain text.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail={
            "error": "no_file",
            "message": "No file provided",
        })

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail={
            "error": "empty_file",
            "message": "Uploaded file is empty",
        })

    content_type = file.content_type or "application/octet-stream"

    try:
        text = extract_text(file_bytes, content_type, filename=file.filename or "document")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "unsupported_format",
            "message": str(exc),
        })
    except Exception as exc:
        logger.error(f"/upload text extraction error: {exc}")
        raise HTTPException(status_code=500, detail={
            "error": "extraction_failed",
            "message": str(exc),
        })

    if not text.strip():
        raise HTTPException(status_code=422, detail={
            "error": "no_text",
            "message": "Could not extract any text from the uploaded file",
        })

    check_result = check_credits("kex_extract", len(text))

    try:
        result = run_pipeline(text, job_id, user_id)
        report_usage("kex_extract", len(text), check_result["credits_spent"])
        return ExtractResponse(**result)
    except Exception as exc:
        logger.error(f"/upload pipeline error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail={
            "error": "pipeline_failed",
            "message": str(exc),
        })


@app.get("/model-status")
async def model_status_endpoint():
    """Cheap, dependency-free status of the NER model warmup (no network probes),
    polled by the dashboard to show the first-run "engine initialising" notice +
    progress bar. Returns: {state, progress, attempt, detail}."""
    return get_model_status()


@app.get("/health")
async def health_endpoint():
    """
    Health check: reports model status and Neo4j connectivity.
    """
    # GLiNER model status
    ner_loaded = get_ner_pipeline().is_loaded

    # Neo4j connectivity
    neo4j_ok = False
    neo4j_error: Optional[str] = None
    try:
        kg = get_kg_builder()
        if not kg.is_connected:
            kg.connect()
        neo4j_ok = True
    except Exception as exc:
        neo4j_error = str(exc)

    # Redis connectivity
    redis_ok = False
    redis_error: Optional[str] = None
    try:
        r = get_redis()
        if r:
            r.ping()
            redis_ok = True
        else:
            redis_error = "not connected"
    except Exception as exc:
        redis_error = str(exc)

    # Ollama reachability (quick probe, no model load)
    ollama_ok = False
    ollama_tags: list[str] = []
    try:
        resp = requests.get(
            f"{config.OLLAMA_BASE}/api/tags",
            timeout=3,
        )
        ollama_ok = resp.status_code == 200
        if ollama_ok:
            models_data = resp.json().get("models", [])
            ollama_tags = [m.get("name", "") for m in models_data]
    except Exception:
        pass

    # Qdrant reachability
    qdrant_ok = False
    qdrant_error: Optional[str] = None
    try:
        from qdrant_client import QdrantClient as _QC
        _qc = _QC(url=config.QDRANT_URL, timeout=3)
        _qc.get_collections()
        qdrant_ok = True
    except Exception as exc:
        qdrant_error = str(exc)

    # Embedding model availability (check if model is listed in Ollama)
    embed_model_available = config.EMBEDDING_MODEL in " ".join(ollama_tags)

    status = "ok" if (neo4j_ok and redis_ok) else "degraded"

    return {
        "status": status,
        "ner_model": {
            "name": config.GLINER_MODEL,
            "type": "GLiNER zero-shot",
            "loaded": ner_loaded,
            "default_entity_types": len(config.DEFAULT_ENTITY_TYPES),
            "wikidata_types_mapped": len(config.WIKIDATA_TYPE_MAP),
        },
        "relex_model": config.RELEX_MODEL,
        "neo4j": {
            "ok": neo4j_ok,
            "uri": config.NEO4J_URI,
            **({"error": neo4j_error} if neo4j_error else {}),
        },
        "redis": {
            "ok": redis_ok,
            "url": config.REDIS_URL,
            **({"error": redis_error} if redis_error else {}),
        },
        "ollama": {
            "ok": ollama_ok,
            "base": config.OLLAMA_BASE,
            "relex_model": config.RELEX_MODEL,
            "embedding_model": config.EMBEDDING_MODEL,
            "embedding_model_available": embed_model_available,
        },
        "qdrant": {
            "ok": qdrant_ok,
            "url": config.QDRANT_URL,
            "collection": config.QDRANT_COLLECTION,
            **({"error": qdrant_error} if qdrant_error else {}),
        },
        "worker": {
            "running": _worker_running,
        },
    }


# ── Search endpoints ─────────────────────────────────────────────────

@app.get("/search/health")
async def search_health_endpoint():
    """Diagnostics: confirm search endpoint is reachable."""
    return {"ok": True}


def _dense_search(vector, req: "SearchReq") -> list[dict]:
    """Dense (vector) channel of hybrid retrieval. Owner + clearance are ALWAYS
    enforced; the compilation scope is a SOFT, droppable filter with an owner-
    corpus fallback. Returns normalized chunk dicts in rank order (best first).
    Raises HTTPException only when Qdrant is genuinely unavailable.
    """
    def _owner_clearance_conditions() -> list:
        conds: list = []
        if req.user_id:
            conds.append(FieldCondition(key="user_id", match=MatchValue(value=req.user_id)))
        # Null-tolerant clearance: a missing min_rank is treated as public (rank 0).
        if req.max_rank is not None:
            conds.append(Filter(should=[
                FieldCondition(key="min_rank", range=Range(lte=float(req.max_rank))),
                IsEmptyCondition(is_empty=PayloadField(key="min_rank")),
            ]))
        return conds

    must_conditions = _owner_clearance_conditions()
    if req.compilation_id:
        must_conditions.append(Filter(should=[
            FieldCondition(key="compilation_id", match=MatchValue(value=req.compilation_id)),
            IsEmptyCondition(is_empty=PayloadField(key="compilation_id")),
        ]))
    qdrant_filter: Optional[Filter] = Filter(must=must_conditions) if must_conditions else None

    qc = get_qdrant_client()
    if qc is None:
        raise HTTPException(status_code=503, detail={"error": "Vector search unavailable"})

    def _run(qfilter: Optional[Filter]):
        if hasattr(qc, "query_points"):
            return qc.query_points(
                collection_name=config.QDRANT_COLLECTION,
                query=vector, limit=max(1, req.limit),
                query_filter=qfilter, with_payload=True,
            ).points
        return qc.search(
            collection_name=config.QDRANT_COLLECTION,
            query_vector=vector, limit=max(1, req.limit),
            query_filter=qfilter, with_payload=True,
        )

    try:
        hits = _run(qdrant_filter)
        if not hits and req.compilation_id:
            logger.info("/search dense: 0 hits scoped to compilation %s — owner-corpus fallback", req.compilation_id)
            hits = _run(Filter(must=_owner_clearance_conditions()) if (req.user_id or req.max_rank is not None) else None)
    except UnexpectedResponse as exc:
        if exc.status_code == 404:
            logger.warning(f"/search dense: collection '{config.QDRANT_COLLECTION}' not found")
            return []
        logger.error(f"/search dense Qdrant error: {exc}")
        return []
    except Exception as exc:
        logger.error(f"/search dense Qdrant error: {exc}")
        return []

    out: list[dict] = []
    for hit in hits:
        payload = hit.payload or {}
        names: list[str] = []
        seen: set[str] = set()
        for m in (payload.get("entity_mentions") or []):
            nm = (m.get("name") or m.get("text") or "") if isinstance(m, dict) else str(m)
            nm = nm.strip()
            if nm and nm not in seen:
                seen.add(nm)
                names.append(nm)
        out.append({
            "text": payload.get("text", ""),
            "score": float(hit.score),         # cosine similarity (0..1) — used for confidence
            "dense_score": float(hit.score),   # preserved through fusion for a meaningful confidence
            "entity_mentions": names,
            "source": payload.get("source_document_id", "") or "",
            "chunk_id": str(hit.id),
        })
    return out


def _lexical_search(req: "SearchReq") -> list[dict]:
    """Lexical (BM25-style) channel of hybrid retrieval, over text_chunks.content_tsv.

    Mirrors the dense path's security/scoping EXACTLY:
      * owner: user_id = req.user_id (when provided)
      * clearance: min_rank IS NULL OR min_rank <= req.max_rank (null-tolerant)
      * soft compilation: compilation_id = req.compilation_id OR compilation_id IS NULL,
        with an owner-corpus fallback when the scoped query returns nothing.

    Ranking: ts_rank_cd over websearch_to_tsquery('simple', q). Additionally UNIONs
    a raw ILIKE substring match so punctuated exact tokens (filenames, hyphenated
    IDs like "GCTRL-XR-7741") that 'simple' splits on punctuation are still caught —
    these get a fixed high lexical rank because an exact substring hit is a strong
    signal. Returns normalized chunk dicts in rank order (best first).
    """
    q = req.query.strip()
    if not q:
        return []
    conn = get_search_pg()
    if conn is None:
        return []

    limit = max(1, req.limit)

    def _scope_sql(include_comp: bool) -> tuple[str, dict]:
        # archived = false: A5 dedup soft-archives near-duplicate chunks; retrieval
        # must skip them so a merged duplicate never resurfaces as a hit.
        clauses = ["tc.archived = false",
                   "tc.content_tsv @@ websearch_to_tsquery('simple', %(q)s)"]
        params: dict = {"q": q, "limit": limit}
        if req.user_id:
            clauses.append("tc.user_id = %(uid)s")
            params["uid"] = req.user_id
        if req.max_rank is not None:
            clauses.append("(tc.min_rank IS NULL OR tc.min_rank <= %(rank)s)")
            params["rank"] = req.max_rank
        if include_comp and req.compilation_id:
            clauses.append("(tc.compilation_id = %(comp)s OR tc.compilation_id IS NULL)")
            params["comp"] = req.compilation_id
        sql = (
            "SELECT tc.id::text, tc.content, tc.entity_mentions, "
            "       ts_rank_cd(tc.content_tsv, websearch_to_tsquery('simple', %(q)s)) AS rank "
            "FROM text_chunks tc "
            "WHERE " + " AND ".join(clauses) + " "
            "ORDER BY rank DESC LIMIT %(limit)s"
        )
        return sql, params

    def _ilike_sql(include_comp: bool) -> tuple[str, dict]:
        # Exact-substring fallback for punctuated tokens tsquery splits apart.
        # archived = false mirrors _scope_sql (skip A5-deduped duplicates).
        clauses = ["tc.archived = false", "tc.content ILIKE %(like)s"]
        params: dict = {"like": f"%{q}%", "limit": limit}
        if req.user_id:
            clauses.append("tc.user_id = %(uid)s"); params["uid"] = req.user_id
        if req.max_rank is not None:
            clauses.append("(tc.min_rank IS NULL OR tc.min_rank <= %(rank)s)"); params["rank"] = req.max_rank
        if include_comp and req.compilation_id:
            clauses.append("(tc.compilation_id = %(comp)s OR tc.compilation_id IS NULL)"); params["comp"] = req.compilation_id
        sql = (
            "SELECT tc.id::text, tc.content, tc.entity_mentions "
            "FROM text_chunks tc WHERE " + " AND ".join(clauses) + " LIMIT %(limit)s"
        )
        return sql, params

    def _normalize(row_id: str, content: str, mentions) -> dict:
        names: list[str] = []
        seen: set[str] = set()
        items = mentions if isinstance(mentions, list) else []
        for m in items:
            nm = (m.get("name") or m.get("text") or "") if isinstance(m, dict) else str(m)
            nm = nm.strip()
            if nm and nm not in seen:
                seen.add(nm); names.append(nm)
        return {"text": content or "", "entity_mentions": names, "source": "", "chunk_id": row_id}

    def _query(include_comp: bool) -> list[dict]:
        results: dict[str, dict] = {}
        order: list[str] = []
        try:
            with conn.cursor() as cur:
                sql, params = _scope_sql(include_comp)
                cur.execute(sql, params)
                for rid, content, mentions, rank in cur.fetchall():
                    if rid not in results:
                        results[rid] = _normalize(rid, content, mentions)
                        results[rid]["score"] = float(rank or 0.0)
                        order.append(rid)
            # ILIKE fallback for exact substrings (punctuated IDs/filenames). These
            # rank at the FRONT — an exact literal hit is the strongest lexical
            # signal and is precisely what BM25-over-tsvector can miss.
            with conn.cursor() as cur:
                sql, params = _ilike_sql(include_comp)
                cur.execute(sql, params)
                ilike_ids = [r[0] for r in cur.fetchall()]
            if ilike_ids:
                # Re-order so exact-substring hits lead, preserving their content.
                lead = []
                for rid in ilike_ids:
                    if rid in results:
                        lead.append(rid)
                    else:
                        with conn.cursor() as cur:
                            cur.execute("SELECT id::text, content, entity_mentions FROM text_chunks WHERE id = %s", (rid,))
                            row = cur.fetchone()
                        if row:
                            results[rid] = _normalize(row[0], row[1], row[2])
                            results[rid]["score"] = 0.0
                            lead.append(rid)
                order = lead + [r for r in order if r not in set(lead)]
        except Exception as exc:
            logger.warning(f"/search lexical query failed: {exc}")
            return []
        return [results[r] for r in order][:limit]

    hits = _query(include_comp=True)
    if not hits and req.compilation_id:
        logger.info("/search lexical: 0 hits scoped to compilation %s — owner-corpus fallback", req.compilation_id)
        hits = _query(include_comp=False)
    return hits


def _rrf_fuse(channels: list[list[dict]], limit: int, k: int = 60) -> list[dict]:
    """Reciprocal-rank fusion of multiple ranked chunk lists into one.

    score(chunk) = Σ_channels 1 / (k + rank_in_channel)   (rank is 1-based)

    Chunks are identified by chunk_id (falling back to text). k≈60 is the standard
    RRF constant — it damps the contribution of low-ranked items so a chunk that is
    top-1 in EITHER channel surfaces, which is exactly what makes the union of dense
    (semantic) and lexical (exact-token) retrieval strictly better than either
    alone. Carries each chunk's richest payload (entity_mentions from whichever
    channel had them) for downstream graph-expand.
    """
    # Lexical-only hits have no cosine similarity; give them a modest positive
    # confidence floor so a chunk recalled purely by exact-token match still
    # reports confidence > 0 downstream (rag.rs averages chunk.score) instead of
    # tanking the answer's confidence to ~0.
    LEXICAL_CONFIDENCE_FLOOR = 0.35

    fused: dict[str, dict] = {}
    for channel in channels:
        for rank, ch in enumerate(channel, start=1):
            key = ch.get("chunk_id") or ch.get("text", "")
            if not key:
                continue
            contrib = 1.0 / (k + rank)
            if key not in fused:
                entry = dict(ch)
                entry["_rrf"] = contrib
                fused[key] = entry
            else:
                fused[key]["_rrf"] += contrib
                # Carry the dense cosine score if THIS channel is the one that had it.
                if ch.get("dense_score") is not None and fused[key].get("dense_score") is None:
                    fused[key]["dense_score"] = ch["dense_score"]
                # Prefer the entity_mentions from whichever channel actually has them.
                if not fused[key].get("entity_mentions") and ch.get("entity_mentions"):
                    fused[key]["entity_mentions"] = ch["entity_mentions"]
                if not fused[key].get("text") and ch.get("text"):
                    fused[key]["text"] = ch["text"]

    # Order by the RRF score (the fusion's job), but REPORT an interpretable
    # per-chunk `score`: the dense cosine similarity when the chunk was retrieved
    # semantically, else a lexical floor. This keeps rag.rs's confidence (mean of
    # chunk.score) meaningful instead of collapsing it to the tiny 1/(k+rank) band.
    ordered = sorted(fused.values(), key=lambda c: c["_rrf"], reverse=True)
    out: list[dict] = []
    for c in ordered[:limit]:
        ds = c.get("dense_score")
        c["score"] = float(ds) if ds is not None else LEXICAL_CONFIDENCE_FLOOR
        c.pop("_rrf", None)
        c.pop("dense_score", None)
        out.append(c)
    return out


@app.post("/search")
async def search_endpoint(req: SearchReq, request: Request):
    # Internal trust boundary: /search takes a caller-supplied user_id + max_rank and
    # has no user auth of its own, so when INTERNAL_API_SECRET is set it MUST be
    # presented (the api-rs layer sends it). This closes the hole where a host-local
    # process could hit the raw worker port with user_id=<victim>&max_rank=MAX. Grace:
    # when the secret is unset (existing installs) the check is skipped.
    _secret = os.environ.get("INTERNAL_API_SECRET", "").strip()
    if _secret and request.headers.get("x-internal-secret", "") != _secret:
        raise HTTPException(status_code=403, detail={"error": "forbidden: internal endpoint"})
    """
    HYBRID retrieval over stored chunks: dense (Qdrant vector) ∪ lexical
    (Postgres BM25-style full-text + exact-substring), fused by reciprocal-rank
    fusion. This is the anchor retrieval for the graph RAG in rag.rs — making it
    hybrid here means BOTH the fast path and the agentic deep path (which call
    this same endpoint) gain exact-keyword / filename / ID recall that pure dense
    vector search misses.

    Cascade:
      1. dense channel  (semantic, owner+clearance+soft-compilation scoped)
      2. lexical channel (exact tokens, SAME scoping, with ILIKE substring rescue)
      3. RRF fusion of the two into one ranked list
      4. fallback: if fusion is empty, lexical-only over the whole owner corpus
    """
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail={"error": "query must not be empty"})
    if len(query) > 2000:
        raise HTTPException(status_code=400, detail={"error": "query exceeds 2000 character limit"})

    # Dense channel — embed the query; embedding failure degrades to lexical-only
    # rather than 503, so exact-token retrieval still works if Ollama is down.
    dense_hits: list[dict] = []
    vector = get_embedding_client().embed(query)
    if vector is None:
        logger.warning("/search: embedding unavailable — dense channel skipped, lexical-only")
    else:
        dense_hits = _dense_search(vector, req)

    # Lexical channel — Postgres full-text + exact-substring (BM25-style).
    lexical_hits = _lexical_search(req)

    # RRF fusion of dense ∪ lexical into a single ranked list.
    fused = _rrf_fuse([dense_hits, lexical_hits], limit=max(1, req.limit))

    # Final fallback: nothing fused (e.g. compilation scope hid everything and the
    # dense fallback also empty) → lexical-only over the WHOLE owner corpus.
    if not fused:
        corpus_req = SearchReq(query=req.query, limit=req.limit, compilation_id=None,
                               user_id=req.user_id, max_rank=req.max_rank)
        corpus_lex = _lexical_search(corpus_req)
        fused = _rrf_fuse([corpus_lex], limit=max(1, req.limit))

    # Cross-encoder rerank: RRF orders by rank-fusion, but only a true query×passage
    # cross-encoder scores actual relevance. Reorders the fused candidate pool so the
    # best passages bubble to the top before rag.rs cuts to its final few. Degrades to
    # a no-op (RRF order) if the model is unavailable.
    reranked = reranker.rerank(query, fused, top_k=max(1, req.limit))

    logger.info(
        "/search hybrid: dense=%d lexical=%d fused=%d reranked=%d (comp=%s)",
        len(dense_hits), len(lexical_hits), len(fused), len(reranked), req.compilation_id,
    )
    return {"chunks": reranked}


# ── A5: semantic dedup-merge ──────────────────────────────────────────


class DedupReq(BaseModel):
    """Scope + tunables for the dedup governance pass. All fields optional; an
    empty body sweeps the whole corpus (still per-user safe) at the default τ."""
    tau: Optional[float] = None
    user_id: Optional[str] = None
    compilation_id: Optional[str] = None
    dry_run: bool = False


@app.post("/dedup")
async def dedup_endpoint(req: DedupReq):
    """
    A5 — find near-duplicate chunks (embedding cosine > τ) and merge each cluster
    into one canonical chunk: union provenance, keep the most-restrictive clearance,
    soft-archive the duplicates. Conservative + per-user + clearance-preserving.

    Called by the api-rs memory-maintenance cycle (and usable standalone / after an
    ingest). Returns {scanned, clusters, merged, tau, dry_run, examples}.
    """
    from .dedup import run_dedup, DEFAULT_TAU
    from starlette.concurrency import run_in_threadpool
    tau = req.tau if (req.tau is not None and 0.5 <= req.tau <= 1.0) else DEFAULT_TAU
    qc = get_qdrant_client()
    # run_dedup is synchronous (blocking psycopg2 + Qdrant I/O). Offload it to a
    # threadpool so a corpus sweep never blocks the uvicorn event loop (which also
    # serves /search and the GLiNER-bound /extract on the same worker).
    return await run_in_threadpool(
        run_dedup,
        qc=qc,
        pg_url=config.PG_URL,
        collection=config.QDRANT_COLLECTION,
        tau=tau,
        user_id=req.user_id,
        compilation_id=req.compilation_id,
        dry_run=req.dry_run,
    )


# ── Local dev entry point ─────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=config.PORT,
        reload=False,
    )

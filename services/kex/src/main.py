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
import threading
import time
import traceback
from contextlib import asynccontextmanager
from typing import Optional

import redis as redis_lib
import requests
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import config
from .chunking import get_chunker
from .embedding import get_embedding_client
from .kg_builder import get_kg_builder
from .middleware.license_check import check_credits, report_usage
from .ner import get_ner_pipeline
from .relex import get_extractor
from .sources.file_handler import extract_text
from .sources.url_handler import extract_from_url
from .vector_store import get_vector_store

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


# ── Core extraction pipeline ─────────────────────────────────────────

def run_pipeline(
    text: str,
    job_id: str,
    user_id: str,
    entity_types: list[str] | None = None,
) -> dict:
    """
    Full extraction pipeline: NER -> RelEx -> KG Builder -> Chunking -> Embedding -> Vector Store.
    Returns a result dict suitable for direct HTTP response or Redis publish.
    """
    logger.info(f"[{job_id}] Pipeline start — {len(text)} chars")

    # 1. Named Entity Recognition (GLiNER zero-shot) — GPU-bound, needs lock
    ner = get_ner_pipeline()
    with _pipeline_lock:
        entities = ner.extract_entities(text, entity_types=entity_types)
    logger.info(f"[{job_id}] NER: {len(entities)} entities")

    # 2. Relation Extraction (Ollama HTTP — can run in parallel)
    relex = get_extractor()
    relations = relex.extract_relations(text, entities)
    logger.info(f"[{job_id}] RelEx: {len(relations)} relations")

    # 3. Write to Knowledge Graph
    kg = get_kg_builder()
    stats = kg.build_graph(job_id, user_id, entities, relations)
    logger.info(f"[{job_id}] KG: {stats}")

    # 4. Chunk text for vector store
    chunker = get_chunker()
    chunks = chunker.chunk(text)
    logger.info(f"[{job_id}] Chunked: {len(chunks)} chunks")

    # 5. Embed chunks (graceful degradation: failed embeddings become None)
    embedder = get_embedding_client()
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
        )
        logger.info(f"[{job_id}] Vector store: {chunks_stored} chunks stored")
    except Exception as exc:
        logger.warning(f"[{job_id}] Vector store failed (non-fatal): {exc}")

    return {
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
    }


# ── Redis background worker ──────────────────────────────────────────

_worker_running = False
_worker_threads: list[tuple[threading.Thread, threading.Event]] = []
_pipeline_lock = threading.Lock()  # serialize GPU-bound NER


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

            # Publish 'processing' status immediately so the UI shows it
            try:
                r.publish("kex:results", json.dumps({"job_id": job_id, "status": "processing"}))
            except Exception:
                pass  # non-fatal

            # Resolve text content based on job type
            if job_type == "url":
                text = extract_from_url(job_input)
            elif job_type == "text":
                text = job_input
            elif job_type == "file":
                # File uploaded as base64 JSON: {"fileBase64": "...", "mimetype": "...", "originalFilename": "..."}
                import base64
                file_data = json.loads(job_input)
                file_bytes = base64.b64decode(file_data["fileBase64"])
                mimetype = file_data.get("mimetype", "application/octet-stream")
                text = extract_text(file_bytes, mimetype)
                logger.info(f"[{job_id}] Extracted {len(text)} chars from file ({mimetype})")
            else:
                raise ValueError(f"Unknown job type: {job_type}")

            check_result = check_credits("kex_extract", len(text))
            result = run_pipeline(text, job_id, user_id, entity_types=entity_types)
            report_usage("kex_extract", len(text), check_result["credits_spent"])
            _publish_result(r, job_id, result)

        except Exception as exc:
            logger.error(f"Worker: job {job_id} failed: {exc}\n{traceback.format_exc()}")
            _publish_error(r, job_id, str(exc))

    logger.info(f"KEX worker-{worker_id} stopped")


def _publish_result(r: redis_lib.Redis, job_id: str, result: dict) -> None:
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

    # Warm up GLiNER model (lazy — will load on first request if skipped)
    try:
        get_ner_pipeline()._get_model()
    except Exception as exc:
        logger.warning(f"GLiNER model pre-load failed: {exc}")

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
        text = extract_text(file_bytes, content_type)
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


# ── Local dev entry point ─────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=config.PORT,
        reload=False,
    )

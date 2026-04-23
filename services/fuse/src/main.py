"""
FUSE Service - Knowledge Graph Fusion Worker
Merges multiple source knowledge graphs into unified compilations.
Listens on Redis queue 'fuse:jobs' for merge requests.

Endpoints:
  POST /merge   - Run merge pipeline on specified source jobs
  GET  /health  - Service health check
"""

import json
import logging
import threading
import time
import traceback
from contextlib import asynccontextmanager
from typing import Optional

import redis as redis_lib
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import config
from .merger import get_merger
from .middleware.license_check import check_credits, report_usage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

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


def run_merge(
    compilation_id: str,
    source_job_ids: list[str],
    user_id: str,
    classification: str = "PUBLIC",
    enable_conex: bool = False,
    match_rules: list[dict] | None = None,
) -> dict:
    """Full three-stage merge pipeline."""
    rules_info = f", {len(match_rules)} match rules" if match_rules else ""
    logger.info(f"[{compilation_id}] Merge start — {len(source_job_ids)} sources{rules_info}")

    merger = get_merger()

    # Apply ontology match rules to merger config
    if match_rules:
        for rule in match_rules:
            threshold = rule.get("threshold")
            if threshold and isinstance(threshold, (int, float)):
                merger.threshold_accept = max(merger.threshold_accept, float(threshold))
                merger.threshold_review = min(merger.threshold_review, float(threshold) - 0.15)

    stats = merger.merge(compilation_id, source_job_ids, user_id, classification, enable_conex=enable_conex)

    logger.info(f"[{compilation_id}] Merge complete: {stats}")
    return {
        "compilation_id": compilation_id,
        "status": "completed",
        **stats,
    }


# ── Redis background worker ──────────────────────────────────────────

_worker_running = False
_worker_thread: Optional[threading.Thread] = None


def _worker_loop() -> None:
    global _worker_running
    logger.info("FUSE worker thread started")

    while _worker_running:
        r = get_redis()
        if r is None:
            logger.warning("Worker: Redis unavailable, retrying in 5s")
            time.sleep(5)
            continue

        try:
            item = r.blpop("fuse:jobs", timeout=2)
        except redis_lib.exceptions.ConnectionError:
            logger.warning("Worker: Redis connection lost, retrying in 5s")
            global _redis_client
            _redis_client = None
            time.sleep(5)
            continue
        except Exception as exc:
            logger.error(f"Worker: BLPOP error: {exc}")
            time.sleep(2)
            continue

        if item is None:
            continue

        _queue_name, raw_payload = item
        logger.info("Worker: received fuse job from queue")

        job_id = "unknown"
        try:
            payload = json.loads(raw_payload)
            job_id = payload.get("job_id", "unknown")
            compilation_id = payload.get("compilation_id", "unknown")
            user_id = payload.get("user_id", "system")
            source_job_ids = payload.get("source_job_ids", [])
            classification = payload.get("classification", "PUBLIC")
            match_rules = payload.get("match_rules")

            check_result = check_credits("fuse_merge", 0)
            result = run_merge(
                compilation_id, source_job_ids, user_id, classification,
                match_rules=match_rules,
            )
            report_usage("fuse_merge", 0, check_result["credits_spent"])
            _publish_result(r, job_id, compilation_id, result)

        except Exception as exc:
            logger.error(
                f"Worker: job {job_id} failed: {exc}\n{traceback.format_exc()}"
            )
            _publish_error(r, job_id, str(exc))

    logger.info("FUSE worker thread stopped")


def _publish_result(
    r: redis_lib.Redis, job_id: str, compilation_id: str, result: dict
) -> None:
    payload = json.dumps(
        {
            "job_id": job_id,
            "compilation_id": compilation_id,
            "status": "completed",
            "result": result,
        }
    )
    try:
        r.publish("fuse:results", payload)
    except Exception as exc:
        logger.error(f"Failed to publish result for {job_id}: {exc}")


def _publish_error(r: redis_lib.Redis, job_id: str, error: str) -> None:
    payload = json.dumps(
        {
            "job_id": job_id,
            "status": "failed",
            "error": error,
        }
    )
    try:
        r.publish("fuse:results", payload)
    except Exception as exc:
        logger.error(f"Failed to publish error for {job_id}: {exc}")


def start_worker() -> None:
    global _worker_running, _worker_thread
    _worker_running = True
    _worker_thread = threading.Thread(
        target=_worker_loop,
        name="fuse-worker",
        daemon=True,
    )
    _worker_thread.start()
    logger.info("FUSE Redis worker started")


def stop_worker() -> None:
    global _worker_running
    _worker_running = False
    if _worker_thread:
        _worker_thread.join(timeout=10)
    logger.info("FUSE Redis worker stopped")


# ── Lifespan ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("FUSE service starting up...")

    try:
        merger = get_merger()
        merger.connect()
    except Exception as exc:
        logger.warning(f"Neo4j not available at startup: {exc}")

    get_redis()
    start_worker()

    logger.info("FUSE service ready")
    yield

    logger.info("FUSE service shutting down...")
    stop_worker()
    get_merger().close()
    logger.info("FUSE service stopped")


# ── FastAPI app ──────────────────────────────────────────────────────

app = FastAPI(
    title="GCTRL FUSE Service",
    version="1.0.0",
    description="Knowledge Graph Fusion: entity matching and graph merging",
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


class MergeRequest(BaseModel):
    compilation_id: str
    source_job_ids: list[str]
    user_id: str
    classification: str = "PUBLIC"


class MergeResponse(BaseModel):
    compilation_id: str
    status: str
    entities_merged: int = 0
    duplicates_found: int = 0
    relations_merged: int = 0
    nodes_total: int = 0


@app.post("/merge", response_model=MergeResponse)
async def merge_endpoint(req: MergeRequest):
    """Run merge pipeline synchronously (for direct HTTP calls)."""
    if not req.source_job_ids:
        raise HTTPException(status_code=400, detail="No source job IDs provided")

    check_result = check_credits("fuse_merge", 0)

    try:
        result = run_merge(
            req.compilation_id,
            req.source_job_ids,
            req.user_id,
            req.classification,
        )
        report_usage("fuse_merge", 0, check_result["credits_spent"])
        return MergeResponse(**result)
    except Exception as exc:
        logger.error(f"/merge error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/health")
async def health_endpoint():
    neo4j_ok = False
    try:
        merger = get_merger()
        if not merger._driver:
            merger.connect()
        neo4j_ok = True
    except Exception:
        pass

    redis_ok = False
    try:
        r = get_redis()
        if r:
            r.ping()
            redis_ok = True
    except Exception:
        pass

    return {
        "status": "ok" if (neo4j_ok and redis_ok) else "degraded",
        "neo4j": {"ok": neo4j_ok, "uri": config.NEO4J_URI},
        "redis": {"ok": redis_ok, "url": config.REDIS_URL},
        "worker": {"running": _worker_running},
        "threshold": config.SIMILARITY_THRESHOLD,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host="0.0.0.0", port=config.PORT, reload=False)


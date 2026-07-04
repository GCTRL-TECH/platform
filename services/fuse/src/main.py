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
from . import communities
from . import distiller
from . import dossier
from . import user_profile
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
    enable_smart_match: bool = True,
    enable_canonical_link: bool = True,
    enable_embedding_match: bool = True,
    match_rules: list[dict] | None = None,
    threshold_accept: float | None = None,
    threshold_review: float | None = None,
    metric_overrides: dict | None = None,
    field_mode_config: dict | None = None,
) -> dict:
    """Full three-stage merge pipeline.

    The optional ``threshold_accept`` / ``threshold_review`` / ``enable_conex`` /
    ``metric_overrides`` knobs let the benchmark harness A/B linking quality via
    the synchronous ``/merge`` path. All are optional → existing callers are
    unaffected (defaults preserve prior behaviour)."""
    rules_info = f", {len(match_rules)} match rules" if match_rules else ""
    logger.info(f"[{compilation_id}] Merge start — {len(source_job_ids)} sources{rules_info}")

    merger = get_merger()

    # ── Tuning seam ───────────────────────────────────────────────────────────
    # Resolve the ACTIVE entity-resolution profile (license-delivered tuned values
    # if present, else bundled generic defaults — never raises). Apply it as the
    # baseline; explicit run_merge params (the benchmark A/B knobs) still win below.
    from . import tuning as _tuning
    from . import config_builder as _cfg, embedding_match as _emb
    _profile = _tuning.load_tuning()
    # Per-type LIMES presets (mutate the in-place dict stage-2 reads).
    _cfg.DEFAULT_METRICS.update(_profile.get("default_metrics") or {})
    # Embedding-match cutoffs (runtime globals).
    _emb.apply_embedding_overrides(_profile.get("embedding_overrides"))
    # Accept/review floors + per-type metric overrides from the profile.
    merger.threshold_accept = float(_profile["threshold_accept"])
    merger.threshold_review = float(_profile["threshold_review"])
    merger.metric_overrides = dict(_profile.get("metric_overrides") or {})
    # Profile field-mode config is the default when the caller didn't pass one.
    if field_mode_config is None:
        field_mode_config = _profile.get("field_mode_config") or None

    # Explicit threshold overrides take precedence (the benchmark A/B knobs). They
    # are applied before match_rules so a rule can still ratchet acceptance up.
    if threshold_accept is not None:
        merger.threshold_accept = float(threshold_accept)
    if threshold_review is not None:
        merger.threshold_review = float(threshold_review)
    # Per-type LIMES metric overrides ({entity_type: "trigrams(x.name,y.name)|0.7"}).
    # Explicit request overrides win over the profile's; absent → keep the profile's.
    if metric_overrides is not None:
        merger.metric_overrides = metric_overrides

    # Apply ontology match rules to merger config
    if match_rules:
        for rule in match_rules:
            threshold = rule.get("threshold")
            if threshold and isinstance(threshold, (int, float)):
                merger.threshold_accept = max(merger.threshold_accept, float(threshold))
                merger.threshold_review = min(merger.threshold_review, float(threshold) - 0.15)

    stats = merger.merge(
        compilation_id, source_job_ids, user_id, classification,
        enable_conex=enable_conex, enable_smart_match=enable_smart_match,
        enable_canonical_link=enable_canonical_link,
        enable_embedding_match=enable_embedding_match,
        field_mode_config=field_mode_config,
    )

    # Persist classification conflicts (don't ship the bulky list in the result).
    conflicts = stats.pop("_conflicts", [])
    if conflicts:
        _write_conflicts(compilation_id, conflicts)

    logger.info(f"[{compilation_id}] Merge complete: {stats}")
    return {
        "compilation_id": compilation_id,
        "status": "completed",
        **stats,
    }


def _write_conflicts(compilation_id: str, conflicts: list[dict]) -> None:
    """Upsert merge-surfaced classification conflicts into Postgres for review.

    Best-effort: a write failure must never fail the merge — the labels are
    already correct in Neo4j; this table only drives the human review queue.
    """
    try:
        import json as _json
        import psycopg2
        conn = psycopg2.connect(config.PG_URL, connect_timeout=5)
        with conn, conn.cursor() as cur:
            for c in conflicts:
                cur.execute(
                    """
                    INSERT INTO classification_conflicts
                        (compilation_id, element_kind, element_key, labels, status)
                    VALUES (%s, %s, %s, %s::jsonb, 'open')
                    ON CONFLICT (compilation_id, element_kind, element_key)
                    DO UPDATE SET labels = EXCLUDED.labels, status = 'open'
                    """,
                    (compilation_id, c["element_kind"], c["element_key"],
                     _json.dumps(c.get("labels", []))),
                )
        conn.close()
        logger.info(f"[{compilation_id}] Recorded {len(conflicts)} classification conflict(s)")
    except Exception as exc:
        logger.warning(f"[{compilation_id}] Failed to record conflicts: {exc}")


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
            # Watch BOTH queues in one blocking pop. Redis returns the queue name
            # that produced the item, so we branch on it below (fuse vs distill).
            item = r.blpop(["fuse:jobs", "distill:jobs"], timeout=2)
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

        queue_name, raw_payload = item

        if queue_name == "distill:jobs":
            _handle_distill_job(r, raw_payload)
            continue

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

            # Authoritative state: mark job as 'processing' in Postgres
            # before doing the heavy merge work.
            _update_job_status(job_id, "processing")

            check_result = check_credits("fuse_merge", 0)
            result = run_merge(
                compilation_id, source_job_ids, user_id, classification,
                match_rules=match_rules,
                enable_smart_match=bool(payload.get("enable_smart_match", True)),
                enable_canonical_link=bool(payload.get("enable_canonical_link", True)),
                enable_embedding_match=bool(payload.get("enable_embedding_match", True)),
            )
            report_usage("fuse_merge", 0, check_result["credits_spent"])
            _publish_result(r, job_id, compilation_id, result)

        except Exception as exc:
            logger.error(
                f"Worker: job {job_id} failed: {exc}\n{traceback.format_exc()}"
            )
            _publish_error(r, job_id, str(exc))


def _handle_distill_job(r: redis_lib.Redis, raw_payload: str) -> None:
    """Process a `distill:jobs` item and publish to `distill:results`.

    Payload: {job_id?, compilation_id, user_id, limit?}. The sync HTTP path
    (`POST /distill`) is the primary M1 entry point; this async consumer mirrors
    the fuse worker so scheduled/queued distillation works the same way."""
    job_id = "unknown"
    try:
        payload = json.loads(raw_payload)
        job_id = payload.get("job_id", "unknown")
        compilation_id = payload.get("compilation_id")
        user_id = payload.get("user_id", "system")
        limit = int(payload.get("limit", 15))
        distill_model = payload.get("distill_model")
        ollama_base = payload.get("ollama_base")
        # LLM runtime kind + optional API key for OpenAI-compatible providers.
        # Defaults to "ollama" so existing distill jobs are unchanged.
        generation_kind = payload.get("generation_kind") or "ollama"
        generation_base = payload.get("generation_base")
        generation_api_key = payload.get("generation_api_key")
        logger.info(f"Worker: received distill job for {compilation_id}")

        if job_id != "unknown":
            _update_job_status(job_id, "processing")

        # Use generation_base for the distiller's generation step when provided;
        # fall back to ollama_base (default install unchanged).
        distill_base = generation_base if generation_base else ollama_base
        result = distiller.distill(
            compilation_id, user_id, limit=limit,
            model=distill_model, ollama_base=distill_base,
            kind=generation_kind, api_key=generation_api_key,
        )

        if job_id != "unknown":
            _update_job_status(job_id, "completed", result=result)
        try:
            r.publish("distill:results", json.dumps({
                "job_id": job_id,
                "compilation_id": compilation_id,
                "status": "completed",
                "result": result,
            }))
        except Exception as exc:
            logger.error(f"Failed to publish distill result for {job_id}: {exc}")

    except Exception as exc:
        logger.error(f"Worker: distill job {job_id} failed: {exc}\n{traceback.format_exc()}")
        if job_id != "unknown":
            _update_job_status(job_id, "failed", error=str(exc))
        try:
            r.publish("distill:results", json.dumps({
                "job_id": job_id, "status": "failed", "error": str(exc),
            }))
        except Exception:
            pass

    logger.info("FUSE worker thread stopped")


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


def _publish_result(
    r: redis_lib.Redis, job_id: str, compilation_id: str, result: dict
) -> None:
    # Authoritative state: write to Postgres BEFORE the fire-and-forget pubsub.
    _update_job_status(job_id, "completed", result=result)
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
    # Authoritative state: write to Postgres BEFORE the fire-and-forget pubsub.
    _update_job_status(job_id, "failed", error=error)
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
    # Optional benchmark A/B knobs (backward compatible — all default to None so
    # existing callers behave exactly as before).
    threshold_accept: Optional[float] = None
    threshold_review: Optional[float] = None
    enable_conex: bool = False
    enable_smart_match: bool = True
    enable_canonical_link: bool = False
    # Embedding best-buddy + model-number pass for NOISY general-name data (the
    # dirty-text quality lever). OFF by default → clean/field-mode paths unchanged.
    enable_embedding_match: bool = False
    metric_overrides: Optional[dict] = None
    # Field-mode precision-recovery knobs (blocking key + authors post-filter).
    # Only consulted when Stage-2 enters attribute-aware field mode; ignored by
    # the general/name-only path. {blocking_key, authors_prop, authors_threshold,
    # authors_min_both}.
    field_mode_config: Optional[dict] = None


class DistillRequest(BaseModel):
    compilation_id: str
    user_id: str
    limit: int = 15
    # Optional per-job overrides from the owner's Settings → AI Models / Infra.
    # Omitted/empty → distiller env defaults (GCTRL_DISTILL_MODEL / OLLAMA_BASE).
    distill_model: Optional[str] = None
    ollama_base: Optional[str] = None
    # LLM runtime selection. Default "ollama" → zero behaviour change.
    generation_kind: str = "ollama"
    generation_base: Optional[str] = None
    generation_api_key: Optional[str] = None


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
            enable_conex=req.enable_conex,
            enable_smart_match=req.enable_smart_match,
            enable_canonical_link=req.enable_canonical_link,
            enable_embedding_match=req.enable_embedding_match,
            threshold_accept=req.threshold_accept,
            threshold_review=req.threshold_review,
            metric_overrides=req.metric_overrides,
            field_mode_config=req.field_mode_config,
        )
        report_usage("fuse_merge", 0, check_result["credits_spent"])
        return MergeResponse(**result)
    except Exception as exc:
        logger.error(f"/merge error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/distill")
async def distill_endpoint(req: DistillRequest):
    """Distil a WIKI compilation into wiki pages synchronously (M1 sync path)."""
    try:
        # Mirror the worker path: prefer generation_base for the distiller's
        # LLM step; fall back to ollama_base so the default install is unchanged.
        distill_base = req.generation_base if req.generation_base else req.ollama_base
        return distiller.distill(
            req.compilation_id, req.user_id, limit=req.limit,
            model=req.distill_model, ollama_base=distill_base,
            kind=req.generation_kind, api_key=req.generation_api_key,
        )
    except ValueError as exc:
        # Bad request: not a WIKI comp / missing source / unknown comp.
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error(f"/distill error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(exc))


class DossierRequest(BaseModel):
    user_id: str
    # Single-entity on-demand build (the api-rs GET /dossier?name=X path).
    entity_name: Optional[str] = None
    # OR: refresh dossiers for the top-degree entities of a compilation.
    compilation_id: Optional[str] = None
    source_job_ids: Optional[list[str]] = None
    top_n: int = 10


@app.post("/dossier/build")
async def dossier_build_endpoint(req: DossierRequest):
    """Build/refresh entity dossier(s) — the HOT memory tier.

    Two modes:
      • entity_name set → compile/refresh ONE dossier on-demand (returns it, or
        404 when the user owns no node with that name).
      • compilation_id + source_job_ids set → refresh the top-N god-node dossiers.
    """
    try:
        if req.entity_name:
            result = dossier.build_dossier_for_name(req.user_id, req.entity_name)
            if result is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"No owned entity named '{req.entity_name}'",
                )
            return result
        if req.compilation_id is not None:
            return dossier.build_top_dossiers(
                req.compilation_id, req.user_id,
                req.source_job_ids or [], top_n=req.top_n,
            )
        raise HTTPException(
            status_code=400,
            detail="Provide entity_name, or compilation_id + source_job_ids",
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"/dossier/build error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(exc))


class ProfileBuildRequest(BaseModel):
    user_id: str


@app.post("/profile/build")
async def profile_build_endpoint(req: ProfileBuildRequest):
    """A6 — distil the user's USER-PROFILE memory from STANDARD-mode history.

    OPT-IN: refuses (403) unless `user_profile.enabled` is true for the user.
    Incognito content is never persisted, so it can never be a source here.
    """
    try:
        return user_profile.build_profile(req.user_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except Exception as exc:
        logger.error(f"/profile/build error: {exc}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(exc))


class CommunitiesRequest(BaseModel):
    compilation_id: str
    user_id: str
    source_job_ids: Optional[list[str]] = None


@app.post("/communities")
async def communities_endpoint(req: CommunitiesRequest):
    """B2 — detect communities + centrality ("god nodes") for a compilation and
    write `_community`/`_centrality`/`_god_node` back onto its Neo4j nodes.
    Fully local (label propagation, no extra deps). Returns a cluster summary."""
    try:
        return communities.detect_communities(
            req.compilation_id, req.user_id, req.source_job_ids or [],
        )
    except Exception as exc:
        logger.error(f"/communities error: {exc}\n{traceback.format_exc()}")
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


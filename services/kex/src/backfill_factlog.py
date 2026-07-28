"""Backfill the session fact log over ALREADY-ingested kex_extract jobs.

New ingests get fact chunks inline (main.py step 7b). This script retrofits an
existing corpus WITHOUT re-running NER/RelEx: per completed job it distills the
stored input text into atomic facts and stores them as chunks under the ORIGINAL
job_id — session mapping, recency ordinals, and parent-document expansion all
keep working. Idempotent: jobs that already have fact chunks are skipped.

Run inside the kex container:
  python -m src.backfill_factlog --email-like 'beam100k-%@bench.local' [--workers 4]
"""
import argparse
import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor

import psycopg2

from . import config
from .embedding import get_embedding_client
from .fact_log import FACT_SEQ_BASE, extract_facts, fact_chunks
from .vector_store import get_vector_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("backfill_factlog")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email-like", required=True,
                    help="SQL LIKE pattern on users.email selecting whose jobs to backfill")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=100000)
    args = ap.parse_args()

    conn = psycopg2.connect(config.PG_URL)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(
            """SELECT j.id::text, j.user_id::text, j.input->>'text'
               FROM jobs j JOIN users u ON u.id = j.user_id
               WHERE u.email LIKE %s AND j.type = 'kex_extract' AND j.status = 'completed'
                 AND COALESCE(j.input->>'text','') <> ''
                 AND NOT EXISTS (
                    SELECT 1 FROM text_chunks tc
                    WHERE tc.job_id = j.id AND tc.chunk_sequence >= %s)
               ORDER BY j.created_at ASC LIMIT %s""",
            (args.email_like, FACT_SEQ_BASE, args.limit),
        )
        jobs = cur.fetchall()
    logger.info("backfill_factlog: %d jobs to process", len(jobs))

    embedder = get_embedding_client()
    vs = get_vector_store()
    done = [0, 0]  # jobs, facts

    def process(row):
        job_id, user_id, text = row
        try:
            facts = extract_facts(text)
            if not facts:
                return 0
            f_chunks = fact_chunks(text, facts)
            f_embeddings = embedder.embed_batch([c.get("embed_text", c["content"]) for c in f_chunks])
            stored = vs.store_chunks(
                f_chunks, f_embeddings, job_id, user_id,
                compilation_id=None,
                entity_mentions=[[] for _ in f_chunks],
            )
            return stored
        except Exception as exc:  # noqa: BLE001
            logger.warning("job %s failed: %s", job_id, exc)
            return 0

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for stored in ex.map(process, jobs):
            done[0] += 1
            done[1] += stored
            if done[0] % 50 == 0:
                logger.info("progress: %d/%d jobs, %d fact chunks", done[0], len(jobs), done[1])

    logger.info("DONE: %d jobs, %d fact chunks stored", done[0], done[1])


if __name__ == "__main__":
    main()

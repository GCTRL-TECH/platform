"""Letzte Freigabe-Pruefung fuer /search: Postgres ist die Wahrheit ueber die Einstufung.

Der dichte Kanal filtert ueber den Qdrant-Payload `min_rank`, der beim Speichern
geschrieben und danach nie wieder angefasst wird. Wird die Einstufung eines Abschnitts
spaeter in Postgres angehoben (Migration 100 hebt bestehende Lehren auf die Stufe ihrer
Wissensbasis), bliebe der Payload auf dem alten Wert und der dichte Kanal gaebe den
Abschnitt weiter an zu niedrig Freigegebene heraus. Diese Pruefung schliesst die
Luecke: EINE Abfrage ueber die (wenigen) Treffer-IDs, alles mit
`text_chunks.min_rank > max_rank` faellt heraus.

Fehlerverhalten: ohne Postgres bleibt die Liste, wie die Kanaele sie geliefert haben
(der Qdrant-Filter galt ja schon) — die Suche faellt nicht aus, nur weil die zweite
Pruefung nicht moeglich ist. Eine ID, die Postgres nicht kennt, bleibt ebenfalls
(sie war nie hoeher eingestuft, als Qdrant weiss).

CYTHON NOTE: Parameter bewusst ohne Annotation (exakte Typpruefung im Prod-Build).
"""

import logging

logger = logging.getLogger(__name__)


def drop_above_rank(chunks, ranks_by_id, max_rank):
    """Rein: Treffer ohne die, deren bekannter Rang ueber `max_rank` liegt.
    `max_rank` None = keine Freigabegrenze (unveraendert)."""
    if max_rank is None or not ranks_by_id:
        return chunks
    out = []
    for c in chunks:
        r = ranks_by_id.get(str(c.get("chunk_id") or ""))
        if r is not None and int(r) > int(max_rank):
            continue
        out.append(c)
    return out


def filter_by_pg_rank(chunks, max_rank, conn_factory):
    """`drop_above_rank` mit den Raengen aus text_chunks. Wirft nie."""
    if max_rank is None or not chunks:
        return chunks
    ids = []
    for c in chunks:
        cid = str(c.get("chunk_id") or "")
        if cid and cid not in ids:
            ids.append(cid)
    if not ids:
        return chunks
    try:
        conn = conn_factory()
        if conn is None:
            return chunks
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id::text, COALESCE(min_rank, 0) FROM text_chunks WHERE id::text = ANY(%(ids)s)",
                {"ids": ids},
            )
            ranks = {row[0]: row[1] for row in cur.fetchall()}
    except Exception as exc:
        logger.warning("/search clearance guard skipped: %s", exc)
        return chunks
    kept = drop_above_rank(chunks, ranks, max_rank)
    if len(kept) != len(chunks):
        logger.info("/search clearance guard: %d chunk(s) above rank %s dropped", len(chunks) - len(kept), max_rank)
    return kept

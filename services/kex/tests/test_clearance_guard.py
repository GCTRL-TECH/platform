"""Letzte Freigabe-Pruefung von /search (src/clearance_guard.py): Postgres entscheidet
ueber die Einstufung, nicht ein veralteter Qdrant-Payload. Offline: die reine Regel,
die Abfrage gegen eine Attrappe und der Einbau in main.py (Quelltext-Waechter)."""

import pathlib
import re

from src import clearance_guard

A = "aaaaaaaa-0000-0000-0000-000000000001"
B = "bbbbbbbb-0000-0000-0000-000000000002"
C = "cccccccc-0000-0000-0000-000000000003"


def hits():
    return [{"chunk_id": A, "text": "oeffentlich"}, {"chunk_id": B, "text": "streng"}, {"chunk_id": C, "text": "unbekannt"}]


class FakeCursor:
    def __init__(self, rows, fail=False):
        self.rows, self.fail, self.sql = rows, fail, None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params):
        if self.fail:
            raise RuntimeError("pg weg")
        self.sql, self.params = sql, params

    def fetchall(self):
        return self.rows


class FakeConn:
    def __init__(self, rows, fail=False):
        self.cur = FakeCursor(rows, fail)

    def cursor(self):
        return self.cur


class TestRule:
    def test_hoeher_eingestufte_treffer_fallen_heraus(self):
        out = clearance_guard.drop_above_rank(hits(), {A: 0, B: 300}, 100)
        assert [c["chunk_id"] for c in out] == [A, C]

    def test_wer_die_freigabe_hat_sieht_alles(self):
        assert len(clearance_guard.drop_above_rank(hits(), {A: 0, B: 300}, 300)) == 3

    def test_ohne_grenze_unveraendert(self):
        assert len(clearance_guard.drop_above_rank(hits(), {B: 300}, None)) == 3


class TestPg:
    def test_raenge_kommen_aus_text_chunks(self):
        conn = FakeConn([(A, 0), (B, 300)])
        out = clearance_guard.filter_by_pg_rank(hits(), 100, lambda: conn)
        assert [c["chunk_id"] for c in out] == [A, C]
        assert "text_chunks" in conn.cur.sql and "min_rank" in conn.cur.sql
        assert conn.cur.params["ids"] == [A, B, C]

    def test_ohne_postgres_bleibt_die_liste(self):
        assert len(clearance_guard.filter_by_pg_rank(hits(), 100, lambda: None)) == 3
        assert len(clearance_guard.filter_by_pg_rank(hits(), 100, lambda: FakeConn([], fail=True))) == 3

    def test_ohne_grenze_keine_abfrage(self):
        def boom():
            raise AssertionError("keine Abfrage ohne Grenze")
        assert len(clearance_guard.filter_by_pg_rank(hits(), None, boom)) == 3


def test_main_ruft_die_pruefung_als_letzten_filter():
    src = (pathlib.Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(encoding="utf-8")
    m = re.search(r"^async def search_endpoint\(.*?(?=^(?:async )?def |^@app\.|^class )", src, re.S | re.M)
    assert m
    body = m.group(0)
    scope = body.index("search_scope.filter_chunks(reranked, req.job_ids)")
    guard = body.index("clearance_guard.filter_by_pg_rank(reranked, req.max_rank, get_search_pg)")
    assert scope < guard < body.index('return {"chunks": reranked}')

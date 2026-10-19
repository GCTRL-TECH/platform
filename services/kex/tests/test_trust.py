"""Trust order for /search (src/trust.py): agent `store` notes rank after source
documents, keep their relative order, are labelled, and nothing ever raises."""

from src import trust


def _c(cid, job):
    return {"chunk_id": cid, "job_id": job, "text": cid}


class _Cur:
    def __init__(self, rows, seen):
        self.rows, self.seen = rows, seen

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params):
        self.seen.append((sql, params))

    def fetchall(self):
        return self.rows


class _Conn:
    def __init__(self, rows):
        self.rows, self.seen = rows, []

    def cursor(self):
        return _Cur(self.rows, self.seen)


def test_agent_notes_move_behind_documents_stably():
    chunks = [_c("n1", "J-note"), _c("d1", "J-doc"), _c("n2", "J-note"), _c("d2", "J-doc2")]
    out = trust.demote_agent_notes(chunks, {"J-note"})
    assert [c["chunk_id"] for c in out] == ["d1", "d2", "n1", "n2"]
    assert out[2]["origin"] == "agent_note" and "origin" not in out[0]


def test_no_agent_jobs_keeps_order():
    chunks = [_c("a", "1"), _c("b", "2")]
    assert trust.demote_agent_notes(chunks, set()) is chunks


def test_apply_looks_up_agent_store_jobs_once():
    conn = _Conn([("J-note",)])
    chunks = [_c("n1", "J-note"), _c("d1", "J-doc")]
    out = trust.apply_trust_order(chunks, lambda: conn, enabled=True)
    assert [c["chunk_id"] for c in out] == ["d1", "n1"]
    assert len(conn.seen) == 1
    sql, params = conn.seen[0]
    assert "agent_store" in params and sorted(params[0]) == ["J-doc", "J-note"]


def test_apply_never_raises_and_respects_switch():
    chunks = [_c("n1", "J-note"), _c("d1", "J-doc")]

    def boom():
        raise RuntimeError("pg down")

    assert trust.apply_trust_order(chunks, boom, enabled=True) == chunks
    assert trust.apply_trust_order(chunks, lambda: None, enabled=True) == chunks
    assert trust.apply_trust_order(chunks, lambda: _Conn([("J-note",)]), enabled=False) == chunks


def test_switch_reads_env(monkeypatch):
    monkeypatch.setenv("KEX_AGENT_NOTE_DEMOTE", "0")
    assert trust.demote_enabled() is False
    monkeypatch.delenv("KEX_AGENT_NOTE_DEMOTE")
    assert trust.demote_enabled() is True

"""Per-request search connections (src/search_pg.py) + the threadpooled /search.

Before: /search was `async def` with blocking calls, so parallel searches ran one
after another on the event loop; all of them shared one psycopg2 connection.
"""
import pathlib
import re
import threading
import time

from src.search_pg import SearchConnPool


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        if self.conn.broken:
            raise RuntimeError("server closed the connection")
        # Two threads on one connection at once is exactly what must never happen.
        if not self.conn.busy.acquire(blocking=False):
            self.conn.shared_use = True
            return
        try:
            time.sleep(0.005)
        finally:
            self.conn.busy.release()


class FakeConn:
    def __init__(self):
        self.closed = False
        self.autocommit = False
        self.broken = False
        self.busy = threading.Lock()
        self.shared_use = False

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        self.closed = True


class Factory:
    def __init__(self):
        self.made = []
        self.lock = threading.Lock()

    def __call__(self):
        c = FakeConn()
        with self.lock:
            self.made.append(c)
        return c


def test_parallel_requests_get_their_own_connection_and_the_pool_is_capped():
    fac = Factory()
    pool = SearchConnPool(fac, size=3)
    peak = {"now": 0, "max": 0}
    lock = threading.Lock()

    def request():
        with pool.scope() as conn:
            assert pool.in_scope() and pool.current() is conn
            assert conn.autocommit is True
            with lock:
                peak["now"] += 1
                peak["max"] = max(peak["max"], peak["now"])
            for _ in range(4):
                with pool.current().cursor() as cur:
                    cur.execute("SELECT 1")
            with lock:
                peak["now"] -= 1

    threads = [threading.Thread(target=request) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert all(not t.is_alive() for t in threads), "a burst beyond the pool size must wait, not hang"
    assert peak["max"] == 3, "requests ran in parallel, capped at the pool size"
    assert len(fac.made) <= 3, "never more connections than the pool size"
    assert not any(c.shared_use for c in fac.made), "two threads used one connection at once"


def test_outside_a_request_nothing_is_bound():
    pool = SearchConnPool(Factory(), size=1)
    assert not pool.in_scope() and pool.current() is None
    with pool.scope():
        pass
    assert not pool.in_scope() and pool.current() is None


def test_dead_connection_is_replaced():
    fac = Factory()
    pool = SearchConnPool(fac, size=1)
    with pool.scope() as first:
        pass
    first.broken = True
    with pool.scope() as second:
        assert second is not first
    assert first.closed


def test_connections_are_reused():
    fac = Factory()
    pool = SearchConnPool(fac, size=2)
    for _ in range(5):
        with pool.scope():
            pass
    assert len(fac.made) == 1


def test_postgres_down_yields_none_and_frees_the_slot():
    def down():
        raise OSError("connection refused")
    pool = SearchConnPool(down, size=1)
    for _ in range(3):  # the slot is released every time, or the 2nd call would block
        with pool.scope() as conn:
            assert conn is None and pool.in_scope()


def test_slot_is_released_when_the_request_raises():
    pool = SearchConnPool(Factory(), size=1)
    try:
        with pool.scope():
            raise ValueError("boom")
    except ValueError:
        pass
    done = threading.Event()
    threading.Thread(target=lambda: (pool.scope().__enter__(), done.set())).start()
    assert done.wait(2), "slot leaked after an exception"


class TestEndpointWiring:
    """Source guard over main.py (not importable offline)."""

    SRC = (pathlib.Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(encoding="utf-8")

    def test_search_is_a_threadpooled_def_inside_a_connection_scope(self):
        assert re.search(r'@app\.post\("/search"\)\ndef search_endpoint\(', self.SRC), \
            "/search must be a plain def (FastAPI threadpool), not async def"
        m = re.search(r"^def search_endpoint\(.*?(?=^(?:async )?def |^@app\.|^class )", self.SRC, re.S | re.M)
        body = m.group(0)
        assert "with _search_pool.scope():" in body
        assert "await " not in body

    def test_get_search_pg_prefers_the_request_connection(self):
        m = re.search(r"^def get_search_pg\(.*?(?=^(?:async )?def |^@app\.|^class )", self.SRC, re.S | re.M)
        body = m.group(0)
        assert body.index("_search_pool.in_scope()") < body.index("global _pg_search_conn")

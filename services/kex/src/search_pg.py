"""Per-request Postgres connections for /search.

/search is a plain `def` endpoint, so FastAPI runs it in its threadpool and
requests really run in parallel (as `async def` with blocking embedding, Qdrant
and psycopg2 calls, one slow search held the event loop and every other /search
queued behind it). The old single module-level connection would serialize them
again, and two threads must never run statements on one connection at once.

`SearchConnPool` therefore hands each request its OWN autocommit connection for
the request's lifetime, bound to the worker thread (`current()`), so every helper
that asks for "the search connection" (lexical channel, Hebbian prior, clearance
guard, source names) gets the request's connection without new parameters.

  * at most `size` connections exist (Postgres max_connections is shared with
    api-rs and the other services);
  * a burst beyond `size` WAITS for a free slot (semaphore) instead of failing;
  * a connection that fails its liveness check is closed and replaced;
  * Postgres unreachable -> `None`, and the lexical channel degrades as before.

Un-annotated on purpose (Cython prod build: annotations are exact type checks).
"""

import logging
import threading
from contextlib import contextmanager

logger = logging.getLogger(__name__)


class SearchConnPool:
    def __init__(self, connect, size):
        """`connect()` opens a new DB-API connection (psycopg2.connect in prod)."""
        self._connect = connect
        self.size = max(1, int(size))
        self._slots = threading.BoundedSemaphore(self.size)
        self._idle = []
        self._lock = threading.Lock()
        self._local = threading.local()

    def _alive(self, conn):
        try:
            if getattr(conn, "closed", False):
                return False
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            return True
        except Exception:
            return False

    @staticmethod
    def _close(conn):
        try:
            conn.close()
        except Exception:
            pass

    def _checkout(self):
        while True:
            with self._lock:
                conn = self._idle.pop() if self._idle else None
            if conn is None:
                break
            if self._alive(conn):
                return conn
            self._close(conn)
        try:
            conn = self._connect()
            conn.autocommit = True
            return conn
        except Exception as exc:
            logger.warning(f"Lexical search: PostgreSQL unavailable: {exc}")
            return None

    def _checkin(self, conn):
        if getattr(conn, "closed", False):
            return
        with self._lock:
            self._idle.append(conn)

    @contextmanager
    def scope(self):
        """One connection for the current thread for the duration of a request."""
        self._slots.acquire()
        conn = None
        try:
            conn = self._checkout()
            self._local.active = True
            self._local.conn = conn
            yield conn
        finally:
            self._local.active = False
            self._local.conn = None
            if conn is not None:
                self._checkin(conn)
            self._slots.release()

    def in_scope(self):
        return bool(getattr(self._local, "active", False))

    def current(self):
        """The connection bound by `scope()` on this thread (may be None)."""
        return getattr(self._local, "conn", None)

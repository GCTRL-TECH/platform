"""Connection helpers (src/netutil.py): credentials never reach the log, the
Redis client survives a Redis restart, and the Qdrant key is optional."""

import socket
import threading

from src import netutil


class TestRedactUrl:
    def test_password_is_masked(self):
        assert netutil.redact_url("redis://default:s3cret@gctrl-redis:6379") == \
            "redis://default:***@gctrl-redis:6379"

    def test_empty_user_with_password(self):
        assert netutil.redact_url("redis://:s3cret@redis:6379/0") == "redis://:***@redis:6379/0"

    def test_token_only_userinfo_is_masked(self):
        assert netutil.redact_url("https://ghp_token@github.com/x") == "https://***@github.com/x"

    def test_password_containing_at_sign(self):
        out = netutil.redact_url("postgresql://GCTRL:p@ss@postgres:5432/GCTRL")
        assert out == "postgresql://GCTRL:***@postgres:5432/GCTRL"
        assert "ss" not in out.split("@", 1)[0]

    def test_url_without_credentials_is_unchanged(self):
        for url in ("redis://redis:6379", "http://qdrant:6333", "bolt://neo4j:7687", ""):
            assert netutil.redact_url(url) == url

    def test_url_inside_message(self):
        msg = "Error connecting to redis://default:pw@gctrl-redis:6379. Connection refused."
        assert netutil.redact_url(msg) == \
            "Error connecting to redis://default:***@gctrl-redis:6379. Connection refused."

    def test_non_string_input(self):
        assert netutil.redact_url(None) == "None"


class TestQdrantKey:
    def test_empty_key_sends_no_header(self):
        assert netutil.qdrant_headers("") == {}
        assert netutil.qdrant_headers(None) == {}
        assert netutil.qdrant_client_kwargs("") == {}

    def test_key_sets_header_and_client_kwarg(self):
        assert netutil.qdrant_headers("k1") == {"api-key": "k1"}
        assert netutil.qdrant_client_kwargs(" k1 ") == {"api_key": "k1"}


def _fake_redis(drop_first_after: int):
    """Minimal RESP server. The first client connection is closed after it has
    answered `drop_first_after` data commands (handshake and health-check PINGs
    do not count), which simulates a Redis restart; later connections are served
    normally. Returns (port, received_data_commands)."""
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    received: list[str] = []

    def read_command(f):
        line = f.readline()
        if not line:
            return None
        n = int(line[1:].strip())
        parts = []
        for _ in range(n):
            size = int(f.readline()[1:].strip())
            parts.append(f.read(size + 2)[:-2].decode())
        return parts

    def serve(conn, limit):
        f = conn.makefile("rb")
        answered = 0
        try:
            while True:
                cmd = read_command(f)
                if cmd is None:
                    return
                name = cmd[0].upper()
                if name == "CLIENT":
                    conn.sendall(b"+OK\r\n")
                    continue
                if name == "PING":
                    conn.sendall(b"+PONG\r\n")
                    continue
                received.append(name)
                conn.sendall(b":1\r\n")
                answered += 1
                if limit is not None and answered >= limit:
                    return
        except OSError:
            return
        finally:
            conn.close()

    def accept_loop():
        first = True
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            limit = drop_first_after if first else None
            first = False
            threading.Thread(target=serve, args=(conn, limit), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    return srv.getsockname()[1], received


class TestRedisReconnect:
    def test_client_has_health_check_and_retry(self):
        r = netutil.redis_client("redis://localhost:6379")
        kw = r.connection_pool.connection_kwargs
        assert kw["health_check_interval"] > 0
        assert kw["retry"] is not None
        assert kw["retry_on_error"]

    def test_command_after_server_drop_succeeds(self):
        port, received = _fake_redis(drop_first_after=1)
        r = netutil.redis_client(f"redis://127.0.0.1:{port}")
        assert r.llen("kex:jobs") == 1
        # The server has now closed the pooled connection (Redis restart).
        assert r.lpush("kex:jobs", "payload") == 1
        assert received == ["LLEN", "LPUSH"]

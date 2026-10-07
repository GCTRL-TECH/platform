"""Connection helpers shared by the worker: credential-safe logging, a Redis
client that survives a Redis restart, and the optional Qdrant API key.

Kept free of heavy imports so it can be unit-tested on its own.
"""

import re

# scheme://userinfo@  (userinfo greedy up to the LAST '@' before the path, so an
# unencoded '@' inside the password is masked too).
_CRED_RE = re.compile(r"(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*://)(?P<userinfo>[^/\s]*)@")


def redact_url(value) -> str:
    """Mask credentials in every URL inside `value`: scheme://user:***@host.
    A userinfo without ':' (a bare token) becomes ***. Text without credentials
    is returned unchanged. Use it whenever a URL or an error mentioning one is
    logged or returned."""
    text = str(value)

    def _mask(m: re.Match) -> str:
        user, sep, _pw = m.group("userinfo").partition(":")
        masked = f"{user}:***" if sep else "***"
        return f"{m.group('scheme')}{masked}@"

    return _CRED_RE.sub(_mask, text)


def redis_client(url: str):
    """Redis client that recovers from a Redis restart on its own: idle pooled
    connections are PINGed before reuse (health_check_interval) and a command
    hitting a dropped connection is retried on a fresh one instead of failing
    (which used to lose job results published right after a restart)."""
    import redis as redis_lib
    from redis.backoff import ExponentialBackoff
    from redis.retry import Retry

    return redis_lib.from_url(
        url,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_keepalive=True,
        health_check_interval=30,
        retry=Retry(ExponentialBackoff(cap=5, base=0.5), 3),
        retry_on_error=[redis_lib.exceptions.ConnectionError, redis_lib.exceptions.TimeoutError],
    )


def qdrant_headers(api_key) -> dict:
    """HTTP headers for raw Qdrant REST calls. Empty key = no header (unchanged
    behaviour for installs without QDRANT_API_KEY)."""
    key = (api_key or "").strip()
    return {"api-key": key} if key else {}


def qdrant_client_kwargs(api_key) -> dict:
    """Extra QdrantClient(...) kwargs. Empty key = none."""
    key = (api_key or "").strip()
    return {"api_key": key} if key else {}

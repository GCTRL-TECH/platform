"""Small, dependency-free time helpers.

Kept separate from main.py (which has heavy top-level imports — redis,
fastapi, qdrant_client — that aren't installed in every environment, e.g. the
unit-test sandbox) so this logic stays importable and testable in isolation.
"""

from datetime import datetime


def iso_to_ms(value: str | None) -> int | None:
    """Parse an ISO-8601 timestamp (as emitted by serde_json for a Rust
    `chrono::DateTime<Utc>`, e.g. "2024-01-01T00:00:00Z") into epoch
    milliseconds — the same format Neo4j's `timestamp()` produces for
    `asserted_at`, so `_source_doc_modified_at` can be compared against it
    directly. Returns None on missing/unparseable input (non-fatal: the edge
    just gets no `_source_doc_modified_at`, same as before this field existed).
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return None

import os

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://neo4j:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379")

# PostgreSQL (direct psycopg2 — for authoritative jobs.status updates)
PG_URL: str = os.environ.get("PG_URL", "postgresql://GCTRL:GCTRL@postgres:5432/GCTRL")

PORT = int(os.environ.get("PORT", "4020"))
SIMILARITY_THRESHOLD = float(os.environ.get("SIMILARITY_THRESHOLD", "0.85"))
RESOLVER_URL = os.environ.get("RESOLVER_URL", "http://resolver:8080")

"""
KEX Service Configuration
"""

import os

# Ollama LLM backend
OLLAMA_BASE: str = os.environ.get("OLLAMA_BASE", "http://host.docker.internal:11434")
RELEX_MODEL: str = os.environ.get("RELEX_MODEL", "llama3.2")

# Neo4j graph database
NEO4J_URI: str = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER: str = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD: str = os.environ.get("NEO4J_PASSWORD", "password")

# Redis job queue
REDIS_URL: str = os.environ.get("REDIS_URL", "redis://localhost:6379")

# Server port
PORT: int = int(os.environ.get("PORT", "4010"))

# Qdrant vector store
QDRANT_URL: str = os.environ.get("QDRANT_URL", "http://qdrant:6333")
QDRANT_COLLECTION: str = os.environ.get("QDRANT_COLLECTION", "GCTRL_chunks")

# Embedding model (Ollama)
EMBEDDING_MODEL: str = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text")

# PostgreSQL (direct psycopg2 — for text_chunks table)
PG_URL: str = os.environ.get("PG_URL", "postgresql://GCTRL:GCTRL@postgres:5432/GCTRL")

# Worker threads (adjustable via Redis key kex:config:threads)
WORKER_THREADS: int = int(os.environ.get("KEX_WORKER_THREADS", "1"))

# GLiNER model
GLINER_MODEL: str = os.environ.get("GLINER_MODEL", "urchade/gliner_medium-v2.1")

# Kept for backward compat - unused with GLiNER
NER_MODEL: str = os.environ.get("NER_MODEL", "dslim/bert-base-NER")

# Default entity types for GLiNER zero-shot NER.
# These are sent as labels to GLiNER at inference time.
# Users can override/extend these per extraction request.
DEFAULT_ENTITY_TYPES: list[str] = [
    # People & Roles
    "person", "politician", "scientist", "artist", "athlete", "author",
    "musician", "actor", "director", "entrepreneur", "military person",
    # Organizations
    "company", "organization", "government agency", "political party",
    "university", "research institute", "nonprofit", "sports team",
    "military organization", "religious organization",
    # Locations
    "country", "city", "state", "region", "continent",
    "mountain", "river", "lake", "ocean", "island",
    "building", "airport", "bridge", "stadium",
    # Temporal
    "date", "time period", "historical event", "holiday",
    # Creative Works
    "book", "film", "song", "album", "tv show", "newspaper",
    "magazine", "software", "video game", "artwork", "patent",
    # Science & Technology
    "chemical compound", "disease", "medical treatment", "drug",
    "biological process", "gene", "protein", "species",
    "technology", "programming language", "algorithm",
    # Products & Commerce
    "product", "brand", "currency", "cryptocurrency",
    # Legal & Political
    "law", "treaty", "court case", "regulation", "policy",
    # Quantitative
    "quantity", "percentage", "monetary value",
    # Abstract concepts
    "scientific theory", "philosophical concept", "religion",
    "language", "award", "degree", "certification",
    # Infrastructure
    "vehicle", "weapon", "spacecraft", "ship",
    "food", "material", "mineral",
]

# Wikidata QID mapping for entity types.
# Maps GLiNER label -> (Wikidata QID, human-readable label).
# This covers the default types above + common variations.
WIKIDATA_TYPE_MAP: dict[str, dict[str, str]] = {
    # People
    "person":               {"qid": "Q5",         "label": "human"},
    "politician":           {"qid": "Q82955",     "label": "politician"},
    "scientist":            {"qid": "Q901",       "label": "scientist"},
    "artist":               {"qid": "Q483501",    "label": "artist"},
    "athlete":              {"qid": "Q2066131",   "label": "athlete"},
    "author":               {"qid": "Q36180",     "label": "writer"},
    "musician":             {"qid": "Q639669",    "label": "musician"},
    "actor":                {"qid": "Q33999",     "label": "actor"},
    "director":             {"qid": "Q2526255",   "label": "film director"},
    "entrepreneur":         {"qid": "Q131524",    "label": "entrepreneur"},
    "military person":      {"qid": "Q47064",     "label": "military personnel"},
    # Organizations
    "company":              {"qid": "Q4830453",   "label": "business"},
    "organization":         {"qid": "Q43229",     "label": "organization"},
    "government agency":    {"qid": "Q327333",    "label": "government agency"},
    "political party":      {"qid": "Q7278",      "label": "political party"},
    "university":           {"qid": "Q3918",      "label": "university"},
    "research institute":   {"qid": "Q31855",     "label": "research institute"},
    "nonprofit":            {"qid": "Q163740",    "label": "nonprofit organization"},
    "sports team":          {"qid": "Q12973014",  "label": "sports team"},
    "military organization":{"qid": "Q176799",    "label": "military unit"},
    "religious organization":{"qid":"Q1530022",   "label": "religious organization"},
    # Locations
    "country":              {"qid": "Q6256",      "label": "country"},
    "city":                 {"qid": "Q515",       "label": "city"},
    "state":                {"qid": "Q7275",      "label": "state"},
    "region":               {"qid": "Q82794",     "label": "geographic region"},
    "continent":            {"qid": "Q5107",      "label": "continent"},
    "mountain":             {"qid": "Q8502",      "label": "mountain"},
    "river":                {"qid": "Q4022",      "label": "river"},
    "lake":                 {"qid": "Q23397",     "label": "lake"},
    "ocean":                {"qid": "Q9430",      "label": "ocean"},
    "island":               {"qid": "Q23442",     "label": "island"},
    "building":             {"qid": "Q41176",     "label": "building"},
    "airport":              {"qid": "Q1248784",   "label": "airport"},
    "bridge":               {"qid": "Q12280",     "label": "bridge"},
    "stadium":              {"qid": "Q483110",    "label": "stadium"},
    "location":             {"qid": "Q17334923",  "label": "location"},
    # Temporal
    "date":                 {"qid": "Q205892",    "label": "calendar date"},
    "time period":          {"qid": "Q186081",    "label": "time interval"},
    "historical event":     {"qid": "Q13418847",  "label": "historical event"},
    "holiday":              {"qid": "Q1445650",   "label": "holiday"},
    "event":                {"qid": "Q1656682",   "label": "event"},
    # Creative Works
    "book":                 {"qid": "Q571",       "label": "book"},
    "film":                 {"qid": "Q11424",     "label": "film"},
    "song":                 {"qid": "Q7366",      "label": "song"},
    "album":                {"qid": "Q482994",    "label": "album"},
    "tv show":              {"qid": "Q5398426",   "label": "television series"},
    "newspaper":            {"qid": "Q11032",     "label": "newspaper"},
    "magazine":             {"qid": "Q41298",     "label": "magazine"},
    "software":             {"qid": "Q7397",      "label": "software"},
    "video game":           {"qid": "Q7889",      "label": "video game"},
    "artwork":              {"qid": "Q838948",    "label": "work of art"},
    "patent":               {"qid": "Q253623",    "label": "patent"},
    # Science & Tech
    "chemical compound":    {"qid": "Q11173",     "label": "chemical compound"},
    "disease":              {"qid": "Q12136",     "label": "disease"},
    "medical treatment":    {"qid": "Q179661",    "label": "treatment"},
    "drug":                 {"qid": "Q12140",     "label": "medication"},
    "biological process":   {"qid": "Q2996394",   "label": "biological process"},
    "gene":                 {"qid": "Q7187",      "label": "gene"},
    "protein":              {"qid": "Q8054",      "label": "protein"},
    "species":              {"qid": "Q7432",      "label": "species"},
    "technology":           {"qid": "Q11016",     "label": "technology"},
    "programming language": {"qid": "Q9143",      "label": "programming language"},
    "algorithm":            {"qid": "Q8366",      "label": "algorithm"},
    # Products & Commerce
    "product":              {"qid": "Q2424752",   "label": "product"},
    "brand":                {"qid": "Q431289",    "label": "brand"},
    "currency":             {"qid": "Q8142",      "label": "currency"},
    "cryptocurrency":       {"qid": "Q13479982",  "label": "cryptocurrency"},
    # Legal
    "law":                  {"qid": "Q7748",      "label": "law"},
    "treaty":               {"qid": "Q131569",    "label": "treaty"},
    "court case":           {"qid": "Q2334719",   "label": "legal case"},
    "regulation":           {"qid": "Q1725664",   "label": "regulation"},
    "policy":               {"qid": "Q1156854",   "label": "policy"},
    # Quantitative
    "quantity":             {"qid": "Q309314",    "label": "quantity"},
    "percentage":           {"qid": "Q11229",     "label": "percentage"},
    "monetary value":       {"qid": "Q1368",      "label": "money"},
    # Abstract
    "scientific theory":    {"qid": "Q17737",     "label": "theory"},
    "philosophical concept":{"qid": "Q151885",    "label": "concept"},
    "religion":             {"qid": "Q9174",      "label": "religion"},
    "language":             {"qid": "Q34770",     "label": "language"},
    "award":                {"qid": "Q618779",    "label": "award"},
    "degree":               {"qid": "Q189533",    "label": "academic degree"},
    "certification":        {"qid": "Q584698",    "label": "certification"},
    # Infrastructure
    "vehicle":              {"qid": "Q42889",     "label": "vehicle"},
    "weapon":               {"qid": "Q728",       "label": "weapon"},
    "spacecraft":           {"qid": "Q40218",     "label": "spacecraft"},
    "ship":                 {"qid": "Q11446",     "label": "ship"},
    "food":                 {"qid": "Q2095",      "label": "food"},
    "material":             {"qid": "Q214609",    "label": "material"},
    "mineral":              {"qid": "Q7946",      "label": "mineral"},
    # Legacy compat (old BERT labels)
    "PER":                  {"qid": "Q5",         "label": "human"},
    "LOC":                  {"qid": "Q17334923",  "label": "location"},
    "ORG":                  {"qid": "Q43229",     "label": "organization"},
    "MISC":                 {"qid": "Q35120",     "label": "entity"},
}


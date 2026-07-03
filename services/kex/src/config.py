"""
KEX Service Configuration
"""

import os

# Ollama LLM backend
OLLAMA_BASE: str = os.environ.get("OLLAMA_BASE", "http://host.docker.internal:11434")
# Relation-extraction model. qwen2.5:7b (4.7 GB, ~6 GB RAM resident) is the
# selected winner: closed-vocab + direction-enforced prompt + validation yields
# relation F1 ~0.86 on the gold set vs ~0.45 for the old free-form llama3.2.
# OUT-OF-THE-BOX: no manual pull needed. KEX warms this model on startup AND
# relex.py self-heals (pulls on a 404, one-time) on the first extraction, so a
# fresh install produces linked graphs with zero setup. See bench/kex/REPORT.md.
RELEX_MODEL: str = os.environ.get("RELEX_MODEL", "qwen2.5:7b")

# Lighter fallback relation model. If the primary model can't run on this host
# (OOM / crashed Ollama runner) or can't be pulled, relex falls back to this one
# (1.9 GB, ~3 GB RAM) so modest machines still get relations out of the box.
RELEX_FALLBACK_MODEL: str = os.environ.get("RELEX_FALLBACK_MODEL", "qwen2.5:3b")

# Recursive gap-fill: after the first relation pass, re-target entities left
# ISOLATED (in the text but in no relation) with a focused second pass, so the
# per-document graph comes out CONNECTED instead of a cloud of orphan nodes. Each
# pass is one extra LLM call and only fires when isolated important entities remain
# → cheap on already-connected docs, recall boost on under-connected ones. Bound the
# passes for speed. Set RELEX_GAPFILL_ENABLED=false to restore single-pass behavior.
RELEX_GAPFILL_ENABLED: bool = os.environ.get("RELEX_GAPFILL_ENABLED", "true").lower() in ("1", "true", "yes")
RELEX_GAPFILL_MAX_PASSES: int = int(os.environ.get("RELEX_GAPFILL_MAX_PASSES", "2"))

# Windowed relation extraction: instead of hard-truncating at RELEX_WINDOW_CHARS,
# the extractor slides a sentence-snapped window over the FULL document text so
# relations in the second half of a long CV, contract, or report are not silently
# dropped. RELEX_MAX_WINDOWS caps the total number of LLM calls per document
# (first N windows kept; a warning is logged for the skipped tail fraction).
# RELEX_MIN_CONFIDENCE: triples below this score are dropped after validation
# (0.0 = off; a value like 0.5 rejects triples that needed both a direction-flip
# and a normalization repair).
RELEX_WINDOW_CHARS: int = int(os.environ.get("KEX_RELEX_WINDOW", "6000"))
RELEX_MAX_WINDOWS: int = int(os.environ.get("KEX_RELEX_MAX_WINDOWS", "8"))
RELEX_MIN_CONFIDENCE: float = float(os.environ.get("KEX_MIN_RELATION_CONFIDENCE", "0.0"))

# Max tokens the relation model may generate per window (Ollama `num_predict`).
# A long document (e.g. a dense CV/resume) can legitimately need 20+ relation
# triples in one window; at 1024 the JSON array was observed to truncate
# mid-object, which made the parser return an empty list for the ENTIRE window
# (round-1 error analysis, FM-2). Raised to 2048 as the new default; still
# overridable per-install for very constrained hosts.
RELEX_NUM_PREDICT: int = int(os.environ.get("RELEX_NUM_PREDICT", "2048"))

# Graph pruning: GLiNER over-extracts — it promotes emotions ("Cool"), generic nouns
# ("software", "box"), and sentence fragments to entities, which become thousands of
# ORPHAN graph nodes that add nothing (they stay searchable in the vector store either
# way). When enabled, a non-core entity is written to the GRAPH only if it participates
# in ≥1 relation; core named entities (person/organization/location/work) are always
# kept even if isolated. This is a GRAPH-only filter — entities remain in chunks/vectors
# for retrieval, so nothing is lost to search. Set false to write every entity as a node.
GRAPH_PRUNE_ISOLATED: bool = os.environ.get("GRAPH_PRUNE_ISOLATED", "true").lower() in ("1", "true", "yes")
GRAPH_KEEP_TYPES: set = {"person", "organization", "location", "work"}

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

# Embedding provider: "ollama" | "nim" | "openai"
EMBEDDING_PROVIDER: str = os.environ.get("EMBEDDING_PROVIDER", "ollama")
EMBEDDING_MODEL: str = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text")
EMBEDDING_BASE_URL: str = os.environ.get("EMBEDDING_BASE_URL", "")
EMBEDDING_API_KEY: str = os.environ.get("EMBEDDING_API_KEY", "")

# PostgreSQL (direct psycopg2 — for text_chunks table)
PG_URL: str = os.environ.get("PG_URL", "postgresql://GCTRL:GCTRL@postgres:5432/GCTRL")

# Worker threads (adjustable via Redis key kex:config:threads)
WORKER_THREADS: int = int(os.environ.get("KEX_WORKER_THREADS", "1"))

# GLiNER model
GLINER_MODEL: str = os.environ.get("GLINER_MODEL", "urchade/gliner_medium-v2.1")

# Kept for backward compat - unused with GLiNER
NER_MODEL: str = os.environ.get("NER_MODEL", "dslim/bert-base-NER")

# Default entity types for GLiNER zero-shot NER (403 encyclopedic types).
# These are sent as labels to GLiNER at inference time.
# Users can override/extend these per extraction request.
# Sweet-spot size: GLiNER batches at 20 labels per call -> 21 batches per chunk
# (CPU-tractable, ~1-2 min per typical document).
DEFAULT_ENTITY_TYPES: list[str] = [
    # ---- People & Roles (47) ----
    "person", "politician", "scientist", "artist", "athlete", "author",
    "musician", "actor", "director", "entrepreneur", "military person",
    "engineer", "doctor", "lawyer", "judge", "teacher", "professor",
    "journalist", "philosopher", "mathematician", "physicist", "chemist",
    "biologist", "economist", "psychologist", "architect", "designer",
    "photographer", "composer", "painter", "sculptor", "dancer",
    "chef", "nurse", "dentist", "veterinarian", "pilot", "astronaut",
    "soldier", "monarch", "president", "prime minister", "senator",
    "mayor", "diplomat", "spy", "criminal",
    # ---- Organizations (40) ----
    "company", "organization", "government agency", "political party",
    "university", "research institute", "nonprofit", "sports team",
    "military organization", "religious organization",
    "bank", "hospital", "school", "public library", "museum", "theater",
    "restaurant", "hotel", "factory", "farm", "embassy", "club",
    "association", "union", "foundation", "think tank", "law firm",
    "publishing house", "record label", "broadcasting company",
    "news agency", "social media platform", "website", "podcast",
    "search engine", "operating system", "database", "marketplace",
    "retail chain", "data center",
    # ---- Locations & Geography (60) ----
    "country", "city", "state", "region", "continent",
    "mountain", "river", "lake", "ocean", "island",
    "building", "airport", "bridge", "stadium",
    "village", "town", "county", "district", "neighborhood", "suburb",
    "capital", "port", "beach", "desert", "forest", "valley",
    "plateau", "peninsula", "archipelago", "sea", "bay", "strait",
    "canal", "dam", "waterfall", "reservoir", "glacier", "volcano",
    "cave", "cliff", "hill", "mountain range", "plain", "wetland",
    "oasis", "geographical feature", "address", "monument", "memorial",
    "statue", "square", "park", "garden", "zoo", "theme park",
    "cemetery", "palace", "castle", "fortress", "temple",
    "church", "mosque", "synagogue", "shrine",
    # ---- Temporal (16) ----
    "date", "time period", "historical event", "holiday",
    "century", "decade", "year", "era", "age", "period", "season",
    "festival", "anniversary", "ceremony", "month", "day",
    # ---- Creative Works (54) ----
    "book", "film", "song", "album", "tv show", "newspaper",
    "magazine", "software", "video game", "artwork", "patent",
    "novel", "poem", "short story", "essay", "biography", "diary",
    "manuscript", "comic book", "graphic novel", "manga", "screenplay",
    "play", "opera", "ballet", "musical", "symphony", "concerto",
    "sonata", "anthem", "podcast episode", "documentary", "animation",
    "cartoon", "sculpture", "painting", "drawing", "photograph",
    "mural", "mosaic", "tapestry", "pottery", "fashion design",
    "costume", "choreography", "recipe", "board game", "card game",
    "video game franchise", "mobile app", "web app", "plugin",
    "software library", "software framework",
    # ---- Science & Technology (52) ----
    "chemical compound", "disease", "medical treatment", "drug",
    "biological process", "gene", "protein", "species",
    "technology", "programming language", "algorithm",
    "chemical element", "molecule", "cell", "organ", "organism",
    "virus", "bacterium", "fungus", "plant", "animal", "ecosystem",
    "biome", "theory", "hypothesis", "equation", "formula",
    "law of physics", "constant", "unit of measurement",
    "scientific instrument", "telescope", "microscope", "satellite",
    "rocket", "robot", "drone", "vehicle model", "aircraft model",
    "locomotive", "machine", "tool", "sensor", "processor",
    "integrated circuit", "computer", "smartphone", "server",
    "network protocol", "encryption algorithm", "machine learning model",
    "experiment",
    # ---- Medical & Health (24) ----
    "symptom", "syndrome", "anatomical part", "body system",
    "surgical procedure", "diagnostic test", "therapy", "vaccine",
    "antibiotic", "painkiller", "medical device", "prosthetic",
    "implant", "mental health condition", "addiction", "allergy",
    "injury", "infection", "epidemic", "pandemic", "healthcare system",
    "clinical trial", "medical specialty", "hospital department",
    # ---- Business & Finance (28) ----
    "product", "brand", "currency", "cryptocurrency",
    "stock", "bond", "derivative", "mutual fund", "hedge fund",
    "venture capital firm", "private equity firm", "startup",
    "corporation", "exchange", "market index", "commodity",
    "contract", "invoice", "tax", "tariff", "subsidy", "grant",
    "loan", "mortgage", "credit card", "payment system",
    "accounting standard", "insurance plan",
    # ---- Legal & Political (23) ----
    "law", "treaty", "court case", "regulation", "policy",
    "constitution", "statute", "amendment", "executive order",
    "lawsuit", "verdict", "prison", "courthouse", "election",
    "referendum", "campaign", "political ideology",
    "international organization", "sanction", "war",
    "peace agreement", "military operation", "terrorist attack",
    # ---- Quantitative (8) ----
    "quantity", "percentage", "monetary value", "measurement",
    "ratio", "statistic", "probability", "trend",
    # ---- Abstract Concepts (20) ----
    "scientific theory", "philosophical concept", "religion",
    "language", "award", "degree", "certification",
    "emotion", "ideology", "methodology", "principle", "belief",
    "cultural concept", "ritual", "tradition", "taboo", "mythology",
    "legend", "folktale", "proverb",
    # ---- Infrastructure & Transport (28) ----
    "vehicle", "weapon", "spacecraft", "ship",
    "food", "material", "mineral",
    "road", "highway", "railway", "subway", "tram", "pipeline",
    "power plant", "electrical grid", "telecommunications tower",
    "warehouse", "shipping container", "freight train", "cargo ship",
    "oil tanker", "aircraft carrier", "submarine", "helicopter",
    "balloon", "motorcycle", "train",
]

# Wikidata QID mapping for entity types.
# Maps GLiNER label -> (Wikidata QID, human-readable label).
# This covers the default types above + common variations.
# Q35120 ("entity") is used as a safe fallback for very generic concepts.
WIKIDATA_TYPE_MAP: dict[str, dict[str, str]] = {
    # ---- People & Roles ----
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
    "engineer":             {"qid": "Q81096",     "label": "engineer"},
    "doctor":               {"qid": "Q39631",     "label": "physician"},
    "lawyer":               {"qid": "Q40348",     "label": "lawyer"},
    "judge":                {"qid": "Q16533",     "label": "judge"},
    "teacher":              {"qid": "Q37226",     "label": "teacher"},
    "professor":            {"qid": "Q121594",    "label": "professor"},
    "journalist":           {"qid": "Q1930187",   "label": "journalist"},
    "philosopher":          {"qid": "Q4964182",   "label": "philosopher"},
    "mathematician":        {"qid": "Q170790",    "label": "mathematician"},
    "physicist":            {"qid": "Q169470",    "label": "physicist"},
    "chemist":              {"qid": "Q593644",    "label": "chemist"},
    "biologist":            {"qid": "Q864503",    "label": "biologist"},
    "economist":            {"qid": "Q188094",    "label": "economist"},
    "psychologist":         {"qid": "Q212980",    "label": "psychologist"},
    "architect":            {"qid": "Q42973",     "label": "architect"},
    "designer":             {"qid": "Q5322166",   "label": "designer"},
    "photographer":         {"qid": "Q33231",     "label": "photographer"},
    "composer":             {"qid": "Q36834",     "label": "composer"},
    "painter":              {"qid": "Q1028181",   "label": "painter"},
    "sculptor":             {"qid": "Q1281618",   "label": "sculptor"},
    "dancer":               {"qid": "Q5716684",   "label": "dancer"},
    "chef":                 {"qid": "Q3499072",   "label": "chef"},
    "cook":                 {"qid": "Q156839",    "label": "cook"},
    "surgeon":              {"qid": "Q774306",    "label": "surgeon"},
    "nurse":                {"qid": "Q186360",    "label": "nurse"},
    "dentist":              {"qid": "Q27349",     "label": "dentist"},
    "veterinarian":         {"qid": "Q202883",    "label": "veterinarian"},
    "pilot":                {"qid": "Q2095549",   "label": "aircraft pilot"},
    "astronaut":            {"qid": "Q11631",     "label": "astronaut"},
    "soldier":              {"qid": "Q4991371",   "label": "soldier"},
    "general":              {"qid": "Q83460",     "label": "general"},
    "admiral":              {"qid": "Q96000",     "label": "admiral"},
    "monarch":              {"qid": "Q116",       "label": "monarch"},
    "king":                 {"qid": "Q12097",     "label": "king"},
    "queen":                {"qid": "Q116050",    "label": "queen regnant"},
    "prince":               {"qid": "Q177092",    "label": "prince"},
    "princess":             {"qid": "Q189898",    "label": "princess"},
    "emperor":              {"qid": "Q39018",     "label": "emperor"},
    "dictator":             {"qid": "Q193391",    "label": "dictator"},
    "president":            {"qid": "Q30461",     "label": "president"},
    "prime minister":       {"qid": "Q14212",     "label": "prime minister"},
    "senator":              {"qid": "Q15686806",  "label": "senator"},
    "mayor":                {"qid": "Q30185",     "label": "mayor"},
    "governor":             {"qid": "Q132050",    "label": "governor"},
    "ambassador":           {"qid": "Q121998",    "label": "ambassador"},
    "diplomat":             {"qid": "Q193391",    "label": "diplomat"},
    "spy":                  {"qid": "Q3287074",   "label": "spy"},
    "criminal":             {"qid": "Q2159907",   "label": "criminal"},
    "victim":               {"qid": "Q35120",     "label": "victim"},
    "witness":              {"qid": "Q35120",     "label": "witness"},
    # ---- Organizations ----
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
    "bank":                 {"qid": "Q22687",     "label": "bank"},
    "hospital":             {"qid": "Q16917",     "label": "hospital"},
    "school":               {"qid": "Q3914",      "label": "school"},
    "public library":       {"qid": "Q7075",      "label": "library"},
    "museum":               {"qid": "Q33506",     "label": "museum"},
    "theater":              {"qid": "Q24354",     "label": "theatre"},
    "restaurant":           {"qid": "Q11707",     "label": "restaurant"},
    "hotel":                {"qid": "Q27686",     "label": "hotel"},
    "factory":              {"qid": "Q83405",     "label": "factory"},
    "mine":                 {"qid": "Q820477",    "label": "mine"},
    "farm":                 {"qid": "Q131596",    "label": "farm"},
    "embassy":              {"qid": "Q3917681",   "label": "embassy"},
    "consulate":            {"qid": "Q1146997",   "label": "consulate"},
    "ngo":                  {"qid": "Q79913",     "label": "non-governmental organization"},
    "club":                 {"qid": "Q988108",    "label": "club"},
    "association":          {"qid": "Q48204",     "label": "association"},
    "union":                {"qid": "Q178790",    "label": "trade union"},
    "cooperative":          {"qid": "Q4539",      "label": "cooperative"},
    "foundation":           {"qid": "Q157031",    "label": "foundation"},
    "charity":              {"qid": "Q708676",    "label": "charitable organization"},
    "think tank":           {"qid": "Q1043741",   "label": "think tank"},
    "law firm":             {"qid": "Q613142",    "label": "law firm"},
    "consulting firm":      {"qid": "Q1058914",   "label": "consulting firm"},
    "design studio":        {"qid": "Q35120",     "label": "design studio"},
    "advertising agency":   {"qid": "Q611917",    "label": "advertising agency"},
    "publishing house":     {"qid": "Q2085381",   "label": "publisher"},
    "record label":         {"qid": "Q18127",     "label": "record label"},
    "broadcasting company": {"qid": "Q1644575",   "label": "broadcaster"},
    "news agency":          {"qid": "Q192283",    "label": "news agency"},
    "social media platform":{"qid": "Q202833",    "label": "social media"},
    "website":              {"qid": "Q35127",     "label": "website"},
    "blog":                 {"qid": "Q30849",     "label": "blog"},
    "podcast":              {"qid": "Q24634210",  "label": "podcast"},
    "youtube channel":      {"qid": "Q17456832",  "label": "YouTube channel"},
    "search engine":        {"qid": "Q19832",     "label": "search engine"},
    "browser":              {"qid": "Q6368",      "label": "web browser"},
    "operating system":     {"qid": "Q9135",      "label": "operating system"},
    "database":             {"qid": "Q8513",      "label": "database"},
    "marketplace":          {"qid": "Q330284",    "label": "marketplace"},
    "retail chain":         {"qid": "Q507619",    "label": "retail chain"},
    # ---- Locations & Geography ----
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
    "village":              {"qid": "Q532",       "label": "village"},
    "town":                 {"qid": "Q3957",      "label": "town"},
    "county":               {"qid": "Q28575",     "label": "county"},
    "district":             {"qid": "Q149621",    "label": "district"},
    "neighborhood":         {"qid": "Q123705",    "label": "neighborhood"},
    "suburb":               {"qid": "Q188509",    "label": "suburb"},
    "capital":              {"qid": "Q5119",      "label": "capital"},
    "port":                 {"qid": "Q44782",     "label": "port"},
    "harbor":               {"qid": "Q283202",    "label": "harbor"},
    "beach":                {"qid": "Q40080",     "label": "beach"},
    "desert":               {"qid": "Q8514",      "label": "desert"},
    "forest":               {"qid": "Q4421",      "label": "forest"},
    "jungle":               {"qid": "Q39594",     "label": "jungle"},
    "valley":               {"qid": "Q39816",     "label": "valley"},
    "plateau":              {"qid": "Q75520",     "label": "plateau"},
    "peninsula":            {"qid": "Q34763",     "label": "peninsula"},
    "archipelago":          {"qid": "Q33837",     "label": "archipelago"},
    "sea":                  {"qid": "Q165",       "label": "sea"},
    "bay":                  {"qid": "Q39594",     "label": "bay"},
    "strait":               {"qid": "Q37901",     "label": "strait"},
    "channel":              {"qid": "Q1322134",   "label": "channel"},
    "canal":                {"qid": "Q12284",     "label": "canal"},
    "dam":                  {"qid": "Q12323",     "label": "dam"},
    "waterfall":            {"qid": "Q34038",     "label": "waterfall"},
    "reservoir":            {"qid": "Q131681",    "label": "reservoir"},
    "glacier":              {"qid": "Q35666",     "label": "glacier"},
    "volcano":              {"qid": "Q8072",      "label": "volcano"},
    "cave":                 {"qid": "Q35509",     "label": "cave"},
    "cliff":                {"qid": "Q19967801",  "label": "cliff"},
    "hill":                 {"qid": "Q54050",     "label": "hill"},
    "mountain range":       {"qid": "Q46831",     "label": "mountain range"},
    "plain":                {"qid": "Q160091",    "label": "plain"},
    "prairie":              {"qid": "Q335322",    "label": "prairie"},
    "tundra":               {"qid": "Q43262",     "label": "tundra"},
    "savanna":              {"qid": "Q42320",     "label": "savanna"},
    "wetland":              {"qid": "Q170321",    "label": "wetland"},
    "oasis":                {"qid": "Q43742",     "label": "oasis"},
    "geographical feature": {"qid": "Q618123",    "label": "geographical feature"},
    "address":              {"qid": "Q319608",    "label": "address"},
    "building complex":     {"qid": "Q1497375",   "label": "building complex"},
    "monument":             {"qid": "Q4989906",   "label": "monument"},
    "memorial":             {"qid": "Q5003624",   "label": "memorial"},
    "statue":               {"qid": "Q179700",    "label": "statue"},
    "fountain":             {"qid": "Q483453",    "label": "fountain"},
    "square":               {"qid": "Q174782",    "label": "town square"},
    "park":                 {"qid": "Q22698",     "label": "park"},
    "garden":               {"qid": "Q1107656",   "label": "garden"},
    "zoo":                  {"qid": "Q43501",     "label": "zoo"},
    "aquarium":             {"qid": "Q1546461",   "label": "aquarium"},
    "theme park":           {"qid": "Q12029365",  "label": "theme park"},
    "cemetery":             {"qid": "Q39614",     "label": "cemetery"},
    "palace":               {"qid": "Q16560",     "label": "palace"},
    "castle":               {"qid": "Q23413",     "label": "castle"},
    "fortress":             {"qid": "Q57831",     "label": "fortress"},
    "temple":               {"qid": "Q44539",     "label": "temple"},
    "church":               {"qid": "Q16970",     "label": "church building"},
    "mosque":               {"qid": "Q32815",     "label": "mosque"},
    "synagogue":            {"qid": "Q34627",     "label": "synagogue"},
    "shrine":               {"qid": "Q697295",    "label": "shrine"},
    "mausoleum":            {"qid": "Q381885",    "label": "mausoleum"},
    # ---- Temporal ----
    "date":                 {"qid": "Q205892",    "label": "calendar date"},
    "time period":          {"qid": "Q186081",    "label": "time interval"},
    "historical event":     {"qid": "Q13418847",  "label": "historical event"},
    "holiday":              {"qid": "Q1445650",   "label": "holiday"},
    "event":                {"qid": "Q1656682",   "label": "event"},
    "century":              {"qid": "Q578",       "label": "century"},
    "decade":               {"qid": "Q39911",     "label": "decade"},
    "year":                 {"qid": "Q577",       "label": "year"},
    "month":                {"qid": "Q5151",      "label": "month"},
    "week":                 {"qid": "Q23387",     "label": "week"},
    "day":                  {"qid": "Q573",       "label": "day"},
    "hour":                 {"qid": "Q25235",     "label": "hour"},
    "era":                  {"qid": "Q6428674",   "label": "era"},
    "age":                  {"qid": "Q11471",     "label": "age"},
    "period":               {"qid": "Q11514315",  "label": "historical period"},
    "season":               {"qid": "Q10688145",  "label": "season"},
    "festival":             {"qid": "Q132241",    "label": "festival"},
    "anniversary":          {"qid": "Q209893",    "label": "anniversary"},
    "birthday":             {"qid": "Q47223",     "label": "birthday"},
    "ceremony":             {"qid": "Q2627975",   "label": "ceremony"},
    # ---- Creative Works ----
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
    "novel":                {"qid": "Q8261",      "label": "novel"},
    "poem":                 {"qid": "Q5185279",   "label": "poem"},
    "short story":          {"qid": "Q49084",     "label": "short story"},
    "essay":                {"qid": "Q35760",     "label": "essay"},
    "biography":            {"qid": "Q36279",     "label": "biography"},
    "memoir":               {"qid": "Q467461",    "label": "memoir"},
    "diary":                {"qid": "Q185598",    "label": "diary"},
    "manuscript":           {"qid": "Q87167",     "label": "manuscript"},
    "comic book":           {"qid": "Q1004",      "label": "comic book"},
    "graphic novel":        {"qid": "Q725377",    "label": "graphic novel"},
    "manga":                {"qid": "Q8274",      "label": "manga"},
    "screenplay":           {"qid": "Q40093",     "label": "screenplay"},
    "play":                 {"qid": "Q25379",     "label": "play"},
    "opera":                {"qid": "Q1344",      "label": "opera"},
    "ballet":               {"qid": "Q131084",    "label": "ballet"},
    "musical":              {"qid": "Q2743",      "label": "musical"},
    "symphony":             {"qid": "Q46395",     "label": "symphony"},
    "concerto":             {"qid": "Q164136",    "label": "concerto"},
    "sonata":               {"qid": "Q5311",      "label": "sonata"},
    "hymn":                 {"qid": "Q484692",    "label": "hymn"},
    "anthem":               {"qid": "Q484692",    "label": "anthem"},
    "jingle":               {"qid": "Q1320115",   "label": "jingle"},
    "podcast episode":      {"qid": "Q61855877",  "label": "podcast episode"},
    "documentary":          {"qid": "Q93204",     "label": "documentary film"},
    "animation":            {"qid": "Q11425",     "label": "animation"},
    "cartoon":              {"qid": "Q627603",    "label": "cartoon"},
    "sculpture":            {"qid": "Q860861",    "label": "sculpture"},
    "painting":             {"qid": "Q3305213",   "label": "painting"},
    "drawing":              {"qid": "Q93184",     "label": "drawing"},
    "photograph":           {"qid": "Q125191",    "label": "photograph"},
    "mural":                {"qid": "Q219423",    "label": "mural"},
    "mosaic":               {"qid": "Q133067",    "label": "mosaic"},
    "tapestry":             {"qid": "Q184296",    "label": "tapestry"},
    "ceramic":              {"qid": "Q45621",     "label": "ceramic art"},
    "pottery":              {"qid": "Q11642",     "label": "pottery"},
    "fashion design":       {"qid": "Q3661311",   "label": "fashion design"},
    "costume":              {"qid": "Q2207288",   "label": "costume"},
    "choreography":         {"qid": "Q830200",    "label": "choreography"},
    "recipe":               {"qid": "Q177439",    "label": "recipe"},
    "board game":           {"qid": "Q131436",    "label": "board game"},
    "card game":            {"qid": "Q142714",    "label": "card game"},
    "role playing game":    {"qid": "Q4951328",   "label": "role-playing game"},
    "video game franchise": {"qid": "Q7058673",   "label": "video game series"},
    "app":                  {"qid": "Q166142",    "label": "application software"},
    "mobile app":           {"qid": "Q620615",    "label": "mobile app"},
    "web app":              {"qid": "Q193424",    "label": "web application"},
    "plugin":               {"qid": "Q184148",    "label": "plug-in"},
    "software library":     {"qid": "Q188860",    "label": "software library"},
    "framework":            {"qid": "Q271680",    "label": "software framework"},
    "sdk":                  {"qid": "Q467707",    "label": "software development kit"},
    # ---- Science & Technology ----
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
    "chemical element":     {"qid": "Q11344",     "label": "chemical element"},
    "molecule":             {"qid": "Q11369",     "label": "molecule"},
    "cell":                 {"qid": "Q7868",      "label": "cell"},
    "organ":                {"qid": "Q712378",    "label": "organ"},
    "organism":             {"qid": "Q7239",      "label": "organism"},
    "virus":                {"qid": "Q808",       "label": "virus"},
    "bacterium":            {"qid": "Q10876",     "label": "bacterium"},
    "fungus":               {"qid": "Q764",       "label": "fungus"},
    "plant":                {"qid": "Q756",       "label": "plant"},
    "animal":               {"qid": "Q729",       "label": "animal"},
    "ecosystem":            {"qid": "Q37813",     "label": "ecosystem"},
    "biome":                {"qid": "Q101998",    "label": "biome"},
    "theory":               {"qid": "Q17737",     "label": "theory"},
    "hypothesis":           {"qid": "Q41719",     "label": "hypothesis"},
    "equation":             {"qid": "Q11345",     "label": "equation"},
    "formula":              {"qid": "Q976981",    "label": "formula"},
    "law of physics":       {"qid": "Q1151067",   "label": "physical law"},
    "constant":             {"qid": "Q173227",    "label": "physical constant"},
    "unit of measurement":  {"qid": "Q47574",     "label": "unit of measurement"},
    "scientific instrument":{"qid": "Q3099911",   "label": "scientific instrument"},
    "telescope":            {"qid": "Q4213",      "label": "telescope"},
    "microscope":           {"qid": "Q196538",    "label": "microscope"},
    "satellite":            {"qid": "Q26540",     "label": "artificial satellite"},
    "rocket":               {"qid": "Q41291",     "label": "rocket"},
    "robot":                {"qid": "Q11012",     "label": "robot"},
    "drone":                {"qid": "Q21157957",  "label": "unmanned aerial vehicle"},
    "vehicle model":        {"qid": "Q3231690",   "label": "automobile model"},
    "aircraft model":       {"qid": "Q15056995",  "label": "aircraft model"},
    "train":                {"qid": "Q870",       "label": "train"},
    "locomotive":           {"qid": "Q93301",     "label": "locomotive"},
    "machine":              {"qid": "Q11019",     "label": "machine"},
    "tool":                 {"qid": "Q39546",     "label": "tool"},
    "sensor":               {"qid": "Q167676",    "label": "sensor"},
    "processor":            {"qid": "Q5300",      "label": "central processing unit"},
    "integrated circuit":   {"qid": "Q80831",     "label": "integrated circuit"},
    "transistor":           {"qid": "Q5339",      "label": "transistor"},
    "computer":             {"qid": "Q68",        "label": "computer"},
    "smartphone":           {"qid": "Q22645",     "label": "smartphone"},
    "tablet":               {"qid": "Q155972",    "label": "tablet computer"},
    "server":               {"qid": "Q44127",     "label": "server"},
    "network protocol":     {"qid": "Q132364",    "label": "communication protocol"},
    "encryption algorithm": {"qid": "Q141090",    "label": "encryption"},
    "data structure":       {"qid": "Q175263",    "label": "data structure"},
    "software framework":   {"qid": "Q271680",    "label": "software framework"},
    "design pattern":       {"qid": "Q623950",    "label": "software design pattern"},
    "programming paradigm": {"qid": "Q188267",    "label": "programming paradigm"},
    "dataset":              {"qid": "Q1172284",   "label": "data set"},
    "machine learning model":{"qid":"Q21198",     "label": "machine learning"},
    "neural network architecture":{"qid":"Q1882",  "label": "neural network"},
    "scientific method":    {"qid": "Q7748",      "label": "scientific method"},
    "experiment":           {"qid": "Q101965",    "label": "experiment"},
    # ---- Medical & Health ----
    "symptom":              {"qid": "Q169872",    "label": "symptom"},
    "syndrome":             {"qid": "Q179630",    "label": "syndrome"},
    "anatomical part":      {"qid": "Q4936952",   "label": "anatomical structure"},
    "body system":          {"qid": "Q281643",    "label": "biological system"},
    "surgical procedure":   {"qid": "Q40855",     "label": "surgery"},
    "diagnostic test":      {"qid": "Q2576666",   "label": "diagnostic test"},
    "therapy":              {"qid": "Q179661",    "label": "therapy"},
    "vaccine":              {"qid": "Q134808",    "label": "vaccine"},
    "antibiotic":           {"qid": "Q12187",     "label": "antibiotic"},
    "painkiller":           {"qid": "Q165247",    "label": "analgesic"},
    "supplement":           {"qid": "Q900948",    "label": "dietary supplement"},
    "medical device":       {"qid": "Q1183543",   "label": "medical device"},
    "prosthetic":           {"qid": "Q500834",    "label": "prosthesis"},
    "implant":              {"qid": "Q11427986",  "label": "medical implant"},
    "mental health condition":{"qid":"Q12135",    "label": "mental disorder"},
    "addiction":            {"qid": "Q12029",     "label": "addiction"},
    "allergy":              {"qid": "Q154430",    "label": "allergy"},
    "injury":               {"qid": "Q193078",    "label": "injury"},
    "fracture":             {"qid": "Q180844",    "label": "bone fracture"},
    "infection":            {"qid": "Q166231",    "label": "infection"},
    "epidemic":             {"qid": "Q44512",     "label": "epidemic"},
    "pandemic":             {"qid": "Q12184",     "label": "pandemic"},
    "public health initiative":{"qid":"Q189603",  "label": "public health"},
    "healthcare system":    {"qid": "Q7196997",   "label": "health care system"},
    "insurance plan":       {"qid": "Q219577",    "label": "insurance"},
    "clinical trial":       {"qid": "Q30612",     "label": "clinical trial"},
    "medical specialty":    {"qid": "Q930752",    "label": "medical specialty"},
    "hospital department":  {"qid": "Q3469910",   "label": "hospital department"},
    "ambulance":            {"qid": "Q180481",    "label": "ambulance"},
    "defibrillator":        {"qid": "Q190095",    "label": "defibrillator"},
    # ---- Business & Finance ----
    "product":              {"qid": "Q2424752",   "label": "product"},
    "brand":                {"qid": "Q431289",    "label": "brand"},
    "currency":             {"qid": "Q8142",      "label": "currency"},
    "cryptocurrency":       {"qid": "Q13479982",  "label": "cryptocurrency"},
    "stock":                {"qid": "Q169489",    "label": "stock"},
    "bond":                 {"qid": "Q133156",    "label": "bond"},
    "derivative":           {"qid": "Q650241",    "label": "derivative"},
    "mutual fund":          {"qid": "Q580750",    "label": "mutual fund"},
    "etf":                  {"qid": "Q1059721",   "label": "exchange-traded fund"},
    "hedge fund":           {"qid": "Q190165",    "label": "hedge fund"},
    "venture capital firm": {"qid": "Q925242",    "label": "venture capital"},
    "private equity firm":  {"qid": "Q827810",    "label": "private equity"},
    "startup":              {"qid": "Q3553344",   "label": "startup company"},
    "corporation":          {"qid": "Q167037",    "label": "corporation"},
    "llc":                  {"qid": "Q207320",    "label": "limited liability company"},
    "partnership":          {"qid": "Q380767",    "label": "partnership"},
    "sole proprietorship":  {"qid": "Q1141395",   "label": "sole proprietorship"},
    "exchange":             {"qid": "Q11691",     "label": "stock exchange"},
    "market index":         {"qid": "Q187289",    "label": "stock market index"},
    "commodity":            {"qid": "Q317088",    "label": "commodity"},
    "contract":             {"qid": "Q2659904",   "label": "contract"},
    "invoice":              {"qid": "Q189533",    "label": "invoice"},
    "receipt":              {"qid": "Q1318381",   "label": "receipt"},
    "tax":                  {"qid": "Q8161",      "label": "tax"},
    "fee":                  {"qid": "Q1340111",   "label": "fee"},
    "tariff":               {"qid": "Q166032",    "label": "tariff"},
    "subsidy":              {"qid": "Q321294",    "label": "subsidy"},
    "grant":                {"qid": "Q230788",    "label": "grant"},
    "loan":                 {"qid": "Q170518",    "label": "loan"},
    "mortgage":             {"qid": "Q156165",    "label": "mortgage loan"},
    "credit card":          {"qid": "Q161380",    "label": "credit card"},
    "debit card":           {"qid": "Q1141518",   "label": "debit card"},
    "payment system":       {"qid": "Q1148747",   "label": "payment system"},
    "accounting standard":  {"qid": "Q752266",    "label": "accounting standard"},
    # ---- Legal & Political ----
    "law":                  {"qid": "Q7748",      "label": "law"},
    "treaty":               {"qid": "Q131569",    "label": "treaty"},
    "court case":           {"qid": "Q2334719",   "label": "legal case"},
    "regulation":           {"qid": "Q1725664",   "label": "regulation"},
    "policy":               {"qid": "Q1156854",   "label": "policy"},
    "constitution":         {"qid": "Q7755",      "label": "constitution"},
    "statute":              {"qid": "Q820655",    "label": "statute"},
    "ordinance":            {"qid": "Q3329948",   "label": "ordinance"},
    "amendment":            {"qid": "Q189290",    "label": "amendment"},
    "executive order":      {"qid": "Q737498",    "label": "executive order"},
    "lawsuit":              {"qid": "Q327954",    "label": "lawsuit"},
    "plaintiff":            {"qid": "Q1234287",   "label": "plaintiff"},
    "defendant":            {"qid": "Q1233144",   "label": "defendant"},
    "verdict":              {"qid": "Q187685",    "label": "verdict"},
    "sentence":             {"qid": "Q1148747",   "label": "sentence"},
    "prison":               {"qid": "Q40357",     "label": "prison"},
    "jail":                 {"qid": "Q40357",     "label": "jail"},
    "courthouse":           {"qid": "Q1137809",   "label": "courthouse"},
    "election":             {"qid": "Q40231",     "label": "election"},
    "referendum":           {"qid": "Q43109",     "label": "referendum"},
    "campaign":             {"qid": "Q11642595",  "label": "political campaign"},
    "political ideology":   {"qid": "Q12909644",  "label": "political ideology"},
    "international organization":{"qid":"Q484652","label": "international organization"},
    "sanction":             {"qid": "Q192778",    "label": "sanctions"},
    "embargo":              {"qid": "Q166032",    "label": "embargo"},
    "war":                  {"qid": "Q198",       "label": "war"},
    "peace agreement":      {"qid": "Q1141795",   "label": "peace treaty"},
    "military operation":   {"qid": "Q645883",    "label": "military operation"},
    "terrorist attack":     {"qid": "Q2223653",   "label": "terrorist attack"},
    # ---- Quantitative ----
    "quantity":             {"qid": "Q309314",    "label": "quantity"},
    "percentage":           {"qid": "Q11229",     "label": "percentage"},
    "monetary value":       {"qid": "Q1368",      "label": "money"},
    "measurement":          {"qid": "Q12453",     "label": "measurement"},
    "ratio":                {"qid": "Q183047",    "label": "ratio"},
    "statistic":            {"qid": "Q1949963",   "label": "statistic"},
    "probability":          {"qid": "Q9492",      "label": "probability"},
    "average":              {"qid": "Q40348",     "label": "average"},
    "median":               {"qid": "Q189572",    "label": "median"},
    "percentile":           {"qid": "Q703675",    "label": "percentile"},
    "trend":                {"qid": "Q35120",     "label": "trend"},
    # ---- Abstract Concepts ----
    "scientific theory":    {"qid": "Q17737",     "label": "theory"},
    "philosophical concept":{"qid": "Q151885",    "label": "concept"},
    "religion":             {"qid": "Q9174",      "label": "religion"},
    "language":             {"qid": "Q34770",     "label": "language"},
    "award":                {"qid": "Q618779",    "label": "award"},
    "degree":               {"qid": "Q189533",    "label": "academic degree"},
    "certification":        {"qid": "Q584698",    "label": "certification"},
    "emotion":              {"qid": "Q9415",      "label": "emotion"},
    "virtue":               {"qid": "Q157811",    "label": "virtue"},
    "vice":                 {"qid": "Q157826",    "label": "vice"},
    "ideology":             {"qid": "Q7257",      "label": "ideology"},
    "methodology":          {"qid": "Q1799072",   "label": "method"},
    "principle":            {"qid": "Q211364",    "label": "principle"},
    "value":                {"qid": "Q3769299",   "label": "value"},
    "belief":               {"qid": "Q572289",    "label": "belief"},
    "cultural concept":     {"qid": "Q11042",     "label": "culture"},
    "ritual":               {"qid": "Q54989",     "label": "ritual"},
    "custom":               {"qid": "Q1299714",   "label": "custom"},
    "tradition":            {"qid": "Q82821",     "label": "tradition"},
    "taboo":                {"qid": "Q183205",    "label": "taboo"},
    "mythology":            {"qid": "Q9134",      "label": "mythology"},
    "legend":               {"qid": "Q47461344",  "label": "legend"},
    "folktale":             {"qid": "Q35958",     "label": "folktale"},
    "fairy tale":           {"qid": "Q699",       "label": "fairy tale"},
    "parable":              {"qid": "Q484328",    "label": "parable"},
    "proverb":              {"qid": "Q35102",     "label": "proverb"},
    "slogan":               {"qid": "Q49084",     "label": "slogan"},
    # ---- Infrastructure & Transport ----
    "vehicle":              {"qid": "Q42889",     "label": "vehicle"},
    "weapon":               {"qid": "Q728",       "label": "weapon"},
    "spacecraft":           {"qid": "Q40218",     "label": "spacecraft"},
    "ship":                 {"qid": "Q11446",     "label": "ship"},
    "food":                 {"qid": "Q2095",      "label": "food"},
    "material":             {"qid": "Q214609",    "label": "material"},
    "mineral":              {"qid": "Q7946",      "label": "mineral"},
    "road":                 {"qid": "Q34442",     "label": "road"},
    "highway":              {"qid": "Q313146",    "label": "highway"},
    "railway":              {"qid": "Q728937",    "label": "railway line"},
    "subway":               {"qid": "Q5503",      "label": "rapid transit"},
    "tram":                 {"qid": "Q3407658",   "label": "tram"},
    "bus route":            {"qid": "Q1761607",   "label": "bus route"},
    "bicycle path":         {"qid": "Q1267305",   "label": "cycling infrastructure"},
    "pipeline":             {"qid": "Q193760",    "label": "pipeline transport"},
    "power plant":          {"qid": "Q159719",    "label": "power station"},
    "electrical grid":      {"qid": "Q221708",    "label": "electrical grid"},
    "water treatment":      {"qid": "Q610533",    "label": "water treatment"},
    "sewer system":         {"qid": "Q855947",    "label": "sanitary sewer"},
    "telecommunications tower":{"qid":"Q3220391", "label": "telecommunications tower"},
    "internet exchange":    {"qid": "Q1411356",   "label": "internet exchange point"},
    "data center":          {"qid": "Q182018",    "label": "data center"},
    "warehouse":            {"qid": "Q181623",    "label": "warehouse"},
    "shipping container":   {"qid": "Q244337",    "label": "shipping container"},
    "freight train":        {"qid": "Q1361322",   "label": "freight train"},
    "cargo ship":            {"qid": "Q105999",   "label": "cargo ship"},
    "oil tanker":           {"qid": "Q14970",     "label": "oil tanker"},
    "aircraft carrier":     {"qid": "Q17205",     "label": "aircraft carrier"},
    "submarine":            {"qid": "Q2811",      "label": "submarine"},
    "helicopter":           {"qid": "Q34486",     "label": "helicopter"},
    "balloon":              {"qid": "Q200923",    "label": "balloon"},
    "motorcycle":           {"qid": "Q34493",     "label": "motorcycle"},
    # ---- Legacy compat (old BERT labels) ----
    "PER":                  {"qid": "Q5",         "label": "human"},
    "LOC":                  {"qid": "Q17334923",  "label": "location"},
    "ORG":                  {"qid": "Q43229",     "label": "organization"},
    "MISC":                 {"qid": "Q35120",     "label": "entity"},
}


# ── COARSE TYPE VOCABULARY ────────────────────────────────────────────────────
# A small CLOSED set of buckets used as the STABLE merge-blocking key.
#
# Problem solved: GLiNER assigns ~403 fine labels and the fine Wikidata QID
# lands in each entity's `type`. The same real entity ("Ground Control") gets a
# DIFFERENT QID per document (software Q7397 / framework Q271680 / library
# Q188860 / organization Q43229 / product Q2424752 / …), so the merger's
# same-`type` blocking rule never collapses the duplicates. Bucketing every
# fine label into one of these coarse types — and blocking on the bucket — lets
# the merger see "all of these are the same kind of thing" while the precise
# fine QID stays on the node as metadata.
#
# Buckets (12):
#   person        — humans and human roles
#   organization  — companies, institutions, teams, agencies
#   location      — places, geography, structures-as-places
#   technology    — software / hardware / products / brands / methods / IT
#                   concepts (DELIBERATELY broad: software∪framework∪library∪
#                   product∪tool∪platform∪database∪language all collapse here,
#                   which is exactly what un-fragments "Ground Control").
#   work          — creative/published works (book, film, song, artwork, patent…)
#   event         — happenings (war, election, conference, historical event…)
#   field         — abstract concepts, disciplines, ideologies, languages,
#                   theories, awards, certifications, biological/medical concepts
#   temporal      — dates, years, periods, eras
#   financial     — money, currency, securities, taxes, payment instruments
#   quantity      — numeric measurements, percentages, statistics, ratios
#   other         — anything unmapped (safe catch-all)
#
# (No standalone "product" bucket: products and technologies fragment into each
# other constantly in real extractions, so they share one bucket. No standalone
# "medical" bucket for the same reason — diseases/drugs/anatomy live under
# `field`, devices/equipment under `technology`.)
COARSE_TYPES: list[str] = [
    "person", "organization", "location", "technology", "work",
    "event", "field", "temporal", "financial", "quantity", "other",
]

# Map of lowercased label -> coarse bucket. Keyed on BOTH the GLiNER label
# (DEFAULT_ENTITY_TYPES) AND the human-readable Wikidata `label` produced by
# WIKIDATA_TYPE_MAP, because:
#   * the live KEX path has `gliner_label` available (preferred key), but
#   * old nodes / backfill only persisted the human `label`.
# Covering both vocabularies in one dict means a single lookup works for either.
# Anything not present falls back to "other".
COARSE_MAP: dict[str, str] = {}


def _coarse_register(bucket: str, labels: list[str]) -> None:
    for lab in labels:
        COARSE_MAP[lab.lower()] = bucket


# person — humans + human roles (gliner labels + their human-label synonyms)
_coarse_register("person", [
    "person", "per", "human", "politician", "scientist", "artist", "athlete",
    "author", "writer", "musician", "actor", "director", "film director",
    "entrepreneur", "military person", "military personnel", "engineer",
    "doctor", "physician", "lawyer", "judge", "teacher", "professor",
    "journalist", "philosopher", "mathematician", "physicist", "chemist",
    "biologist", "economist", "psychologist", "architect", "designer",
    "photographer", "composer", "painter", "sculptor", "dancer", "chef",
    "cook", "surgeon", "nurse", "dentist", "veterinarian", "pilot",
    "aircraft pilot", "astronaut", "soldier", "general", "admiral", "monarch",
    "king", "queen", "queen regnant", "prince", "princess", "emperor",
    "dictator", "president", "prime minister", "senator", "mayor", "governor",
    "ambassador", "diplomat", "spy", "criminal", "victim", "witness",
    "plaintiff", "defendant", "founder", "ceo", "researcher",
])

# organization — collective bodies
_coarse_register("organization", [
    "company", "business", "organization", "org", "government agency",
    "political party", "university", "research institute", "nonprofit",
    "nonprofit organization", "non-governmental organization", "ngo",
    "sports team", "military organization", "military unit",
    "religious organization", "bank", "hospital", "school", "public library",
    "library", "museum", "theater", "theatre", "restaurant", "hotel",
    "factory", "mine", "farm", "embassy", "consulate", "club", "association",
    "union", "trade union", "cooperative", "foundation", "charity",
    "charitable organization", "think tank", "law firm", "consulting firm",
    "design studio", "advertising agency", "publishing house", "publisher",
    "record label", "broadcasting company", "broadcaster", "news agency",
    "corporation", "llc", "limited liability company", "partnership",
    "sole proprietorship", "startup", "startup company",
    "venture capital firm", "venture capital", "private equity firm",
    "private equity", "hedge fund", "team",
])

# location — places + geography + structures regarded as places
_coarse_register("location", [
    "country", "city", "state", "region", "geographic region", "continent",
    "mountain", "river", "lake", "ocean", "island", "building", "airport",
    "bridge", "stadium", "location", "loc", "village", "town", "county",
    "district", "neighborhood", "suburb", "capital", "port", "harbor",
    "beach", "desert", "forest", "jungle", "valley", "plateau", "peninsula",
    "archipelago", "sea", "bay", "strait", "channel", "canal", "dam",
    "waterfall", "reservoir", "glacier", "volcano", "cave", "cliff", "hill",
    "mountain range", "plain", "prairie", "tundra", "savanna", "wetland",
    "oasis", "geographical feature", "address", "building complex",
    "monument", "memorial", "statue", "fountain", "square", "town square",
    "park", "garden", "zoo", "aquarium", "theme park", "cemetery", "palace",
    "castle", "fortress", "temple", "church", "church building", "mosque",
    "synagogue", "shrine", "mausoleum", "courthouse", "prison", "jail",
    "data center", "warehouse", "power plant", "power station",
    "telecommunications tower", "internet exchange point", "place",
    # linear / transport infrastructure — treated as places on the map
    "road", "highway", "railway", "railway line", "subway", "rapid transit",
    "tram", "bus route", "bicycle path", "cycling infrastructure", "pipeline",
    "pipeline transport", "electrical grid", "water treatment", "sewer system",
    "sanitary sewer",
])

# technology — software, hardware, products, brands, methods, IT artefacts.
# Intentionally the BROADEST bucket: this is where "Ground Control"'s many
# fine types (software / framework / library / product / organization-as-tool)
# converge so the merger can finally collapse them.
_coarse_register("technology", [
    "software", "video game", "mobile app", "app", "application software",
    "web app", "web application", "plugin", "plug-in", "software library",
    "software framework", "framework", "sdk", "software development kit",
    "technology", "programming language", "algorithm", "machine", "tool",
    "sensor", "processor", "central processing unit", "integrated circuit",
    "transistor", "computer", "smartphone", "tablet", "tablet computer",
    "server", "network protocol", "communication protocol",
    "encryption algorithm", "encryption", "data structure", "design pattern",
    "software design pattern", "programming paradigm", "dataset", "data set",
    "machine learning model", "machine learning",
    "neural network architecture", "neural network", "robot", "drone",
    "unmanned aerial vehicle", "satellite", "artificial satellite",
    "telescope", "microscope", "scientific instrument", "rocket",
    "spacecraft", "operating system", "database", "marketplace",
    "retail chain", "website", "blog", "podcast", "youtube channel",
    "search engine", "browser", "web browser", "social media platform",
    "social media", "product", "brand", "vehicle", "vehicle model",
    "automobile model", "aircraft model", "aircraft", "ship", "cargo ship",
    "oil tanker", "aircraft carrier", "submarine", "helicopter", "balloon",
    "motorcycle", "train", "locomotive", "freight train", "weapon",
    "material", "mineral", "food", "medical device", "prosthetic",
    "prosthesis", "implant", "medical implant", "defibrillator", "ambulance",
    "scientific method", "methodology", "method", "experiment",
    "diagnostic test", "shipping container", "tool",
])

# work — creative / published / intellectual-property works
_coarse_register("work", [
    "book", "film", "song", "album", "tv show", "television series",
    "newspaper", "magazine", "artwork", "work of art", "patent", "novel",
    "poem", "short story", "essay", "biography", "memoir", "diary",
    "manuscript", "comic book", "graphic novel", "manga", "screenplay",
    "play", "opera", "ballet", "musical", "symphony", "concerto", "sonata",
    "hymn", "anthem", "jingle", "podcast episode", "documentary",
    "documentary film", "animation", "cartoon", "sculpture", "painting",
    "drawing", "photograph", "mural", "mosaic", "tapestry", "ceramic",
    "ceramic art", "pottery", "fashion design", "costume", "choreography",
    "recipe", "board game", "card game", "role playing game",
    "role-playing game", "video game franchise", "video game series",
    "slogan", "proverb", "parable", "fairy tale", "folktale", "legend",
])

# event — discrete happenings
_coarse_register("event", [
    "historical event", "event", "holiday", "festival", "anniversary",
    "birthday", "ceremony", "war", "peace agreement", "peace treaty",
    "military operation", "terrorist attack", "election", "referendum",
    "campaign", "political campaign", "epidemic", "pandemic",
    "clinical trial", "lawsuit", "court case", "legal case",
])

# field — abstract concepts, disciplines, ideologies, languages, theories,
# qualifications, and biomedical/scientific concepts (non-device).
_coarse_register("field", [
    "scientific theory", "theory", "philosophical concept", "concept",
    "religion", "language", "award", "degree", "academic degree",
    "certification", "emotion", "virtue", "vice", "ideology",
    "political ideology", "principle", "value", "belief", "cultural concept",
    "culture", "ritual", "custom", "tradition", "taboo", "mythology",
    "hypothesis", "equation", "formula", "law of physics", "physical law",
    "constant", "physical constant", "unit of measurement", "law", "treaty",
    "regulation", "policy", "constitution", "statute", "ordinance",
    "amendment", "executive order", "verdict", "sentence",
    "international organization", "sanction", "sanctions", "embargo",
    "chemical compound", "disease", "medical treatment", "treatment", "drug",
    "medication", "biological process", "gene", "protein", "species",
    "chemical element", "molecule", "cell", "organ", "organism", "virus",
    "bacterium", "fungus", "plant", "animal", "ecosystem", "biome",
    "symptom", "syndrome", "anatomical part", "anatomical structure",
    "body system", "biological system", "surgical procedure", "surgery",
    "therapy", "vaccine", "antibiotic", "painkiller", "analgesic",
    "supplement", "dietary supplement", "mental health condition",
    "mental disorder", "addiction", "allergy", "injury", "fracture",
    "bone fracture", "infection", "public health initiative", "public health",
    "healthcare system", "health care system", "medical specialty",
    "hospital department", "accounting standard",
])

# temporal — time points / spans
_coarse_register("temporal", [
    "date", "calendar date", "time period", "time interval", "century",
    "decade", "year", "month", "week", "day", "hour", "era", "age", "period",
    "historical period", "season",
])

# financial — money, securities, financial instruments
_coarse_register("financial", [
    "currency", "cryptocurrency", "stock", "bond", "derivative",
    "mutual fund", "etf", "exchange-traded fund", "exchange", "stock exchange",
    "market index", "stock market index", "commodity", "contract", "invoice",
    "receipt", "tax", "fee", "tariff", "subsidy", "grant", "loan", "mortgage",
    "mortgage loan", "credit card", "debit card", "payment system",
    "monetary value", "money", "insurance plan", "insurance",
])

# quantity — bare numbers / measurements / statistics
_coarse_register("quantity", [
    "quantity", "percentage", "measurement", "ratio", "statistic",
    "probability", "average", "median", "percentile", "trend",
])


def coarse_for(gliner_label: str = "", human_label: str = "") -> str:
    """Resolve an entity's coarse bucket.

    Tries the GLiNER label first (live KEX path), then the human Wikidata label
    (backfill / old nodes that only persisted `label`). Falls back to "other".
    """
    for key in (gliner_label, human_label):
        if key:
            bucket = COARSE_MAP.get(str(key).strip().lower())
            if bucket:
                return bucket
    return "other"


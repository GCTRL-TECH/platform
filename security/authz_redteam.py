#!/usr/bin/env python3
"""Adversarial authorization red-team suite.

The invariant: NO token, prompt, or tool argument can widen a caller's grant. This
seeds a CONFIDENTIAL entity + dossier owned by the operator, then hammers every
read tool with a LOW-clearance token and asserts it can NEVER see the confidential
data — while a HIGH-clearance token can (control, so we know the fix didn't just
break everything). Exit non-zero on ANY leak → wire into CI / pre-deploy gate.

Env: GCTRL_API_URL (default http://localhost:4000/api), JWT_SECRET, OWNER (user uuid),
NEO_CONTAINER (default neo4j), NEO_PW.
"""
import hmac, hashlib, base64, json, os, subprocess, sys, time, urllib.request, urllib.error

API = os.environ.get("GCTRL_API_URL", "http://localhost:4000/api").rstrip("/")
SECRET = os.environ.get("JWT_SECRET", "borghive-dev-jwt-secret-change-in-production").encode()
OWNER = os.environ.get("OWNER", "e5b05d21-a730-4f8c-9d69-47aa9cfcb7ba")
NEO = os.environ.get("NEO_CONTAINER", "neo4j")
NEO_PW = os.environ.get("NEO_PW", "password")

SECRET_ENTITY = "RedteamSecret Zeta"
SECRET_NEIGH = "RedteamClassified Payload"
SECRET_MARKER = "TOPSECRET-CANARY-9f3a2b"  # must never reach a low-clearance reader
CONF_RANK = 50   # the confidential fact's _min_rank
LOW_RANK = 10    # below CONF_RANK → must be denied
HIGH_RANK = 100  # above CONF_RANK → control, must succeed


def mint(rank):
    def b(d): return base64.urlsafe_b64encode(d).rstrip(b"=").decode()
    h = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    # api_key_rank caps get_user_clearance_rank to `rank` — simulates a scoped key.
    p = b(json.dumps({"sub": OWNER, "email": "redteam@test", "role": "user",
                      "clearance": "INTERNAL", "api_key_rank": rank,
                      "iat": now, "exp": now + 3600}).encode())
    sig = b(hmac.new(SECRET, (h + "." + p).encode(), hashlib.sha256).digest())
    return h + "." + p + "." + sig


def cy(stmt):
    subprocess.run(["docker", "exec", NEO, "cypher-shell", "-u", "neo4j", "-p", NEO_PW,
                    "--format", "plain", stmt], capture_output=True, text=True)


def api(path, tok, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{API}{path}", data=data, method=method)
    r.add_header("Content-Type", "application/json")
    r.add_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, str(e)


def agent_tool(name, args, tok):
    return api(f"/agent/tools/{name}", tok, "POST", args)


def seed():
    print("seeding confidential entity + dossier ...")
    cy(f"MERGE (a:Entity {{name:'{SECRET_ENTITY}', user_id:'{OWNER}'}}) "
       f"SET a._owner='{OWNER}', a._min_rank={CONF_RANK}, a._source_job='redteam-job', a.label='project' ")
    cy(f"MERGE (b:Entity {{name:'{SECRET_NEIGH}', user_id:'{OWNER}'}}) "
       f"SET b._owner='{OWNER}', b._min_rank={CONF_RANK}, b._source_job='redteam-job', b.label='thing' ")
    cy(f"MATCH (a:Entity {{name:'{SECRET_ENTITY}',user_id:'{OWNER}'}}), (b:Entity {{name:'{SECRET_NEIGH}',user_id:'{OWNER}'}}) "
       f"MERGE (a)-[r:CONTAINS]->(b) SET r._owner='{OWNER}', r._min_rank={CONF_RANK} ")
    # A dossier for the secret entity, with the canary in the summary.
    ins = (f"INSERT INTO entity_dossiers (user_id, entity_uri, entity_name, summary, archived) "
           f"VALUES ('{OWNER}', 'redteam:{SECRET_ENTITY}', '{SECRET_ENTITY}', "
           f"'{SECRET_MARKER}: this dossier aggregates confidential facts.', false) "
           f"ON CONFLICT (user_id, entity_uri) DO UPDATE SET summary=EXCLUDED.summary, archived=false;")
    subprocess.run(["docker", "exec", "gctrl-postgres", "psql", "-U", "GCTRL", "-d", "GCTRL", "-c", ins],
                   capture_output=True, text=True)


def cleanup():
    cy(f"MATCH (n) WHERE n._source_job='redteam-job' DETACH DELETE n")
    subprocess.run(["docker", "exec", "gctrl-postgres", "psql", "-U", "GCTRL", "-d", "GCTRL", "-c",
                    f"DELETE FROM entity_dossiers WHERE entity_uri='redteam:{SECRET_ENTITY}';"],
                   capture_output=True, text=True)


def leaked(resp_text):
    # A leak = confidential CONTENT the caller never supplied: the dossier canary or
    # the classified neighbour. The requested entity NAME is often echoed back
    # (e.g. get_neighbors' "entity" field, a RAG "not found" message) — that echo is
    # not a leak, so we do NOT flag SECRET_ENTITY here.
    return SECRET_MARKER in resp_text or SECRET_NEIGH in resp_text


def main():
    seed()
    low, high = mint(LOW_RANK), mint(HIGH_RANK)
    fails, checks = [], []

    # (label, call) → each returns (status, text)
    probes = {
        "get_dossier":     lambda t: agent_tool("get_dossier", {"name": SECRET_ENTITY}, t),
        "get_entity":      lambda t: agent_tool("get_entity", {"name": SECRET_ENTITY}, t),
        "search_entities": lambda t: agent_tool("search_entities", {"query": "Redteam"}, t),
        "get_neighbors":   lambda t: agent_tool("get_neighbors", {"name": SECRET_ENTITY}, t),
        "query_rag":       lambda t: api("/rag/query", t, "POST",
                             {"message": f"What is {SECRET_ENTITY}?", "mode": "incognito"}),
    }
    print("\n== LOW-clearance token MUST NOT leak ==")
    for name, call in probes.items():
        _, txt = call(low)
        if leaked(txt):
            fails.append(name); print(f"  LEAK  {name}: confidential data returned to low token!")
        else:
            print(f"  ok    {name}: denied")
        checks.append(name)

    print("\n== HIGH-clearance token control (should SEE it) ==")
    seen_any = False
    for name in ("get_dossier", "get_entity"):
        _, txt = probes[name](high)
        if leaked(txt):
            seen_any = True; print(f"  ok    {name}: visible to high token (control)")
        else:
            print(f"  WARN  {name}: high token did not see it — fix may be over-broad")

    cleanup()
    print("\n" + "=" * 50)
    if fails:
        print(f"RED-TEAM FAILED — {len(fails)} leak(s): {', '.join(fails)}")
        sys.exit(1)
    if not seen_any:
        print("RED-TEAM INCONCLUSIVE — control token saw nothing (seed/visibility issue)")
        sys.exit(2)
    print(f"RED-TEAM PASSED — {len(checks)} tools deny low-clearance access; control sees it.")


if __name__ == "__main__":
    main()

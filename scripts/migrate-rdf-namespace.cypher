// Rewrites historical entity URIs from the legacy borghive.dev namespace
// to the new gctrl.tech namespace. Idempotent — safe to re-run.
//
// Usage:
//   docker exec neo4j cypher-shell -u neo4j -p password \
//     -f /scripts/migrate-rdf-namespace.cypher
//
// To customise the namespaces, edit the two parameters below.
:param old_ns => 'http://borghive.dev/entity/';
:param new_ns => 'http://gctrl.tech/entity/';

// Rewrite Entity.uri
MATCH (n:Entity)
WHERE n.uri STARTS WITH $old_ns
SET n.uri = $new_ns + substring(n.uri, size($old_ns))
RETURN count(n) AS rewritten_entity_uris;

// If any relationships carry a uri property too, rewrite those:
MATCH ()-[r]->()
WHERE r.uri IS NOT NULL AND r.uri STARTS WITH $old_ns
SET r.uri = $new_ns + substring(r.uri, size($old_ns))
RETURN count(r) AS rewritten_relationship_uris;

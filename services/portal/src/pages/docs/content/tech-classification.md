# Classification & Access Control

Every node, edge, and text chunk in GCTRL carries a classification - and every query, retrieval, and agent token is filtered by it, row by row.

## What it does

Data enters GCTRL already tagged with a clearance rank (public, internal, confidential, restricted, or your own custom scheme), inherited from its source or set explicitly. From that point on, **everything** that reads the graph - a human query, a Talk-to-Graph answer, an embedding search, an MCP tool call from an agent - is filtered against the caller's effective clearance before results are assembled. A caller below a record's clearance doesn't get a redacted version of it; the record simply isn't in the result set, as if it didn't exist.

## Why it matters / USP

Most knowledge-graph and RAG tools treat access control as a wrapper: a permissions check bolted on in front of a graph that is itself flat and clearance-blind. GCTRL puts classification **inside the knowledge layer** - clearance is a property of the data itself, enforced at the query engine, not at an API gateway that can be bypassed by talking to the store directly. That is the difference between "our app hides this" and "this cannot be returned."

The practical result is that many people's knowledge can live in **one merged graph** without anyone seeing more than they're cleared for. Two colleagues can run the identical query against the identical compilation and get different, correctly-scoped answers. Access tokens compose the same guarantee for agents: a scoped token sees exactly the clearance and the graphs it was granted, and nothing else exists for it - not "won't fetch," but "not there." And it's not a performance trade-off either: enforcing clearance on every query costs on the order of **0.1 ms** - compliance that doesn't cost latency.

This is the layer that makes GCTRL's positioning as an enterprise, ISO 27001- and TISAX-aware memory tier credible: least-privilege isn't a policy document, it's how the query engine works.

## How it fits

Classification is enforced at every stage that reads the graph - Manage KGs traversal, Talk-to-Graph retrieval, and every MCP tool an external agent calls - so it applies uniformly whether a human or an agent is asking.

## In practice

An internal analyst and a restricted-clearance auditor both query the same merged company graph for a vendor. The analyst sees the public and internal facts on file; the auditor sees those plus the confidential contract terms neither of them had to configure per-query - the clearance on the data and the token decided it.

## See also

[Multi-Agent Fabric](tech-multi-agent-fabric.md) · [Cloaking](tech-cloaking.md) · [Sovereign & On-Prem](tech-sovereign.md)

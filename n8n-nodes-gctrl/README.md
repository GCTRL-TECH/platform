# n8n-nodes-gctrl

n8n community node for [Ground Control (GCTRL)](https://gctrl.tech) - structured knowledge graphs for AI.

Drop any data, get structured knowledge. Extract, query, fuse, and manage knowledge graphs directly from n8n workflows. Use Ground Control as persistent memory for AI agents.

> **Migrating from `n8n-nodes-borghive`?** See [MIGRATION.md](./MIGRATION.md).

## Nodes

### Ground Control
The main node with all operations:
- **Knowledge**: Extract text, store knowledge, upload files, list/get jobs
- **Query**: Ask natural language questions, get graph schema
- **Graph**: List, create, refresh, delete compilations
- **Fusion**: Merge multiple graphs, check fusion jobs
- **Entity**: Search entities by name or type
- **Ontology**: List available ontologies

### Ground Control Trigger
Polling trigger that fires when:
- An extraction job completes
- A fusion job completes
- Any job completes

### Ground Control Memory (AI Agent)
Persistent memory provider for n8n AI Agent nodes. Unlike in-memory stores, Ground Control Memory:
- Survives across workflow executions
- Creates structured entities and embeddings
- Is queryable via natural language
- Can be fused with other knowledge

### Ground Control Knowledge Tool (AI Agent)
Gives AI agents the ability to query Ground Control knowledge graphs as a tool during reasoning. Agents get grounded answers with sources and confidence scores.

## Setup

1. Install the node: `npm install n8n-nodes-gctrl`
2. In n8n, go to Settings > Community Nodes > Install
3. Create a Ground Control API credential with your API URL and key
4. Start using Ground Control nodes in your workflows

## Credentials

- **Base URL**: Your Ground Control API URL (default: `http://localhost:4000`)
- **Auth Method**: API Key or Email/Password
- **API Key**: A Ground Control API key (recommended for production)
- **Email/Password**: Auto-refreshing JWT authentication

## License

MIT

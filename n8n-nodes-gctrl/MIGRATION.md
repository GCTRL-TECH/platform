# Migration Guide: `n8n-nodes-borghive` → `n8n-nodes-gctrl`

The `n8n-nodes-borghive` package was renamed to `n8n-nodes-gctrl` as part of
the BorgHive → Ground Control rebrand. This is a breaking change because
n8n stores workflow node references by package name and node type — the new
package exposes new node type names.

## TL;DR

```bash
# In your n8n instance (Settings > Community Nodes):
npm uninstall n8n-nodes-borghive
npm install n8n-nodes-gctrl
# Then restart n8n
```

## Step-by-step

### 1. Uninstall the old package

In your n8n instance:

- **n8n UI**: Settings → Community Nodes → find `n8n-nodes-borghive` → Uninstall.
- **CLI / Docker**: `npm uninstall -g n8n-nodes-borghive` (or remove it from
  your `~/.n8n/nodes/package.json` and run `npm install` in that folder).

### 2. Install the new package

- **n8n UI**: Settings → Community Nodes → Install → enter `n8n-nodes-gctrl`.
- **CLI / Docker**: `npm install -g n8n-nodes-gctrl`.

### 3. Restart n8n

Required so n8n re-scans the community nodes folder and registers the new
node types.

### 4. Re-select the nodes in existing workflows

Because n8n identifies a node by `package + nodeName`, workflows that
referenced the old `borgHive` / `borgHiveTrigger` / `borgHiveMemory` /
`borgHiveKnowledgeTool` types **will show a "Node not found" placeholder**
after the package switch.

Fix per workflow:
1. Open the workflow.
2. Delete the broken placeholder node.
3. Add the equivalent Ground Control node from the node panel.
4. Re-wire its inputs/outputs to neighbouring nodes.
5. Re-select the existing Ground Control API credential (see step 5).

The node parameter shape is unchanged, so once the new node is dropped in
the same parameter values apply.

### 5. Credentials

The credential type was renamed from `borgHiveApi` to `gctrlApi`, but the
authentication contract did **not** change (same Base URL, API Key, or
Email/Password auth shape).

If you used **API Key** auth, just attach the existing credential record
to the new node — n8n will keep the stored secret. If your existing
credential is still typed as `borgHiveApi` after the migration, create a
new `Ground Control API` credential and copy the values over.

### 6. Verify

A quick smoke test:
1. Drop a `Ground Control` node into a new workflow.
2. Set resource = `Knowledge`, operation = `List Jobs`.
3. Execute. You should see a list of extraction jobs from your API.

## Node name mapping

| Old (`n8n-nodes-borghive`) | New (`n8n-nodes-gctrl`)        |
|----------------------------|--------------------------------|
| BorgHive                   | Ground Control                 |
| BorgHive Trigger           | Ground Control Trigger         |
| BorgHive Memory            | Ground Control Memory          |
| BorgHive Knowledge Tool    | Ground Control Knowledge Tool  |
| BorgHive API (credential)  | Ground Control API (credential)|

## Why a breaking rename instead of a shim?

The npm name and the n8n node identifier are tightly coupled. A shim
package would force every user to keep both names installed forever, and
n8n's node registry would still see two distinct node types — defeating
the rename. A clean break with a clear migration is less long-term debt
than a permanent alias.

The MCP server takes the opposite tradeoff: its tool names are part of a
wire contract with already-deployed `.mcp.json` files, so it keeps
`borghive_*` aliases (logged as deprecated) until v2.

## Questions / issues

File an issue at https://github.com/gctrl/n8n-nodes-gctrl/issues.

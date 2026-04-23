# Rename Plan: GCTRL → Ground Control (GCTRL)

## Scope: 58 files across the codebase

### Rename Rules
| Old | New | Where |
|-----|-----|-------|
| `GCTRL` | `Ground Control` | UI strings, docs, comments |
| `GCTRL` | `gctrl` | Package names, identifiers, URLs |
| `GCTRL` | `GCTRL` | Environment variables |
| `GCTRL-api` | `gctrl-api` | Container names |
| `GCTRL-web` | `gctrl-web` | Container names |
| `GCTRL-kex` | `gctrl-kex` | Container names |
| `GCTRL-fuse` | `gctrl-fuse` | Container names |
| `GCTRL-postgres` | `gctrl-postgres` | Container names |
| `GCTRL-redis` | `gctrl-redis` | Container names |
| `GCTRL_` | `gctrl_` | DB table prefixes, MCP tools |
| `GCTRLApi` | `gctrlApi` | Credential type names |
| `n8n-nodes-GCTRL` | `n8n-nodes-gctrl` | npm package |

### Critical Breaking Changes
1. **Docker volumes** — renaming containers means Docker volumes need migration
2. **MCP tool names** — `GCTRL_extract` → `gctrl_extract` etc. — breaks existing MCP configs
3. **Database** — PostgreSQL database name stays `GCTRL` (no data migration needed)
4. **OAuth redirect URIs** — need updating in Google/Microsoft/Slack/GitHub dev consoles
5. **API endpoints** — stay at `/api/...` (no change needed)

### Recommendation
- Rename in code files (58 files)
- Keep PostgreSQL database name as-is (avoid data migration)
- Provide migration notes for Docker volumes
- Update .mcp.json for Claude Code
- Update CLAUDE.md and CLAUDE-GCTRL.md
- Test everything after rename

### Execute when user is available to verify.


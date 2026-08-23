-- 078: per-access-token "Codebase access" capability.
--
-- code_access = false turns OFF everything code-related for that token:
--   * the agent code tools (code_symbol / code_trace / code_impact /
--     code_architecture) are refused, and the MCP gateway omits them from
--     tools/list so a connecting model never even sees them;
--   * CODE compilations are invisible - dropped from the token's kb grant set,
--     from /kg/compilations, from the agent's list_graphs, and any explicit
--     compilationId read of a CODE graph resolves to "denied" (rank i32::MIN);
--   * code writes are refused (POST /api/kex/code, DELETE /api/kex/code/files).
--
-- Default true: existing tokens and every token created without the flag keep
-- today's behaviour. This is a capability switch, not a security downgrade -
-- turning it OFF only ever removes access.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS code_access BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN api_keys.code_access IS
  'Capability switch: when false this token cannot use the code tools, cannot see CODE compilations, and cannot write code knowledge. Default true (unchanged behaviour).';

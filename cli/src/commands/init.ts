import { Command } from 'commander'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { getApiKey, getApiUrl } from '../config'

/**
 * `gctrl init` - connect the agent in THIS repository to GCTRL in one command.
 *
 * Writes (or merges into) the MCP config file of the chosen client with two servers:
 *   gctrl       the HTTP agent gateway - knowledge tools, scoped to the token
 *   gctrl-code  the published stdio server filtered to the code tools, auto-indexing this
 *               repository at start-up (GCTRL_CODE_AUTO_INDEX=cwd) so the Codebase KB is
 *               there before the agent's first question - indexing must run where the code is.
 * Existing servers in the file are kept; the two GCTRL entries are replaced.
 */
export interface McpConfigInput {
  apiUrl: string      // e.g. https://host/api  (the CLI's apiUrl + /api)
  token: string
  codeFolder?: string // Users/<name>/Code on a shared instance
}

/** Pure builder so tests can pin the shape (see cli/test/init.test.ts). */
export function buildMcpServers(input: McpConfigInput): Record<string, unknown> {
  const api = input.apiUrl.replace(/\/+$/, '')
  return {
    gctrl: {
      type: 'http',
      url: `${api}/agent/mcp`,
      headers: { Authorization: `ApiKey ${input.token}` },
    },
    'gctrl-code': {
      command: 'npx',
      args: ['-y', 'gctrl-mcp'],
      env: {
        GCTRL_API_URL: api,
        GCTRL_API_TOKEN: input.token,
        GCTRL_MCP_TOOLS: 'code',
        GCTRL_CODE_AUTO_INDEX: 'cwd',
        ...(input.codeFolder ? { GCTRL_CODE_FOLDER: input.codeFolder } : {}),
      },
    },
  }
}

/** Merge the GCTRL servers into an existing MCP config document (other servers survive). */
export function mergeMcpConfig(existing: unknown, servers: Record<string, unknown>): Record<string, unknown> {
  const doc = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
  const current = (doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}) as Record<string, unknown>
  return { ...doc, mcpServers: { ...current, ...servers } }
}

const CLIENT_FILES: Record<string, string> = {
  claude: '.mcp.json',            // Claude Code (project scope)
  cursor: path.join('.cursor', 'mcp.json'),
  codex: path.join('.codex', 'mcp.json'),
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Connect the agent in this repository to GCTRL (knowledge + Codebase KB) - writes the MCP config')
    .option('--client <name>', 'claude | cursor | codex (default: claude)', 'claude')
    .option('--token <token>', 'GCTRL access token (default: the one from `gctrl auth login` / GCTRL_API_KEY)')
    .option('--url <url>', 'GCTRL base URL (default: the configured one)')
    .option('--code-folder <path>', 'Folder for the auto-created code graph, e.g. Users/<name>/Code (shared instances)')
    .option('--print', 'Print the config instead of writing it')
    .action((opts: { client: string; token?: string; url?: string; codeFolder?: string; print?: boolean }) => {
      const file = CLIENT_FILES[opts.client]
      if (!file) { console.error(chalk.red(`Unknown client '${opts.client}' (claude | cursor | codex)`)); process.exit(1) }
      const token = opts.token ?? getApiKey()
      if (!token) { console.error(chalk.red('No token. Run `gctrl auth login`, set GCTRL_API_KEY, or pass --token.')); process.exit(1) }
      const base = (opts.url ?? getApiUrl()).replace(/\/+$/, '')
      const apiUrl = base.endsWith('/api') ? base : `${base}/api`
      const servers = buildMcpServers({ apiUrl, token, codeFolder: opts.codeFolder })
      const target = path.resolve(process.cwd(), file)
      let existing: unknown = {}
      if (fs.existsSync(target)) {
        try { existing = JSON.parse(fs.readFileSync(target, 'utf8')) } catch { console.error(chalk.red(`${file} is not valid JSON - fix or remove it first`)); process.exit(1) }
      }
      const merged = mergeMcpConfig(existing, servers)
      const text = JSON.stringify(merged, null, 2) + '\n'
      if (opts.print) { console.log(text); return }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
      console.log(chalk.green(`✓ ${file} written`) + chalk.dim(` - gctrl (gateway) + gctrl-code (stdio, auto-index of ${path.basename(process.cwd())})`))
      console.log(chalk.dim('Restart your agent; it indexes this repository on start-up and follows the GCTRL coding protocol (GET /api/agent/skill.md).'))
      if (!fs.existsSync(path.resolve(process.cwd(), '.git'))) {
        console.log(chalk.yellow('Note: no .git here - auto-index only runs inside a git repository.'))
      }
    })
}

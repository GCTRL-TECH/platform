import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Code2, Terminal, Bot, GitBranch, Zap, MousePointer2, Wind, AppWindow, Github,
  Workflow, Paperclip, Rss, Link2, Layers, Webhook, HardDrive, BookOpen,
  FolderKanban, Globe, FileText, type LucideIcon,
} from 'lucide-react'
import { useScrollReveal } from '@/hooks/useScrollReveal'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'
import { Seo } from '@/components/Seo'

type Category = 'Coding Agents' | 'IDEs' | 'Agent Frameworks' | 'Copilots' | 'Automation' | 'Knowledge Sources'

const CATEGORIES: Category[] = ['Coding Agents', 'IDEs', 'Agent Frameworks', 'Copilots', 'Automation', 'Knowledge Sources']

type Integration = { name: string; category: Category; method: string; desc: string; icon: LucideIcon }

const INTEGRATIONS: Integration[] = [
  // Coding Agents
  { name: 'Claude Code', category: 'Coding Agents', method: 'MCP', icon: Code2, desc: 'MCP over HTTP via .mcp.json — durable, access-controlled memory in every session.' },
  { name: 'Codex', category: 'Coding Agents', method: 'MCP', icon: Terminal, desc: 'MCP config in ~/.codex/config.toml — same tools, same tokens.' },
  { name: 'Kimi', category: 'Coding Agents', method: 'MCP', icon: Bot, desc: 'Connects over MCP like any other client.' },
  { name: 'Cline', category: 'Coding Agents', method: 'MCP', icon: GitBranch, desc: 'MCP client inside VS Code — point it at the GCTRL gateway.' },
  { name: 'OpenClaw', category: 'Coding Agents', method: 'MCP or HTTP', icon: Zap, desc: 'MCP, or call GCTRL tools directly over HTTP.' },
  // IDEs
  { name: 'Cursor', category: 'IDEs', method: 'MCP', icon: MousePointer2, desc: 'MCP via .cursor/mcp.json.' },
  { name: 'Windsurf', category: 'IDEs', method: 'MCP', icon: Wind, desc: 'MCP client support out of the box.' },
  { name: 'Zed', category: 'IDEs', method: 'MCP', icon: AppWindow, desc: 'MCP support for agent-mode requests.' },
  { name: 'VS Code + GitHub Copilot', category: 'IDEs', method: 'MCP / agent mode', icon: Code2, desc: 'Agent mode speaks MCP — same config as any other client.' },
  // Copilots
  { name: 'Microsoft Copilot Studio', category: 'Copilots', method: 'Custom connector', icon: Workflow, desc: 'Custom connector to the GCTRL REST API — send the ApiKey header, get graph-grounded answers.' },
  { name: 'GitHub Copilot', category: 'Copilots', method: 'MCP / agent mode', icon: Github, desc: 'Agent mode connects over MCP like any IDE client.' },
  // Agent Frameworks
  { name: 'Pi', category: 'Agent Frameworks', method: 'Built-in · zero setup', icon: Zap, desc: "GCTRL's built-in agent. Zero setup — enable it in Settings → Agent." },
  { name: 'Paperclip', category: 'Agent Frameworks', method: 'Drop-in · skill.md + HTTP', icon: Paperclip, desc: 'Drop in skill.md and call tools directly over HTTP — no MCP required.' },
  { name: 'Hermes', category: 'Agent Frameworks', method: 'Drop-in · skill.md + HTTP', icon: Rss, desc: 'Same drop-in harness pattern as Paperclip.' },
  { name: 'LangChain', category: 'Agent Frameworks', method: 'HTTP or MCP', icon: Link2, desc: "Wrap GCTRL's HTTP tools, or use the MCP adapter." },
  { name: 'LlamaIndex', category: 'Agent Frameworks', method: 'HTTP or MCP', icon: Layers, desc: 'Same options — HTTP tools or an MCP adapter.' },
  // Automation
  { name: 'n8n', category: 'Automation', method: 'Native nodes', icon: Workflow, desc: 'Native GCTRL nodes — build workflows without touching the API directly.' },
  { name: 'Webhooks', category: 'Automation', method: 'HTTP', icon: Webhook, desc: 'Fire on ingest, extraction, or fusion events — configure in Settings → Webhooks.' },
  // Knowledge Sources
  { name: 'Google Drive', category: 'Knowledge Sources', method: 'Connector', icon: HardDrive, desc: 'Import documents straight from a connected Drive.' },
  { name: 'Obsidian', category: 'Knowledge Sources', method: 'Connector', icon: BookOpen, desc: 'Pull an entire vault in as a knowledge source.' },
  { name: 'SharePoint', category: 'Knowledge Sources', method: 'Connector', icon: FolderKanban, desc: 'Import from Microsoft 365 document libraries.' },
  { name: 'Website crawler', category: 'Knowledge Sources', method: 'Connector', icon: Globe, desc: 'Point it at a site and ingest the pages that matter.' },
  { name: 'PDF / DOCX upload', category: 'Knowledge Sources', method: 'Upload or ingest_file', icon: FileText, desc: 'Upload in the UI, or have any connected agent call ingest_file.' },
]

function CategoryPills({ active, onChange }: { active: string; onChange: (c: string) => void }) {
  const pills = ['All', ...CATEGORIES]
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {pills.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
            active === c
              ? 'border-indigo-400/60 bg-indigo-500/15 text-indigo-200'
              : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:border-slate-600 hover:text-slate-200'
          }`}
        >
          {c}
        </button>
      ))}
    </div>
  )
}

function IntegrationCard({ item }: { item: Integration }) {
  const Icon = item.icon
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-5 backdrop-blur-sm transition-all hover:border-indigo-500/30 hover:bg-slate-800/60">
      <div className="flex items-center justify-center rounded-xl border border-indigo-400/20 bg-indigo-500/10 p-2.5" style={{ width: '2.75rem', height: '2.75rem' }}>
        <Icon className="h-5 w-5 text-indigo-300" strokeWidth={1.75} />
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-100">{item.name}</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">{item.desc}</p>
      </div>
      <span className="mt-auto inline-flex w-fit rounded-full bg-slate-800/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {item.method}
      </span>
    </div>
  )
}

function HowItWorks() {
  return (
    <div className="reveal grid gap-4 lg:grid-cols-3">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-400">MCP over HTTP</p>
        <p className="mt-1.5 text-xs text-slate-500">Remote agents, orchestrators — the gateway is off by default, enable it in Settings → Agent.</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900/80 p-3 text-[11px] leading-relaxed text-slate-300">
{`{
  "mcpServers": {
    "gctrl": {
      "type": "http",
      "url": "https://<your-install>/api/agent/mcp",
      "headers": {
        "Authorization": "ApiKey <token>"
      }
    }
  }
}`}
        </pre>
      </div>
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-violet-400">MCP over stdio</p>
        <p className="mt-1.5 text-xs text-slate-500">Local agents — Claude Code, Cursor, Claude Desktop — on the same machine or LAN.</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900/80 p-3 text-[11px] leading-relaxed text-slate-300">
{`{
  "mcpServers": {
    "gctrl": {
      "command": "node",
      "args": ["services/mcp/dist/index.js"],
      "env": {
        "GCTRL_API_TOKEN": "gctrl_..."
      }
    }
  }
}`}
        </pre>
      </div>
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-indigo-400">Direct HTTP</p>
        <p className="mt-1.5 text-xs text-slate-500">Any framework with its own tool-calling convention — no MCP client required.</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900/80 p-3 text-[11px] leading-relaxed text-slate-300">
{`curl -X POST \\
  https://<your-install>/api/agent/tools/search_entities \\
  -H "Authorization: ApiKey <token>" \\
  -H "Content-Type: application/json" \\
  -d '{ "query": "..." }'`}
        </pre>
      </div>
    </div>
  )
}

export function IntegrationsPage() {
  useScrollReveal()
  const [active, setActive] = useState('All')

  const filtered = useMemo(
    () => (active === 'All' ? INTEGRATIONS : INTEGRATIONS.filter((i) => i.category === active)),
    [active],
  )

  return (
    <div className="min-h-screen bg-[#020617]">
      <Seo
        title="Integrations — GCTRL"
        description="Connect GCTRL's governed memory layer to Claude Code, Cursor, Codex, LangChain, n8n, and more over MCP or HTTP — plus connectors for Google Drive, Obsidian, and SharePoint."
        path="/integrations"
      />
      <SiteHeader />

      {/* Hero */}
      <section className="relative overflow-hidden px-6 pt-32 pb-12">
        <div className="pointer-events-none absolute left-1/2 top-0 -z-0 h-96 w-[40rem] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-[120px]" />
        <div className="relative mx-auto max-w-3xl text-center">
          <span className="glass-pill mb-5">Integrations</span>
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Connect your agent.{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              Keep your knowledge.
            </span>
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-slate-400">
            GCTRL works with any MCP client, agent framework, or direct HTTP call — pick the transport that matches
            where your agent runs. Every integration sees exactly the clearance and knowledge-base scope carried by
            its token.
          </p>
        </div>
      </section>

      {/* Filter + grid */}
      <section className="px-6 pb-20">
        <div className="mx-auto max-w-6xl">
          <div className="reveal mb-10">
            <CategoryPills active={active} onChange={setActive} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((item) => (
              <IntegrationCard key={item.name} item={item} />
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-slate-900 bg-gradient-to-b from-[#020617] to-[#0a0f24] px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="reveal mb-10 text-center">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">How it works</p>
            <h2 className="text-3xl font-bold text-white">Three transports, one set of tools.</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-400">
              Tokens come from Access Control — create one scoped to exactly the knowledge bases an integration
              should see.
            </p>
          </div>
          <HowItWorks />
        </div>
      </section>

      {/* Footer CTA */}
      <section className="px-6 py-20">
        <div className="reveal mx-auto flex max-w-3xl flex-col items-center gap-5 rounded-3xl border border-slate-800 bg-slate-900/40 p-10 text-center backdrop-blur-sm">
          <h2 className="text-2xl font-bold text-white">Ready to connect an agent?</h2>
          <p className="max-w-xl text-slate-400">
            Full setup steps for every transport, plus a per-integration reference, live in the docs.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link to="/docs/integrations" className="btn-cta-primary">Read the integrations docs</Link>
            <Link to="/docs/quickstart" className="btn-cta-secondary">Quick Start guide</Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { MousePointer2, Plug2, Terminal } from 'lucide-react'

// Same recolouring CDN trick as IntegrationsSection — /FFFFFF suffix returns
// a white version of the mark server-side.
const CDN = 'https://cdn.simpleicons.org'
const WHITE = 'FFFFFF'

const CLIENTS: { name: string; logo: string | null; node?: ReactNode }[] = [
  { name: 'Claude Code',   logo: `${CDN}/claude/${WHITE}` },
  // OpenAI pulled its mark from simpleicons (404s) — lucide Terminal instead.
  { name: 'Codex',         logo: null, node: <Terminal className="h-5 w-5 text-white" strokeWidth={1.75} /> },
  { name: 'Cursor',        logo: null, node: <MousePointer2 className="h-5 w-5 text-white" strokeWidth={1.75} /> },
  { name: 'GitHub Copilot', logo: `${CDN}/githubcopilot/${WHITE}` },
  { name: 'LangGraph',     logo: `${CDN}/langchain/${WHITE}` },
  { name: 'Any MCP client', logo: null, node: <Plug2 className="h-5 w-5 text-white" strokeWidth={1.75} /> },
]

/**
 * Slim compatibility strip directly under the hero. One job: make it obvious
 * within the first scroll that GCTRL plugs into the AI tools people already
 * use — before any architecture talk.
 */
export function WorksWithSection() {
  return (
    <section className="relative border-y border-slate-800/60 bg-[#020617] px-6 py-14">
      <div className="mx-auto max-w-5xl text-center">
        <p className="mb-8 text-xs font-semibold uppercase tracking-widest text-slate-500 reveal">
          Works with the AI you already use
        </p>

        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-6 reveal">
          {CLIENTS.map((c) => (
            <div key={c.name} className="flex items-center gap-2.5 opacity-70 transition-opacity hover:opacity-100">
              {c.node
                ? c.node
                : <img src={c.logo!} alt="" width={20} height={20} className="h-5 w-5" loading="lazy" />}
              <span className="text-sm font-medium text-slate-300">{c.name}</span>
            </div>
          ))}
        </div>

        <p className="mt-8 text-sm text-slate-500 reveal">
          Your AI already speaks GCTRL — connect over MCP with one config block.{' '}
          <Link to="/integrations" className="text-indigo-400 transition-colors hover:text-indigo-300">
            See all integrations →
          </Link>
        </p>
      </div>
    </section>
  )
}

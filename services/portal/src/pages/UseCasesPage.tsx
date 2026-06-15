import { Link } from 'react-router-dom'
import { useScrollReveal } from '@/hooks/useScrollReveal'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'

function TeamMemoryDiagram() {
  const Token = ({ name, tool, color }: { name: string; tool: string; color: string }) => (
    <div className={`rounded-xl border px-3 py-2 text-center ${color}`}>
      <p className="text-sm font-semibold text-slate-100">{name}</p>
      <p className="text-[10px] uppercase tracking-wider text-slate-400">{tool} · scoped token</p>
    </div>
  )
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6 backdrop-blur-sm sm:p-8">
      {/* Colleagues */}
      <p className="mb-3 text-center text-[11px] uppercase tracking-[0.2em] text-slate-500">Your team</p>
      <div className="grid grid-cols-3 gap-3">
        <Token name="Engineer" tool="Claude Code" color="border-violet-400/30 bg-violet-500/10" />
        <Token name="Analyst" tool="Cursor" color="border-cyan-400/30 bg-cyan-500/10" />
        <Token name="Exec" tool="Hermes" color="border-indigo-400/30 bg-indigo-500/10" />
      </div>

      <div className="my-4 text-center text-slate-600">↓ &nbsp; MCP &nbsp; ↓</div>

      {/* Central GCTRL */}
      <div className="rounded-2xl border border-indigo-400/40 bg-indigo-500/10 px-6 py-5 text-center">
        <div className="bg-gradient-to-r from-indigo-300 via-violet-300 to-cyan-300 bg-clip-text text-xl font-bold text-transparent">
          GCTRL
        </div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-slate-300">central · on-prem · audited</p>
      </div>

      <div className="my-4 text-center text-slate-600">↓</div>

      {/* Outputs */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-center">
          <p className="text-sm font-semibold text-slate-200">Per-person KG + Wiki</p>
          <p className="text-xs text-slate-500">each colleague's own knowledge base</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-center">
          <p className="text-sm font-semibold text-slate-200">Merged company KG + Wiki</p>
          <p className="text-xs text-slate-500">classification enforced per clearance</p>
        </div>
      </div>
    </div>
  )
}

export function UseCasesPage() {
  useScrollReveal()

  return (
    <div className="min-h-screen bg-[#020617]">
      <SiteHeader />

      {/* Hero */}
      <section className="relative overflow-hidden px-6 pt-32 pb-16">
        <div className="pointer-events-none absolute left-1/2 top-0 -z-0 h-96 w-[40rem] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-[120px]" />
        <div className="relative mx-auto max-w-3xl text-center">
          <span className="glass-pill mb-5">Use cases</span>
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Built for{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              teams and enterprise
            </span>
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-slate-400">
            How organizations use GCTRL as the shared, access-controlled memory layer for their entire AI workforce.
          </p>
        </div>
      </section>

      {/* Agentic Team Memory */}
      <section className="px-6 pb-24">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="reveal-left">
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-400">Featured use case</p>
              <h2 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Agentic Team Memory</h2>
              <p className="mt-5 text-lg leading-relaxed text-slate-400">
                Run <span className="font-medium text-slate-200">one central GCTRL</span>, on your own hardware. Every
                colleague drops an individual <span className="font-medium text-slate-200">scoped token</span> into their
                Codex, Claude or Hermes. Each gets their own Wiki-LLM base and their own knowledge graph — and the
                knowledge of all employees can be merged into one company-wide KG and Wiki.
              </p>
              <p className="mt-4 text-lg leading-relaxed text-slate-400">
                When people of different clearance query that shared graph,{' '}
                <span className="font-medium text-slate-200">classification stays intact</span> — everyone sees exactly
                what they're cleared for, nothing more. Full audit trail. GDPR-compliant. Fully on-prem. A real push for
                data sovereignty.
              </p>
            </div>
            <div className="reveal-right">
              <TeamMemoryDiagram />
            </div>
          </div>

          {/* Why GCTRL is unique here */}
          <div className="reveal mt-16 rounded-2xl border border-slate-800 bg-slate-900/40 p-8">
            <h3 className="text-xl font-semibold text-white">Why nothing else does this</h3>
            <p className="mt-3 max-w-3xl leading-relaxed text-slate-400">
              Plenty of tools let an agent <em>have</em> a memory and write to it. But{' '}
              <span className="font-medium text-slate-200">none of them ingest at scale.</span> GCTRL gives you the raw
              storage for deterministic context <span className="font-medium text-slate-200">and</span>, in parallel,
              every organised memory layer — including a curated Wiki-LLM of company knowledge — on a high-performance
              graph + vector core.
            </p>
            <div className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Per-employee scoped tokens', 'Each colleague connects their own agent with their own KB scope — own wiki, own graph.'],
                ['One merged company brain', 'Fuse everyone’s knowledge into a single company KG + Wiki, deduplicated and cross-linked.'],
                ['Classification-preserving queries', 'Clearance is enforced at query time on the merged graph — same data, different views per person.'],
                ['Full audit trail', 'Every access and every denial is logged with token, action, resource and outcome.'],
                ['GDPR by design', 'Incognito sessions stay in browser memory; personalization is opt-in and erasable.'],
                ['On-prem & sovereign', 'Local inference, your storage, your network — no data leaves the building.'],
              ].map(([title, body]) => (
                <div key={title}>
                  <p className="font-semibold text-slate-100">{title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-slate-400">{body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Ideal for + setup */}
          <div className="reveal mt-8 grid gap-4 sm:grid-cols-2">
            <div className="feature-card-landing">
              <h4 className="font-semibold text-slate-100">Ideal for</h4>
              <ul className="mt-3 space-y-1.5 text-sm text-slate-400">
                <li>• Regulated industries needing on-prem AI with audit + clearance control</li>
                <li>• Engineering & research orgs that want a shared, compounding knowledge base</li>
                <li>• Teams standardizing on agents (Claude Code, Cursor, Codex, Hermes)</li>
              </ul>
            </div>
            <div className="feature-card-landing">
              <h4 className="font-semibold text-slate-100">How to set it up</h4>
              <ul className="mt-3 space-y-1.5 text-sm text-slate-400">
                <li>1. <Link to="/docs/installation" className="text-indigo-400 hover:text-indigo-300">Install GCTRL</Link> on a central machine</li>
                <li>2. Create <Link to="/docs/access-control" className="text-indigo-400 hover:text-indigo-300">scoped tokens</Link> per colleague</li>
                <li>3. <Link to="/docs/agents-mcp" className="text-indigo-400 hover:text-indigo-300">Connect each agent over MCP</Link></li>
              </ul>
            </div>
          </div>

          <div className="reveal mt-12 text-center">
            <Link to="/register" className="btn-cta-primary">Get started free</Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}

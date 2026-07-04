import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useScrollReveal } from '@/hooks/useScrollReveal'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'
import { Seo } from '@/components/Seo'

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

function LegacyRevivalDiagram() {
  const Source = ({ name, kind }: { name: string; kind: string }) => (
    <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-center">
      <p className="text-sm font-semibold text-slate-100">{name}</p>
      <p className="text-[10px] uppercase tracking-wider text-slate-400">{kind}</p>
    </div>
  )
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6 backdrop-blur-sm sm:p-8">
      {/* Legacy sources */}
      <p className="mb-3 text-center text-[11px] uppercase tracking-[0.2em] text-slate-500">Locked-away legacy data</p>
      <div className="grid grid-cols-2 gap-3">
        <Source name="Mailserver" kind="email archive" />
        <Source name="SharePoint" kind="decade-old archive" />
        <Source name="Legacy SQL" kind="old databases" />
        <Source name="File shares" kind="orphaned drives" />
      </div>

      <div className="my-4 text-center text-slate-600">↓ &nbsp; ingest at scale &nbsp; ↓</div>

      {/* Central GCTRL */}
      <div className="rounded-2xl border border-cyan-400/40 bg-cyan-500/10 px-6 py-5 text-center">
        <div className="bg-gradient-to-r from-amber-300 via-orange-300 to-cyan-300 bg-clip-text text-xl font-bold text-transparent">
          GCTRL
        </div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-slate-300">ingest · FUSE resolve · canonical</p>
      </div>

      <div className="my-4 text-center text-slate-600">↓</div>

      {/* Output */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-center">
          <p className="text-sm font-semibold text-slate-200">Clean canonical KG + Wiki</p>
          <p className="text-xs text-slate-500">queryable by your AI agents</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-center">
          <p className="text-sm font-semibold text-slate-200">Provenance + clearance intact</p>
          <p className="text-xs text-slate-500">lineage & retention preserved</p>
        </div>
      </div>
    </div>
  )
}

function ProjectIsolationDiagram() {
  const Project = ({ name, client, agent, color }: { name: string; client: string; agent: string; color: string }) => (
    <div className={`rounded-xl border p-3 ${color}`}>
      <p className="text-sm font-semibold text-slate-100">{name}</p>
      <p className="text-[10px] uppercase tracking-wider text-slate-400">{client}</p>
      <div className="mt-2 rounded-lg border border-slate-700/60 bg-slate-950/50 px-2 py-1.5 text-center">
        <p className="text-[11px] text-slate-300">{agent}</p>
        <p className="text-[9px] uppercase tracking-wider text-slate-500">scoped · class-gated</p>
      </div>
    </div>
  )
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6 backdrop-blur-sm sm:p-8">
      {/* Single source of truth */}
      <div className="rounded-2xl border border-emerald-400/40 bg-emerald-500/10 px-6 py-5 text-center">
        <div className="bg-gradient-to-r from-emerald-300 via-teal-300 to-cyan-300 bg-clip-text text-xl font-bold text-transparent">
          GCTRL
        </div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-slate-300">one source of truth · on-prem</p>
      </div>

      <div className="my-4 text-center text-slate-600">↓ &nbsp; partitioned by classification &nbsp; ↓</div>

      {/* Isolated project lanes */}
      <div className="grid grid-cols-3 gap-3">
        <Project name="Project Atlas" client="Client A" agent="Engineer · Claude Code" color="border-emerald-400/30 bg-emerald-500/10" />
        <Project name="Project Bolt" client="Client B" agent="Analyst · Cursor" color="border-teal-400/30 bg-teal-500/10" />
        <Project name="Internal R&D" client="Confidential" agent="Exec · Hermes" color="border-cyan-400/30 bg-cyan-500/10" />
      </div>

      {/* Wall note */}
      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-center">
        <p className="text-sm font-semibold text-slate-200">No cross-project bleed</p>
        <p className="text-xs text-slate-500">an agent on one project can’t see, cite, or leak another — by accident or otherwise</p>
      </div>
    </div>
  )
}

export function UseCasesPage() {
  useScrollReveal()
  const location = useLocation()

  useEffect(() => {
    if (location.hash) {
      document
        .getElementById(location.hash.slice(1))
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [location.hash])

  return (
    <div className="min-h-screen bg-[#020617]">
      <Seo
        title="Use Cases — GCTRL"
        description="Shared agentic team memory, airtight per-project isolation, and activating legacy data — how enterprises use GCTRL's governed knowledge graph day to day."
        path="/use-cases"
      />
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
            Three ways organizations put GCTRL to work as the shared, access-controlled memory layer for their
            entire AI workforce — from live team knowledge to airtight client projects to decades of locked-away
            legacy data.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to="#agentic-team-memory"
              className="rounded-xl border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-sm font-medium text-indigo-200 transition hover:border-indigo-400/60 hover:text-white"
            >
              Agentic Team Memory
            </Link>
            <Link
              to="#project-isolation"
              className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-400/60 hover:text-white"
            >
              Airtight Client Projects
            </Link>
            <Link
              to="#legacy-revival"
              className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-100 transition hover:border-amber-400/60 hover:text-white"
            >
              Activate Your Legacy Data
            </Link>
          </div>
        </div>
      </section>

      {/* Agentic Team Memory */}
      <section id="agentic-team-memory" className="scroll-mt-24 px-6 pb-24">
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
        </div>
      </section>

      {/* One Source of Truth, Airtight Projects */}
      <section id="project-isolation" className="scroll-mt-24 px-6 pb-24">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="reveal-left">
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">Agency use case</p>
              <h2 className="mt-2 text-3xl font-bold text-white sm:text-4xl">
                One Source of Truth,{' '}
                <span className="bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400 bg-clip-text text-transparent">
                  Airtight Projects
                </span>
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-slate-400">
                Run your whole agency on <span className="font-medium text-slate-200">one platform</span> — a single
                source of truth instead of a sprawl of disconnected tools per client. Every project and client gets its
                own walled knowledge base, and every colleague or agent connects with a{' '}
                <span className="font-medium text-slate-200">token scoped to exactly the projects they’re on</span>.
              </p>
              <p className="mt-4 text-lg leading-relaxed text-slate-400">
                Classification and fine-grained access control mean project knowledge{' '}
                <span className="font-medium text-slate-200">can never get mixed up — not even by accident</span>. An
                agent working Client A’s project literally can’t retrieve, cite, or leak Client B’s data: over-clearance
                queries return nothing, and <span className="font-medium text-slate-200">every node, edge, chunk and
                wiki page</span> is gated at query time. One source of truth, zero cross-project bleed — with a full
                audit trail on every access.
              </p>
            </div>
            <div className="reveal-right">
              <ProjectIsolationDiagram />
            </div>
          </div>

          {/* Why GCTRL is unique here */}
          <div className="reveal mt-16 rounded-2xl border border-slate-800 bg-slate-900/40 p-8">
            <h3 className="text-xl font-semibold text-white">Why nothing else does this</h3>
            <p className="mt-3 max-w-3xl leading-relaxed text-slate-400">
              Folder permissions and per-client workspaces rely on someone never making a mistake — one wrong share, one
              pasted doc, one agent with too-broad context, and a client’s data ends up where it shouldn’t. GCTRL makes
              isolation <span className="font-medium text-slate-200">structural</span>: clearance lives on the data
              itself and is enforced at retrieval, so a leak across projects isn’t <em>discouraged</em> — it’s{' '}
              <span className="font-medium text-slate-200">not representable</span>.
            </p>
            <div className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Per-element classification', 'Every node, edge, chunk and wiki page carries its own clearance — gating is on the data, not a folder rule someone can forget.'],
                ['Enforced at query time', 'Over-clearance results vanish during retrieval — an agent can’t surface what its token isn’t cleared for, even with a perfect prompt.'],
                ['Project-scoped tokens', 'A token is bound to its project’s knowledge bases; every other project is invisible, not merely hidden.'],
                ['Accidental-leak proof', 'If it’s out of scope it can’t be retrieved, cited, or fused into another project — there is no “oops, wrong client.”'],
                ['One platform, not ten', 'A single source of truth and one ops surface — instead of a siloed tool per client that never compounds into shared value.'],
                ['Audit every access', 'Token, action, resource and outcome — every grant and every denial is logged, for your client and your auditor.'],
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
                <li>• Agencies &amp; consultancies running many clients on one platform</li>
                <li>• Multi-client work under NDA or strict confidentiality</li>
                <li>• Chinese-wall separation between projects, deals or case teams</li>
                <li>• Anyone who can’t risk one client’s data in another’s deliverable</li>
              </ul>
            </div>
            <div className="feature-card-landing">
              <h4 className="font-semibold text-slate-100">How to set it up</h4>
              <ul className="mt-3 space-y-1.5 text-sm text-slate-400">
                <li>1. <Link to="/docs/installation" className="text-indigo-400 hover:text-indigo-300">Install GCTRL</Link> once as your agency’s source of truth</li>
                <li>2. Create a KB per project + <Link to="/docs/access-control" className="text-indigo-400 hover:text-indigo-300">scoped tokens</Link> per colleague</li>
                <li>3. Set <Link to="/docs/compliance" className="text-indigo-400 hover:text-indigo-300">classification</Link> per element; <Link to="/docs/agents-mcp" className="text-indigo-400 hover:text-indigo-300">connect agents over MCP</Link></li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Activate Your Legacy Data */}
      <section id="legacy-revival" className="scroll-mt-24 px-6 pb-24">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="reveal-left">
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-400">Enterprise use case</p>
              <h2 className="mt-2 text-3xl font-bold text-white sm:text-4xl">
                Activate Your{' '}
                <span className="bg-gradient-to-r from-amber-400 via-orange-400 to-cyan-400 bg-clip-text text-transparent">
                  Legacy Data
                </span>
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-slate-400">
                Every enterprise sits on decades of locked-away knowledge —{' '}
                <span className="font-medium text-slate-200">old mailservers and email archives</span>, a decade-old
                SharePoint, <span className="font-medium text-slate-200">legacy SQL databases</span>, orphaned file
                shares and network drives. It's exactly the data your AI needs, and exactly the data nobody can use.
              </p>
              <p className="mt-4 text-lg leading-relaxed text-slate-400">
                GCTRL ingests that mess <span className="font-medium text-slate-200">at scale</span>.{' '}
                <span className="font-medium text-slate-200">FUSE</span> resolves the duplicates and contradictions —
                matching records that describe the same entity across systems and reconciling them — into{' '}
                <span className="font-medium text-slate-200">one clean, canonical knowledge graph</span>, and serves it
                to your agents with <span className="font-medium text-slate-200">provenance, lineage and retention
                preserved</span>, and clearance enforced at query time.
              </p>
            </div>
            <div className="reveal-right">
              <LegacyRevivalDiagram />
            </div>
          </div>

          {/* Why GCTRL is unique here */}
          <div className="reveal mt-16 rounded-2xl border border-slate-800 bg-slate-900/40 p-8">
            <h3 className="text-xl font-semibold text-white">Why nothing else does this</h3>
            <p className="mt-3 max-w-3xl leading-relaxed text-slate-400">
              Most “chat with your data” tools <span className="font-medium text-slate-200">choke on messy legacy at
              volume</span> — they index a handful of clean docs and call it done. GCTRL is built to ingest the{' '}
              <em>mess</em> and resolve it <span className="font-medium text-slate-200">deterministically</span> into
              structured, queryable knowledge — turning a liability into a moat, without breaking compliance.
            </p>
            <div className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Ingest at volume', 'Decades of mailservers, SharePoint, SQL and file shares — pulled in at scale, not a sample.'],
                ['Deterministic entity resolution', 'FUSE matches records describing the same entity across systems and merges them, repeatably.'],
                ['Contradictions reconciled', 'Conflicting and duplicate facts collapse into one canonical, trustworthy version.'],
                ['Provenance & lineage', 'Every fact traces back to its source system and document — nothing is a black box.'],
                ['Retention preserved', 'Original retention and deletion rules carry through, so compliance stays intact.'],
                ['Clearance enforced', 'The resulting graph is queried under the same classification rules as the rest of GCTRL.'],
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
                <li>• Migrating or decommissioning legacy systems without losing the knowledge inside</li>
                <li>• M&A data consolidation across two organizations' overlapping systems</li>
                <li>• Making 10+ years of archives finally AI-usable</li>
                <li>• Regulated orgs needing provenance + retention preserved end-to-end</li>
              </ul>
            </div>
            <div className="feature-card-landing">
              <h4 className="font-semibold text-slate-100">How to set it up</h4>
              <ul className="mt-3 space-y-1.5 text-sm text-slate-400">
                <li>1. <Link to="/docs/installation" className="text-indigo-400 hover:text-indigo-300">Install GCTRL</Link> and point it at your legacy sources</li>
                <li>2. Run <Link to="/docs/modules" className="text-indigo-400 hover:text-indigo-300">KEX &amp; FUSE</Link> to ingest and resolve at scale</li>
                <li>3. Serve the graph under <Link to="/docs/access-control" className="text-indigo-400 hover:text-indigo-300">access control</Link> to your agents</li>
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

import { Link } from 'react-router-dom'
import { GitBranch, Cloud, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react'

// Measured with packages/code-indexer/bench/protocol-bench.mjs on 2026-08-25 - the same twelve
// structural questions answered once through the Codebase KB and once by grep-and-read (grep
// plus a 40-line window around every hit). Keep in step with docs/code-kb-protocol-bench.md.
const STATS = [
  { key: 'save', value: '94', unit: '%', label: 'Fewer tokens per structural question', sub: 'GCTRL repo · Rust + TS + Python · 12/12 correct' },
  { key: 'save2', value: '90', unit: '%', label: 'Fewer tokens on a 1,000-file TypeScript app', sub: '12/12 correct · one call per answer' },
  { key: 'edges', value: '100', unit: '%', label: 'Call-graph edges verified correct', sub: '1,119 edges cross-checked against the compiler' },
  { key: 'time', value: 'sec', unit: '', label: 'Re-index after a commit', sub: 'incremental - only changed files travel' },
]

const ICON_CLS: Record<string, string> = {
  indigo: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-300',
  violet: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  cyan: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300',
}

const PILLARS: { Icon: LucideIcon; color: keyof typeof ICON_CLS; title: string; body: string }[] = [
  {
    Icon: Cloud,
    color: 'indigo',
    title: 'One code brain, every harness',
    body: 'Claude Code on your laptop, Cursor at the office, Codex in CI, an Anvil agent on the server - they all connect to the same Codebase KB. What one agent learned about your repository, the next one already knows. Your context stops living in a single chat window.',
  },
  {
    Icon: GitBranch,
    color: 'violet',
    title: 'The graph answers, grep does not',
    body: 'Where is X defined, who calls it, what breaks if I change it - one call to the graph, read only the lines that matter. No more scanning whole trees into the context window and paying for it on every turn.',
  },
  {
    Icon: Sparkles,
    color: 'cyan',
    title: 'Decisions live next to the code',
    body: 'The why and the where in the same graph: architecture decisions, conventions and gotchas are stored on the very symbols they concern, so the next session inherits them instead of rediscovering them.',
  },
  {
    Icon: ShieldCheck,
    color: 'indigo',
    title: 'Yours, scoped, on your terms',
    body: 'Runs in your cloud or on-prem. Every token carries its own Codebase access; a colleague’s agent sees the repositories it was granted and nothing else. Indexing is a line you write - code never leaves the machine by accident.',
  },
]

export function CodeBrainSection() {
  return (
    <div className="relative overflow-hidden border-t border-slate-900 bg-gradient-to-b from-[#020617] via-[#070c1e] to-[#020617] px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="reveal mx-auto max-w-3xl text-center">
          <span className="glass-pill mb-5">Codebase KB</span>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            A code brain that{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              travels with you.
            </span>
          </h2>
          <p className="mt-4 text-lg text-slate-400">
            Point GCTRL at a repository and its structure becomes a knowledge graph - files, classes, functions,
            who-calls-what - living in your cloud, shared by every agent you use. Switch harness, switch machine,
            switch model: the knowledge comes along. And your agents spend their tokens on thinking, not on grep.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {STATS.map((s, i) => (
            <div key={s.key} className={`stat-card reveal reveal-delay-${(i % 4) + 1}`}>
              <p className="text-3xl font-bold text-white sm:text-4xl">
                {s.value}
                {s.unit && <span className="ml-1 text-base font-medium text-indigo-300">{s.unit}</span>}
              </p>
              <p className="mt-2 text-sm font-medium text-slate-300">{s.label}</p>
              <p className="mt-0.5 text-xs text-slate-500">{s.sub}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {PILLARS.map((p, i) => (
            <div key={p.title} className={`reveal reveal-delay-${(i % 4) + 1} rounded-2xl border border-slate-800 bg-slate-900/40 p-6`}>
              <div className={`mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border ${ICON_CLS[p.color]}`}>
                <p.Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="text-lg font-semibold text-white">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{p.body}</p>
            </div>
          ))}
        </div>

        <div className="reveal mt-8 flex flex-col items-center justify-between gap-4 rounded-2xl border border-violet-500/20 bg-violet-500/5 px-6 py-5 sm:flex-row">
          <p className="text-sm text-slate-300">
            <span className="font-semibold text-violet-300">Two lines to switch it on:</span> create an access token, run{' '}
            <code className="rounded bg-slate-950 px-1.5 py-0.5 text-xs text-slate-200">gctrl init</code> in your repository -
            the agent indexes it on start-up and follows the coding protocol from the GCTRL skill.
          </p>
          <Link to="/docs/tech-code-brain" className="btn-cta-secondary shrink-0">
            How the code brain works →
          </Link>
        </div>
      </div>
    </div>
  )
}

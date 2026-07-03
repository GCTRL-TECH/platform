import { SlidersHorizontal, KeyRound, ScrollText, Network, type LucideIcon } from 'lucide-react'

const STANDARDS = ['GDPR', 'ISO 27001', 'SOC 2', 'TISAX', 'NIS2']

const ICON_CLS: Record<string, string> = {
  indigo: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-300',
  violet: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  cyan: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300',
}

const PILLARS: { Icon: LucideIcon; color: keyof typeof ICON_CLS; title: string; body: string }[] = [
  {
    Icon: SlidersHorizontal,
    color: 'indigo',
    title: 'Per-element classification',
    body: 'Nodes, edges, and chunks each carry their own clearance markings. Sensitivity travels with the data, not the schema — so it survives every merge, query, and export.',
  },
  {
    Icon: KeyRound,
    color: 'violet',
    title: 'Scoped tokens for users AND agents',
    body: 'Issue narrow, time-bound, revocable capabilities to a person or an AI agent. Every retrieval is filtered server-side against the caller’s scope — never a client-side hint that can be ignored.',
  },
  {
    Icon: ScrollText,
    color: 'cyan',
    title: 'Forensic audit trail',
    body: 'Every access, every denial, every scope grant — captured with the caller, the context, and the verdict. The receipts your CISO, auditors, and DPO accept before procurement signs.',
  },
  {
    Icon: Network,
    color: 'indigo',
    title: 'Granular orchestration',
    body: 'Merge the whole organisation’s knowledge into one graph — and classification still holds. Two people of different clearance query the same data and each sees only what they’re cleared for.',
  },
]

export function SpeedOfTrustSection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-[#0a0f24] via-[#070c1e] to-[#0a0f24] px-6 py-28">
      <div className="pointer-events-none absolute left-1/2 top-0 h-[400px] w-[800px] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-[140px]" />

      <div className="relative mx-auto max-w-6xl">
        <div className="mb-12 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">Trust, built in</p>
          <h2 className="mx-auto max-w-3xl text-4xl font-bold text-white md:text-6xl">
            Running at the{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              speed of trust.
            </span>
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-300">
            Anyone can bolt an LLM onto a database. The hard, unglamorous part is controlling exactly
            who — human or agent — can touch which fact, and proving it forever after.
            We built GCTRL knowing that in the enterprise, <span className="font-medium text-white">compliance isn’t a feature — it’s the permission to exist.</span>
          </p>
        </div>

        {/* Compliance standards strip */}
        <div className="mb-16 flex flex-wrap items-center justify-center gap-3 reveal">
          {STANDARDS.map((std) => (
            <span key={std} className="glass-pill">
              <svg className="h-3.5 w-3.5 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              {std}
            </span>
          ))}
        </div>

        {/* The four pillars of the moat */}
        <div className="grid gap-6 md:grid-cols-2">
          {PILLARS.map((p, i) => (
            <div key={p.title} className={`feature-card-landing reveal reveal-delay-${(i % 4) + 1} flex gap-4 p-6`}>
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${ICON_CLS[p.color]}`}>
                <p.Icon className="h-5 w-5" strokeWidth={1.75} />
              </div>
              <div>
                <h3 className="mb-1.5 font-semibold text-white">{p.title}</h3>
                <p className="text-sm leading-relaxed text-slate-400">{p.body}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Proof tie-in — the moat costs nothing at query time */}
        <a
          href="#benchmarks"
          className="reveal mt-8 flex flex-col items-center justify-between gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-6 py-5 transition-colors hover:border-emerald-500/40 sm:flex-row"
        >
          <p className="text-sm text-slate-300">
            <span className="font-semibold text-emerald-300">And it’s effectively free.</span> Classification and scope
            enforcement add <span className="font-medium text-white">≈ 0 ms</span> to retrieval — security with no
            performance tax.
          </p>
          <span className="shrink-0 text-sm font-medium text-emerald-300">See the facts ↓</span>
        </a>
      </div>
    </section>
  )
}

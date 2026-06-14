/**
 * Benchmarks are from the 2026-06-11 baseline run (`bench/report-test01.json`),
 * graph "Test" = 2,686 nodes on local CPU/Ollama. The headline claim — sub-15ms
 * graph reads with negative access-control overhead — is the platform's
 * differentiator: fine-grained classification at zero retrieval cost.
 */
const STATS = [
  {
    value: '13.6',
    unit: 'ms',
    label: 'Graph read p50',
    hint: 'Median latency to traverse the knowledge graph.',
  },
  {
    value: '33.7',
    unit: 'ms',
    label: 'Entity search p50',
    hint: 'Indexed entity lookup with scoped-token filtering applied.',
  },
  {
    value: '−7.9',
    unit: 'ms',
    label: 'Access-control overhead',
    hint: 'Net cost of classification + scope enforcement. Negative — it makes retrieval faster.',
  },
  {
    value: '0',
    unit: 'gates failed',
    label: 'Security regression rate',
    hint: 'Every tuning candidate must keep classification gates green or it gets reverted.',
  },
]

const PILLARS = [
  {
    icon: '🎚️',
    title: 'Per-element classification',
    body: 'Nodes, edges, and chunks each carry their own clearance markings. TLP-style sensitivity travels with the data, not the schema.',
  },
  {
    icon: '🔐',
    title: 'Scoped tokens for users AND agents',
    body: 'Issue narrow, time-bound capabilities to a human or an AI agent. Every retrieval is filtered server-side against the caller’s scope — never a client-side hint.',
  },
  {
    icon: '🤝',
    title: 'Agent-native by design',
    body: 'GCTRL speaks MCP and the OpenAI tool-call protocol out of the box. Drop it into any agent network as the team’s shared, source-of-truth memory.',
  },
  {
    icon: '🛠️',
    title: 'CLI-first GCTRL Agent',
    body: 'A first-class agent that operates GCTRL end-to-end from a terminal — plug it into other agents as a Database Engineer peer that extracts, fuses, and queries on demand.',
  },
]

export function SpeedOfTrustSection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-[#0a0f24] via-[#070c1e] to-[#0a0f24] px-6 py-28">
      {/* Faint corner glow to anchor the section visually */}
      <div className="pointer-events-none absolute left-1/2 top-0 h-[400px] w-[800px] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-[140px]" />

      <div className="relative mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">Trust by Design</p>
          <h2 className="mx-auto max-w-3xl text-4xl font-bold text-white md:text-5xl">
            Running at the{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              speed of trust.
            </span>
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-slate-400">
            Fine-grained classification, scoped tokens, and full audit — enforced at zero retrieval latency.
          </p>
        </div>

        {/* ── Stat cards ───────────────────────────────────────────────────── */}
        <div className="mb-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((s, i) => (
            <div
              key={s.label}
              className={`reveal reveal-delay-${(i % 4) + 1} group rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-sm transition-all hover:border-indigo-500/40 hover:bg-slate-800/60`}
            >
              <div className="flex items-baseline gap-1.5">
                <span className="text-4xl font-bold tabular-nums text-white md:text-5xl">{s.value}</span>
                <span className="text-sm font-medium text-slate-400">{s.unit}</span>
              </div>
              <div className="mt-2 text-xs font-semibold uppercase tracking-wider text-indigo-400">
                {s.label}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-500">{s.hint}</p>
            </div>
          ))}
        </div>

        {/* ── Differentiator pillars ───────────────────────────────────────── */}
        <div className="grid gap-6 md:grid-cols-2">
          {PILLARS.map((p, i) => (
            <div
              key={p.title}
              className={`feature-card-landing reveal reveal-delay-${(i % 4) + 1} flex gap-4 p-6`}
            >
              <div className="text-3xl">{p.icon}</div>
              <div>
                <h3 className="mb-1.5 font-semibold text-white">{p.title}</h3>
                <p className="text-sm leading-relaxed text-slate-400">{p.body}</p>
              </div>
            </div>
          ))}
        </div>

      </div>
    </section>
  )
}

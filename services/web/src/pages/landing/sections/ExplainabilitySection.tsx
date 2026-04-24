const POINTS = [
  {
    title: 'Every Answer is Traceable',
    body: 'Unlike vector similarity, knowledge graph traversal produces a verifiable reasoning path. Audit every AI answer back to its source documents, extraction timestamp, and confidence score.',
    icon: '🔍',
  },
  {
    title: 'GDPR & ISMS Compliance Built In',
    body: "Full explainability is a prerequisite for responsible AI under GDPR Article 22 and ISO 27001. GCTRL's graph layer gives compliance teams the audit trail they need — without custom tooling.",
    icon: '🇪🇺',
  },
  {
    title: 'Fully On-Premises Deployment',
    body: 'Run Neo4j, Qdrant, and the entire GCTRL stack inside your own data centre or private cloud. No data ever leaves your perimeter. No vendor lock-in. Full sovereignty.',
    icon: '🏛️',
  },
]

export function ExplainabilitySection() {
  return (
    <section className="relative bg-[#020617] px-6 py-28">
      {/* Background accent */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[400px] w-[800px] rounded-full bg-violet-800/8 blur-[100px]" />
      </div>

      <div className="relative mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-400">The Graph Advantage</p>
          <h2 className="text-4xl font-bold text-white">
            Explainable by design.
            <br />
            <span className="text-violet-400">Not a black box.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-slate-400 leading-relaxed">
            Vectors tell you <em>how similar</em> two chunks of text are. Knowledge graphs tell you <em>why</em> an answer is correct — and prove it. That distinction matters for every regulated industry.
          </p>
        </div>

        {/* Split: points left, graph visual right */}
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-8">
            {POINTS.map((p, i) => (
              <div key={p.title} className={`reveal reveal-delay-${i + 1} flex gap-5`}>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10 text-xl">
                  {p.icon}
                </div>
                <div>
                  <h3 className="mb-1.5 font-semibold text-white">{p.title}</h3>
                  <p className="text-sm leading-relaxed text-slate-400">{p.body}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Abstract knowledge graph visual */}
          <div className="reveal-right flex justify-center">
            <div className="relative h-64 w-64 rounded-2xl border border-violet-500/15 bg-violet-950/20 p-6 backdrop-blur-sm">
              <p className="mb-4 text-center text-[10px] font-mono uppercase tracking-widest text-violet-400/70">
                Knowledge Graph
              </p>
              <svg viewBox="0 0 240 200" className="h-full w-full" fill="none">
                <line x1="120" y1="80"  x2="60"  y2="150" stroke="rgb(139,92,246)" strokeOpacity="0.3" strokeWidth="1" strokeDasharray="4 2" />
                <line x1="120" y1="80"  x2="180" y2="150" stroke="rgb(139,92,246)" strokeOpacity="0.3" strokeWidth="1" strokeDasharray="4 2" />
                <line x1="120" y1="80"  x2="120" y2="30"  stroke="rgb(99,102,241)" strokeOpacity="0.4" strokeWidth="1.5" />
                <line x1="60"  y1="150" x2="180" y2="150" stroke="rgb(139,92,246)" strokeOpacity="0.2" strokeWidth="1" strokeDasharray="4 2" />
                {[
                  { cx: 120, cy: 80,  r: 14, label: 'Entity',    fill: 'rgb(99,102,241)',  fo: 0.25 },
                  { cx: 120, cy: 30,  r: 8,  label: 'Source',    fill: 'rgb(99,102,241)',  fo: 0.2  },
                  { cx: 60,  cy: 150, r: 11, label: 'Relation',  fill: 'rgb(139,92,246)', fo: 0.2  },
                  { cx: 180, cy: 150, r: 11, label: 'Attribute', fill: 'rgb(34,211,238)',  fo: 0.2  },
                ].map((n) => (
                  <g key={`${n.cx},${n.cy}`}>
                    <circle cx={n.cx} cy={n.cy} r={n.r} fill={n.fill} fillOpacity={n.fo} stroke={n.fill} strokeOpacity="0.5" strokeWidth="1" />
                    <text x={n.cx} y={n.cy + n.r + 10} textAnchor="middle" fontSize="8" fill="rgb(148,163,184)" fontFamily="monospace">
                      {n.label}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-20 grid gap-6 sm:grid-cols-3 reveal">
          {[
            { value: '100%', label: 'On-Premises Capable', sub: 'No cloud dependency required' },
            { value: 'Full', label: 'Audit Trail',         sub: 'Every AI answer traceable' },
            { value: 'GDPR', label: 'Article 22 Ready',    sub: 'Explainability by default' },
          ].map((s) => (
            <div key={s.label} className="stat-card">
              <div className="mb-1 text-3xl font-bold text-white">{s.value}</div>
              <div className="font-semibold text-slate-200">{s.label}</div>
              <div className="mt-1 text-xs text-slate-500">{s.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

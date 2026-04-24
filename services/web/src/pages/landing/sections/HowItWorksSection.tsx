const STEPS = [
  {
    num: '01',
    title: 'Connect & Extract',
    body: 'Point GCTRL at your data sources — files, APIs, databases. KEX extracts entities, facts, and relationships into a staging layer.',
    color: 'indigo',
  },
  {
    num: '02',
    title: 'Fuse & Deduplicate',
    body: 'FUSE identifies matching entities across sources. Configurable matching rules + ML scoring collapse duplicates into canonical records.',
    color: 'violet',
  },
  {
    num: '03',
    title: 'Ground in Knowledge Graph',
    body: 'Harmonised data lands in a versioned Neo4j knowledge graph with full lineage. Every fact is linked to its provenance.',
    color: 'cyan',
  },
  {
    num: '04',
    title: 'Deploy Grounded AI',
    body: 'Your AI queries the knowledge graph first — getting structured, sourced context before generating. Explainable, accurate, auditable.',
    color: 'emerald',
  },
]

export function HowItWorksSection() {
  return (
    <section className="relative bg-gradient-to-b from-[#0a0f24] to-[#020617] px-6 py-28">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">How It Works</p>
          <h2 className="text-4xl font-bold text-white">Four steps to ground control.</h2>
        </div>

        <div className="relative grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          {/* Connector line (desktop) */}
          <div className="pointer-events-none absolute left-0 right-0 top-8 hidden border-t border-dashed border-indigo-500/20 lg:block" />

          {STEPS.map((step, i) => (
            <div key={step.num} className={`reveal reveal-delay-${i + 1} relative`}>
              <div className="relative z-10 mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-indigo-500/30 bg-indigo-600/15 text-lg font-bold text-indigo-400">
                {step.num}
              </div>
              <h3 className="mb-2 font-semibold text-white">{step.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

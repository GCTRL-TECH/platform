import { Link } from 'react-router-dom'
import type { ComponentType } from 'react'
import { IngestVignette, FuseVignette, LayersVignette, ServeVignette } from './vignettes/CardVignettes'

type Step = {
  num: string
  title: string
  body: string
  Vignette: ComponentType
  gradient: string
}

const STEPS: Step[] = [
  {
    num: '01',
    title: 'Ingest',
    body: 'Connect any source - SharePoint, Google Drive, email archives, databases, APIs. A governed ingestion layer classifies and tags everything on the way in.',
    Vignette: IngestVignette,
    gradient: 'from-indigo-500 to-indigo-400',
  },
  {
    num: '02',
    title: 'Resolve & fuse',
    body: 'FUSE collapses duplicates and contradictions across every source into one clean, canonical knowledge graph - no conflicting copies, one version of the truth.',
    Vignette: FuseVignette,
    gradient: 'from-violet-500 to-violet-400',
  },
  {
    num: '03',
    title: 'Organise into memory',
    body: 'Facts land in layered memory - hot dossiers, warm chunks, the cold graph, and a curated Wiki - on top of your swappable Neo4j + Qdrant.',
    Vignette: LayersVignette,
    gradient: 'from-fuchsia-500 to-cyan-400',
  },
  {
    num: '04',
    title: 'Serve to agents',
    body: 'Your agents query it over MCP - clearance-filtered and fully audited - returning grounded answers with provenance, not guesses.',
    Vignette: ServeVignette,
    gradient: 'from-cyan-500 to-cyan-400',
  },
]

export function HowItWorksSection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-[#0a0f24] to-[#020617] px-6 py-28">
      <div className="relative mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">How It Works</p>
          <h2 className="text-4xl font-bold text-white md:text-5xl">
            From raw sources to{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              ground control
            </span>
            .
          </h2>
          <p className="mx-auto mt-4 max-w-2xl leading-relaxed text-slate-400">
            One pipeline turns scattered, conflicting data into a governed memory your agents can actually trust.
          </p>
        </div>

        <div className="relative grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          {/* Connector line (desktop) */}
          <div className="pointer-events-none absolute left-0 right-0 top-7 hidden bg-gradient-to-r from-indigo-500/0 via-violet-500/30 to-cyan-500/0 lg:block">
            <div className="h-px w-full border-t border-dashed border-white/10" />
          </div>

          {STEPS.map((step, i) => {
            return (
              <div key={step.num} className={`group reveal reveal-delay-${i + 1} relative`}>
                <div className="feature-card-landing flex h-full flex-col">
                  <div className="mb-5 flex items-center gap-3">
                    <div
                      className={`relative z-10 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${step.gradient} text-lg font-bold text-white shadow-lg shadow-indigo-900/30 transition-transform duration-300 group-hover:-translate-y-0.5`}
                    >
                      {step.num}
                    </div>
                  </div>
                  <step.Vignette />
                  <h3 className="mb-2 font-semibold text-white">{step.title}</h3>
                  <p className="text-sm leading-relaxed text-slate-400">{step.body}</p>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-14 flex flex-col items-center gap-4 text-center reveal reveal-delay-5">
          <p className="text-sm text-slate-400">
            One governed flow - ingestion to answer - with provenance preserved at every hop.
          </p>
          <Link to="/docs/architecture" className="btn-cta-secondary">
            Explore the architecture
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </section>
  )
}

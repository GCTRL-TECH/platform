import { Link } from 'react-router-dom'

const CAPABILITIES = [
  { label: 'KEX Extract', color: 'indigo' },
  { label: 'FUSE Merge',  color: 'violet' },
  { label: 'KG Ground',   color: 'cyan'   },
  { label: 'RAG Deploy',  color: 'emerald'},
  { label: 'Connectors',  color: 'amber'  },
  { label: 'Classify',    color: 'rose'   },
]

export function SolutionSection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-[#020617] to-[#0a0f24] px-6 py-28">
      <div className="mx-auto grid max-w-6xl items-center gap-16 lg:grid-cols-2">
        {/* Copy */}
        <div className="reveal-left">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">The Solution</p>
          <h2 className="mb-6 text-4xl font-bold leading-tight text-white">
            One command centre.<br />
            <span className="text-indigo-400">Total ground control.</span>
          </h2>
          <p className="mb-6 text-slate-400 leading-relaxed">
            GCTRL sits between your raw data sources and your AI stack. It extracts, cleans, deduplicates, classifies, and fuses everything into a unified knowledge graph — structured, versioned, and explainable.
          </p>
          <p className="text-slate-400 leading-relaxed">
            Connect any storage backend. Use our native Neo4j + Qdrant stack, or swap in your own. GCTRL is infrastructure-agnostic, built to integrate with whatever you already run.
          </p>
          <div className="mt-8">
            <Link to="/register" className="btn-cta-primary">Start Grounding Your Data</Link>
          </div>
        </div>

        {/* Orbit diagram */}
        <div className="reveal-right flex justify-center">
          <div className="relative h-64 w-64">
            {/* Centre hub */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="relative z-10 flex h-20 w-20 items-center justify-center rounded-2xl border border-indigo-500/40 bg-indigo-600/20 shadow-lg shadow-indigo-900/40 backdrop-blur-sm">
                <img src="/gctrl/icon-color.svg?v=2" alt="GCTRL" className="h-10 w-10" />
              </div>
              <div className="absolute h-20 w-20 rounded-2xl bg-indigo-600/10 blur-xl" />
            </div>

            {/* Orbit ring */}
            <div className="absolute inset-0 rounded-full border border-dashed border-indigo-500/15" />

            {/* Satellite nodes */}
            {CAPABILITIES.map((cap, i) => {
              const angle = (i / CAPABILITIES.length) * 360
              const rad = (angle * Math.PI) / 180
              const r = 108
              const x = 50 + (r / 128) * 50 * Math.cos(rad)
              const y = 50 + (r / 128) * 50 * Math.sin(rad)
              return (
                <div
                  key={cap.label}
                  className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl border border-slate-700/60 bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-slate-300 shadow-md"
                  style={{ left: `${x}%`, top: `${y}%` }}
                >
                  {cap.label}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

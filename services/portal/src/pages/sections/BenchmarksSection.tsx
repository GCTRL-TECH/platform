import { Link } from 'react-router-dom'

const STATS = [
  // Two quality numbers share one card so the grid stays a single row of four.
  {
    key: 'quality',
    sub: 'unsupervised · zero training',
    metrics: [
      { value: '0.97', unit: 'F1', label: 'Entity linking (DBLP-ACM)' },
      { value: '0.978', unit: 'recall', label: 'NER detection (bilingual)' },
    ],
  },
  { key: 'latency', value: '<50', unit: 'ms p95', label: 'Memory retrieval latency', sub: '7-27 ms median' },
  { key: 'acl', value: '≈0', unit: 'ms', label: 'Access-control overhead', sub: 'compliance is effectively free' },
  { key: 'throughput', value: '2,750', unit: '/s', label: 'Matching-engine throughput', sub: 'sub-quadratic ~O(n^1.5)' },
]

// Competitor figures are CITED from published papers on the same public datasets -
// not head-to-heads we ran. GCTRL numbers are measured on our testbench.
const COMPARE = [
  { dataset: 'DBLP-ACM', gctrl: '0.97', note: 'no training', sota: 'Ditto 0.989 · DeepMatcher 0.985' },
  { dataset: 'Abt-Buy', gctrl: '0.866', note: 'local embeddings', sota: 'Ditto 0.891 · DeepMatcher 0.628' },
]

export function BenchmarksSection() {
  return (
    <div className="border-t border-slate-900 bg-[#020617] px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="reveal mx-auto max-w-2xl text-center">
          <span className="glass-pill mb-5">Benchmarks</span>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Near-supervised quality.{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              Zero training.
            </span>
          </h2>
          <p className="mt-4 text-lg text-slate-400">
            Measured on standard public benchmarks and our own testbench - fully local, no labelled data.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {STATS.map((s, i) => (
            <div key={s.key} className={`stat-card reveal reveal-delay-${(i % 4) + 1}`}>
              {s.metrics ? (
                <>
                  <div className="space-y-2">
                    {s.metrics.map((m) => (
                      <div key={m.label} className="flex items-baseline gap-2">
                        <p className="text-2xl font-bold text-white sm:text-3xl">
                          {m.value}
                          <span className="ml-1 text-sm font-medium text-indigo-300">{m.unit}</span>
                        </p>
                        <p className="text-xs font-medium text-slate-300">{m.label}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">{s.sub}</p>
                </>
              ) : (
                <>
                  <p className="text-3xl font-bold text-white sm:text-4xl">
                    {s.value}
                    <span className="ml-1 text-base font-medium text-indigo-300">{s.unit}</span>
                  </p>
                  <p className="mt-2 text-sm font-medium text-slate-300">{s.label}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{s.sub}</p>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="reveal mt-10 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Entity linking F1 - vs published SOTA on the same datasets
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-semibold">Dataset</th>
                <th className="px-5 py-3 font-semibold">GCTRL (measured)</th>
                <th className="px-5 py-3 font-semibold">Published SOTA (cited)</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((row) => (
                <tr key={row.dataset} className="border-t border-slate-800/60">
                  <td className="px-5 py-3 font-medium text-slate-200">{row.dataset}</td>
                  <td className="px-5 py-3">
                    <span className="text-lg font-bold text-emerald-400">{row.gctrl}</span>
                    <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">{row.note}</span>
                  </td>
                  <td className="px-5 py-3 text-slate-400">{row.sota}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-800 px-5 py-3 text-xs text-slate-500">
            Supervised baselines are cited from their published papers (Ditto, DeepMatcher) on the identical public
            datasets - GCTRL reaches comparable quality with no labelled training data. Head-to-heads vs other
            GraphRAG systems are in progress.
          </p>
        </div>

        <div className="reveal mt-8 flex flex-col items-center justify-between gap-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-6 py-5 sm:flex-row">
          <p className="text-sm text-slate-300">
            <span className="font-semibold text-cyan-300">Performance tip:</span> vector search is the slowest retrieval
            step (~44 ms vs ~7 ms for graph). Qdrant is <span className="font-medium text-slate-100">swappable</span> -
            point GCTRL at a faster vector store to cut query latency further.
          </p>
          <Link to="/docs/benchmarks" className="btn-cta-secondary shrink-0">
            Full benchmarks →
          </Link>
        </div>
      </div>
    </div>
  )
}

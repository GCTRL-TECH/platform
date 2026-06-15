import { Route, ShieldCheck, ServerCog } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type Point = {
  title: string
  body: string
  icon: LucideIcon
}

const POINTS: Point[] = [
  {
    title: 'Every answer is traceable',
    body: 'Vectors only tell you how similar two chunks are. The graph reconstructs the exact path — query to entities to source documents — so every answer comes with timestamps and a confidence score.',
    icon: Route,
  },
  {
    title: 'Audit-ready by default',
    body: 'GDPR Article 22 and ISO 27001 demand explainable decisions. The graph layer hands compliance teams that audit trail out of the box — no custom tooling required.',
    icon: ShieldCheck,
  },
  {
    title: 'Sovereign and on-prem',
    body: 'Run Neo4j, Qdrant, and the full GCTRL stack inside your own perimeter. No data leaves, no vendor lock-in — total sovereignty.',
    icon: ServerCog,
  },
]

const STATS = [
  { value: '100%', label: 'On-prem capable', sub: 'No cloud dependency required' },
  { value: 'Full', label: 'Audit trail', sub: 'Every answer traceable to source' },
  { value: 'GDPR', label: 'Article 22 ready', sub: 'Explainability by default' },
]

export function ExplainabilitySection() {
  return (
    <section className="relative overflow-hidden bg-[#020617] px-6 py-28">
      {/* Background accent */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[420px] w-[820px] rounded-full bg-violet-800/8 blur-[110px]" />
      </div>

      <div className="relative mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-400">The Graph Advantage</p>
          <h2 className="text-4xl font-bold text-white md:text-5xl">
            Explainable by design.
            <br />
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              Not a black box.
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl leading-relaxed text-slate-400">
            Vectors tell you <em>how similar</em> two chunks are. The knowledge graph tells you <em>why</em> an answer is
            correct — and proves it with a reasoning path you can follow all the way back to the source.
          </p>
        </div>

        {/* Split: points left, provenance trail right */}
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="space-y-8">
            {POINTS.map((p, i) => {
              const Icon = p.icon
              return (
                <div key={p.title} className={`reveal reveal-left reveal-delay-${i + 1} flex gap-5`}>
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/25 bg-violet-500/10 text-violet-300">
                    <Icon className="h-5 w-5" strokeWidth={1.75} />
                  </div>
                  <div>
                    <h3 className="mb-1.5 font-semibold text-white">{p.title}</h3>
                    <p className="text-sm leading-relaxed text-slate-400">{p.body}</p>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Provenance trail visual */}
          <div className="reveal-right flex justify-center">
            <div className="relative w-full max-w-md rounded-2xl border border-violet-500/15 bg-violet-950/20 p-6 backdrop-blur-sm">
              <p className="mb-5 text-center text-[10px] font-mono uppercase tracking-widest text-violet-400/70">
                Reasoning Path
              </p>
              <svg viewBox="0 0 320 280" className="h-full w-full" fill="none" role="img" aria-label="Provenance trail from query through graph entities to source citations">
                <defs>
                  <linearGradient id="prov-flow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgb(99,102,241)" />
                    <stop offset="50%" stopColor="rgb(139,92,246)" />
                    <stop offset="100%" stopColor="rgb(34,211,238)" />
                  </linearGradient>
                  <radialGradient id="prov-glow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="rgb(139,92,246)" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="rgb(139,92,246)" stopOpacity="0" />
                  </radialGradient>
                </defs>

                {/* glow behind the central entity layer */}
                <circle cx="160" cy="140" r="70" fill="url(#prov-glow)" />

                {/* links: query -> entities */}
                <line x1="160" y1="48" x2="92" y2="138" stroke="url(#prov-flow)" strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="5 3" />
                <line x1="160" y1="48" x2="160" y2="118" stroke="url(#prov-flow)" strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="5 3" />
                <line x1="160" y1="48" x2="228" y2="138" stroke="url(#prov-flow)" strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="5 3" />
                {/* entity-to-entity relation */}
                <line x1="92" y1="138" x2="160" y2="140" stroke="rgb(139,92,246)" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3 3" />
                <line x1="160" y1="140" x2="228" y2="138" stroke="rgb(139,92,246)" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3 3" />
                {/* entities -> sources */}
                <line x1="92" y1="138" x2="92" y2="222" stroke="rgb(34,211,238)" strokeOpacity="0.45" strokeWidth="1.25" strokeDasharray="4 3" />
                <line x1="160" y1="140" x2="160" y2="222" stroke="rgb(34,211,238)" strokeOpacity="0.45" strokeWidth="1.25" strokeDasharray="4 3" />
                <line x1="228" y1="138" x2="228" y2="222" stroke="rgb(34,211,238)" strokeOpacity="0.45" strokeWidth="1.25" strokeDasharray="4 3" />

                {/* query node */}
                <g>
                  <rect x="108" y="26" width="104" height="30" rx="8" fill="rgb(99,102,241)" fillOpacity="0.18" stroke="rgb(99,102,241)" strokeOpacity="0.6" strokeWidth="1" />
                  <text x="160" y="45" textAnchor="middle" fontSize="11" fill="rgb(199,210,254)" fontFamily="monospace">Query</text>
                </g>

                {/* entity nodes */}
                {[
                  { cx: 92, label: 'Entity' },
                  { cx: 160, label: 'Entity' },
                  { cx: 228, label: 'Entity' },
                ].map((n) => (
                  <g key={`e-${n.cx}`}>
                    <circle cx={n.cx} cy={n.cx === 160 ? 140 : 138} r="15" fill="rgb(139,92,246)" fillOpacity="0.22" stroke="rgb(139,92,246)" strokeOpacity="0.65" strokeWidth="1.25" />
                    <text x={n.cx} y={(n.cx === 160 ? 140 : 138) + 3.5} textAnchor="middle" fontSize="7.5" fill="rgb(221,214,254)" fontFamily="monospace">●</text>
                  </g>
                ))}

                {/* source citation nodes */}
                {[
                  { cx: 92, label: 'doc · 09:42' },
                  { cx: 160, label: 'doc · 11:18' },
                  { cx: 228, label: 'doc · 14:05' },
                ].map((s) => (
                  <g key={`s-${s.cx}`}>
                    <rect x={s.cx - 30} y="222" width="60" height="26" rx="6" fill="rgb(34,211,238)" fillOpacity="0.14" stroke="rgb(34,211,238)" strokeOpacity="0.55" strokeWidth="1" />
                    <text x={s.cx} y="238" textAnchor="middle" fontSize="7" fill="rgb(165,243,252)" fontFamily="monospace">{s.label}</text>
                  </g>
                ))}

                {/* layer captions */}
                <text x="14" y="44" fontSize="7.5" fill="rgb(100,116,139)" fontFamily="monospace">ask</text>
                <text x="14" y="143" fontSize="7.5" fill="rgb(100,116,139)" fontFamily="monospace">graph</text>
                <text x="14" y="239" fontSize="7.5" fill="rgb(100,116,139)" fontFamily="monospace">proof</text>
              </svg>

              <div className="mt-4 flex items-center justify-center gap-4 text-[10px] font-mono text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" /> query
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-400" /> entities
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" /> sources
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-20 grid gap-6 sm:grid-cols-3 reveal">
          {STATS.map((s) => (
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

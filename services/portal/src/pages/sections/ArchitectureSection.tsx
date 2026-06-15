import { Suspense, lazy, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

const ArchitectureScene = lazy(() => import('@/components/three/ArchitectureScene'))

// Render the WebGL scene only when the browser can handle it and the user hasn't
// asked to reduce motion — otherwise show the static layered diagram fallback.
function useCanRender3D() {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let webgl = false
    try {
      const c = document.createElement('canvas')
      webgl = !!(c.getContext('webgl2') || c.getContext('webgl'))
    } catch {
      webgl = false
    }
    setOk(!reduced && webgl)
  }, [])
  return ok
}

function StaticArchitecture() {
  const Row = ({ items, accent }: { items: string[]; accent: string }) => (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {items.map((it) => (
        <span key={it} className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${accent}`}>
          {it}
        </span>
      ))}
    </div>
  )
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">
      <span className="text-[10px] uppercase tracking-[0.2em] text-violet-300">your agents · via MCP</span>
      <Row items={['Claude', 'Cursor', 'Hermes']} accent="border-violet-400/30 bg-violet-500/10 text-violet-200" />
      <div className="text-slate-600">↓</div>
      <div className="rounded-2xl border border-indigo-400/40 bg-indigo-500/10 px-6 py-4 text-center backdrop-blur-sm">
        <div className="bg-gradient-to-r from-indigo-300 via-violet-300 to-cyan-300 bg-clip-text text-lg font-bold text-transparent">
          GCTRL
        </div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-300">middleware</div>
        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
          {['Hot', 'Warm', 'Cold', 'Wiki'].map((m) => (
            <span key={m} className="rounded border border-white/10 bg-slate-950/50 px-1.5 py-0.5 text-[10px] text-slate-300">
              {m}
            </span>
          ))}
        </div>
      </div>
      <div className="text-slate-600">↓</div>
      <Row items={['Neo4j', 'Qdrant', 'Postgres', 'Redis']} accent="border-cyan-400/30 bg-cyan-500/10 text-cyan-200" />
      <span className="text-[10px] uppercase tracking-[0.2em] text-cyan-300">your storage · swappable</span>
    </div>
  )
}

export function ArchitectureSection() {
  const can3D = useCanRender3D()

  return (
    <div className="relative overflow-hidden border-y border-slate-900 bg-[#020617] px-6 py-24">
      <div className="pointer-events-none absolute left-1/2 top-1/2 -z-0 h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/10 blur-[120px]" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        {/* 3D visual */}
        <div className="reveal-left order-2 h-[26rem] w-full lg:order-1 lg:h-[32rem]">
          {can3D ? (
            <Suspense fallback={<StaticArchitecture />}>
              <ArchitectureScene />
            </Suspense>
          ) : (
            <StaticArchitecture />
          )}
        </div>

        {/* Narrative */}
        <div className="reveal-right order-1 lg:order-2">
          <span className="glass-pill mb-5">Architecture</span>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Middleware that sits on top of{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              whatever you already run
            </span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-slate-400">
            GCTRL is a stateless orchestration layer over your graph and vector stores. It bundles Neo4j,
            Qdrant, Postgres and Redis for a one-line install — but every one of them is{' '}
            <span className="font-medium text-slate-200">swappable</span>. Point GCTRL at your own managed
            stores and own your data end to end. No lock-in.
          </p>

          <ul className="mt-7 space-y-4">
            {[
              ['Ingestion layer + memory organiser', 'GCTRL ingests at scale, builds a knowledge graph, and keeps it clean — the part other "agent memory" tools skip.'],
              ['Raw storage for deterministic context', 'Authoritative, queryable facts — not a fuzzy embedding blob. Ground your agents on truth.'],
              ['Parallel memory layers', 'Hot dossiers, warm chunks, the cold graph, and a curated Wiki-LLM of company knowledge — all at once.'],
              ['Your agents plug in over MCP', 'Claude, Cursor, Hermes and more gain durable, access-controlled memory as a team member.'],
            ].map(([title, body]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400" />
                <div>
                  <p className="font-semibold text-slate-100">{title}</p>
                  <p className="text-sm leading-relaxed text-slate-400">{body}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-8">
            <Link to="/docs/architecture" className="btn-cta-secondary">
              Explore the architecture →
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

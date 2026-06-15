import { Suspense, lazy, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArchitectureDiagram } from './ArchitectureDiagram'

const ArchitectureScene = lazy(() => import('@/components/three/ArchitectureScene'))

// The galaxy is WebGL; render it only when the browser can, and the user hasn't
// asked to reduce motion. The glass diagram (DOM) is always shown on top.
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

const STATIC_BG = 'h-full w-full bg-[radial-gradient(circle_at_50%_38%,rgba(99,102,241,0.20),transparent_70%)]'

export function ArchitectureSection() {
  const can3D = useCanRender3D()

  return (
    <div className="relative overflow-hidden border-y border-slate-900 bg-[#020617] px-6 py-24">
      <div className="pointer-events-none absolute left-1/2 top-1/2 -z-0 h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/10 blur-[120px]" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        {/* Visual: galaxy background + readable iced-glass diagram */}
        <div className="reveal-left relative order-2 h-[38rem] w-full overflow-hidden rounded-3xl border border-white/5 lg:order-1 lg:h-[44rem]">
          <div className="absolute inset-0">
            {can3D ? (
              <Suspense fallback={<div className={STATIC_BG} />}>
                <ArchitectureScene />
              </Suspense>
            ) : (
              <div className={STATIC_BG} />
            )}
          </div>
          <div className="relative z-10 h-full">
            <ArchitectureDiagram />
          </div>
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
            Sources flow in, agents plug in, and access control governs both — while GCTRL organises everything into
            layered memory on top of <span className="font-medium text-slate-200">swappable</span> storage. Bundled for
            a one-line install; point it at your own Neo4j, Qdrant and Postgres anytime. No lock-in.
          </p>

          <ul className="mt-7 space-y-4">
            {[
              ['Ingest from any source', 'SharePoint, Google Drive, email archives and other silos stream in through a governed ingestion layer.'],
              ['Full classification control', 'Per-element clearance on nodes, edges and chunks. Scoped tokens for every user and agent. Merge everyone’s knowledge into one graph and classification still holds — each person sees only what they’re cleared for. Granular, auditable, on every read and write.'],
              ['Parallel memory layers', 'Hot dossiers, warm chunks, the cold graph, and a curated Wiki — each backed by its own store, organised on a high-performance core.'],
              ['Your agents plug in over MCP', 'Claude, Codex, Hermes and more gain durable, access-controlled memory as a team member.'],
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

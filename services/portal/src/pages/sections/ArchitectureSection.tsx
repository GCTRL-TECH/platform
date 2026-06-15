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

function Pill({ children, accent }: { children: string; accent: string }) {
  return <span className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${accent}`}>{children}</span>
}

function Layer({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="w-full rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <p className="mb-2 text-center text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      {children}
    </div>
  )
}

function StaticArchitecture() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4">
      {/* Sources & Agents */}
      <Layer label="Sources & Agents">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-wrap justify-center gap-1.5">
            {['SharePoint', 'Google Drive', 'Other Silo'].map((s) => (
              <Pill key={s} accent="border-cyan-400/30 bg-cyan-500/10 text-cyan-200">{s}</Pill>
            ))}
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {['Hermes', 'Claude', 'Codex'].map((s) => (
              <Pill key={s} accent="border-violet-400/30 bg-violet-500/10 text-violet-200">{s}</Pill>
            ))}
          </div>
        </div>
      </Layer>
      <span className="text-xs text-slate-600">↓ &nbsp;&nbsp; ↑↓</span>
      <Layer label="Access Control">
        <div className="flex flex-wrap justify-center gap-1.5">
          <Pill accent="border-amber-400/30 bg-amber-500/10 text-amber-200">Ingestion · classify</Pill>
          <Pill accent="border-amber-400/30 bg-amber-500/10 text-amber-200">Access rights · clearance</Pill>
        </div>
      </Layer>
      <span className="text-xs text-slate-600">↕</span>
      <div className="w-full rounded-xl border border-indigo-400/40 bg-indigo-500/10 p-3 text-center">
        <div className="bg-gradient-to-r from-indigo-300 via-violet-300 to-cyan-300 bg-clip-text text-sm font-bold text-transparent">
          GCTRL · Middleware
        </div>
        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
          {['Hot', 'Warm', 'Cold', 'Wiki'].map((m) => (
            <Pill key={m} accent="border-white/10 bg-slate-950/50 text-slate-300">{m}</Pill>
          ))}
        </div>
      </div>
      <span className="text-xs text-slate-600">↕</span>
      <Layer label="Your Infrastructure">
        <div className="flex flex-wrap justify-center gap-1.5">
          {['Neo4j', 'Postgres', 'Qdrant', 'Wiki'].map((s) => (
            <Pill key={s} accent="border-sky-400/30 bg-sky-500/10 text-sky-200">{s}</Pill>
          ))}
        </div>
      </Layer>
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
        <div className="reveal-left order-2 h-[38rem] w-full lg:order-1 lg:h-[44rem]">
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
            Sources flow in, agents plug in, and access control governs both — while GCTRL organises everything into
            layered memory on top of <span className="font-medium text-slate-200">swappable</span> storage. Bundled for
            a one-line install; point it at your own Neo4j, Qdrant and Postgres anytime. No lock-in.
          </p>

          <ul className="mt-7 space-y-4">
            {[
              ['Ingest from any source', 'SharePoint, Google Drive, email archives and other silos stream in through a governed ingestion layer.'],
              ['Full classification control', 'Per-element clearance on nodes, edges and chunks. Scoped tokens for every user and agent. Merge everyone’s knowledge into one graph and classification still holds — each person sees only what they’re cleared for. Granular, auditable, on every read and write.'],
              ['Parallel memory layers', 'Hot dossiers, warm chunks, the cold graph, and a curated Wiki — organised on a high-performance core.'],
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

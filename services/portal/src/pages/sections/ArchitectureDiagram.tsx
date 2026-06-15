// The readable foreground for the architecture visual: iced-glass panels laid
// out in three layers over the galaxy background. Pure DOM — no 3D label drift.
// Memory tiers connect DIRECTLY to their backing store (Hot↔Postgres,
// Warm↔Qdrant, Cold↔Neo4j, Wiki↔Wiki).

const CI = {
  cyan: '#22d3ee',
  violet: '#a78bfa',
  indigo: '#818cf8',
  iceCyan: '#67e8f9',
  sky: '#38bdf8',
}

function Lane({ color, dir = 'down' }: { color: string; dir?: 'down' | 'up' | 'both' }) {
  const Dot = ({ cls }: { cls: string }) => (
    <span className={`absolute left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${cls}`} style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
  )
  return (
    <div className="relative mx-auto h-9 w-px" style={{ background: `linear-gradient(to bottom, transparent, ${color}66, transparent)` }}>
      {(dir === 'down' || dir === 'both') && <Dot cls="arch-flow-down" />}
      {(dir === 'up' || dir === 'both') && <Dot cls="arch-flow-up" />}
    </div>
  )
}

function Panel({ caption, children, emphasized = false }: { caption: string; children: React.ReactNode; emphasized?: boolean }) {
  return (
    <div
      className={`rounded-2xl border ${emphasized ? 'border-indigo-400/30' : 'border-white/10'} bg-slate-950/55 p-3.5 backdrop-blur-md`}
      style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 30px rgba(2,6,23,0.4)' }}
    >
      <p className="mb-2.5 text-center text-[9px] font-semibold uppercase tracking-[0.2em] text-slate-500">{caption}</p>
      {children}
    </div>
  )
}

function Chip({ label, sub, accent }: { label: string; sub?: string; accent: string }) {
  return (
    <div className="rounded-lg border bg-white/[0.05] px-2 py-1.5 text-center backdrop-blur-sm" style={{ borderColor: `${accent}40` }}>
      <p className="text-[11px] font-semibold leading-tight text-slate-100">{label}</p>
      {sub && <p className="text-[8px] uppercase leading-tight tracking-wider text-slate-400">{sub}</p>}
    </div>
  )
}

const MEM = [
  { label: 'Hot', sub: 'dossiers', color: CI.violet },
  { label: 'Warm', sub: 'chunks', color: CI.indigo },
  { label: 'Cold', sub: 'graph', color: CI.cyan },
  { label: 'Wiki', sub: 'pages', color: CI.iceCyan },
]
const STORE = ['Postgres', 'Qdrant', 'Neo4j', 'Wiki']

export function ArchitectureDiagram() {
  return (
    <div className="relative flex h-full w-full items-center justify-center px-2 py-4">
      <div className="w-full max-w-sm">
        {/* Layer 1 — Sources & Agents */}
        <Panel caption="Sources & Agents">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <p className="text-center text-[9px] uppercase tracking-wider text-cyan-300/80">Sources</p>
              {['SharePoint', 'Google Drive', 'Email & files'].map((s) => (
                <Chip key={s} label={s} accent={CI.cyan} />
              ))}
            </div>
            <div className="space-y-1.5">
              <p className="text-center text-[9px] uppercase tracking-wider text-violet-300/80">Agents</p>
              {['Claude', 'Codex', 'Hermes'].map((s) => (
                <Chip key={s} label={s} accent={CI.violet} />
              ))}
            </div>
          </div>
        </Panel>

        {/* connector: sources → ingestion (down) · agents ↔ rights (both) */}
        <div className="flex justify-around px-10 py-0.5">
          <Lane color={CI.cyan} dir="down" />
          <Lane color={CI.violet} dir="both" />
        </div>

        {/* Layer 2 — GCTRL Middleware (access control + core + memory, one layer) */}
        <Panel caption="GCTRL · Middleware" emphasized>
          <div className="grid grid-cols-3 items-center gap-2">
            <Chip label="Ingestion" sub="classify" accent={CI.indigo} />
            <div
              className="rounded-xl border border-indigo-400/50 bg-indigo-500/15 px-2 py-2 text-center"
              style={{ boxShadow: '0 0 24px rgba(99,102,241,0.35), inset 0 1px 0 rgba(255,255,255,0.1)' }}
            >
              <p className="bg-gradient-to-r from-indigo-300 via-violet-300 to-cyan-300 bg-clip-text text-sm font-bold text-transparent">GCTRL</p>
              <p className="text-[8px] uppercase tracking-[0.15em] text-slate-300">core</p>
            </div>
            <Chip label="Access rights" sub="clearance" accent={CI.indigo} />
          </div>

          <p className="mb-1.5 mt-3 text-center text-[9px] uppercase tracking-wider text-slate-500">Memory layers</p>
          <div className="grid grid-cols-4 gap-1.5">
            {MEM.map((m) => (
              <div key={m.label} className="rounded-lg border bg-white/[0.05] px-1 py-1.5 text-center backdrop-blur-sm" style={{ borderColor: `${m.color}55` }}>
                <p className="text-[11px] font-semibold leading-tight" style={{ color: m.color }}>{m.label}</p>
                <p className="text-[8px] uppercase leading-tight tracking-wider text-slate-400">{m.sub}</p>
              </div>
            ))}
          </div>
        </Panel>

        {/* connector: each memory tier ↔ its own store, directly */}
        <div className="grid grid-cols-4 gap-1.5 px-3.5 py-0.5">
          {MEM.map((m) => <Lane key={m.label} color={m.color} dir="both" />)}
        </div>

        {/* Layer 3 — Your Infrastructure */}
        <Panel caption="Your Infrastructure · swappable">
          <div className="grid grid-cols-4 gap-1.5">
            {STORE.map((s, i) => <Chip key={`${s}-${i}`} label={s} accent={CI.sky} />)}
          </div>
        </Panel>
      </div>
    </div>
  )
}

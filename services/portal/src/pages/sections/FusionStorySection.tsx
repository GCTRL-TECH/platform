import { useEffect, useState } from 'react'
import { FileText, MessagesSquare, Bot, Database, Sparkles } from 'lucide-react'

/**
 * FusionStorySection — the product narrative as one looping animation.
 *
 * Four beats, ~3.4s each:
 *   0  Ingest — files, team chats, agent sessions, legacy systems flow in
 *   1  Graph  — the stream becomes entities + relations
 *   2  Fuse   — FUSE spots that two nodes are the SAME real-world thing
 *   3  Truth  — they merge into one governed "galaxy": a single source of
 *               truth, owned by the customer, on their infrastructure
 *
 * Implementation notes: everything animates with opacity/scale transitions
 * driven by a tiny stage machine — no timeline lib. Edges + flow particles
 * live in one stretched SVG (viewBox 100×56, preserveAspectRatio="none") so
 * coordinates are “percent of canvas”; nodes are HTML for crisp labels.
 * prefers-reduced-motion → static final beat.
 */

const STAGE_MS = 3400

const STEPS = [
  { title: 'Everything flows in', desc: 'Files, team chats, agent sessions, legacy systems' },
  { title: 'Becomes a living graph', desc: 'Entities and relations — not a pile of chunks' },
  { title: 'FUSE spots what’s the same', desc: 'Duplicates and contradictions resolve' },
  { title: 'One source of truth — yours', desc: 'Governed, on your own infrastructure' },
]

// Canvas coordinates: percent of the canvas (x 0-100, y 0-56).
const CENTER = { x: 52, y: 30 }

// The duplicate pair FUSE will merge (same company, two spellings).
const DUP_A = { x: 40, y: 14, label: 'Acme Corp' }
const DUP_B = { x: 66, y: 11, label: 'ACME GmbH' }
const MERGED = { x: 53, y: 12.5, label: 'Acme Corp' }

// Stable entities around the centre.
const NODES = [
  { x: 34, y: 32, label: 'M. Weber' },
  { x: 58, y: 36, label: 'Project Atlas' },
  { x: 74, y: 26, label: 'Berlin' },
  { x: 43, y: 46, label: 'Contract #218' },
  { x: 68, y: 47, label: 'Invoice 2209' },
]

// Edges before the merge (…to the two duplicate nodes) and after (…to the
// merged node). Only opacity changes — endpoints never animate.
const EDGES_STABLE: [number, number][][] = [
  [[34, 32], [58, 36]], // Weber — Atlas
  [[58, 36], [74, 26]], // Atlas — Berlin
  [[58, 36], [43, 46]], // Atlas — Contract
  [[34, 32], [43, 46]], // Weber — Contract
  [[58, 36], [68, 47]], // Atlas — Invoice
]
const EDGES_PRE: [number, number][][] = [
  [[DUP_A.x, DUP_A.y], [34, 32]],
  [[DUP_A.x, DUP_A.y], [58, 36]],
  [[DUP_B.x, DUP_B.y], [74, 26]],
]
const EDGES_POST: [number, number][][] = [
  [[MERGED.x, MERGED.y], [34, 32]],
  [[MERGED.x, MERGED.y], [58, 36]],
  [[MERGED.x, MERGED.y], [74, 26]],
]

// Ingest particles: start point + travel delta (SVG user units == canvas %).
const FLOWS = [
  { x: 10, y: 16, fx: 40, fy: 13, d: '0s' },
  { x: 10, y: 30, fx: 40, fy: 1, d: '0.9s' },
  { x: 9, y: 44, fx: 41, fy: -13, d: '1.7s' },
  { x: 92, y: 15, fx: -38, fy: 14, d: '0.5s' },
  { x: 93, y: 31, fx: -39, fy: 0, d: '1.3s' },
  { x: 92, y: 45, fx: -38, fy: -14, d: '2.1s' },
]

const SOURCES_LEFT = [
  { Icon: FileText, label: 'PDFs & docs' },
  { Icon: MessagesSquare, label: 'Team chats' },
]
const SOURCES_RIGHT = [
  { Icon: Bot, label: 'Agent sessions' },
  { Icon: Database, label: 'Legacy systems' },
]

function Node({ x, y, label, visible, accent = false, big = false }: {
  x: number; y: number; label: string; visible: boolean; accent?: boolean; big?: boolean
}) {
  return (
    <div
      className={`absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-700 ${
        visible ? 'opacity-100 scale-100' : 'opacity-0 scale-50'
      }`}
      style={{ left: `${x}%`, top: `${(y / 56) * 100}%` }}
    >
      <div className="flex flex-col items-center gap-1">
        <span
          className={`rounded-full ${
            big
              ? 'h-4 w-4 bg-white shadow-[0_0_10px_rgba(255,255,255,0.9),0_0_24px_rgba(129,140,248,0.8)]'
              : accent
                ? 'h-2.5 w-2.5 bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]'
                : 'h-2.5 w-2.5 bg-indigo-300 shadow-[0_0_8px_rgba(129,140,248,0.7)]'
          }`}
        />
        <span className={`whitespace-nowrap text-[10px] ${big ? 'font-semibold text-white' : 'text-slate-400'}`}>
          {label}
        </span>
      </div>
    </div>
  )
}

export function FusionStorySection() {
  const [stage, setStage] = useState(0)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setReduced(true)
      setStage(3)
      return
    }
    const t = window.setInterval(() => setStage((s) => (s + 1) % 4), STAGE_MS)
    return () => window.clearInterval(t)
  }, [])

  const graphVisible = stage >= 1
  const fusing = stage === 2
  const fused = stage === 3

  return (
    <section className="relative overflow-hidden bg-[#020617] px-6 py-28">
      <div className="mx-auto max-w-5xl">
        <div className="mb-12 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">How it feels</p>
          <h2 className="mx-auto max-w-3xl text-4xl font-bold text-white md:text-5xl">
            From scattered noise to{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              one source of truth.
            </span>
          </h2>
        </div>

        {/* ── Animation canvas ─────────────────────────────────────────── */}
        <div className="reveal relative mx-auto h-[340px] max-w-4xl rounded-3xl border border-slate-800 bg-slate-950/60 backdrop-blur-sm sm:h-[380px]">

          {/* Source chips — left + right rims */}
          <div className="absolute left-3 top-1/2 flex -translate-y-1/2 flex-col gap-4 sm:left-5">
            {SOURCES_LEFT.map(({ Icon, label }) => (
              <div key={label} className={`flex items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-900/80 px-3 py-2 transition-opacity duration-700 ${stage <= 1 ? 'opacity-100' : 'opacity-40'}`}>
                <Icon className="h-4 w-4 text-cyan-300" strokeWidth={1.75} />
                <span className="hidden text-xs text-slate-300 sm:block">{label}</span>
              </div>
            ))}
          </div>
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-4 sm:right-5">
            {SOURCES_RIGHT.map(({ Icon, label }) => (
              <div key={label} className={`flex items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-900/80 px-3 py-2 transition-opacity duration-700 ${stage <= 1 ? 'opacity-100' : 'opacity-40'}`}>
                <Icon className="h-4 w-4 text-violet-300" strokeWidth={1.75} />
                <span className="hidden text-xs text-slate-300 sm:block">{label}</span>
              </div>
            ))}
          </div>

          {/* Galaxy state — glow core + slow orbit rings behind the nodes */}
          <div
            aria-hidden
            className={`pointer-events-none absolute transition-opacity duration-1000 ${fused ? 'opacity-100' : 'opacity-0'}`}
            style={{ left: `${CENTER.x}%`, top: `${(CENTER.y / 56) * 100}%` }}
          >
            <div className="story-core-pulse absolute -translate-x-1/2 -translate-y-1/2 h-40 w-40 rounded-full bg-indigo-500/25 blur-2xl" />
            <div className="absolute -translate-x-1/2 -translate-y-1/2 h-44 w-44 animate-[spin_36s_linear_infinite] rounded-full border border-indigo-400/25">
              <span className="absolute -top-0.5 left-1/2 h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,0.9)]" />
            </div>
            <div className="absolute -translate-x-1/2 -translate-y-1/2 h-64 w-64 animate-[spin_55s_linear_infinite_reverse] rounded-full border border-violet-400/15">
              <span className="absolute top-1/2 -left-0.5 h-1.5 w-1.5 rounded-full bg-violet-300 shadow-[0_0_6px_rgba(196,181,253,0.9)]" />
            </div>
          </div>

          {/* Edges + ingest particles — one stretched SVG, coords = canvas % */}
          <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 100 56" preserveAspectRatio="none">
            {EDGES_STABLE.map(([[x1, y1], [x2, y2]], i) => (
              <line key={`s${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(129,140,248,0.35)" strokeWidth="1" vectorEffect="non-scaling-stroke" className={`transition-opacity duration-700 ${graphVisible ? 'opacity-100' : 'opacity-0'}`} />
            ))}
            {EDGES_PRE.map(([[x1, y1], [x2, y2]], i) => (
              <line key={`p${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(129,140,248,0.35)" strokeWidth="1" vectorEffect="non-scaling-stroke" className={`transition-opacity duration-700 ${graphVisible && !fused ? 'opacity-100' : 'opacity-0'}`} />
            ))}
            {EDGES_POST.map(([[x1, y1], [x2, y2]], i) => (
              <line key={`m${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(165,180,252,0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" className={`transition-opacity duration-700 ${fused ? 'opacity-100' : 'opacity-0'}`} />
            ))}
            {/* FUSE match indicator between the two duplicates */}
            <line x1={DUP_A.x} y1={DUP_A.y} x2={DUP_B.x} y2={DUP_B.y} stroke="rgba(252,211,77,0.9)" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" className={`transition-opacity duration-500 ${fusing ? 'opacity-100' : 'opacity-0'}`} />
            {/* Ingest particles */}
            {!reduced && stage <= 1 && FLOWS.map((f, i) => (
              <circle
                key={i}
                cx={f.x}
                cy={f.y}
                r="0.8"
                fill="rgba(165,243,252,0.9)"
                className="story-flow-dot"
                style={{ '--fx': `${f.fx}px`, '--fy': `${f.fy}px`, animationDelay: f.d } as React.CSSProperties}
              />
            ))}
          </svg>

          {/* Duplicate pair → merged node */}
          <Node {...DUP_A} visible={graphVisible && !fused} accent={fusing} />
          <Node {...DUP_B} visible={graphVisible && !fused} accent={fusing} />
          <Node {...MERGED} visible={fused} big />

          {/* Stable entities */}
          {NODES.map((n) => (
            <Node key={n.label} {...n} visible={graphVisible} />
          ))}

          {/* FUSE badge during the match beat */}
          <div
            className={`absolute left-1/2 top-2 -translate-x-1/2 transition-all duration-500 ${fusing ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}
          >
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-200">
              <Sparkles className="h-3 w-3" /> FUSE — same entity detected
            </span>
          </div>

          {/* Truth caption */}
          <div className={`absolute inset-x-0 bottom-4 text-center transition-all duration-1000 ${fused ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
            <p className="text-sm font-semibold text-white">One source of truth. <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">Yours.</span></p>
            <p className="mt-0.5 text-[11px] text-slate-500">Every fact governed, deduplicated, and owned — on your infrastructure.</p>
          </div>
        </div>

        {/* ── Step captions ────────────────────────────────────────────── */}
        <div className="reveal mx-auto mt-8 grid max-w-4xl grid-cols-2 gap-3 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              onClick={() => setStage(i)}
              className={`rounded-xl border px-4 py-3 text-left transition-all duration-500 ${
                stage === i
                  ? 'border-indigo-400/50 bg-indigo-500/10'
                  : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
              }`}
            >
              <p className={`text-sm font-semibold ${stage === i ? 'text-white' : 'text-slate-300'}`}>
                <span className={`mr-1.5 ${stage === i ? 'text-indigo-300' : 'text-slate-600'}`}>{i + 1}</span>
                {s.title}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{s.desc}</p>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Check } from 'lucide-react'

/**
 * Card micro-vignettes - the fusion-story visual language (glowing dots,
 * hairline edges, slate chips, percent-native canvas) shrunk into small
 * looping scenes that act out each card's message. All timing lives in the
 * shared 6s `vig-*` keyframes (globals.css); geometry comes in per instance
 * via --x0/--x1/--y1 custom properties.
 *
 * Convention (mirrors the CSS): BASE inline styles are the resolved END
 * state of each scene. The keyframes carry every transient state, so with
 * reduced motion (animation: none) each canvas still shows a meaningful
 * static diagram - never an empty box.
 */

/** Pause all loops while the vignette is offscreen. */
function useVignettePause() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      ([entry]) => el.classList.toggle('vig-paused', !entry.isIntersecting),
      { rootMargin: '80px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return ref
}

function Canvas({ children }: { children: ReactNode }) {
  const ref = useVignettePause()
  return (
    <div
      ref={ref}
      aria-hidden
      className="relative mb-5 h-24 w-full overflow-hidden rounded-xl border border-slate-800/60 bg-slate-950/50"
    >
      {children}
    </div>
  )
}

const DOT_COLOR = {
  indigo: 'bg-indigo-300 shadow-[0_0_8px_rgba(129,140,248,0.7)]',
  cyan: 'bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.7)]',
  violet: 'bg-violet-300 shadow-[0_0_8px_rgba(196,181,253,0.7)]',
  amber: 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.7)]',
  slate: 'bg-slate-400 shadow-[0_0_6px_rgba(148,163,184,0.5)]',
} as const

function VDot({
  x, y, color = 'indigo', label, big = false, className = '', style,
}: {
  x?: number; y: number; color?: keyof typeof DOT_COLOR; label?: string
  big?: boolean; className?: string; style?: CSSProperties
}) {
  return (
    // Only the dot is in-flow (translate(-50%,-50%) centres it on x/y);
    // the label hangs below without shifting the anchor - same trick as
    // the fusion story's Node.
    <div
      className={`absolute -translate-x-1/2 -translate-y-1/2 ${className}`}
      style={{ ...(x != null ? { left: `${x}%` } : {}), top: `${y}%`, ...style }}
    >
      <span
        className={`block rounded-full ${
          big
            ? 'h-3.5 w-3.5 bg-white shadow-[0_0_9px_rgba(255,255,255,0.9),0_0_20px_rgba(129,140,248,0.8)]'
            : `h-2 w-2 ${DOT_COLOR[color]}`
        }`}
      />
      {label && (
        <span className={`absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-[9px] ${big ? 'font-semibold text-white' : 'text-slate-400'}`}>
          {label}
        </span>
      )}
    </div>
  )
}

function VChip({ x, y, children, tone = 'slate', className = '', style }: {
  x: number; y: number; children: ReactNode
  tone?: 'slate' | 'amber' | 'cyan'; className?: string; style?: CSSProperties
}) {
  const tones = {
    slate: 'border-slate-700/70 bg-slate-900/80 text-slate-300',
    amber: 'border-amber-400/30 bg-amber-500/10 text-amber-200/90',
    cyan: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200/90',
  }
  return (
    <div
      className={`absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] leading-none ${tones[tone]} ${className}`}
      style={{ left: `${x}%`, top: `${y}%`, ...style }}
    >
      {children}
    </div>
  )
}

/** Hairline SVG edge layer sharing the 0-100 canvas space. */
function Edges({ children }: { children: ReactNode }) {
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
      {children}
    </svg>
  )
}

/* ── Problem 1: Locked in silos - dots trapped in boxes; one keeps
      trying to cross the wall and bounces off. ─────────────────────── */
export function SilosVignette() {
  return (
    <Canvas>
      {[
        { x: 4, label: 'SharePoint', flash: false },
        { x: 37, label: 'Legacy SQL', flash: true },
        { x: 70, label: 'Mail', flash: false },
      ].map((box) => (
        <div
          key={box.label}
          className={`absolute rounded-md border bg-slate-900/50 ${box.flash ? 'vig-wall-flash border-slate-700/70' : 'border-slate-700/70'}`}
          style={{ left: `${box.x}%`, width: '26%', top: '16%', height: '64%' }}
        >
          <span className="absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap text-[8px] text-slate-500">
            {box.label}
          </span>
        </div>
      ))}
      {/* Restless trapped dots */}
      <VDot x={11} y={38} color="slate" className="vig-jitter" />
      <VDot x={22} y={55} color="slate" className="vig-jitter" style={{ animationDelay: '-1.7s' }} />
      <VDot x={78} y={40} color="slate" className="vig-jitter" style={{ animationDelay: '-3.1s' }} />
      <VDot x={88} y={58} color="slate" className="vig-jitter" style={{ animationDelay: '-0.8s' }} />
      <VDot x={57} y={60} color="slate" className="vig-jitter" style={{ animationDelay: '-2.4s' }} />
      {/* The one that keeps trying to leave (middle box, right wall at 63%) */}
      <VDot y={40} color="amber" className="vig-escape" style={{ left: '46%', ['--x0' as string]: '46%', ['--x1' as string]: '61%' }} />
    </Canvas>
  )
}

/* ── Problem 2: Messy & contradictory - the canonical duplicate pair
      plus one fact flickering between two values. ──────────────────── */
export function ConflictVignette() {
  return (
    <Canvas>
      <Edges>
        <line
          x1={31} y1={34} x2={69} y2={34}
          stroke="rgb(252 211 77 / 0.55)" strokeWidth={1} strokeDasharray="0.05 0.035"
          pathLength={1} vectorEffect="non-scaling-stroke"
          className="vig-flicker story-dash-march"
        />
      </Edges>
      <VDot x={28} y={34} color="amber" label="Acme Corp" className="story-match-pulse" />
      <VDot x={72} y={34} color="amber" label="ACME GmbH" className="story-match-pulse" style={{ animationDelay: '-0.55s' }} />
      <span className="vig-flicker absolute left-1/2 top-[30%] -translate-x-1/2 -translate-y-1/2 text-xs font-semibold text-amber-300" style={{ animationDelay: '-1.2s' }}>
        ≠
      </span>
      {/* Same fact, two truths - chips stacked on one spot, anti-phase */}
      <VChip x={50} y={78} tone="slate" className="vig-alt">Revenue: €1.2M</VChip>
      <VChip x={50} y={78} tone="amber" className="vig-alt" style={{ animationDelay: '-3s', opacity: 0 }}>
        Revenue: €2.1M
      </VChip>
    </Canvas>
  )
}

/* ── Problem 3: Governance overwhelming - the clearance ring that
      never manages to close around the cluster. ────────────────────── */
export function GovernanceVignette() {
  return (
    <Canvas>
      <Edges>
        {([[30, 38, 48, 30], [48, 30, 64, 46], [30, 38, 40, 64], [40, 64, 58, 70], [64, 46, 58, 70]] as const).map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgb(148 163 184 / 0.22)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {/* The failing clearance ring: draws ~70%, collapses, retries.
            Base = incomplete ring (reduced-motion end state). */}
        <path
          d="M 48 14 C 74 16 82 38 76 58 C 70 78 52 86 38 80 C 22 74 16 54 22 38 C 27 24 36 16 48 14 Z"
          fill="none" stroke="rgb(252 211 77 / 0.6)" strokeWidth={1.2}
          strokeDasharray="0.05 0.03" pathLength={1} vectorEffect="non-scaling-stroke"
          className="vig-ring-fail" style={{ strokeDashoffset: 0.3, opacity: 0.5 }}
        />
      </Edges>
      <VDot x={30} y={38} />
      <VDot x={48} y={30} />
      <VDot x={64} y={46} />
      <VDot x={40} y={64} color="violet" />
      <VDot x={58} y={70} color="violet" />
      <VChip x={80} y={22} tone="amber">who sees what?</VChip>
    </Canvas>
  )
}

/* ── Step 01: Ingest - dots cross the classification gate and come out
      wearing their clearance ring. ─────────────────────────────────── */
export function IngestVignette() {
  const ring = 'rgba(129, 140, 248, 0.45)'
  const dot = (y: number, delay: string) => (
    <VDot
      y={y} color="indigo" className="vig-gate-dot"
      style={{
        left: '88%',
        boxShadow: `0 0 0 2.5px ${ring}`,
        animationDelay: delay,
        ['--x0' as string]: '13%',
        ['--gx' as string]: '48%',
        ['--x1' as string]: '88%',
        ['--ring' as string]: ring,
      }}
    />
  )
  return (
    <Canvas>
      <VChip x={11} y={30}>Drive</VChip>
      <VChip x={11} y={66}>Mail</VChip>
      {/* The gate */}
      <div className="absolute w-px bg-gradient-to-b from-transparent via-indigo-400/70 to-transparent" style={{ left: '48%', top: '12%', height: '76%' }} />
      <span className="absolute -translate-x-1/2 text-[8px] uppercase tracking-widest text-indigo-300/80" style={{ left: '48%', top: '2%' }}>
        classify
      </span>
      {dot(30, '0s')}
      {dot(50, '-2s')}
      {dot(66, '-4s')}
    </Canvas>
  )
}

/* ── Step 02: Resolve & fuse - the duplicate pair from Problem 2 slides
      together and flashes into one canonical node; ≠ becomes =. ─────── */
export function FuseVignette() {
  return (
    <Canvas>
      {/* No labels on the sliding pair - they'd smear across each other
          mid-flight; the merged node carries the canonical name. */}
      <VDot y={46} color="violet" className="vig-merge-dot" style={{ left: '50%', opacity: 0, ['--x0' as string]: '22%' }} />
      <VDot y={46} color="violet" className="vig-merge-dot" style={{ left: '50%', opacity: 0, ['--x0' as string]: '78%' }} />
      <VDot x={50} y={46} big label="Acme Corp" className="vig-merge-result" style={{ opacity: 1 }} />
      <span className="vig-phase-a absolute left-1/2 top-[18%] -translate-x-1/2 -translate-y-1/2 text-xs font-semibold text-amber-300" style={{ opacity: 0 }}>
        ≠
      </span>
      <span className="vig-phase-b absolute left-1/2 top-[18%] -translate-x-1/2 -translate-y-1/2 text-xs font-semibold text-violet-300" style={{ opacity: 1 }}>
        =
      </span>
    </Canvas>
  )
}

/* ── Step 03: Organise into memory - dots settle into their layer.
      (The tetris beat: falling pieces finding their place.) ─────────── */
export function LayersVignette() {
  const SHELVES = [
    { y: 40, label: 'hot' },
    { y: 62, label: 'warm' },
    { y: 84, label: 'cold' },
  ]
  const DOTS: { x: number; shelf: number; color: 'cyan' | 'violet' | 'indigo'; delay: string }[] = [
    { x: 30, shelf: 0, color: 'cyan', delay: '0s' },
    { x: 62, shelf: 1, color: 'violet', delay: '-1.4s' },
    { x: 46, shelf: 1, color: 'indigo', delay: '-2.8s' },
    { x: 72, shelf: 2, color: 'cyan', delay: '-4.2s' },
  ]
  return (
    <Canvas>
      {SHELVES.map((s) => (
        <div key={s.label}>
          <div className="absolute border-t border-slate-700/60" style={{ left: '10%', right: '10%', top: `${s.y}%` }} />
          <span className="absolute -translate-y-full text-[8px] text-slate-500" style={{ right: '3%', top: `${s.y}%` }}>
            {s.label}
          </span>
        </div>
      ))}
      {DOTS.map((d, i) => (
        <VDot
          key={i} x={d.x} y={0} color={d.color} className="vig-drop"
          style={{ top: `${SHELVES[d.shelf].y - 5}%`, opacity: 1, animationDelay: d.delay, ['--y1' as string]: `${SHELVES[d.shelf].y - 5}%` }}
        />
      ))}
    </Canvas>
  )
}

/* ── Step 04: Serve to agents - a query edge lights up, the answer dot
      travels back to the agent, audited and with provenance. ────────── */
export function ServeVignette() {
  return (
    <Canvas>
      <Edges>
        <line x1={20} y1={30} x2={32} y2={52} stroke="rgb(148 163 184 / 0.25)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1={32} y1={52} x2={16} y2={72} stroke="rgb(148 163 184 / 0.25)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line
          x1={32} y1={52} x2={70} y2={52}
          stroke="rgb(103 232 249 / 0.7)" strokeWidth={1} strokeDasharray="0.05 0.03"
          pathLength={1} vectorEffect="non-scaling-stroke"
          className="vig-edge-cycle" style={{ strokeDashoffset: 0, opacity: 0.6 }}
        />
      </Edges>
      <VDot x={20} y={30} color="slate" />
      <VDot x={32} y={52} color="cyan" />
      <VDot x={16} y={72} color="slate" />
      <VDot y={52} color="cyan" className="vig-answer-dot" style={{ left: '70%', opacity: 0, ['--x0' as string]: '32%', ['--x1' as string]: '70%' }} />
      <VChip x={82} y={52} tone="cyan">Agent</VChip>
      <VChip x={50} y={80} tone="slate" className="vig-pop-late" style={{ opacity: 1 }}>
        <span className="inline-flex items-center gap-1">
          <Check className="h-2.5 w-2.5 text-emerald-400" strokeWidth={2.5} />
          audited · provenance
        </span>
      </VChip>
    </Canvas>
  )
}

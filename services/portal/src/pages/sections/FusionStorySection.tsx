import { useEffect, useState } from 'react'
import { FileText, Files, MessagesSquare, Bot, Database, Cloud, Mail, Server, Lock, type LucideIcon } from 'lucide-react'

/**
 * FusionStorySection — the product narrative as one looping animation.
 *
 * Four beats, ~3.4s each (a numbered headline at the top of the canvas names
 * the current beat; the cards below give the longer explanation):
 *   0  Ingest — particles stream from the contributor chips (left: team
 *      chats + agent sessions) and source chips (right: PDFs, drives,
 *      databases…) to the spots where nodes will appear
 *   1  Graph  — nodes pop in exactly where the dots landed, edges draw in
 *   2  Fuse   — everything dims except the duplicate pair; FUSE flags them
 *   3  Truth  — the duplicates visibly slide together and flash into ONE
 *      node; then a governed sub-scope is ringed "confidential" while the
 *      rest dims: scoped access on one shared graph
 *
 * Implementation notes: percent-native canvas — nodes, dots and SVG lines all
 * share one 0-100 coordinate space. The SVG (viewBox 0 0 100 100,
 * preserveAspectRatio="none") only holds LINES, which survive the non-uniform
 * stretch via vectorEffect="non-scaling-stroke" + pathLength=1. Dots and
 * nodes are HTML, so they stay pixel-crisp at any container size. Each Node
 * wrapper contains ONLY the dot (label hangs below via absolute positioning),
 * so the dot's centre sits exactly on the (x,y) the SVG edges point at.
 * One tiny stage machine, no timeline lib. prefers-reduced-motion → static
 * final beat.
 */

const STAGE_MS = 3400

const STEPS = [
  { title: 'Everything flows in', desc: 'Team chats, agent sessions, files, databases, legacy systems' },
  { title: 'Becomes a living graph', desc: 'Entities and relations — not a pile of chunks' },
  { title: 'FUSE spots what’s the same', desc: 'Duplicates and contradictions resolve' },
  { title: 'One governed source of truth — yours', desc: 'Access-controlled down to the node, on your own infrastructure' },
]

// The duplicate pair FUSE will merge (same company, two spellings).
const DUP_A = { x: 40, y: 25, label: 'Acme Corp' }
const DUP_B = { x: 66, y: 20, label: 'ACME GmbH' }
const MERGED = { x: 53, y: 22, label: 'Acme Corp' }

// Stable entities around the centre.
const NODES = [
  { x: 34, y: 57, label: 'M. Weber' },
  { x: 58, y: 64, label: 'Project Atlas' },
  { x: 74, y: 46, label: 'Berlin' },
  { x: 43, y: 82, label: 'Contract #218' },
  { x: 68, y: 84, label: 'Invoice 2209' },
]

// Edges before the merge (…to the two duplicate nodes) and after (…to the
// merged node). Only opacity/draw state changes — endpoints never animate.
const EDGES_STABLE: [number, number][][] = [
  [[34, 57], [58, 64]], // Weber — Atlas
  [[58, 64], [74, 46]], // Atlas — Berlin
  [[58, 64], [43, 82]], // Atlas — Contract
  [[34, 57], [43, 82]], // Weber — Contract
  [[58, 64], [68, 84]], // Atlas — Invoice
]
const EDGES_PRE: [number, number][][] = [
  [[DUP_A.x, DUP_A.y], [34, 57]],
  [[DUP_A.x, DUP_A.y], [58, 64]],
  [[DUP_B.x, DUP_B.y], [74, 46]],
]
const EDGES_POST: [number, number][][] = [
  [[MERGED.x, MERGED.y], [34, 57]],
  [[MERGED.x, MERGED.y], [58, 64]],
  [[MERGED.x, MERGED.y], [74, 46]],
]

// The governed sub-scope marked "confidential" in beat 3: Atlas + Contract +
// Invoice. Everything outside the area (except the freshly merged node)
// dims — scoped access on one shared graph.
// The outline is a custom blob polygon hugging the three nodes WITH their
// labels (labels hang ~5 units below each dot), so no text gets cut.
// M. Weber (34,57) and Berlin (74,46) stay outside.
const SCOPE_PATH = 'M 58 55 L 74 64 L 77 79 L 71 93 L 54 95 L 37 90 L 34 76 L 45 63 Z'
const SCOPE_BADGE = { x: 55, y: 78 } // roughly the blob's centroid
const SCOPED_LABELS = new Set(['Project Atlas', 'Contract #218', 'Invoice 2209'])

// Chip row centres (percent of canvas height) — 6 chips per side, stacked
// around the vertical middle. Kept in one place so the ingest particles
// spawn where the chips actually sit.
const CHIP_ROWS = [22, 33.2, 44.4, 55.6, 66.8, 78]

type Chip = { Icon: LucideIcon; label: string; tip: string }

const CONTRIBUTORS: Chip[] = [
  { Icon: MessagesSquare, label: 'Team Chat 1', tip: 'Team members contribute knowledge straight from their chats — into private or shared compilations, at their clearance level.' },
  { Icon: MessagesSquare, label: 'Team Chat 2', tip: 'Every conversation can become durable knowledge: decisions, facts and context are extracted, not lost in scrollback.' },
  { Icon: MessagesSquare, label: 'Team Chat 3', tip: 'Private by default, shared when you choose — each compilation has its own access rules.' },
  { Icon: Bot, label: 'Agent Session 1', tip: 'Claude, Codex & co. write what they learn in each session back to shared memory — the team’s agents stop forgetting.' },
  { Icon: Bot, label: 'Agent Session 2', tip: 'Scoped tokens govern what each agent may read and write — an agent only ever sees what it’s cleared for.' },
  { Icon: Bot, label: 'Agent Session 3', tip: 'Swap the agent, keep the memory: session knowledge lives in YOUR fabric, not inside the tool.' },
]

const SOURCES: Chip[] = [
  { Icon: FileText, label: 'PDFs', tip: 'PDFs are extracted into entities and relations — with provenance preserved for every fact.' },
  { Icon: Files, label: 'Docs', tip: 'Word, Excel and wiki pages become structured knowledge instead of dead files.' },
  { Icon: Server, label: 'Legacy System', tip: 'Old ERP exports, file shares and orphaned apps stream in through the governed ingestion layer.' },
  { Icon: Cloud, label: 'Cloud Drive', tip: 'Google Drive & SharePoint sync continuously — new files are extracted as they land.' },
  { Icon: Database, label: 'SQL Database', tip: 'Structured records join the same graph — finally connected to the unstructured world.' },
  { Icon: Mail, label: 'Mail Server', tip: 'Mail archives become searchable knowledge — clearance and privacy intact.' },
]

// Ingest particles. Each starts at its chip row (x 15% left / 85% right,
// y from CHIP_ROWS) and lands EXACTLY on the node it feeds — single source
// of truth, no hand-typed travel deltas.
const FLOWS = [
  // Left — contributors
  { x0: 15, y0: CHIP_ROWS[0], to: DUP_A, d: '0.2s' },    // Team Chat 1 → Acme Corp
  { x0: 15, y0: CHIP_ROWS[1], to: NODES[0], d: '1.4s' }, // Team Chat 2 → M. Weber
  { x0: 15, y0: CHIP_ROWS[2], to: NODES[1], d: '0.8s' }, // Team Chat 3 → Project Atlas
  { x0: 15, y0: CHIP_ROWS[3], to: NODES[3], d: '1.9s' }, // Agent Session 1 → Contract #218
  { x0: 15, y0: CHIP_ROWS[4], to: NODES[1], d: '0.4s' }, // Agent Session 2 → Project Atlas
  { x0: 15, y0: CHIP_ROWS[5], to: NODES[0], d: '1.6s' }, // Agent Session 3 → M. Weber
  // Right — sources
  { x0: 85, y0: CHIP_ROWS[0], to: DUP_B, d: '0.3s' },    // PDFs → ACME GmbH
  { x0: 85, y0: CHIP_ROWS[1], to: NODES[2], d: '1.2s' }, // Docs → Berlin
  { x0: 85, y0: CHIP_ROWS[2], to: NODES[4], d: '0.6s' }, // Legacy System → Invoice 2209
  { x0: 85, y0: CHIP_ROWS[3], to: DUP_B, d: '1.8s' },    // Cloud Drive → ACME GmbH
  { x0: 85, y0: CHIP_ROWS[4], to: NODES[4], d: '2.1s' }, // SQL Database → Invoice 2209
  { x0: 85, y0: CHIP_ROWS[5], to: NODES[2], d: '0.9s' }, // Mail Server → Berlin
]

function SourceChip({ chip, side, active }: { chip: Chip; side: 'left' | 'right'; active: boolean }) {
  return (
    <div className={`group relative flex items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-900/80 px-3 py-1.5 transition-opacity duration-700 ${active ? 'opacity-100' : 'opacity-40'} hover:!opacity-100`}>
      <chip.Icon className={`h-4 w-4 flex-shrink-0 ${side === 'left' ? 'text-violet-300' : 'text-cyan-300'}`} strokeWidth={1.75} />
      <span className="hidden whitespace-nowrap text-xs text-slate-300 sm:block">{chip.label}</span>
      {/* Hover explainer — glass box next to the chip, over the canvas */}
      <div
        className={`pointer-events-none absolute top-1/2 z-20 w-60 -translate-y-1/2 rounded-xl border border-white/10 bg-slate-950/95 p-3 opacity-0 shadow-xl backdrop-blur-md transition-opacity duration-200 group-hover:opacity-100 ${
          side === 'left' ? 'left-full ml-2' : 'right-full mr-2'
        }`}
      >
        <p className="mb-1 text-[11px] font-semibold text-white">{chip.label}</p>
        <p className="text-[11px] leading-relaxed text-slate-400">{chip.tip}</p>
      </div>
    </div>
  )
}

function Node({ x, y, label, visible, accent = false, big = false, dim = false, seed = false, animClass = '', animDelay, slide = false }: {
  x: number; y: number; label: string; visible: boolean
  accent?: boolean; big?: boolean
  /** dimmed while attention is elsewhere (FUSE pair / confidential scope) */
  dim?: boolean
  /** faint landing-site marker during the ingest beat (no label) */
  seed?: boolean
  /** one-shot keyframe class (pop / merge flash), re-applied per beat */
  animClass?: string
  animDelay?: string
  /** animate left/top — used for the duplicates sliding into the merge */
  slide?: boolean
}) {
  return (
    // The wrapper's only in-flow child is the dot, so translate(-50%,-50%)
    // puts the DOT's centre exactly on (x,y) — the same point the SVG edges
    // terminate at. The label hangs below via absolute positioning and never
    // shifts the anchor.
    <div
      className={`absolute -translate-x-1/2 -translate-y-1/2 ${animClass} ${
        visible
          ? dim
            ? 'opacity-40 scale-100'
            : 'opacity-100 scale-100'
          : seed
            ? 'opacity-25 scale-75'
            : 'opacity-0 scale-50'
      }`}
      style={{
        left: `${x}%`,
        top: `${y}%`,
        // The slide transition moves the node first and fades it only after
        // arrival (opacity delayed .5s) — the pair visibly touches, then
        // winks out into the merged node.
        transition: slide
          ? 'left 0.6s ease-in, top 0.6s ease-in, opacity 0.25s linear 0.5s, transform 0.6s ease-in'
          : 'opacity 0.7s ease, transform 0.7s ease',
        ...(animDelay ? { animationDelay: animDelay } : {}),
      }}
    >
      <span
        className={`block rounded-full ${
          big
            ? 'h-4 w-4 bg-white shadow-[0_0_10px_rgba(255,255,255,0.9),0_0_24px_rgba(129,140,248,0.8)]'
            : accent
              ? 'h-2.5 w-2.5 bg-amber-300 story-match-pulse'
              : 'h-2.5 w-2.5 bg-indigo-300 shadow-[0_0_8px_rgba(129,140,248,0.7)]'
        }`}
      />
      <span
        className={`absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-[10px] transition-opacity duration-500 ${
          big ? 'font-semibold text-white' : 'text-slate-400'
        } ${seed && !visible ? 'opacity-0' : ''}`}
      >
        {label}
      </span>
    </div>
  )
}

export function FusionStorySection() {
  const [stage, setStage] = useState(0)
  const [reduced, setReduced] = useState(false)
  // Bumped on manual step clicks so the interval restarts from the chosen
  // beat instead of overriding the click a moment later.
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setReduced(true)
      setStage(3)
      return
    }
    const t = window.setInterval(() => setStage((s) => (s + 1) % 4), STAGE_MS)
    return () => window.clearInterval(t)
  }, [nonce])

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

          {/* Beat headline — uniform across all four beats: number + title.
              Re-mounted per stage (key) so it slides in fresh each beat. */}
          <div key={`hl-${stage}`} className="story-headline absolute left-1/2 top-3 z-10 -translate-x-1/2">
            <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-slate-900/85 px-4 py-1.5 text-xs font-semibold text-white backdrop-blur-sm">
              <span className="text-indigo-300">{stage + 1}</span>
              {STEPS[stage].title}
            </span>
          </div>

          {/* Contributor chips (left) & source chips (right). Bright while
              ingesting, dimmed after — hover always explains the item. */}
          <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2 sm:left-5">
            {CONTRIBUTORS.map((chip) => (
              <SourceChip key={chip.label} chip={chip} side="left" active={stage === 0} />
            ))}
          </div>
          <div className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col items-end gap-2 sm:right-5">
            {SOURCES.map((chip) => (
              <SourceChip key={chip.label} chip={chip} side="right" active={stage === 0} />
            ))}
          </div>

          {/* Edges — lines only, drawn in via pathLength=1 + dash tricks */}
          <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {EDGES_STABLE.map(([[x1, y1], [x2, y2]], i) => (
              <line
                key={`s${i}`}
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="rgba(129,140,248,0.35)" strokeWidth="1" vectorEffect="non-scaling-stroke"
                pathLength={1} strokeDasharray="1"
                className={`transition-opacity duration-500 ${graphVisible ? 'story-edge-draw' : 'opacity-0'} ${fusing ? 'opacity-30' : ''}`}
                style={{ animationDelay: `${0.4 + i * 0.09}s` }}
              />
            ))}
            {EDGES_PRE.map(([[x1, y1], [x2, y2]], i) => (
              <line
                key={`p${i}`}
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="rgba(129,140,248,0.35)" strokeWidth="1" vectorEffect="non-scaling-stroke"
                pathLength={1} strokeDasharray="1"
                className={`transition-opacity duration-300 ${graphVisible && !fused ? 'story-edge-draw' : 'opacity-0'} ${fusing ? 'opacity-30' : ''}`}
                style={{ animationDelay: `${0.5 + i * 0.09}s` }}
              />
            ))}
            {EDGES_POST.map(([[x1, y1], [x2, y2]], i) => (
              <line
                key={`m${i}`}
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="rgba(165,180,252,0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke"
                pathLength={1} strokeDasharray="1"
                className={fused ? 'story-edge-draw' : 'opacity-0'}
                style={{ animationDelay: `${0.8 + i * 0.09}s` }}
              />
            ))}
            {/* FUSE match indicator — marching amber dashes between the pair */}
            <line
              x1={DUP_A.x} y1={DUP_A.y} x2={DUP_B.x} y2={DUP_B.y}
              stroke="rgba(252,211,77,0.9)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
              pathLength={1} strokeDasharray="0.06 0.045"
              className={`transition-opacity duration-500 ${fusing ? 'story-dash-march opacity-100' : 'opacity-0'}`}
            />
            {/* Confidential scope — beat 3: after the merge, a translucent
                red fill settles over the governed sub-scope… */}
            <path
              d={SCOPE_PATH}
              fill="rgba(248,113,113,0.09)"
              stroke="none"
              className={fused ? 'story-scope-fill' : 'opacity-0'}
              style={{ animationDelay: '1450ms' }}
            />
            {/* …after a dotted red outline has grown around the three nodes.
                Round linecaps + non-scaling-stroke keep the dots perfectly
                round despite the stretched viewBox; pathLength=1 keeps their
                spacing uniform. */}
            <path
              d={SCOPE_PATH}
              fill="none"
              stroke="rgba(248,113,113,0.8)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray="0.002 0.016"
              className={fused ? 'story-scope-grow' : 'opacity-0'}
              style={{ animationDelay: '1000ms' }}
            />
          </svg>

          {/* Confidential badge — centred in the scope, above everything. */}
          <div
            aria-hidden
            className={`pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-500 ${fused ? 'opacity-100' : 'opacity-0'}`}
            style={{
              left: `${SCOPE_BADGE.x}%`,
              top: `${SCOPE_BADGE.y}%`,
              transitionDelay: fused ? '1600ms' : '0ms',
            }}
          >
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-red-400/50 bg-slate-950/90 px-3 py-1.5 text-[11px] font-medium text-red-200 shadow-lg shadow-red-950/40">
              <Lock className="h-3.5 w-3.5" strokeWidth={1.75} /> Confidential · access restricted
            </span>
          </div>

          {/* Ingest particles — HTML, so they stay round and crisp. Each one
              flies from its chip row to the exact node it becomes. */}
          {!reduced && stage === 0 && FLOWS.map((f, i) => (
            <span
              key={i}
              aria-hidden
              className="story-flow-dot pointer-events-none absolute h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_6px_rgba(165,243,252,0.9)]"
              style={{
                '--x0': `${f.x0}%`,
                '--y0': `${f.y0}%`,
                '--x1': `${f.to.x}%`,
                '--y1': `${f.to.y}%`,
                animationDelay: f.d,
              } as React.CSSProperties}
            />
          ))}

          {/* Duplicate pair → merged node. On the Truth beat the pair SLIDES
              to the merged position, touches, and winks out (slide). */}
          <Node
            x={fused ? MERGED.x : DUP_A.x}
            y={fused ? MERGED.y : DUP_A.y}
            label={DUP_A.label}
            visible={graphVisible && !fused}
            seed={stage === 0}
            accent={fusing}
            slide={fused}
            animClass={stage === 1 ? 'story-node-pop' : ''}
            animDelay={stage === 1 ? '550ms' : undefined}
          />
          <Node
            x={fused ? MERGED.x : DUP_B.x}
            y={fused ? MERGED.y : DUP_B.y}
            label={DUP_B.label}
            visible={graphVisible && !fused}
            seed={stage === 0}
            accent={fusing}
            slide={fused}
            animClass={stage === 1 ? 'story-node-pop' : ''}
            animDelay={stage === 1 ? '660ms' : undefined}
          />
          {/* Merge flash fires the instant the pair converges (~.55s in). */}
          <Node
            {...MERGED}
            visible={fused}
            big
            animClass={fused ? 'story-merge-flash' : ''}
            animDelay={fused ? '0.55s' : undefined}
          />

          {/* Stable entities — pop in staggered where the dots landed. In the
              final beat, nodes outside the confidential scope dim. */}
          {NODES.map((n, i) => (
            <Node
              key={n.label}
              {...n}
              visible={graphVisible}
              seed={stage === 0}
              dim={fusing || (fused && !SCOPED_LABELS.has(n.label))}
              animClass={stage === 1 ? 'story-node-pop' : ''}
              animDelay={stage === 1 ? `${i * 110}ms` : undefined}
            />
          ))}
        </div>

        {/* ── Step captions ────────────────────────────────────────────── */}
        <div className="reveal mx-auto mt-8 grid max-w-4xl grid-cols-2 gap-3 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              onClick={() => { setStage(i); setNonce((n) => n + 1) }}
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
              {/* Beat progress — track always rendered (no layout shift),
                  the active one fills over exactly one stage. */}
              <span
                key={`${stage}-${nonce}`}
                className={`mt-2 block h-0.5 w-full origin-left rounded bg-indigo-400/60 ${
                  stage === i && !reduced ? 'story-step-progress' : 'opacity-0'
                }`}
                style={{ animationDuration: `${STAGE_MS}ms` }}
              />
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

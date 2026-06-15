import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Line, Html, RoundedBox, Edges } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'

// ── Three layers, top → bottom ────────────────────────────────────────────────
//   Top         Sources (left)  ·  Agents (right)
//   GCTRL       ONE middleware layer: access control (ingestion + rights) AND the
//               core + Hot/Warm/Cold/Wiki memory
//   Infra       Neo4j · Postgres · Qdrant · Wiki
// CI palette only — indigo / violet / cyan / slate. No camera orbit; the chips
// pulse, signals flow, and a slow light reveals the depth.

const Y_TOP = 4.4
const Y_MID = 0
const Y_INFRA = -4.4
const BOARD_W = 9

// Rows inside the tall middleware board
const MID_TOP = 0.85   // access control + core row
const MID_BOT = -0.95  // memory row

const COL = {
  source: '#22d3ee', // cyan
  agent: '#a78bfa',  // violet
  gate: '#818cf8',   // indigo (access control is part of the middleware)
  core: '#6366f1',
  coreGlow: '#818cf8',
  memHot: '#a78bfa', memWarm: '#818cf8', memCold: '#22d3ee', memWiki: '#67e8f9',
  infra: '#38bdf8',
  edge: '#c7d2fe',
  trace: '#475569',
}

const v = (x: number, y: number, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z)

function Caption({ pos, text, accent = 'text-slate-300', df = 12 }: { pos: [number, number, number]; text: string; accent?: string; df?: number }) {
  return (
    <Html position={pos} center distanceFactor={df} zIndexRange={[8, 0]}>
      <div style={{ pointerEvents: 'none' }} className={`select-none whitespace-nowrap text-center text-[11px] font-semibold leading-none ${accent}`}>
        {text}
      </div>
    </Html>
  )
}

function LayerTitle({ y, text }: { y: number; text: string }) {
  return (
    <Html position={[0, y, 0]} center distanceFactor={13} zIndexRange={[7, 0]}>
      <div style={{ pointerEvents: 'none' }} className="select-none whitespace-nowrap rounded-full border border-white/10 bg-slate-950/80 px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400 backdrop-blur-sm">
        {text}
      </div>
    </Html>
  )
}

function Board({ y, h }: { y: number; h: number }) {
  return (
    <group position={[0, y, -0.45]}>
      <RoundedBox args={[BOARD_W, h, 0.16]} radius={0.1} smoothness={3}>
        <meshStandardMaterial color="#0a1120" metalness={0.5} roughness={0.5} transparent opacity={0.7} />
        <Edges threshold={15} color={COL.trace} />
      </RoundedBox>
    </group>
  )
}

// A clean surface-mounted chip — no protruding pins. The core gets an inset die.
function Chip({
  pos, w = 1.05, h = 0.5, color, label, sub, labelPos = 'below', core = false,
}: {
  pos: [number, number, number]; w?: number; h?: number; color: string
  label: string; sub?: string; labelPos?: 'below' | 'above' | 'on'; core?: boolean
}) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null)
  const seed = useMemo(() => Math.abs(Math.sin(pos[0] * 11.3 + pos[1] * 5.7)) * 6.28, [pos])
  useFrame(({ clock }) => {
    if (matRef.current) matRef.current.emissiveIntensity = (core ? 0.8 : 0.42) + Math.sin(clock.elapsedTime * 0.9 + seed) * (core ? 0.3 : 0.12)
  })
  const depth = core ? 0.4 : 0.26
  const labelY = labelPos === 'on' ? 0 : labelPos === 'above' ? h / 2 + 0.26 : -h / 2 - 0.26
  return (
    <group position={[pos[0], pos[1], 0.3]}>
      <RoundedBox args={[w, h, depth]} radius={0.05} smoothness={3}>
        <meshStandardMaterial ref={matRef} color={color} emissive={color} emissiveIntensity={0.5} metalness={0.4} roughness={0.35} toneMapped={false} />
        <Edges threshold={15} color={COL.edge} />
      </RoundedBox>
      {/* CPU die — an inset bright plate on the core's face (replaces floating pins) */}
      {core && (
        <mesh position={[0, 0, depth / 2 + 0.01]}>
          <boxGeometry args={[w * 0.62, h * 0.55, 0.04]} />
          <meshStandardMaterial color="#c7d2fe" emissive={COL.coreGlow} emissiveIntensity={1.1} metalness={0.6} roughness={0.2} toneMapped={false} />
        </mesh>
      )}
      <Html position={[0, labelY, 0.3]} center distanceFactor={labelPos === 'on' ? 8 : 10} zIndexRange={[6, 0]}>
        <div style={{ pointerEvents: 'none' }} className="select-none whitespace-nowrap text-center">
          <div className={`${core ? 'text-[13px] font-bold text-white' : 'text-[10px] font-semibold text-slate-100'} leading-tight`}>{label}</div>
          {sub && <div className="text-[8px] uppercase leading-tight tracking-[0.12em] text-slate-400">{sub}</div>}
        </div>
      </Html>
    </group>
  )
}

function FlowDot({ from, to, speed, offset, color }: { from: THREE.Vector3; to: THREE.Vector3; speed: number; offset: number; color: string }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = ((clock.elapsedTime * speed + offset) % 1 + 1) % 1
    ref.current.position.lerpVectors(from, to, t)
    ref.current.scale.setScalar(0.5 + Math.sin(t * Math.PI) * 0.85)
  })
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.05, 12, 12]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  )
}

function Lane({ a, b, color, both = false, subtle = false }: { a: THREE.Vector3; b: THREE.Vector3; color: string; both?: boolean; subtle?: boolean }) {
  const seed = useMemo(() => Math.random(), [])
  return (
    <>
      <Line points={[a, b]} color={color} lineWidth={subtle ? 1 : 1.3} transparent opacity={subtle ? 0.18 : 0.3} />
      <FlowDot from={a} to={b} speed={0.32} offset={seed} color={color} />
      {both && <FlowDot from={b} to={a} speed={0.28} offset={seed + 0.5} color={color} />}
    </>
  )
}

function Scene() {
  const groupRef = useRef<THREE.Group>(null)
  const lightRef = useRef<THREE.PointLight>(null)

  useFrame(({ clock, pointer }) => {
    const t = clock.elapsedTime
    if (lightRef.current) {
      // slow + smooth sweep
      lightRef.current.position.x = Math.sin(t * 0.18) * 6
      lightRef.current.position.y = 1 + Math.cos(t * 0.14) * 4
    }
    if (groupRef.current) {
      groupRef.current.rotation.y += (pointer.x * 0.12 - groupRef.current.rotation.y) * 0.03
      groupRef.current.rotation.x += (0.1 - pointer.y * 0.08 - groupRef.current.rotation.x) * 0.03
    }
  })

  const sources = [
    { x: -3.7, label: 'SharePoint' },
    { x: -2.3, label: 'Drive' },
    { x: -0.9, label: 'Email' },
  ]
  const agents = [
    { x: 0.9, label: 'Claude' },
    { x: 2.3, label: 'Codex' },
    { x: 3.7, label: 'Hermes' },
  ]
  const memory = [
    { x: -3.0, label: 'Hot', color: COL.memHot },
    { x: -1.0, label: 'Warm', color: COL.memWarm },
    { x: 1.0, label: 'Cold', color: COL.memCold },
    { x: 3.0, label: 'Wiki', color: COL.memWiki },
  ]
  const infra = [
    { x: -3.4, label: 'Neo4j' },
    { x: -1.13, label: 'Postgres' },
    { x: 1.13, label: 'Qdrant' },
    { x: 3.4, label: 'Wiki' },
  ]

  const gateL = v(-3.0, MID_TOP)   // ingestion (access control, in middleware)
  const gateR = v(3.0, MID_TOP)    // access rights (access control, in middleware)

  return (
    <group ref={groupRef}>
      <Board y={Y_TOP} h={1.5} />
      <Board y={Y_MID} h={3.5} />
      <Board y={Y_INFRA} h={1.5} />

      {/* Layer titles — placed in the gaps, never over chips */}
      <LayerTitle y={Y_TOP + 1.25} text="Sources & Agents" />
      <LayerTitle y={Y_TOP - 1.55} text="GCTRL · Middleware" />
      <LayerTitle y={Y_INFRA + 1.25} text="Your Infrastructure" />
      <Caption pos={[-3.0, Y_TOP - 0.95, 0]} text="sources →" accent="text-cyan-300/80" df={13} />
      <Caption pos={[3.0, Y_TOP - 0.95, 0]} text="← agents" accent="text-violet-300/80" df={13} />
      <Caption pos={[0, Y_INFRA - 1.0, 0]} text="swappable" accent="text-sky-300/80" df={13} />

      {/* Top layer */}
      {sources.map((s) => <Chip key={s.label} pos={[s.x, Y_TOP, 0]} color={COL.source} label={s.label} w={1.1} />)}
      {agents.map((a) => <Chip key={a.label} pos={[a.x, Y_TOP, 0]} color={COL.agent} label={a.label} w={1.1} />)}

      {/* Middleware: access control (gates) + core in the upper row */}
      <Chip pos={[gateL.x, gateL.y, 0]} color={COL.gate} label="Ingestion" sub="classify" labelPos="above" w={1.5} />
      <Chip pos={[gateR.x, gateR.y, 0]} color={COL.gate} label="Access rights" sub="clearance" labelPos="above" w={1.5} />
      <Chip pos={[0, MID_TOP, 0]} color={COL.core} label="GCTRL" sub="middleware" labelPos="on" w={1.9} h={0.8} core />

      {/* Middleware: memory row */}
      {memory.map((m) => <Chip key={m.label} pos={[m.x, MID_BOT, 0]} color={m.color} label={m.label} sub="memory" w={1.05} h={0.44} />)}

      {/* Infra */}
      {infra.map((s) => <Chip key={s.label} pos={[s.x, Y_INFRA, 0]} color={COL.infra} label={s.label} w={1.35} />)}

      {/* ── Lanes ── */}
      {/* Ingestion: sources → ingestion gate (one-way down) */}
      {sources.map((s) => <Lane key={`s${s.x}`} a={v(s.x, Y_TOP - 0.32)} b={v(gateL.x, gateL.y + 0.42)} color={COL.source} />)}
      {/* Agents ↔ access-rights gate (bidirectional) */}
      {agents.map((a) => <Lane key={`a${a.x}`} a={v(a.x, Y_TOP - 0.32)} b={v(gateR.x, gateR.y + 0.42)} color={COL.agent} both />)}
      {/* Inside the middleware: gates ↔ core, core → memory (subtle) */}
      <Lane a={v(gateL.x + 0.4, MID_TOP)} b={v(-0.95, MID_TOP)} color={COL.gate} subtle />
      <Lane a={v(gateR.x - 0.4, MID_TOP)} b={v(0.95, MID_TOP)} color={COL.gate} both subtle />
      {memory.map((m) => <Lane key={`m${m.x}`} a={v(0, MID_TOP - 0.42)} b={v(m.x, MID_BOT + 0.24)} color={m.color} subtle />)}
      {/* Core ↔ infra (read/write) */}
      {infra.map((s) => <Lane key={`i${s.x}`} a={v(0, MID_BOT - 0.24)} b={v(s.x, Y_INFRA + 0.32)} color={COL.infra} both />)}

      <pointLight ref={lightRef} position={[3, 3, 6]} intensity={50} color="#a5b4fc" distance={34} />
    </group>
  )
}

export default function ArchitectureScene() {
  return (
    <Canvas
      camera={{ position: [0, 0, 16], fov: 42 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[-4, 6, 8]} intensity={1.1} color="#a5b4fc" />
      <pointLight position={[-6, -4, 5]} intensity={26} color="#22d3ee" distance={30} />
      <Scene />
      <EffectComposer>
        <Bloom luminanceThreshold={0.3} luminanceSmoothing={0.9} intensity={0.6} mipmapBlur radius={0.7} />
      </EffectComposer>
    </Canvas>
  )
}

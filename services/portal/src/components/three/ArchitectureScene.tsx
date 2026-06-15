import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Line, Html, RoundedBox, Edges } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'

// ── Layered "PCB stack" ───────────────────────────────────────────────────────
// Four boards stacked top→bottom, chips mounted on each, vertical signal lanes
// carrying animated pulses between layers. No camera orbit — the chips pulse, the
// signals flow, and a sweeping light reveals the depth.
//
//   Top         Sources (left)            ·  Agents (right)
//   Access      Data ingestion (gate)     ·  Access rights (gate)
//   Middleware  GCTRL core + Hot/Warm/Cold/Wiki memory
//   Infra       Neo4j · Postgres · Qdrant · Wiki

const Y_TOP = 3.5
const Y_AC = 1.2
const Y_MID = -1.3
const Y_INFRA = -3.7
const Z = 0.0

const C = {
  source: '#22d3ee',
  agent: '#a78bfa',
  gate: '#f59e0b',
  core: '#818cf8',
  mem: '#fb7185',
  infra: '#38bdf8',
}

type Vec = [number, number, number]
const v = (x: number, y: number, z = Z): THREE.Vector3 => new THREE.Vector3(x, y, z)

function Label({ text, sub, y = -0.5 }: { text: string; sub?: string; y?: number }) {
  return (
    <Html position={[0, y, 0.35]} center distanceFactor={11} zIndexRange={[8, 0]}>
      <div style={{ pointerEvents: 'none' }} className="select-none whitespace-nowrap text-center">
        <div className="text-[11px] font-semibold leading-tight text-slate-100">{text}</div>
        {sub && <div className="text-[8px] uppercase leading-tight tracking-[0.15em] text-slate-400">{sub}</div>}
      </div>
    </Html>
  )
}

// A circuit board: thin translucent slab with a glowing edge trace + a title.
function Board({ y, title, accent }: { y: number; title: string; accent: string }) {
  return (
    <group position={[0, y, -0.35]}>
      <RoundedBox args={[9.2, 1.7, 0.18]} radius={0.09} smoothness={3}>
        <meshStandardMaterial color="#0b1222" metalness={0.5} roughness={0.45} transparent opacity={0.82} />
        <Edges threshold={15} color={accent} />
      </RoundedBox>
      <Html position={[-4.25, 0.62, 0.2]} distanceFactor={12} zIndexRange={[6, 0]}>
        <div style={{ pointerEvents: 'none' }} className="select-none whitespace-nowrap rounded-sm border border-white/10 bg-slate-950/70 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          {title}
        </div>
      </Html>
    </group>
  )
}

// A surface-mounted chip. `cpu` adds pins + a stronger pulse (the GCTRL core).
function Chip({
  pos, w = 1.15, h = 0.52, color, label, sub, cpu = false,
}: { pos: Vec; w?: number; h?: number; color: string; label: string; sub?: string; cpu?: boolean }) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null)
  const grpRef = useRef<THREE.Group>(null)
  const seed = useMemo(() => Math.abs(Math.sin(pos[0] * 12.9 + pos[1] * 78.2)) * 6.28, [pos])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (matRef.current) matRef.current.emissiveIntensity = (cpu ? 0.85 : 0.5) + Math.sin(t * 1.6 + seed) * (cpu ? 0.4 : 0.18)
    if (grpRef.current) grpRef.current.position.z = Z + 0.32 + Math.sin(t * 0.9 + seed) * 0.04
  })
  const depth = cpu ? 0.42 : 0.3
  return (
    <group ref={grpRef} position={[pos[0], pos[1], Z + 0.32]}>
      <RoundedBox args={[w, h, depth]} radius={0.05} smoothness={3}>
        <meshStandardMaterial ref={matRef} color={color} emissive={color} emissiveIntensity={0.6} metalness={0.55} roughness={0.3} toneMapped={false} />
        <Edges threshold={15} color={'#e2e8f0'} />
      </RoundedBox>
      {/* CPU pins */}
      {cpu &&
        Array.from({ length: 9 }).map((_, i) => {
          const x = -w / 2 + 0.12 + (i * (w - 0.24)) / 8
          return (
            <group key={i}>
              <mesh position={[x, h / 2 + 0.06, 0]}>
                <boxGeometry args={[0.04, 0.12, depth * 0.7]} />
                <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.25} />
              </mesh>
              <mesh position={[x, -h / 2 - 0.06, 0]}>
                <boxGeometry args={[0.04, 0.12, depth * 0.7]} />
                <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.25} />
              </mesh>
            </group>
          )
        })}
      <Label text={label} sub={sub} y={-h / 2 - 0.28} />
    </group>
  )
}

function FlowDot({ from, to, speed, offset, color }: { from: THREE.Vector3; to: THREE.Vector3; speed: number; offset: number; color: string }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = ((clock.elapsedTime * speed + offset) % 1 + 1) % 1
    ref.current.position.lerpVectors(from, to, t)
    ref.current.scale.setScalar(0.5 + Math.sin(t * Math.PI) * 0.9)
  })
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.055, 12, 12]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  )
}

// A signal lane between two points. `both` adds a return pulse (bidirectional).
function Lane({ a, b, color, both = false }: { a: THREE.Vector3; b: THREE.Vector3; color: string; both?: boolean }) {
  const seed = useMemo(() => Math.random(), [])
  return (
    <>
      <Line points={[a, b]} color={color} lineWidth={1.4} transparent opacity={0.3} />
      <FlowDot from={a} to={b} speed={0.45} offset={seed} color={color} />
      {both && <FlowDot from={b} to={a} speed={0.4} offset={seed + 0.5} color={color} />}
    </>
  )
}

function Scene() {
  const groupRef = useRef<THREE.Group>(null)
  const lightRef = useRef<THREE.PointLight>(null)

  useFrame(({ clock, pointer }) => {
    const t = clock.elapsedTime
    // Sweeping light — gives the boards shifting highlights (proves the 3D).
    if (lightRef.current) {
      lightRef.current.position.x = Math.sin(t * 0.5) * 6
      lightRef.current.position.y = Math.cos(t * 0.4) * 4
    }
    // Subtle pointer parallax (not an orbit) — a gentle tilt toward the cursor.
    if (groupRef.current) {
      groupRef.current.rotation.y += (pointer.x * 0.18 - groupRef.current.rotation.y) * 0.05
      groupRef.current.rotation.x += (0.12 - pointer.y * 0.12 - groupRef.current.rotation.x) * 0.05
    }
  })

  // Chip x-positions
  const sources = [
    { x: -3.4, label: 'SharePoint' },
    { x: -2.1, label: 'Google Drive' },
    { x: -0.8, label: 'Other Silo' },
  ]
  const agents = [
    { x: 0.8, label: 'Hermes' },
    { x: 2.1, label: 'Claude' },
    { x: 3.4, label: 'Codex' },
  ]
  const memory = [
    { x: -3.3, label: 'Hot', color: '#fb7185' },
    { x: -1.85, label: 'Warm', color: '#fbbf24' },
    { x: 1.85, label: 'Cold', color: '#60a5fa' },
    { x: 3.3, label: 'Wiki', color: '#a78bfa' },
  ]
  const infra = [
    { x: -3.4, label: 'Neo4j' },
    { x: -1.15, label: 'Postgres' },
    { x: 1.15, label: 'Qdrant' },
    { x: 3.4, label: 'Wiki' },
  ]
  const ingestGate = -2.1
  const rightsGate = 2.1
  const coreTop = v(0, Y_MID + 0.5)
  const coreBot = v(0, Y_MID - 0.5)

  return (
    <group ref={groupRef}>
      <Board y={Y_TOP} title="Sources & Agents" accent="#334155" />
      <Board y={Y_AC} title="Access Control" accent={C.gate} />
      <Board y={Y_MID} title="GCTRL · Middleware" accent={C.core} />
      <Board y={Y_INFRA} title="Your Infrastructure" accent={C.infra} />

      {/* Top: sources (left, ingest) + agents (right) */}
      {sources.map((s) => <Chip key={s.label} pos={[s.x, Y_TOP, Z]} color={C.source} label={s.label} sub="source" w={1.25} />)}
      {agents.map((a) => <Chip key={a.label} pos={[a.x, Y_TOP, Z]} color={C.agent} label={a.label} sub="agent" w={1.15} />)}

      {/* Access control gates */}
      <Chip pos={[ingestGate, Y_AC, Z]} color={C.gate} label="Ingestion" sub="classify + tag" w={1.7} />
      <Chip pos={[rightsGate, Y_AC, Z]} color={C.gate} label="Access rights" sub="clearance gate" w={1.7} />

      {/* Middleware: GCTRL core + 4 memory chips */}
      <Chip pos={[0, Y_MID, Z]} color={C.core} label="GCTRL" sub="middleware" w={1.7} h={0.7} cpu />
      {memory.map((m) => <Chip key={m.label} pos={[m.x, Y_MID, Z]} color={m.color} label={m.label} sub="memory" w={1.05} h={0.42} />)}

      {/* Infra */}
      {infra.map((s) => <Chip key={s.label} pos={[s.x, Y_INFRA, Z]} color={C.infra} label={s.label} w={1.4} />)}

      {/* ── Lanes ── */}
      {/* Ingestion: sources → ingest gate → core (one-way, downward) */}
      {sources.map((s) => <Lane key={`s${s.x}`} a={v(s.x, Y_TOP - 0.35)} b={v(ingestGate, Y_AC + 0.35)} color={C.source} />)}
      <Lane a={v(ingestGate, Y_AC - 0.35)} b={coreTop} color={C.source} />
      {/* Agents: agents ↔ access-rights gate ↔ core (bidirectional) */}
      {agents.map((a) => <Lane key={`a${a.x}`} a={v(a.x, Y_TOP - 0.35)} b={v(rightsGate, Y_AC + 0.35)} color={C.agent} both />)}
      <Lane a={v(rightsGate, Y_AC - 0.35)} b={coreTop} color={C.agent} both />
      {/* Core ↔ infra (read/write, bidirectional) */}
      {infra.map((s) => <Lane key={`i${s.x}`} a={coreBot} b={v(s.x, Y_INFRA + 0.35)} color={C.infra} both />)}

      <pointLight ref={lightRef} position={[3, 3, 5]} intensity={55} color="#c4b5fd" distance={30} />
    </group>
  )
}

export default function ArchitectureScene() {
  return (
    <Canvas
      camera={{ position: [0, 0, 13], fov: 42 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <ambientLight intensity={0.45} />
      <directionalLight position={[-4, 6, 8]} intensity={1.2} color="#a5b4fc" />
      <pointLight position={[-6, -4, 4]} intensity={30} color="#22d3ee" distance={28} />
      <Scene />
      <EffectComposer>
        <Bloom luminanceThreshold={0.25} luminanceSmoothing={0.85} intensity={0.7} mipmapBlur radius={0.7} />
      </EffectComposer>
    </Canvas>
  )
}

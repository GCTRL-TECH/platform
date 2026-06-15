import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Line, Html } from '@react-three/drei'
import * as THREE from 'three'

// ── Scene layout ─────────────────────────────────────────────────────────────
// GCTRL core at origin (the middleware slab). Storage it sits ON sits below;
// agents that connect TO it sit above; the four memory layers stack behind it.

const STORAGE = [
  { label: 'Neo4j', sub: 'graph', color: '#22d3ee', x: -3 },
  { label: 'Qdrant', sub: 'vectors', color: '#818cf8', x: -1 },
  { label: 'Postgres', sub: 'relational', color: '#38bdf8', x: 1 },
  { label: 'Redis', sub: 'queues', color: '#f472b6', x: 3 },
] as const

const AGENTS = [
  { label: 'Claude', color: '#a78bfa', x: -2.4 },
  { label: 'Cursor', color: '#67e8f9', x: 0 },
  { label: 'Hermes', color: '#c4b5fd', x: 2.4 },
] as const

const MEMORY_LAYERS = [
  { label: 'Hot · Dossiers', color: '#fb7185', z: -0.9 },
  { label: 'Warm · Chunks', color: '#fbbf24', z: -1.5 },
  { label: 'Cold · Graph', color: '#60a5fa', z: -2.1 },
  { label: 'Wiki · Curated', color: '#a78bfa', z: -2.7 },
] as const

const CORE_POS = new THREE.Vector3(0, 0, 0)
const STORAGE_Y = -2.3
const AGENT_Y = 2.5

function labelDiv(text: string, sub?: string) {
  return (
    <div
      style={{ pointerEvents: 'none', transform: 'translateY(-50%)' }}
      className="select-none whitespace-nowrap rounded-md border border-white/10 bg-slate-950/70 px-2 py-0.5 text-center backdrop-blur-sm"
    >
      <div className="text-[11px] font-semibold leading-tight text-slate-100">{text}</div>
      {sub && <div className="text-[9px] uppercase leading-tight tracking-wider text-slate-400">{sub}</div>}
    </div>
  )
}

// A small glowing dot that travels along a connection to suggest data flow.
function FlowParticle({ from, to, speed, offset, color }: { from: THREE.Vector3; to: THREE.Vector3; speed: number; offset: number; color: string }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = ((clock.elapsedTime * speed + offset) % 1 + 1) % 1
    ref.current.position.lerpVectors(from, to, t)
    const s = 0.6 + Math.sin(t * Math.PI) * 0.8
    ref.current.scale.setScalar(s)
  })
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.05, 12, 12]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  )
}

function Connection({ from, to, color }: { from: THREE.Vector3; to: THREE.Vector3; color: string }) {
  return (
    <>
      <Line points={[from, to]} color={color} lineWidth={1} transparent opacity={0.28} />
      <FlowParticle from={from} to={to} speed={0.35} offset={Math.random()} color={color} />
    </>
  )
}

function Core() {
  const ref = useRef<THREE.Mesh>(null)
  const matRef = useRef<THREE.MeshStandardMaterial>(null)
  useFrame(({ clock }) => {
    const p = 0.6 + Math.sin(clock.elapsedTime * 1.4) * 0.25
    if (matRef.current) matRef.current.emissiveIntensity = p
    if (ref.current) ref.current.rotation.y = clock.elapsedTime * 0.15
  })
  return (
    <group>
      <mesh ref={ref}>
        <boxGeometry args={[2.4, 0.7, 1.4]} />
        <meshStandardMaterial
          ref={matRef}
          color="#4f46e5"
          emissive="#6366f1"
          emissiveIntensity={0.7}
          metalness={0.6}
          roughness={0.25}
        />
      </mesh>
      {/* wireframe halo */}
      <mesh scale={1.06}>
        <boxGeometry args={[2.4, 0.7, 1.4]} />
        <meshBasicMaterial color="#a5b4fc" wireframe transparent opacity={0.18} />
      </mesh>
      <Html position={[0, 0, 0.75]} center distanceFactor={8} zIndexRange={[10, 0]}>
        <div style={{ pointerEvents: 'none' }} className="select-none whitespace-nowrap text-center">
          <div className="bg-gradient-to-r from-indigo-300 via-violet-300 to-cyan-300 bg-clip-text text-base font-bold tracking-wide text-transparent">
            GCTRL
          </div>
          <div className="text-[9px] uppercase tracking-[0.2em] text-slate-300">middleware</div>
        </div>
      </Html>
    </group>
  )
}

function SceneContent() {
  const groupRef = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(clock.elapsedTime * 0.12) * 0.5
    }
  })

  const storageNodes = useMemo(
    () => STORAGE.map((s) => ({ ...s, pos: new THREE.Vector3(s.x, STORAGE_Y, 0) })),
    [],
  )
  const agentNodes = useMemo(
    () => AGENTS.map((a) => ({ ...a, pos: new THREE.Vector3(a.x, AGENT_Y, 0) })),
    [],
  )

  return (
    <group ref={groupRef}>
      <Core />

      {/* Memory layers — translucent planes stacked behind the core */}
      {MEMORY_LAYERS.map((m) => (
        <group key={m.label} position={[0, 0, m.z]}>
          <mesh>
            <boxGeometry args={[2.7, 0.9, 0.06]} />
            <meshStandardMaterial color={m.color} emissive={m.color} emissiveIntensity={0.25} transparent opacity={0.16} metalness={0.3} roughness={0.4} />
          </mesh>
          <Html position={[1.75, 0, 0]} center distanceFactor={9} zIndexRange={[5, 0]}>
            {labelDiv(m.label)}
          </Html>
        </group>
      ))}

      {/* Storage nodes (below) + connections up to the core */}
      {storageNodes.map((s) => (
        <group key={s.label}>
          <mesh position={s.pos}>
            <cylinderGeometry args={[0.42, 0.42, 0.5, 28]} />
            <meshStandardMaterial color={s.color} emissive={s.color} emissiveIntensity={0.3} metalness={0.5} roughness={0.3} />
          </mesh>
          <Html position={[s.x, STORAGE_Y - 0.62, 0]} center distanceFactor={9} zIndexRange={[5, 0]}>
            {labelDiv(s.label, s.sub)}
          </Html>
          <Connection from={s.pos} to={CORE_POS} color={s.color} />
        </group>
      ))}

      {/* Agent nodes (above) + connections down to the core */}
      {agentNodes.map((a) => (
        <group key={a.label}>
          <mesh position={a.pos}>
            <icosahedronGeometry args={[0.34, 0]} />
            <meshStandardMaterial color={a.color} emissive={a.color} emissiveIntensity={0.35} metalness={0.5} roughness={0.3} flatShading />
          </mesh>
          <Html position={[a.x, AGENT_Y + 0.6, 0]} center distanceFactor={9} zIndexRange={[5, 0]}>
            {labelDiv(a.label)}
          </Html>
          <Connection from={a.pos} to={CORE_POS} color={a.color} />
        </group>
      ))}

      {/* Captions */}
      <Html position={[0, AGENT_Y + 1.25, 0]} center distanceFactor={10} zIndexRange={[5, 0]}>
        <div style={{ pointerEvents: 'none' }} className="select-none whitespace-nowrap rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-0.5 text-[10px] font-medium text-violet-200 backdrop-blur-sm">
          your agents · via MCP
        </div>
      </Html>
      <Html position={[0, STORAGE_Y - 1.35, 0]} center distanceFactor={10} zIndexRange={[5, 0]}>
        <div style={{ pointerEvents: 'none' }} className="select-none whitespace-nowrap rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-0.5 text-[10px] font-medium text-cyan-200 backdrop-blur-sm">
          your storage · swappable
        </div>
      </Html>
    </group>
  )
}

export default function ArchitectureScene() {
  return (
    <Canvas
      camera={{ position: [0, 0.5, 9], fov: 42 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <ambientLight intensity={0.6} />
      <pointLight position={[4, 5, 6]} intensity={60} color="#a5b4fc" />
      <pointLight position={[-5, -3, 4]} intensity={40} color="#22d3ee" />
      <SceneContent />
    </Canvas>
  )
}

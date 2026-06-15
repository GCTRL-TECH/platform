import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'

// A smooth, slowly-rotating spiral galaxy in the CI palette (indigo → violet →
// cyan). Pure background visual — the readable architecture sits on top as DOM.
function Galaxy() {
  const ref = useRef<THREE.Points>(null)

  const { positions, colors } = useMemo(() => {
    const COUNT = 7000
    const positions = new Float32Array(COUNT * 3)
    const colors = new Float32Array(COUNT * 3)
    const inside = new THREE.Color('#818cf8')  // indigo
    const mid = new THREE.Color('#a78bfa')      // violet
    const outside = new THREE.Color('#22d3ee')  // cyan
    const branches = 4
    const spin = 0.85
    const rMax = 11
    const randomness = 0.55
    const power = 2.8
    for (let i = 0; i < COUNT; i++) {
      const i3 = i * 3
      const r = Math.pow(Math.random(), 1.5) * rMax
      const branch = ((i % branches) / branches) * Math.PI * 2
      const spinA = r * spin
      const sign = () => (Math.random() < 0.5 ? 1 : -1)
      const rx = Math.pow(Math.random(), power) * sign() * randomness * r
      const ry = Math.pow(Math.random(), power) * sign() * randomness * r * 0.32
      const rz = Math.pow(Math.random(), power) * sign() * randomness * r
      positions[i3] = Math.cos(branch + spinA) * r + rx
      positions[i3 + 1] = ry
      positions[i3 + 2] = Math.sin(branch + spinA) * r + rz
      const t = r / rMax
      const c = t < 0.5 ? inside.clone().lerp(mid, t * 2) : mid.clone().lerp(outside, (t - 0.5) * 2)
      colors[i3] = c.r
      colors[i3 + 1] = c.g
      colors[i3 + 2] = c.b
    }
    return { positions, colors }
  }, [])

  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * 0.03
  })

  return (
    <points ref={ref} rotation={[0.62, 0, 0]}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.05}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.38}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

export default function ArchitectureScene() {
  return (
    <Canvas
      camera={{ position: [0, 2.4, 9], fov: 55 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <Galaxy />
      <EffectComposer>
        <Bloom luminanceThreshold={0.15} luminanceSmoothing={0.9} intensity={0.5} mipmapBlur radius={0.75} />
      </EffectComposer>
    </Canvas>
  )
}

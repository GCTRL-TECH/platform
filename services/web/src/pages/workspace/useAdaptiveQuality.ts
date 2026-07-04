/**
 * useAdaptiveQuality — FPS-driven render-quality governor for the workspace
 * canvas (Wave 2). Replaces the old binary "labels throttled" FPS guard with a
 * graduated ladder so a huge graph degrades smoothly instead of the renderer
 * just getting slower and slower:
 *
 *   L0 full            — labels on, all edges, all nodes
 *   L1 labels off       — the single biggest per-frame cost on dense graphs
 *   L2 edges culled     — only the top edgeVisibleFraction of edges (by
 *                         confidence, then by min-endpoint-degree) draw
 *   L3 nodes culled      — only the top-degree nodeVisibleBudget nodes draw
 *                         (three sub-steps: 8000 → 4000 → 2000) as the last
 *                         resort on pathological graphs
 *
 * Degradation only kicks in when FPS actually craters (FPS_FLOOR=5 — the user
 * explicitly wants quality preserved until things are nearly unusable, not at
 * the first sign of a dip) and requires FPS to stay low for STEP_DOWN_MS
 * before each step. Recovery is slower/more cautious (STEP_UP_MS) and both
 * directions are rate-limited by STEP_COOLDOWN_MS so the governor can't
 * oscillate.
 *
 * Perf shape mirrors the rest of WorkspaceCanvas: the smoothed FPS estimate
 * and step timers live in refs (updated up to 60x/sec via registerFrame with
 * zero re-renders), and exactly one setState fires — only on an actual step
 * transition — to update the UI pill.
 */

import { useCallback, useRef, useState } from 'react'

export type QualityLevel = 0 | 1 | 2 | 3

export interface AdaptiveQuality {
  level: QualityLevel
  labelsEnabled: boolean
  /** Fraction of edges (by rank) allowed to draw. 1.0 at L0/L1, 0.4 at L2, 0.15 at L3. */
  edgeVisibleFraction: number
  /** Max nodes (by degree rank) allowed to draw. Infinity below L3; 8000/4000/2000 within L3. */
  nodeVisibleBudget: number
  /** Call once per rendered frame (2D onRenderFramePre and the 3D rAF loop both call this). */
  registerFrame: (now: number) => void
  /** Reset the governor — e.g. on new graph data. Optionally seeds a starting
   *  level so very large graphs don't have to visibly "fall" into degradation
   *  on first paint (warmup seeding). */
  reset: (seedLevel?: QualityLevel) => void
}

const FPS_FLOOR = 5 // degrade ONLY below this — user requirement: preserve quality aggressively
const FPS_RECOVER = 15
const STEP_DOWN_MS = 2000 // sustained-low duration required before stepping down
const STEP_UP_MS = 4000 // sustained-high duration required before recovering
const STEP_COOLDOWN_MS = 3000 // minimum gap between any two transitions

// Internal step ladder is finer than the public `level`: L3 has three
// sub-steps (progressively harsher node budgets) so a pathological graph
// keeps degrading gracefully instead of jumping straight to 2000 nodes.
const STEP_L1 = 1
const STEP_L2 = 2
const STEP_L3_A = 3 // budget 8000
const STEP_L3_B = 4 // budget 4000
const STEP_L3_C = 5 // budget 2000 — floor
const MAX_STEP = STEP_L3_C

function stepToLevel(step: number): QualityLevel {
  if (step <= 0) return 0
  if (step === STEP_L1) return 1
  if (step === STEP_L2) return 2
  return 3
}

function stepToBudget(step: number): number {
  if (step === STEP_L3_A) return 8000
  if (step === STEP_L3_B) return 4000
  if (step >= STEP_L3_C) return 2000
  return Infinity
}

function stepToEdgeFraction(step: number): number {
  const level = stepToLevel(step)
  if (level <= 1) return 1.0
  if (level === 2) return 0.4
  return 0.15
}

/** Map a public seed level onto the mildest internal step for that level. */
function levelToSeedStep(level: QualityLevel): number {
  if (level === 3) return STEP_L3_A
  return level
}

export function useAdaptiveQuality(): AdaptiveQuality {
  const stepRef = useRef(0)
  const fpsRef = useRef(60)
  const lastFrameRef = useRef(0)
  const lowSinceRef = useRef<number | null>(null)
  const highSinceRef = useRef<number | null>(null)
  const lastTransitionRef = useRef(0)

  // Only used to force a re-render for the UI pill on an actual step change —
  // the authoritative value is always stepRef.current.
  const [, bumpUi] = useState(0)

  const applyStep = useCallback((next: number, now: number) => {
    const clamped = Math.max(0, Math.min(MAX_STEP, next))
    if (clamped === stepRef.current) return
    stepRef.current = clamped
    lastTransitionRef.current = now
    lowSinceRef.current = null
    highSinceRef.current = null
    bumpUi((t) => (t + 1) & 0xffff)
  }, [])

  const registerFrame = useCallback(
    (now: number) => {
      const last = lastFrameRef.current
      lastFrameRef.current = now
      if (last) {
        const dt = now - last
        if (dt > 0) fpsRef.current = fpsRef.current * 0.9 + (1000 / dt) * 0.1
      }
      const fps = fpsRef.current

      if (now - lastTransitionRef.current < STEP_COOLDOWN_MS) return

      if (fps < FPS_FLOOR) {
        highSinceRef.current = null
        if (lowSinceRef.current == null) lowSinceRef.current = now
        if (now - lowSinceRef.current >= STEP_DOWN_MS && stepRef.current < MAX_STEP) {
          applyStep(stepRef.current + 1, now)
        }
      } else if (fps > FPS_RECOVER) {
        lowSinceRef.current = null
        if (highSinceRef.current == null) highSinceRef.current = now
        if (now - highSinceRef.current >= STEP_UP_MS && stepRef.current > 0) {
          applyStep(stepRef.current - 1, now)
        }
      } else {
        lowSinceRef.current = null
        highSinceRef.current = null
      }
    },
    [applyStep],
  )

  const reset = useCallback((seedLevel: QualityLevel = 0) => {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    stepRef.current = levelToSeedStep(seedLevel)
    fpsRef.current = 60
    lastFrameRef.current = 0
    lowSinceRef.current = null
    highSinceRef.current = null
    lastTransitionRef.current = now
    bumpUi((t) => (t + 1) & 0xffff)
  }, [])

  const step = stepRef.current
  return {
    level: stepToLevel(step),
    labelsEnabled: stepToLevel(step) === 0,
    edgeVisibleFraction: stepToEdgeFraction(step),
    nodeVisibleBudget: stepToBudget(step),
    registerFrame,
    reset,
  }
}

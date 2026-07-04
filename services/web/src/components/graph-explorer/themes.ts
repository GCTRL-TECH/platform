/**
 * Graph canvas themes (Wave 2).
 *
 * A theme is pure data + a couple of small pure functions — WorkspaceCanvas
 * reads it to resolve backgrounds, node/link/label colours, and (for 2D) a
 * pre-rendered starfield/glow sprite cache. Nothing here touches React state;
 * it's safe to import from a per-frame canvas callback.
 *
 * Perf rules baked into the design (see WorkspaceCanvas for the consumers):
 *   - 2D starfield is rendered ONCE into an offscreen canvas and blitted per
 *     frame (never regenerated per-frame) — see `renderStarfield2D`.
 *   - 2D glow is a cached per-colour radial-gradient sprite, drawImage'd under
 *     the node — NEVER ctx.shadowBlur (notoriously expensive per-call).
 *   - 3D starfield is one THREE.Points object, added/removed on theme change.
 */

import { fnv1a, withAlpha } from './colors'

export interface GraphTheme {
  id: string
  label: string
  /** 2D canvas background (also used as the CSS fallback). */
  background: string
  /** Optional hue/tone transform applied to the resolved base node colour. */
  nodeColor?: (base: string) => string
  /** Optional full palette override (unused by the built-in themes; hook for
   *  future custom themes). */
  nodePalette?: Record<string, string>
  link: { neutral: string; opacityScale: number }
  // NOTE: the design doc's interface names this sub-object `label` too, which
  // collides with the theme's own display-name field of the same name —
  // named `labelStyle` here to keep both fields (a deliberate, documented
  // deviation; see Wave 2 handoff notes).
  labelStyle: { color: string; outline: string }
  /** 2D glow (radial-gradient sprite behind each node). Only active at full
   *  quality (L0) and below `maxNodes`, so it never fights the perf governor. */
  glow?: { spriteScale: number; maxNodes: number }
  /** Reserved for a future animated-edge-particle effect (typed now, not yet
   *  rendered — see Wave 2 deviations). */
  particles?: { count: number; speed: number }
  threeD: {
    bg: string
    starfield?: { count: number; radius: number }
    spriteColor: string
  }
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`
}

/** Deterministic hue within [base, base+spread) from a hash of the input string. */
function hashedHue(seed: string, base: number, spread: number): number {
  return (base + (fnv1a(seed) % spread)) % 360
}

// ─── midnight (default) — exactly today's look, unchanged ─────────────────────

const midnight: GraphTheme = {
  id: 'midnight',
  label: 'Midnight',
  background: '#020617',
  link: { neutral: '#475569', opacityScale: 1 },
  labelStyle: { color: '#d6deec', outline: '#020617' },
  threeD: { bg: '#020617', spriteColor: '#d6deec' },
}

// ─── galaxy — starfield + glowing nodes + white labels ─────────────────────────

const galaxy: GraphTheme = {
  id: 'galaxy',
  label: 'Galaxy',
  background: '#04040f',
  // Nodes look like STARS: every type color maps into the white→light-gold
  // band (founder request — the full type palette was too colorful for a
  // night sky). Deterministic per base color, so the same entity type keeps
  // the same star shade: warm hue 40-52°, gentle saturation, high lightness.
  nodeColor: (base) => {
    const h = fnv1a(base)
    const hue = 40 + (h % 13)          // 40-52° — warm gold band
    const sat = 12 + (h % 48)          // 12-59% — near-white … light gold
    const light = 80 + ((h >> 8) % 13) // 80-92% — always bright, star-like
    return hsl(hue, sat, light)
  },
  // Relations as faint warm starlight instead of slate blue.
  link: { neutral: '#e8dfc0', opacityScale: 0.85 },
  labelStyle: { color: '#f5efdc', outline: '#04040f' },
  glow: { spriteScale: 2.4, maxNodes: 1500 },
  threeD: {
    bg: '#04040f',
    starfield: { count: 2500, radius: 2000 },
    spriteColor: '#f5efdc',
  },
}

// ─── paper — light mode; label OUTLINE must flip too or text is unreadable ─────

const paper: GraphTheme = {
  id: 'paper',
  label: 'Paper',
  background: '#f8fafc',
  link: { neutral: '#94a3b8', opacityScale: 1 },
  labelStyle: { color: '#1e293b', outline: '#f8fafc' },
  threeD: { bg: '#f8fafc', spriteColor: '#1e293b' },
}

// ─── terminal — black + green hue transform ────────────────────────────────────

const terminal: GraphTheme = {
  id: 'terminal',
  label: 'Terminal',
  background: '#000000',
  nodeColor: (base) => hsl(hashedHue(base, 110, 50), 75, 50),
  link: { neutral: '#15803d', opacityScale: 1 },
  labelStyle: { color: '#4ade80', outline: '#000000' },
  threeD: { bg: '#000000', spriteColor: '#4ade80' },
}

// ─── synthwave — deep purple + magenta/cyan hue rotation ───────────────────────

const synthwave: GraphTheme = {
  id: 'synthwave',
  label: 'Synthwave',
  background: '#1a0b2e',
  nodeColor: (base) =>
    fnv1a(base) % 2 === 0
      ? hsl(hashedHue(`${base}:m`, 295, 30), 85, 62)
      : hsl(hashedHue(`${base}:c`, 178, 30), 85, 58),
  link: { neutral: '#7c3aed', opacityScale: 1.1 },
  labelStyle: { color: '#f472b6', outline: '#1a0b2e' },
  threeD: { bg: '#1a0b2e', spriteColor: '#f0abfc' },
}

export const GRAPH_THEMES: Record<string, GraphTheme> = {
  midnight, galaxy, paper, terminal, synthwave,
}
export const THEME_LIST: GraphTheme[] = Object.values(GRAPH_THEMES)
export const DEFAULT_THEME_ID = 'midnight'

export function resolveTheme(id: string | null | undefined): GraphTheme {
  if (id && GRAPH_THEMES[id]) return GRAPH_THEMES[id]
  return midnight
}

/** Rotate a resolved CSS colour's hue by `deg` degrees (the optional hue-slider
 *  override). Accepts hex or hsl(); always returns hsl() for a stable format. */
export function rotateHue(color: string, deg: number): string {
  if (!deg) return color
  const trimmed = color.trim()
  let h: number, s: number, l: number
  const hexMatch = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(trimmed)
  if (hexMatch) {
    let hexStr = hexMatch[1]
    if (hexStr.length === 3) hexStr = hexStr.split('').map((c) => c + c).join('')
    const num = parseInt(hexStr, 16)
    const r = ((num >> 16) & 0xff) / 255
    const g = ((num >> 8) & 0xff) / 255
    const b = (num & 0xff) / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    l = (max + min) / 2
    const d = max - min
    if (d === 0) { h = 0; s = 0 } else {
      s = d / (1 - Math.abs(2 * l - 1))
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      h *= 60
      if (h < 0) h += 360
    }
    s *= 100; l *= 100
  } else {
    const hslMatch = /^hsl\(\s*([\d.]+)[ ,]+([\d.]+)%?[ ,]+([\d.]+)%?\s*\)$/i.exec(trimmed)
    if (!hslMatch) return color
    h = parseFloat(hslMatch[1]); s = parseFloat(hslMatch[2]); l = parseFloat(hslMatch[3])
  }
  return hsl((h + deg + 360) % 360, s, l)
}

// ─── 2D starfield (rendered once, blitted per frame) ───────────────────────────

/** Render a 2-3 depth-layer starfield into a detached canvas sized to the
 *  container. Called only on mount/resize/theme-change (never per-frame). */
export function renderStarfield2D(width: number, height: number, count: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(width))
  canvas.height = Math.max(1, Math.floor(height))
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width <= 1 || canvas.height <= 1) return canvas

  // Cheap deterministic PRNG (LCG) — doesn't need cryptographic quality, just
  // a stable-feeling scatter that's fast to regenerate on resize.
  let seed = 1337
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  const layers = [
    { n: Math.round(count * 0.5), r: 0.6, alpha: 0.35 },
    { n: Math.round(count * 0.3), r: 1.0, alpha: 0.55 },
    { n: Math.round(count * 0.2), r: 1.6, alpha: 0.85 },
  ]
  ctx.fillStyle = '#ffffff'
  for (const layer of layers) {
    for (let i = 0; i < layer.n; i++) {
      const x = rand() * canvas.width
      const y = rand() * canvas.height
      ctx.globalAlpha = layer.alpha * (0.5 + rand() * 0.5)
      ctx.beginPath()
      ctx.arc(x, y, layer.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
  return canvas
}

// ─── 2D glow sprites (cached per resolved colour) ──────────────────────────────

/** Get (or lazily render) a radial-gradient glow sprite for a resolved node
 *  colour. Cached by the caller (a Map<color, canvas> ref) so repeated nodes
 *  of the same colour cost one drawImage, never a fresh gradient/shadowBlur. */
export function renderGlowSprite(color: string): HTMLCanvasElement {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, withAlpha(color, 0.55))
  grad.addColorStop(1, withAlpha(color, 0))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return canvas
}

/**
 * Color & label resolution for the Graph Explorer.
 *
 * The backend currently emits `node.type === "Entity"` for everything
 * (Neo4j label), while the actual entity type lives in
 *   - `properties.label`  ("person", "organization", …)  ← preferred
 *   - `properties.type`   ("Q5", "Q43229", …)            ← Wikidata QID fallback
 *
 * This module is the single source of truth for those resolutions plus the
 * curated colour palette used by the canvas, legend, and side drawer.
 */

import type { ColorBy, GraphNode } from './types'

// ─── Curated palette (typed labels + Wikidata QIDs) ────────────────────────────

const CURATED_COLORS: Record<string, string> = {
  person: '#6366f1',
  q5: '#6366f1',

  organization: '#f59e0b',
  q43229: '#f59e0b',

  location: '#10b981',
  q17334923: '#10b981',
  city: '#10b981',
  q515: '#10b981',

  event: '#ec4899',

  product: '#3b82f6',
  q2424752: '#3b82f6',

  concept: '#8b5cf6',
  work: '#06b6d4',
  date: '#a78bfa',
  money: '#22c55e',

  unknown: '#94a3b8',
}

export const DEFAULT_NODE_COLOR = CURATED_COLORS.unknown
export const BG_COLOR = '#020617'

// ─── Resolution helpers ────────────────────────────────────────────────────────

/**
 * Resolve a stable, human-friendly type label for a node.
 *
 * Order:
 *   1. properties.label  (preferred — KEX writes "person", "organization", …)
 *   2. properties.type   (Wikidata QID fallback)
 *   3. node.type         (Neo4j label, today always "Entity")
 *   4. literal "unknown"
 */
export function resolveTypeLabel(node: GraphNode): string {
  const p = node.properties ?? {}
  const propLabel = p['label']
  if (typeof propLabel === 'string' && propLabel.trim()) {
    return propLabel.trim().toLowerCase()
  }
  const propType = p['type']
  if (typeof propType === 'string' && propType.trim()) {
    return propType.trim().toLowerCase()
  }
  if (node.type && node.type.trim() && node.type !== 'Entity') {
    return node.type.trim().toLowerCase()
  }
  return 'unknown'
}

/**
 * Resolve the Wikidata QID for a node, if any (case-insensitive).
 * Returns e.g. "Q5" or null.
 */
export function resolveWikidataQid(node: GraphNode): string | null {
  const p = node.properties ?? {}
  const candidates = [p['type'], p['wikidataId'], p['wikidata_id'], p['qid']]
  for (const c of candidates) {
    if (typeof c === 'string' && /^Q\d+$/i.test(c.trim())) {
      return c.trim().toUpperCase()
    }
  }
  return null
}

/**
 * Resolve the source-job id for a node (string) or null.
 * KEX writes `_source_job` onto the node properties.
 */
export function resolveSourceJobId(node: GraphNode): string | null {
  const p = node.properties ?? {}
  const v = p['_source_job'] ?? p['source_job'] ?? p['sourceJob']
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

// ─── Colour computation ────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash — small, fast, deterministic.
 * Used for the unknown-key fallback palette so the same string always maps to
 * the same hue across reloads.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

function hslString(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`
}

function hashColor(key: string): string {
  const h = fnv1a(key) % 360
  return hslString(h, 65, 60)
}

/**
 * Resolve the canvas colour for a node under the selected ColorBy mode.
 * Always returns a valid CSS colour string.
 */
export function getNodeColor(node: GraphNode, mode: ColorBy = 'type'): string {
  let key: string
  switch (mode) {
    case 'wikidata': {
      const qid = resolveWikidataQid(node)
      key = qid ? qid.toLowerCase() : 'unknown'
      break
    }
    case 'source': {
      const sj = resolveSourceJobId(node)
      key = sj ? `src:${sj}` : 'unknown'
      break
    }
    case 'type':
    default: {
      key = resolveTypeLabel(node)
      break
    }
  }

  const curated = CURATED_COLORS[key]
  if (curated) return curated
  if (key === 'unknown') return DEFAULT_NODE_COLOR
  return hashColor(key)
}

/**
 * Color key string used by Legend and for memoisation. Mirrors the key getter
 * inside `getNodeColor` so the legend groups nodes the same way the canvas
 * paints them.
 */
export function getColorKey(node: GraphNode, mode: ColorBy = 'type'): string {
  switch (mode) {
    case 'wikidata':
      return (resolveWikidataQid(node) ?? 'unknown').toLowerCase()
    case 'source':
      return resolveSourceJobId(node) ?? 'unknown'
    case 'type':
    default:
      return resolveTypeLabel(node)
  }
}

// ─── Alpha / fade helpers ──────────────────────────────────────────────────────

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const num = parseInt(h, 16)
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff }
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return { r: f(0), g: f(8), b: f(4) }
}

/**
 * Apply alpha to any CSS colour string we emit (hex or hsl()). Returns rgba().
 * Falls back to the input unchanged if we can't parse it (safe for the canvas).
 */
export function withAlpha(color: string, alpha: number): string {
  const a = clamp01(alpha)
  const trimmed = color.trim()

  // hex (#rgb or #rrggbb)
  const rgb = hexToRgb(trimmed)
  if (rgb) {
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
  }

  // hsl(h s% l%) — values may use spaces or commas.
  const hslMatch = /^hsl\(\s*([\d.]+)[ ,]+([\d.]+)%?[ ,]+([\d.]+)%?\s*\)$/i.exec(trimmed)
  if (hslMatch) {
    const h = parseFloat(hslMatch[1])
    const s = parseFloat(hslMatch[2])
    const l = parseFloat(hslMatch[3])
    const { r, g, b } = hslToRgb(h, s, l)
    return `rgba(${r}, ${g}, ${b}, ${a})`
  }

  return trimmed
}

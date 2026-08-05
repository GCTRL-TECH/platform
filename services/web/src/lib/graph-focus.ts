/**
 * graph-focus — shared deep-link focus matcher.
 *
 * Lifted verbatim from GraphWorkspace's focus effect so the embeddable graph
 * page (EmbedGraphPage) resolves a `?focus=` / postMessage mention to the SAME
 * node the full workspace would. A chunk (e.g. from a Talk-to-Graph source)
 * mentions many entities, only some of which are real nodes, and mentions are
 * often partial ("Fabio" for node "Fabio Chiaramonte") or generic ("German").
 * We score every node against each candidate and pick the best:
 *   exact > word-prefix > word-boundary > substring > reverse-substring,
 * weighting earlier candidates higher and de-prioritising email/URL-ish labels
 * (so "Fabio" lands on the person, not "fabio@fjalla.net").
 */

import type { GraphNode } from '@/components/graph-explorer/types'

/**
 * Resolve the single best-matching node for a set of candidate mention strings.
 * Returns null when nothing scores above zero (missing/unknown → no selection).
 */
export function matchFocusNode(nodes: GraphNode[], candidates: string[]): GraphNode | null {
  const nameOf = (x: GraphNode) =>
    (x.label || (x.properties?.name as string | undefined) || x.id || '').trim()
  const looksTechnical = (s: string) => /[@/]|https?:|\.\w{2,}$/.test(s)

  let bestNode: GraphNode | null = null
  let bestScore = -Infinity
  for (let idx = 0; idx < candidates.length; idx++) {
    const lc = candidates[idx].toLowerCase()
    if (lc.length < 2) continue
    const candWeight = candidates.length - idx // earlier mention = higher
    const escaped = lc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const wordRe = new RegExp(`\\b${escaped}\\b`)
    for (const node of nodes) {
      const label = nameOf(node)
      const ll = label.toLowerCase()
      if (!ll) continue
      let base = 0
      if (ll === lc) base = 100
      else if (ll.startsWith(lc + ' ') || ll.startsWith(lc + ',')) base = 80
      else if (wordRe.test(ll)) base = 60
      else if (ll.includes(lc)) base = 40
      else if (lc.includes(ll) && ll.length >= 3) base = 30
      if (base === 0) continue
      // Shorter, non-technical labels are more likely the canonical entity.
      let score = base + candWeight - label.length * 0.1
      if (looksTechnical(label)) score -= 25
      if (score > bestScore) {
        bestScore = score
        bestNode = node
      }
    }
  }
  return bestNode
}

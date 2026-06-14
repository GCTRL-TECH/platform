// Shared model-selection helpers for the chat surfaces (Talk-to-Graph, Agent
// page, floating widget). The /llm/models endpoint already filters out
// embedding-only models server-side; these helpers pick a sensible default and
// guard against any stale/bad selection slipping through.

export interface LlmModel {
  provider: string
  model: string
  name: string
  available: boolean
  requiresKey?: boolean
}

// Embedding models can't chat — never default to or keep one selected.
export function isEmbeddingModel(model: string | null | undefined): boolean {
  if (!model) return false
  const n = model.toLowerCase()
  return (
    n.includes('embed') ||
    n.includes('all-minilm') ||
    n.startsWith('bge-') ||
    n.startsWith('gte-') ||
    n.includes('/bge-') ||
    n.includes('/gte-')
  )
}

// Preference order for a known-good LOCAL chat model, then any available one.
const PREFERRED = ['qwen2.5', 'qwen2.5:7b', 'llama3.2', 'llama3.1', 'mistral']

export function pickDefaultChatModel(models: LlmModel[]): string | null {
  const usable = models.filter((m) => m.available && !isEmbeddingModel(m.model))
  if (usable.length === 0) return null
  for (const pref of PREFERRED) {
    const hit = usable.find((m) => m.model === pref || m.model.startsWith(`${pref}:`))
    if (hit) return hit.model
  }
  return usable[0].model
}

// True when `model` is a valid, chat-capable choice present in the list.
export function isValidChatSelection(model: string | null | undefined, models: LlmModel[]): boolean {
  if (!model || isEmbeddingModel(model)) return false
  return models.some((m) => m.model === model && m.available)
}

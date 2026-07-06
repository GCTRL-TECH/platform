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

export function pickDefaultChatModel(models: LlmModel[], preferred?: string | null): string | null {
  const usable = models.filter((m) => m.available && !isEmbeddingModel(m.model))
  if (usable.length === 0) return null
  // Honor the user's explicitly configured default first (e.g. a provider
  // default_model). Critical on machines where the "best local" model crashes
  // (e.g. an Ollama runner that dies on qwen) but the user has set a working
  // cloud model as their default — we must not snap back to the crashing local.
  if (preferred) {
    const want = preferred.trim()
    const hit = usable.find((m) => m.model === want)
    if (hit) return hit.model
  }
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

// ── Cookbook sync helpers ────────────────────────────────────────────────────
//
// The Agent page / Talk-to-Graph keep their own per-device localStorage model
// selection (`gctrl.agent.llmModel`, `gctrl.rag.model`) so those widgets don't
// snap back to a default on reload. When the Cookbook applies a new agent/rag
// model server-side (PUT /llm/model-prefs), it must also sync these keys —
// otherwise the client picker would keep sending its stale localStorage model
// on the next chat request, which wins over the server pref in the resolution
// chain (see services/llm.rs `resolve_purpose_model`).

const LS_AGENT_MODEL = 'gctrl.agent.llmModel'
const LS_AGENT_PROVIDER = 'gctrl.agent.llmProvider'
const LS_RAG_MODEL = 'gctrl.rag.model'

export function setAgentModelLocal(model: string, provider = 'ollama'): void {
  try {
    localStorage.setItem(LS_AGENT_MODEL, model)
    // The agent widget sends BOTH provider and model per request — syncing only
    // the model would pair a cloud model with the stale 'ollama' provider (or
    // vice versa) and every chat turn would 404 with "model not found".
    localStorage.setItem(LS_AGENT_PROVIDER, provider)
  } catch {
    /* ignore — private mode / storage disabled */
  }
}

export function setRagModelLocal(model: string): void {
  try {
    localStorage.setItem(LS_RAG_MODEL, model)
  } catch {
    /* ignore — private mode / storage disabled */
  }
}

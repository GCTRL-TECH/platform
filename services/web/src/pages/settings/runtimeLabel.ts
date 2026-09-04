import type { ActiveRuntime } from './RuntimeSwitcher'

// Bundled container endpoints — matches services/api-rs/src/routes/infra.rs
// (launch_llamacpp_container / launch_vllm_container base URLs). Used purely to
// turn an opaque base_url into a plain-word label; never sent anywhere.
const LLAMACPP_BUNDLED_URL = 'http://gctrl-llamacpp:8080'
const VLLM_BUNDLED_URL = 'http://gctrl-vllm:8000'

/**
 * Plain-word label for the active generation runtime, e.g. for the top of the
 * Inference Runtime card.
 *
 * `ollamaOverrideUrl` disambiguates bundled vs. native Ollama — it comes from
 * the admin-only GET /infra/overrides "ollama" entry, so it has three states:
 *   - undefined → not fetched (non-admin caller) — don't over-claim, say "Ollama"
 *   - null      → fetched, no override saved — bundled
 *   - string    → the saved native/custom override URL
 */
export function describeRuntime(
  activeRuntime: ActiveRuntime | null,
  ollamaOverrideUrl: string | null | undefined,
): string {
  if (!activeRuntime) return 'Unknown'
  if (activeRuntime.provider === 'ollama') {
    if (ollamaOverrideUrl === undefined) return 'Ollama'
    return ollamaOverrideUrl ? `Native Ollama (${ollamaOverrideUrl})` : 'Bundled Ollama (container)'
  }
  switch (resolveRuntimeId(activeRuntime)) {
    case 'llamacpp': return 'llama.cpp (bundled)'
    case 'vllm': return 'vLLM (GPU)'
    case 'mlx': return 'MLX / oMLX (this host)'
    default:
      return activeRuntime.base_url ? `Custom endpoint (${activeRuntime.base_url})` : 'Custom endpoint'
  }
}

/** Short chip label (no URL) — for compact per-purpose "runs on" chips. */
export function describeRuntimeShort(activeRuntime: ActiveRuntime | null): string {
  if (!activeRuntime) return 'Unknown'
  if (activeRuntime.provider === 'ollama') return 'Ollama'
  switch (resolveRuntimeId(activeRuntime)) {
    case 'llamacpp': return 'llama.cpp'
    case 'vllm': return 'vLLM'
    case 'mlx': return 'MLX'
    default: return 'Custom endpoint'
  }
}

/**
 * Catalog id of the active runtime. Prefers the persisted `runtime_id`
 * (migration 082); rows written before it carry null, so fall back to the
 * bundled-URL heuristics. Returns null when nothing can be inferred (a plain
 * custom endpoint written pre-082).
 */
function resolveRuntimeId(activeRuntime: ActiveRuntime): string | null {
  if (activeRuntime.runtime_id) return activeRuntime.runtime_id
  if (activeRuntime.provider === 'ollama') return 'ollama'
  if (activeRuntime.base_url === LLAMACPP_BUNDLED_URL) return 'llamacpp'
  if (activeRuntime.base_url === VLLM_BUNDLED_URL) return 'vllm'
  return null
}

/**
 * When the active runtime is a bundled non-Ollama runtime, returns the id
 * GET /infra/models?runtime= expects. Returns null for Ollama (no runtime
 * catalog needed — the Ollama model list already covers it) and for a
 * genuinely custom openai_compatible endpoint (no runtime catalog exists for
 * an arbitrary external server, so we fall back to the free-text escape hatch
 * instead of inventing one).
 */
export function bundledGenerationRuntimeId(activeRuntime: ActiveRuntime | null): 'llamacpp' | 'vllm' | null {
  if (!activeRuntime || activeRuntime.provider === 'ollama') return null
  // `mlx` and `external` are deliberately NOT bundled: no /infra/models catalog
  // exists for them, so callers fall through to the free-text / instance path.
  const id = resolveRuntimeId(activeRuntime)
  return id === 'llamacpp' || id === 'vllm' ? id : null
}

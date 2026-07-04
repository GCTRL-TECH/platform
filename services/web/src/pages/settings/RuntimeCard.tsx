import { useState, useEffect, useCallback } from 'react'
import {
  Wifi,
  WifiOff,
  Loader2,
  RefreshCw,
  AlertTriangle,
  Cpu,
  Sparkles,
  Server,
  Box,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { RuntimeSwitcher, type ActiveRuntime } from './RuntimeSwitcher'
import { NativeOllamaGuide } from './NativeOllamaGuide'
import type { HardwareInfo, Recommendation } from './HardwareCard'
import { describeRuntime } from './runtimeLabel'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OllamaOverride {
  service: 'ollama'
  url: string | null
  hasSecret: boolean
  updatedAt: string | null
  source: 'default' | 'override'
  defaultUrl?: string
  note: string
}

interface ProbeResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

const NATIVE_URL_SUGGESTION = 'http://host.docker.internal:11434'

interface Props {
  hardware: HardwareInfo | null
  recommendation: Recommendation | null
  activeRuntime: ActiveRuntime | null
  isAdmin: boolean
  /** Runtime was switched via the embedded RuntimeSwitcher — refetch active-runtime upstream. */
  onSwitched?: () => void
  /**
   * Reports the current Ollama location override so sibling components (the
   * per-purpose model pickers) can show an accurate "runs on" chip.
   * undefined = not known yet / non-admin, null = bundled, string = override URL.
   * Pass a stable callback (a useState setter is ideal — this fires on every load).
   */
  onOllamaOverrideChange?: (url: string | null | undefined) => void
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * "Inference Runtime" card — the single place that answers "which engine is
 * GCTRL actually using right now, and how do I change it". Shown at the top of
 * Settings → AI Models and in the Cookbook.
 *
 * Two switches live here, in plain words:
 *  1. Ollama location (bundled container vs. native/custom host) — the
 *     `/infra/overrides` "ollama" entry. Admin-only (that endpoint is admin-gated).
 *  2. Runtime kind (Ollama / llama.cpp / vLLM / custom endpoint) — the existing
 *     RuntimeSwitcher, embedded rather than rebuilt.
 */
export function RuntimeCard({ hardware, recommendation, activeRuntime, isAdmin, onSwitched, onOllamaOverrideChange }: Props) {
  const [override, setOverride] = useState<OllamaOverride | null>(null)
  const [overrideLoading, setOverrideLoading] = useState(isAdmin)
  const [nativeUrl, setNativeUrl] = useState('')

  const [bundledTest, setBundledTest] = useState<ProbeResult | null>(null)
  const [nativeTest, setNativeTest] = useState<ProbeResult | null>(null)
  const [testingBundled, setTestingBundled] = useState(false)
  const [testingNative, setTestingNative] = useState(false)
  const [applying, setApplying] = useState<'bundled' | 'native' | null>(null)

  const loadOverride = useCallback(async () => {
    if (!isAdmin) {
      onOllamaOverrideChange?.(undefined)
      return
    }
    setOverrideLoading(true)
    try {
      const { data } = await api.get<{ overrides: OllamaOverride[] }>('/infra/overrides')
      const entry = data.overrides.find((o) => o.service === 'ollama') ?? null
      setOverride(entry)
      const activeUrl = entry?.url ?? null
      onOllamaOverrideChange?.(activeUrl)
      setNativeUrl((prev) => prev || activeUrl || NATIVE_URL_SUGGESTION)
    } catch {
      /* non-fatal */
    } finally {
      setOverrideLoading(false)
    }
  }, [isAdmin, onOllamaOverrideChange])

  useEffect(() => { void loadOverride() }, [loadOverride])

  const bundledUrl = override?.defaultUrl || 'http://gctrl-ollama:11434'

  const testUrl = useCallback(async (url: string): Promise<ProbeResult> => {
    try {
      const { data } = await api.post<{ ok: boolean; latencyMs?: number; error?: string }>(
        '/infra/overrides/ollama/test',
        { url },
      )
      return { ok: !!data.ok, latencyMs: data.latencyMs, error: data.error }
    } catch {
      return { ok: false, error: 'Test request failed' }
    }
  }, [])

  const testBundled = useCallback(async () => {
    setTestingBundled(true)
    setBundledTest(await testUrl(bundledUrl))
    setTestingBundled(false)
  }, [testUrl, bundledUrl])

  const testNative = useCallback(async () => {
    const url = nativeUrl.trim() || NATIVE_URL_SUGGESTION
    setTestingNative(true)
    setNativeTest(await testUrl(url))
    setTestingNative(false)
  }, [testUrl, nativeUrl])

  // Auto-probe both locations once we know the override state.
  useEffect(() => {
    if (!isAdmin || overrideLoading) return
    void testBundled()
    void testNative()
    // Only re-run when admin/override-loaded state flips, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, overrideLoading])

  async function useBundled() {
    setApplying('bundled')
    try {
      await api.delete('/infra/overrides/ollama')
      await loadOverride()
    } catch {
      /* non-fatal */
    } finally {
      setApplying(null)
    }
  }

  async function useNative() {
    const url = nativeUrl.trim()
    if (!url) return
    setApplying('native')
    try {
      await api.put('/infra/overrides/ollama', { url })
      await loadOverride()
    } catch {
      /* non-fatal */
    } finally {
      setApplying(null)
    }
  }

  const isOverridden = !!(override?.url && override.source === 'override')
  const label = describeRuntime(activeRuntime, isAdmin ? (override?.url ?? null) : undefined)

  return (
    <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      {/* Header: plain-word active runtime */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-violet-400" />
          <span className="text-sm font-medium text-slate-200">Inference Runtime</span>
        </div>
        {activeRuntime && (
          activeRuntime.healthy ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              <Wifi size={9} /> Healthy
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
              <WifiOff size={9} /> Unhealthy
            </span>
          )
        )}
      </div>

      <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Currently running</p>
        <p className="mt-0.5 font-mono text-sm text-indigo-300">{label}</p>
        {activeRuntime?.model && (
          <p className="mt-0.5 text-[11px] text-slate-500">Model: <span className="font-mono text-slate-400">{activeRuntime.model}</span></p>
        )}
      </div>

      {/* Hardware + recommendation context, one line each */}
      {hardware && (
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
          <Cpu size={11} className="text-slate-600" />
          {hardware.cpu_cores} cores · {hardware.ram_gb} GB RAM
          {hardware.gpu_name ? ` · ${hardware.gpu_name} (${hardware.vram_gb ?? '?'} GB VRAM)` : ' · no GPU detected'}
        </p>
      )}
      {recommendation && (
        <p className="flex items-start gap-1.5 text-[11px] text-violet-300/80">
          <Sparkles size={11} className="mt-0.5 shrink-0" />
          Recommended for your hardware: <span className="font-mono text-cyan-300">{recommendation.runtime} + {recommendation.model}</span> — {recommendation.rationale}
        </p>
      )}

      {/* Ollama location switch: bundled vs native/custom */}
      <div className="space-y-2 border-t border-slate-800 pt-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Ollama location</p>
          {isAdmin && (
            <button
              onClick={() => { void testBundled(); void testNative() }}
              disabled={testingBundled || testingNative}
              className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 disabled:opacity-50"
            >
              <RefreshCw size={10} className={(testingBundled || testingNative) ? 'animate-spin' : ''} /> Retest both
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">
          Switch between the Ollama that ships in the box and one running natively on your machine — native is typically GPU-fast.
        </p>

        {!isAdmin ? (
          <p className="text-[11px] text-amber-500/80">Ask your admin to change the Ollama location.</p>
        ) : (
          <div className="space-y-2">
            {/* Bundled row */}
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2">
              <Box size={13} className="shrink-0 text-slate-500" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-slate-300">Bundled (container)</p>
                <p className="truncate font-mono text-[10px] text-slate-600">{bundledUrl}</p>
              </div>
              <ProbeDot testing={testingBundled} result={bundledTest} />
              {!isOverridden ? (
                <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-300">In use</span>
              ) : (
                <button
                  onClick={() => void useBundled()}
                  disabled={applying !== null}
                  className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-[10px] font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                >
                  {applying === 'bundled' ? <Loader2 size={10} className="animate-spin" /> : 'Use this'}
                </button>
              )}
            </div>

            {/* Native / custom row */}
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2">
              <Server size={13} className="shrink-0 text-slate-500" />
              <input
                value={nativeUrl}
                onChange={(e) => setNativeUrl(e.target.value)}
                placeholder={NATIVE_URL_SUGGESTION}
                className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => void testNative()}
                disabled={testingNative}
                className="shrink-0 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700 disabled:opacity-50"
              >
                {testingNative ? <Loader2 size={10} className="animate-spin" /> : 'Test'}
              </button>
              <ProbeDot testing={testingNative} result={nativeTest} />
              {isOverridden && override?.url === nativeUrl.trim() ? (
                <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-300">In use</span>
              ) : (
                <button
                  onClick={() => void useNative()}
                  disabled={applying !== null || !nativeUrl.trim()}
                  className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-[10px] font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                >
                  {applying === 'native' ? <Loader2 size={10} className="animate-spin" /> : 'Use this'}
                </button>
              )}
            </div>

            {nativeTest && !nativeTest.ok && (
              <NativeOllamaGuide ollamaBase={nativeUrl.trim() || NATIVE_URL_SUGGESTION} onRetest={() => void testNative()} />
            )}
          </div>
        )}
      </div>

      {/* Runtime kind switch — reuse RuntimeSwitcher, don't rebuild it. */}
      <div className="space-y-2 border-t border-slate-800 pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Change runtime (Ollama / llama.cpp / vLLM / custom endpoint)
        </p>
        <RuntimeSwitcher
          hardware={hardware}
          isAdmin={isAdmin}
          activeRuntime={activeRuntime}
          onSwitched={onSwitched}
        />
      </div>
    </div>
  )
}

function ProbeDot({ testing, result }: { testing: boolean; result: ProbeResult | null }) {
  if (testing) return <Loader2 size={11} className="shrink-0 animate-spin text-slate-500" />
  if (!result) return <span className="h-2 w-2 shrink-0 rounded-full bg-slate-700" />
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      title={result.ok ? `Reachable${result.latencyMs != null ? ` · ${result.latencyMs}ms` : ''}` : (result.error ?? 'Unreachable')}
    >
      <span className={cn('h-2 w-2 rounded-full', result.ok ? 'bg-emerald-500' : 'bg-red-500')} />
      {result.ok && result.latencyMs != null && (
        <span className="text-[10px] text-slate-500">{result.latencyMs}ms</span>
      )}
      {!result.ok && (
        <AlertTriangle size={10} className="text-red-400" />
      )}
    </span>
  )
}

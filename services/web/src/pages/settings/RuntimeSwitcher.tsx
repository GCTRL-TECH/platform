import { useState, useEffect, useRef, useCallback } from 'react'
import { Check, Wifi, WifiOff, Loader2, AlertTriangle, Eye, EyeOff, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { getToken } from '@/lib/auth'
import { RuntimeModelPicker } from './RuntimeModelPicker'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActiveRuntime {
  provider: string
  base_url: string | null
  model: string | null
  embedding_mode: string | null
  configured: boolean
  healthy: boolean
}

export interface RuntimeCatalogEntry {
  id: string
  label: string
  kind: string
  needs_base_url: boolean
  needs_gpu?: boolean
}

interface Props {
  hardware: { ram_gb: number; nvidia_toolkit: boolean } | null
  isAdmin: boolean
  activeRuntime: ActiveRuntime | null
  onSwitched?: () => void
}

type StreamPhase = 'idle' | 'streaming' | 'done' | 'error'

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Lists available runtimes, shows the current active runtime with a health badge,
 * and lets admins switch runtimes. Streams progress from POST /api/infra/switch-runtime.
 * Non-admins see read-only state.
 */
export function RuntimeSwitcher({ hardware, isAdmin, activeRuntime, onSwitched }: Props) {
  const [catalog, setCatalog] = useState<RuntimeCatalogEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)

  // Switcher form state
  const [expanded, setExpanded] = useState(false)
  const [selectedKind, setSelectedKind] = useState<string>('')
  const [selectedModel, setSelectedModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  // SSE stream state
  const [streamPhase, setStreamPhase] = useState<StreamPhase>('idle')
  const [streamSteps, setStreamSteps] = useState<string[]>([])
  const [streamError, setStreamError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const stepsEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [streamSteps])

  useEffect(() => {
    return () => { controllerRef.current?.abort() }
  }, [])

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true)
    try {
      const { data } = await api.get<RuntimeCatalogEntry[] | { runtimes: RuntimeCatalogEntry[] }>('/infra/runtimes')
      // The endpoint returns { runtimes: [...] } — treating it as a bare array
      // made `catalog.find` throw and crashed the whole Infrastructure tab.
      setCatalog(Array.isArray(data) ? data : data.runtimes ?? [])
    } catch { /* non-fatal */ } finally {
      setCatalogLoading(false)
    }
  }, [])

  useEffect(() => { void loadCatalog() }, [loadCatalog])

  // Pre-fill form from active runtime
  useEffect(() => {
    if (activeRuntime && !selectedKind) {
      setSelectedKind(activeRuntime.provider)
      setSelectedModel(activeRuntime.model ?? '')
      setBaseUrl(activeRuntime.base_url ?? '')
    }
  }, [activeRuntime, selectedKind])

  const selectedEntry = catalog.find((e) => e.kind === selectedKind || e.id === selectedKind)
  const vllmEntry = catalog.find((e) => e.id === 'vllm' || e.kind === 'vllm')
  const needsBaseUrl = selectedEntry?.needs_base_url ?? false
  const needsGpu = selectedEntry?.needs_gpu ?? false
  const gpuAvailable = hardware?.nvidia_toolkit ?? false

  async function handleSwitch() {
    if (!selectedKind) return
    const controller = new AbortController()
    controllerRef.current = controller
    setStreamPhase('streaming')
    setStreamSteps([])
    setStreamError('')

    try {
      const token = getToken()
      const body: Record<string, string | undefined> = { runtime: selectedKind }
      if (selectedModel) body.model = selectedModel
      if (baseUrl.trim()) body.base_url = baseUrl.trim()
      if (apiKey.trim()) body.api_key = apiKey.trim()

      const resp = await fetch('/api/infra/switch-runtime', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!resp.ok || !resp.body) {
        setStreamError(resp.status === 401 ? 'Not authorized.' : `Server returned ${resp.status}`)
        setStreamPhase('error')
        return
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let eventType = 'message'
          const dataLines: string[] = []
          for (const rawLine of frame.split('\n')) {
            const line = rawLine.replace(/\r$/, '')
            if (line.startsWith(':')) continue
            if (line.startsWith('event:')) eventType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
          }
          const dataStr = dataLines.join('\n')
          if (eventType === 'progress') {
            try {
              const parsed = JSON.parse(dataStr) as { message?: string }
              if (parsed.message) setStreamSteps((s) => [...s, parsed.message!])
            } catch {
              if (dataStr) setStreamSteps((s) => [...s, dataStr])
            }
          } else if (eventType === 'done') {
            setStreamPhase('done')
            controller.abort()
            onSwitched?.()
            return
          } else if (eventType === 'error') {
            try {
              const parsed = JSON.parse(dataStr) as { message?: string }
              setStreamError(parsed.message ?? 'Switch failed')
            } catch {
              setStreamError(dataStr || 'Switch failed')
            }
            setStreamPhase('error')
            controller.abort()
            return
          }
        }
      }
      // Clean stream end without done event
      setStreamPhase('done')
      onSwitched?.()
    } catch (e) {
      if (!controller.signal.aborted) {
        setStreamError('Connection lost')
        setStreamPhase('error')
      }
    }
  }

  function resetStream() {
    setStreamPhase('idle')
    setStreamSteps([])
    setStreamError('')
  }

  // ─── Read-only active runtime badge ──────────────────────────────────────────

  const ActiveBadge = () => {
    if (!activeRuntime) return null
    return (
      <div className="flex items-center gap-2">
        {activeRuntime.healthy ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
            <Wifi size={9} /> Healthy
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
            <WifiOff size={9} /> Unhealthy
          </span>
        )}
        <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-300">
          {activeRuntime.provider}
        </span>
        {activeRuntime.model && (
          <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-300">
            {activeRuntime.model}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Current active runtime */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Active runtime</p>
            {activeRuntime ? (
              <ActiveBadge />
            ) : (
              <p className="text-sm text-slate-500">Not configured</p>
            )}
            {activeRuntime?.base_url && (
              <p className="font-mono text-[10px] text-slate-600">{activeRuntime.base_url}</p>
            )}
          </div>
          {isAdmin && (
            <button
              onClick={() => { setExpanded((v) => !v); resetStream() }}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                expanded
                  ? 'border-indigo-700 bg-indigo-950/40 text-indigo-300'
                  : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700',
              )}
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              Switch runtime
            </button>
          )}
        </div>
      </div>

      {/* Runtime selector (admin, expanded) */}
      {isAdmin && expanded && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-4 space-y-4">
          {streamPhase === 'idle' && (
            <>
              {/* Runtime picker */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-slate-400">Runtime</label>
                {catalogLoading ? (
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Loader2 size={12} className="animate-spin" /> Loading runtimes…
                  </div>
                ) : (
                  <select
                    value={selectedKind}
                    onChange={(e) => {
                      setSelectedKind(e.target.value)
                      setSelectedModel('')
                    }}
                    style={{ colorScheme: 'dark' }}
                    className="w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="">Select a runtime…</option>
                    {catalog.map((entry) => {
                      const isVllm = entry.id === 'vllm' || entry.kind === 'vllm'
                      const disabled = isVllm && !gpuAvailable
                      return (
                        <option key={entry.id} value={entry.kind || entry.id} disabled={disabled}>
                          {entry.label}
                          {disabled ? ' (requires NVIDIA GPU + toolkit)' : ''}
                        </option>
                      )
                    })}
                  </select>
                )}
                {/* vLLM tooltip when GPU not available */}
                {vllmEntry && !gpuAvailable && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-400/80">
                    <AlertTriangle size={11} />
                    vLLM requires an NVIDIA GPU with the CUDA toolkit installed and detected.
                  </p>
                )}
                {needsGpu && gpuAvailable && (
                  <p className="mt-1 text-[11px] text-emerald-400/80">NVIDIA GPU detected — vLLM can use it.</p>
                )}
              </div>

              {/* Base URL (for external / llamacpp / vllm) */}
              {needsBaseUrl && (
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium text-slate-400">
                    Base URL
                  </label>
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://host:port/v1"
                    className="w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              )}

              {/* API key (external only) */}
              {selectedEntry && selectedEntry.id === 'external' && (
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium text-slate-400">
                    API Key <span className="text-slate-600">(optional)</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-…"
                      className="w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 pr-9 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    >
                      {showApiKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Model picker — shown for runtimes that need a model selection */}
              {selectedKind && !needsBaseUrl && (
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium text-slate-400">Model</label>
                  <RuntimeModelPicker
                    runtime={selectedKind}
                    value={selectedModel}
                    onChange={setSelectedModel}
                    systemRamGb={hardware?.ram_gb}
                  />
                </div>
              )}

              {/* For external/vllm where user sets base_url, also allow picking a model */}
              {selectedKind && needsBaseUrl && (
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium text-slate-400">
                    Model <span className="text-slate-600">(from base URL)</span>
                  </label>
                  <RuntimeModelPicker
                    runtime={selectedKind}
                    value={selectedModel}
                    onChange={setSelectedModel}
                    systemRamGb={hardware?.ram_gb}
                  />
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => { setExpanded(false); resetStream() }}
                  className="rounded-md px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSwitch()}
                  disabled={!selectedKind}
                  className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Apply runtime
                </button>
              </div>
            </>
          )}

          {streamPhase === 'streaming' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <Loader2 size={14} className="animate-spin text-indigo-400" />
                Switching runtime — please wait…
              </div>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-1">
                {streamSteps.map((step, i) => (
                  <p key={i} className="text-[11px] font-mono text-slate-400">{step}</p>
                ))}
                {streamSteps.length === 0 && (
                  <p className="text-[11px] text-slate-600">Starting…</p>
                )}
                <div ref={stepsEndRef} />
              </div>
            </div>
          )}

          {streamPhase === 'done' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-4 py-3">
                <Check size={15} className="text-emerald-400" />
                <p className="text-sm text-emerald-300">Runtime switched successfully.</p>
              </div>
              {streamSteps.length > 0 && (
                <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-1">
                  {streamSteps.map((step, i) => (
                    <p key={i} className="text-[11px] font-mono text-slate-400">{step}</p>
                  ))}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() => { setExpanded(false); resetStream() }}
                  className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  Done
                </button>
              </div>
            </div>
          )}

          {streamPhase === 'error' && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-3">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-400" />
                <div className="text-sm text-red-300">
                  <p className="font-medium">Switch failed</p>
                  {streamError && <p className="mt-1 text-xs text-red-400/80">{streamError}</p>}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={resetStream}
                  className="rounded-md border border-slate-700 bg-slate-800 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Read-only runtime list for non-admins */}
      {!isAdmin && !catalogLoading && catalog.length > 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Available runtimes</p>
          <div className="flex flex-wrap gap-1.5">
            {catalog.map((entry) => (
              <span
                key={entry.id}
                className={cn(
                  'rounded-md px-2 py-0.5 text-[10px] font-medium',
                  (entry.kind === activeRuntime?.provider || entry.id === activeRuntime?.provider)
                    ? 'bg-indigo-500/15 text-indigo-300'
                    : 'bg-slate-800 text-slate-500',
                )}
              >
                {entry.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

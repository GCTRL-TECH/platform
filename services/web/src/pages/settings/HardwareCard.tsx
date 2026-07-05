import { useState, useRef, useEffect } from 'react'
import { Cpu, Zap, Sparkles, RefreshCw, AlertTriangle, Check, Loader2, MemoryStick, Box, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { getToken } from '@/lib/auth'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Container-visible CPU/RAM — what containers (KEX/FUSE/etc) can actually use. */
export interface HardwareDockerView {
  cpu_cores: number
  ram_gb: number
  source: string
}

/** Host-level view — GPU is probed at runtime; host RAM is only known if the
 *  installer recorded it (unknowable from inside a container otherwise). */
export interface HardwareSystemView {
  gpu_name: string | null
  vram_gb: number | null
  nvidia_toolkit: boolean
  ram_gb: number | null
  ram_source: string
}

export interface HardwareInfo {
  cpu_cores: number
  ram_gb: number
  gpu_name: string | null
  vram_gb: number | null
  nvidia_toolkit: boolean
  arch: string
  os: string
  // Added so the UI can show Docker vs System views side by side. Optional —
  // an api build that predates this still returns the flat fields above, so
  // every read below falls back to them.
  docker?: HardwareDockerView
  system?: HardwareSystemView
}

export interface Recommendation {
  runtime: string
  model: string
  rationale: string
  speedup_estimate: string
}

interface Props {
  hardware: HardwareInfo | null
  recommendation: Recommendation | null
  isAdmin: boolean
  onHardwareRescan?: (updated: HardwareInfo) => void
  onSwitchToRecommended?: (runtime: string, model: string) => void
}

type SwitchPhase = 'idle' | 'streaming' | 'done' | 'error'

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Shows detected hardware specs + the AI recommendation card.
 * "Switch to recommended" streams POST /api/infra/switch-runtime.
 * "Re-scan" calls POST /api/infra/rescan-hardware (admin only).
 */
export function HardwareCard({ hardware, recommendation, isAdmin, onHardwareRescan, onSwitchToRecommended }: Props) {
  const [rescanning, setRescanning] = useState(false)
  const [rescanError, setRescanError] = useState('')

  const [switchPhase, setSwitchPhase] = useState<SwitchPhase>('idle')
  const [switchSteps, setSwitchSteps] = useState<string[]>([])
  const [switchError, setSwitchError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const stepsEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [switchSteps])

  useEffect(() => {
    return () => { controllerRef.current?.abort() }
  }, [])

  async function handleRescan() {
    if (!isAdmin) return
    setRescanning(true)
    setRescanError('')
    try {
      const { data } = await api.post<HardwareInfo>('/infra/rescan-hardware')
      onHardwareRescan?.(data)
    } catch {
      setRescanError('Re-scan failed')
    } finally {
      setRescanning(false)
    }
  }

  async function handleSwitchToRecommended() {
    if (!recommendation) return
    const controller = new AbortController()
    controllerRef.current = controller
    setSwitchPhase('streaming')
    setSwitchSteps([])
    setSwitchError('')

    try {
      const token = getToken()
      const resp = await fetch('/api/infra/switch-runtime', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          runtime: recommendation.runtime,
          model: recommendation.model,
        }),
        signal: controller.signal,
      })

      if (!resp.ok || !resp.body) {
        setSwitchError(resp.status === 401 ? 'Not authorized.' : `Server error ${resp.status}`)
        setSwitchPhase('error')
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
              if (parsed.message) setSwitchSteps((s) => [...s, parsed.message!])
            } catch {
              if (dataStr) setSwitchSteps((s) => [...s, dataStr])
            }
          } else if (eventType === 'done') {
            setSwitchPhase('done')
            controller.abort()
            onSwitchToRecommended?.(recommendation.runtime, recommendation.model)
            return
          } else if (eventType === 'error') {
            try {
              const parsed = JSON.parse(dataStr) as { message?: string }
              setSwitchError(parsed.message ?? 'Switch failed')
            } catch {
              setSwitchError(dataStr || 'Switch failed')
            }
            setSwitchPhase('error')
            controller.abort()
            return
          }
        }
      }
      setSwitchPhase('done')
      onSwitchToRecommended?.(recommendation.runtime, recommendation.model)
    } catch (e) {
      if (!controller.signal.aborted) {
        setSwitchError('Connection lost')
        setSwitchPhase('error')
      }
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!hardware) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-6 text-sm text-slate-500">
        <Loader2 size={14} className="animate-spin" />
        Detecting hardware…
      </div>
    )
  }

  // Defensive fallback: `docker`/`system` may be absent if the api hasn't been
  // rebuilt yet — fall back to the flat legacy fields so this never crashes.
  const dockerCpuCores = hardware.docker?.cpu_cores ?? hardware.cpu_cores
  const dockerRamGb = hardware.docker?.ram_gb ?? hardware.ram_gb
  const sysGpuName = hardware.system?.gpu_name ?? hardware.gpu_name
  const sysVramGb = hardware.system?.vram_gb ?? hardware.vram_gb
  const sysNvidiaToolkit = hardware.system?.nvidia_toolkit ?? hardware.nvidia_toolkit
  const sysRamGb = hardware.system ? hardware.system.ram_gb : null

  return (
    <div className="space-y-3">
      {/* Hardware specs card */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-cyan-400" />
            <span className="text-sm font-medium text-slate-200">Detected hardware</span>
          </div>
          {isAdmin && (
            <button
              onClick={() => void handleRescan()}
              disabled={rescanning}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            >
              <RefreshCw size={10} className={rescanning ? 'animate-spin' : ''} />
              Re-scan
            </button>
          )}
        </div>

        {/* Docker (container-visible) */}
        <div className="mb-3">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Box size={11} className="text-indigo-400" />
            <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-300">
              Docker (container-visible)
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Spec label="CPU cores" value={String(dockerCpuCores)} icon={Cpu} />
            <Spec label="RAM" value={`${dockerRamGb} GB`} icon={MemoryStick} />
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            What containers can use (WSL2 VM on Windows)
          </p>
        </div>

        {/* System (host) */}
        <div>
          <div className="mb-1.5 flex items-center gap-1.5">
            <Server size={11} className="text-violet-400" />
            <span className="text-[10px] font-medium uppercase tracking-wide text-violet-300">
              System (host)
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Spec
              label="GPU"
              value={sysGpuName ?? 'None detected'}
              icon={Zap}
              highlight={!!sysGpuName}
            />
            <Spec
              label="VRAM"
              value={sysVramGb != null ? `${sysVramGb} GB` : '—'}
              icon={Zap}
            />
            <Spec
              label="Host RAM"
              value={sysRamGb != null ? `${sysRamGb} GB` : 'Not detected'}
              icon={MemoryStick}
              highlight={sysRamGb != null}
            />
          </div>
          {sysRamGb == null && (
            <p className="mt-1 text-[10px] text-slate-500">
              Host RAM not detected — run the installer to capture host specs
            </p>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
          <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-slate-400">{hardware.arch}</span>
          <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-slate-400">{hardware.os}</span>
          {sysNvidiaToolkit ? (
            <span className="rounded bg-emerald-950/40 px-2 py-0.5 font-mono text-emerald-400">CUDA toolkit detected</span>
          ) : (
            <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-slate-500">No CUDA toolkit</span>
          )}
        </div>

        {rescanError && (
          <p className="mt-2 text-[11px] text-red-400">{rescanError}</p>
        )}
      </div>

      {/* Recommendation card */}
      {recommendation && (
        <div className="rounded-lg border border-indigo-800/40 bg-indigo-950/20 px-4 py-4 space-y-3">
          <div className="flex items-start gap-2">
            <Sparkles size={14} className="mt-0.5 shrink-0 text-violet-400" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-200">
                For your hardware we recommend{' '}
                <span className="text-indigo-300">{recommendation.runtime}</span>
                {' '}+{' '}
                <span className="font-mono text-cyan-300">{recommendation.model}</span>
              </p>
              <p className="mt-1 text-xs text-slate-400">{recommendation.rationale}</p>
              {recommendation.speedup_estimate && (
                <p className="mt-1 text-[11px] text-violet-300/80">
                  Estimated speedup: {recommendation.speedup_estimate} (estimate — actual results vary by workload)
                </p>
              )}
            </div>
          </div>

          {/* Switch progress */}
          {switchPhase === 'streaming' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 size={12} className="animate-spin text-indigo-400" />
                Switching to recommended runtime…
              </div>
              <div className="max-h-32 overflow-y-auto rounded border border-slate-800 bg-slate-950 p-2 space-y-0.5">
                {switchSteps.map((step, i) => (
                  <p key={i} className="text-[10px] font-mono text-slate-400">{step}</p>
                ))}
                <div ref={stepsEndRef} />
              </div>
            </div>
          )}

          {switchPhase === 'done' && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-900/40 bg-emerald-950/20 px-3 py-2">
              <Check size={12} className="text-emerald-400" />
              <p className="text-xs text-emerald-300">Switched to recommended runtime.</p>
            </div>
          )}

          {switchPhase === 'error' && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2">
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-red-400" />
                <p className="text-xs text-red-300">{switchError || 'Switch failed'}</p>
              </div>
              <button
                onClick={() => setSwitchPhase('idle')}
                className="text-[11px] text-slate-400 hover:text-slate-200"
              >
                Try again
              </button>
            </div>
          )}

          {(switchPhase === 'idle' || switchPhase === 'error') && isAdmin && (
            <button
              onClick={() => void handleSwitchToRecommended()}
              className="flex items-center gap-1.5 rounded-md bg-indigo-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 transition-colors"
            >
              <Zap size={12} />
              Switch to recommended
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Spec tile ────────────────────────────────────────────────────────────────

function Spec({
  label,
  value,
  icon: Icon,
  highlight = false,
}: {
  label: string
  value: string
  icon: typeof Cpu
  highlight?: boolean
}) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="flex items-center gap-1 mb-0.5">
        <Icon size={11} className={highlight ? 'text-cyan-400' : 'text-slate-600'} />
        <span className="text-[9px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <p className={cn('text-sm font-medium', highlight ? 'text-cyan-300' : 'text-slate-200')}>{value}</p>
    </div>
  )
}

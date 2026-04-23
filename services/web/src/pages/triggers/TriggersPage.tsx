import { useState, useEffect, useRef } from 'react'
import { Timer, Play, Pause, Trash2, Zap, GitMerge, Database, Clock, Loader2, Save } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'

interface Trigger {
  id: string
  name: string
  module: 'kex' | 'fuse' | 'compilation'
  type: 'cron' | 'change_detection'
  status: 'active' | 'paused' | 'error'
  cronSchedule: string | null
  config: Record<string, unknown>
  lastRunAt: string | null
  nextRunAt: string | null
  runCount: number
  lastError: string | null
  createdAt: string
}

const MODULE_ICONS: Record<string, typeof Zap> = { kex: Zap, fuse: GitMerge, compilation: Database }
const MODULE_COLORS: Record<string, string> = { kex: 'text-blue-400', fuse: 'text-purple-400', compilation: 'text-emerald-400' }
const STATUS_COLORS: Record<string, string> = { active: 'bg-emerald-400', paused: 'bg-slate-500', error: 'bg-red-400' }

// Cron presets removed — triggers are created from KEX with presets there

export default function TriggersPage() {
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [loading, setLoading] = useState(true)
  // Create form removed — triggers are created from KEX extraction options
  const [heartbeat, setHeartbeat] = useState<{ intervalMs: number; lastTickAt: string | null; lastTickDurationMs: number | null; isTicking: boolean }>({ intervalMs: 60000, lastTickAt: null, lastTickDurationMs: null, isTicking: false })
  const [heartbeatValue, setHeartbeatValue] = useState(1)
  const [heartbeatUnit, setHeartbeatUnit] = useState('minute')
  const [heartbeatDirty, setHeartbeatDirty] = useState(false)
  const [heartbeatSaving, setHeartbeatSaving] = useState(false)
  const [tickingManual, setTickingManual] = useState(false)
  const [countdown, setCountdown] = useState('')
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    void load(); void loadHeartbeat()
    // Poll heartbeat status every 5s to keep lastTickAt and isTicking fresh
    const poll = setInterval(() => void loadHeartbeat(), 5000)
    return () => clearInterval(poll)
  }, [])

  // Countdown timer — recalculates from lastTickAt + intervalMs, not reset on interval change
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current)

    function update() {
      if (!heartbeat.lastTickAt) { setCountdown(''); return }
      const nextTickAt = new Date(heartbeat.lastTickAt).getTime() + heartbeat.intervalMs
      const remaining = Math.max(0, nextTickAt - Date.now())
      if (remaining <= 0) { setCountdown('now'); return }
      const totalSec = Math.ceil(remaining / 1000)
      if (totalSec < 60) { setCountdown(`${totalSec}s`); return }
      const min = Math.floor(totalSec / 60)
      const sec = totalSec % 60
      if (min < 60) { setCountdown(`${min}m ${sec}s`); return }
      const hr = Math.floor(min / 60)
      const remMin = min % 60
      setCountdown(`${hr}h ${remMin}m`)
    }

    update()
    countdownRef.current = setInterval(update, 1000)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [heartbeat.lastTickAt, heartbeat.intervalMs])

  async function load() {
    setLoading(true)
    try {
      const { data } = await api.get('/triggers')
      setTriggers(data.triggers || [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const UNIT_MS: Record<string, number> = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }

  function msToValueUnit(ms: number): { value: number; unit: string } {
    if (ms >= 604800000 && ms % 604800000 === 0) return { value: ms / 604800000, unit: 'week' }
    if (ms >= 86400000 && ms % 86400000 === 0) return { value: ms / 86400000, unit: 'day' }
    if (ms >= 3600000 && ms % 3600000 === 0) return { value: ms / 3600000, unit: 'hour' }
    if (ms >= 60000 && ms % 60000 === 0) return { value: ms / 60000, unit: 'minute' }
    return { value: Math.round(ms / 1000), unit: 'second' }
  }

  async function loadHeartbeat() {
    try {
      const { data } = await api.get('/triggers/heartbeat')
      setHeartbeat(data)
      // Only sync value/unit from server when not editing locally
      if (!heartbeatDirty) {
        const { value, unit } = msToValueUnit(data.intervalMs)
        setHeartbeatValue(value)
        setHeartbeatUnit(unit)
      }
    } catch { /* ignore */ }
  }

  async function saveHeartbeat() {
    const ms = heartbeatValue * (UNIT_MS[heartbeatUnit] || 60000)
    setHeartbeatSaving(true)
    try {
      await api.put('/triggers/heartbeat', { intervalMs: ms })
      setHeartbeat((prev) => ({ ...prev, intervalMs: ms }))
      setHeartbeatDirty(false)
    } catch { alert('Failed to update heartbeat') }
    finally { setHeartbeatSaving(false) }
  }

  async function handleTickNow() {
    setTickingManual(true)
    try {
      await api.post('/triggers/heartbeat/tick')
      await loadHeartbeat()
      await load()
    } catch { /* ignore */ }
    finally { setTickingManual(false) }
  }

  // handleCreate removed — triggers created from KEX

  async function handlePause(id: string) { await api.post(`/triggers/${id}/pause`); await load() }
  async function handleResume(id: string) { await api.post(`/triggers/${id}/resume`); await load() }
  async function handleDelete(id: string) { if (!confirm('Delete this trigger?')) return; await api.delete(`/triggers/${id}`); await load() }
  async function handleRunNow(id: string) { await api.post(`/triggers/${id}/run-now`); await load() }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-100">Triggers</h1>
        <p className="text-xs text-slate-500">Manage recurring extraction, fusion, and sync jobs</p>
      </div>

      {/* Heartbeat config */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Status indicator: spinner when ticking, pulse when idle */}
            {heartbeat.isTicking || tickingManual ? (
              <Loader2 size={14} className="animate-spin text-indigo-400" />
            ) : (
              <div className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
            <div>
              <span className="text-xs font-medium text-slate-200">Heartbeat</span>
              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                {heartbeat.lastTickAt && (
                  <span>Last tick: {new Date(heartbeat.lastTickAt).toLocaleTimeString()}</span>
                )}
                {countdown && <span className="text-indigo-400">Next: {countdown}</span>}
                {heartbeat.lastTickDurationMs != null && (
                  <span className="text-slate-600">({heartbeat.lastTickDurationMs}ms)</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500">Every</span>
            <input
              type="number"
              min={1}
              value={heartbeatValue}
              onChange={(e) => { setHeartbeatValue(Math.max(1, parseInt(e.target.value) || 1)); setHeartbeatDirty(true) }}
              className="w-14 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-center text-[10px] text-slate-200 focus:border-indigo-500 focus:outline-none"
            />
            <select
              value={heartbeatUnit}
              onChange={(e) => { setHeartbeatUnit(e.target.value); setHeartbeatDirty(true) }}
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300"
            >
              <option value="second">second(s)</option>
              <option value="minute">minute(s)</option>
              <option value="hour">hour(s)</option>
              <option value="day">day(s)</option>
              <option value="week">week(s)</option>
            </select>
            {heartbeatDirty && (
              <button
                onClick={() => void saveHeartbeat()}
                disabled={heartbeatSaving}
                className="flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {heartbeatSaving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                Save
              </button>
            )}
            <button
              onClick={() => void handleTickNow()}
              disabled={tickingManual}
              className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-[10px] font-medium text-indigo-400 hover:bg-slate-700 hover:text-indigo-300 disabled:opacity-50 transition-colors"
              title="Execute one heartbeat tick now"
            >
              {tickingManual ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
              Tick Now
            </button>
          </div>
        </div>
      </div>

      {/* Triggers list */}
      <div className="card p-0 overflow-hidden">
        <div className="border-b border-slate-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-200">All Triggers <span className="text-slate-600">({triggers.length})</span></h3>
        </div>
        {loading ? (
          <div className="py-8 text-center text-xs text-slate-500">Loading...</div>
        ) : triggers.length === 0 ? (
          <div className="py-8 text-center">
            <Timer size={20} className="mx-auto text-slate-600" />
            <p className="mt-2 text-xs text-slate-500">No triggers yet</p>
            <p className="text-[10px] text-slate-600">Create one to automate recurring extractions</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {triggers.map((t) => {
              const ModIcon = MODULE_ICONS[t.module] || Zap
              return (
                <div key={t.id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-800/30 transition-colors">
                  <div className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_COLORS[t.status])} />
                  <ModIcon size={14} className={cn('shrink-0', MODULE_COLORS[t.module])} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-slate-200">{t.name}</p>
                    <p className="text-[10px] text-slate-500">
                      {t.module.toUpperCase()} · {t.type === 'cron' ? t.cronSchedule : 'On change'} · {t.runCount} runs
                    </p>
                  </div>
                  {t.lastRunAt && (
                    <span className="shrink-0 text-[10px] text-slate-600 flex items-center gap-1">
                      <Clock size={10} /> {formatDistanceToNow(new Date(t.lastRunAt), { addSuffix: true })}
                    </span>
                  )}
                  {t.lastError && <span className="shrink-0 text-[9px] text-red-400" title={t.lastError}>Error</span>}
                  <div className="shrink-0 flex items-center gap-1">
                    <button onClick={() => void handleRunNow(t.id)} title="Run now" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-indigo-400"><Play size={12} /></button>
                    {t.status === 'active' ? (
                      <button onClick={() => void handlePause(t.id)} title="Pause" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-amber-400"><Pause size={12} /></button>
                    ) : (
                      <button onClick={() => void handleResume(t.id)} title="Resume" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-emerald-400"><Play size={12} /></button>
                    )}
                    <button onClick={() => void handleDelete(t.id)} title="Delete" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-red-400"><Trash2 size={12} /></button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

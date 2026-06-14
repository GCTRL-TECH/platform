import { useState, useEffect, useRef } from 'react'
import {
  Timer, Play, Pause, Trash2, Zap, GitMerge, Database, Clock, Loader2, Save,
  BookOpenText, FolderSync, Plus, Pencil, X, Check,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'

type TriggerModule = 'kex' | 'fuse' | 'compilation' | 'obsidian' | 'distill'

interface Trigger {
  id: string
  name: string
  module: TriggerModule
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

interface WikiComp { id: string; name: string; type?: string; isSystem?: boolean }

const MODULE_ICONS: Record<string, typeof Zap> = {
  kex: Zap, fuse: GitMerge, compilation: Database, obsidian: FolderSync, distill: BookOpenText,
}
const MODULE_COLORS: Record<string, string> = {
  kex: 'text-blue-400', fuse: 'text-purple-400', compilation: 'text-emerald-400',
  obsidian: 'text-sky-400', distill: 'text-violet-400',
}
const STATUS_COLORS: Record<string, string> = { active: 'bg-emerald-400', paused: 'bg-slate-500', error: 'bg-red-400' }

// ── Interval ⇄ cron helpers ─────────────────────────────────────────────────
// We expose a friendly value+unit picker and translate to/from a cron string so
// the user decides "every 10 minutes / 4 hours / 1 day" without writing cron.

function intervalToCron(value: number, unit: string): string {
  const v = Math.max(1, Math.floor(value))
  if (unit === 'minute') return `*/${Math.min(v, 59)} * * * *`
  if (unit === 'hour') return `0 */${Math.min(v, 23)} * * *`
  return `0 0 */${Math.min(v, 28)} * *` // day
}
function cronToInterval(cron: string | null): { value: number; unit: string } | null {
  if (!cron) return null
  let m: RegExpMatchArray | null
  if ((m = cron.match(/^\*\/(\d+) \* \* \* \*$/))) return { value: +m[1], unit: 'minute' }
  if ((m = cron.match(/^0 \*\/(\d+) \* \* \*$/))) return { value: +m[1], unit: 'hour' }
  if ((m = cron.match(/^0 0 \*\/(\d+) \* \*$/))) return { value: +m[1], unit: 'day' }
  return null
}
function describeSchedule(t: Trigger): string {
  if (t.type === 'change_detection') return 'Heartbeat · skips when idle'
  const iv = cronToInterval(t.cronSchedule)
  if (iv) return `Every ${iv.value} ${iv.unit}${iv.value > 1 ? 's' : ''}`
  return t.cronSchedule || 'cron'
}

export default function TriggersPage() {
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [wikis, setWikis] = useState<WikiComp[]>([])
  const [loading, setLoading] = useState(true)
  const [heartbeat, setHeartbeat] = useState<{ intervalMs: number; lastTickAt: string | null; lastTickDurationMs: number | null; isTicking: boolean }>({ intervalMs: 60000, lastTickAt: null, lastTickDurationMs: null, isTicking: false })
  const [heartbeatValue, setHeartbeatValue] = useState(1)
  const [heartbeatUnit, setHeartbeatUnit] = useState('minute')
  const [heartbeatDirty, setHeartbeatDirty] = useState(false)
  const [heartbeatSaving, setHeartbeatSaving] = useState(false)
  const [tickingManual, setTickingManual] = useState(false)
  const [countdown, setCountdown] = useState('')
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    void load(); void loadHeartbeat(); void loadWikis()
    const poll = setInterval(() => void loadHeartbeat(), 5000)
    return () => clearInterval(poll)
  }, [])

  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    function update() {
      if (!heartbeat.lastTickAt) { setCountdown(''); return }
      const nextTickAt = new Date(heartbeat.lastTickAt).getTime() + heartbeat.intervalMs
      const remaining = Math.max(0, nextTickAt - Date.now())
      if (remaining <= 0) { setCountdown('now'); return }
      const totalSec = Math.ceil(remaining / 1000)
      if (totalSec < 60) { setCountdown(`${totalSec}s`); return }
      const min = Math.floor(totalSec / 60); const sec = totalSec % 60
      if (min < 60) { setCountdown(`${min}m ${sec}s`); return }
      const hr = Math.floor(min / 60); const remMin = min % 60
      setCountdown(`${hr}h ${remMin}m`)
    }
    update()
    countdownRef.current = setInterval(update, 1000)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [heartbeat.lastTickAt, heartbeat.intervalMs])

  async function load() {
    setLoading(true)
    try { const { data } = await api.get('/triggers'); setTriggers(data.triggers || []) }
    catch { /* ignore */ } finally { setLoading(false) }
  }

  async function loadWikis() {
    try {
      const { data } = await api.get('/kg/compilations?limit=100')
      setWikis((data.compilations || []).filter((c: WikiComp) => c.type === 'WIKI'))
    } catch { /* ignore */ }
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
      if (!heartbeatDirty) {
        const { value, unit } = msToValueUnit(data.intervalMs)
        setHeartbeatValue(value); setHeartbeatUnit(unit)
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
    try { await api.post('/triggers/heartbeat/tick'); await loadHeartbeat(); await load() }
    catch { /* ignore */ } finally { setTickingManual(false) }
  }

  async function handlePause(id: string) { await api.post(`/triggers/${id}/pause`); await load() }
  async function handleResume(id: string) { await api.post(`/triggers/${id}/resume`); await load() }
  async function handleDelete(id: string) { if (!confirm('Delete this trigger?')) return; await api.delete(`/triggers/${id}`); await load() }
  async function handleRunNow(id: string) { await api.post(`/triggers/${id}/run-now`); await load() }

  // Which wikis already have a distill trigger (so we can flag the gap).
  const wikisWithTrigger = new Set(
    triggers.filter((t) => t.module === 'distill')
      .map((t) => (t.config?.compilationId as string) || ''),
  )
  const wikisMissingTrigger = wikis.filter((w) => !wikisWithTrigger.has(w.id))

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-100">Triggers</h1>
        <p className="text-xs text-slate-500">Manage recurring extraction, fusion, sync, and wiki-distill jobs</p>
      </div>

      {/* Heartbeat config (global executor tick rate) */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {heartbeat.isTicking || tickingManual ? (
              <Loader2 size={14} className="animate-spin text-indigo-400" />
            ) : (
              <div className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
            <div>
              <span className="text-xs font-medium text-slate-200">Heartbeat</span>
              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                {heartbeat.lastTickAt && <span>Last tick: {new Date(heartbeat.lastTickAt).toLocaleTimeString()}</span>}
                {countdown && <span className="text-indigo-400">Next: {countdown}</span>}
                {heartbeat.lastTickDurationMs != null && <span className="text-slate-600">({heartbeat.lastTickDurationMs}ms)</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500">Every</span>
            <input type="number" min={1} value={heartbeatValue}
              onChange={(e) => { setHeartbeatValue(Math.max(1, parseInt(e.target.value) || 1)); setHeartbeatDirty(true) }}
              className="w-14 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-center text-[10px] text-slate-200 focus:border-indigo-500 focus:outline-none" />
            <select value={heartbeatUnit} onChange={(e) => { setHeartbeatUnit(e.target.value); setHeartbeatDirty(true) }}
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300">
              <option value="second">second(s)</option>
              <option value="minute">minute(s)</option>
              <option value="hour">hour(s)</option>
              <option value="day">day(s)</option>
              <option value="week">week(s)</option>
            </select>
            {heartbeatDirty && (
              <button onClick={() => void saveHeartbeat()} disabled={heartbeatSaving}
                className="flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors">
                {heartbeatSaving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />} Save
              </button>
            )}
            <button onClick={() => void handleTickNow()} disabled={tickingManual}
              className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-[10px] font-medium text-indigo-400 hover:bg-slate-700 hover:text-indigo-300 disabled:opacity-50 transition-colors"
              title="Execute one heartbeat tick now">
              {tickingManual ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />} Tick Now
            </button>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-slate-600">
          The heartbeat is how often the executor checks for due triggers. A trigger in <span className="text-violet-300">Heartbeat mode</span> runs every tick but skips when there's nothing new.
        </p>
      </div>

      {/* Auto-distill triggers per wiki */}
      <DistillTriggerSection
        wikis={wikis}
        wikisMissingTrigger={wikisMissingTrigger}
        onCreated={load}
      />

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
          </div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {triggers.map((t) => (
              <TriggerRow key={t.id} t={t}
                onChanged={load}
                onRunNow={handleRunNow} onPause={handlePause} onResume={handleResume} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Per-wiki distill trigger creation ───────────────────────────────────────

function DistillTriggerSection({
  wikis, wikisMissingTrigger, onCreated,
}: {
  wikis: WikiComp[]
  wikisMissingTrigger: WikiComp[]
  onCreated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [wikiId, setWikiId] = useState('')
  const [mode, setMode] = useState<'cron' | 'heartbeat'>('cron')
  const [value, setValue] = useState(10)
  const [unit, setUnit] = useState('minute')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (open && !wikiId && wikisMissingTrigger[0]) setWikiId(wikisMissingTrigger[0].id) }, [open, wikiId, wikisMissingTrigger])

  async function create() {
    if (!wikiId) { setErr('Pick a wiki'); return }
    const wiki = wikis.find((w) => w.id === wikiId)
    setBusy(true); setErr(null)
    try {
      await api.post('/triggers', {
        name: `Auto-distill: ${wiki?.name ?? 'Wiki'}`,
        module: 'distill',
        type: mode === 'heartbeat' ? 'change_detection' : 'cron',
        cronSchedule: mode === 'cron' ? intervalToCron(value, unit) : undefined,
        config: { compilationId: wikiId },
      })
      setOpen(false); setWikiId('')
      onCreated()
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to create trigger')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <BookOpenText size={14} className="text-violet-400" /> Wiki auto-distill triggers
          </h3>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Each wiki keeps itself up to date on its own schedule.{' '}
            {wikisMissingTrigger.length > 0 && (
              <span className="text-amber-400">{wikisMissingTrigger.length} wiki{wikisMissingTrigger.length > 1 ? 's' : ''} without a distill trigger.</span>
            )}
          </p>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="btn-secondary text-xs">
          <Plus size={13} /> New distill trigger
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-slate-500">Wiki</label>
              <select value={wikiId} onChange={(e) => setWikiId(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 focus:border-violet-500 focus:outline-none">
                <option value="">Select a wiki…</option>
                {wikis.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isSystem ? ' (system)' : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-slate-500">Mode</label>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'cron' | 'heartbeat')}
                className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 focus:border-violet-500 focus:outline-none">
                <option value="cron">Fixed interval</option>
                <option value="heartbeat">Heartbeat (runs when there's something new)</option>
              </select>
            </div>
          </div>

          {mode === 'cron' && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500">Distill every</span>
              <input type="number" min={1} value={value} onChange={(e) => setValue(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-16 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-center text-xs text-slate-200 focus:border-violet-500 focus:outline-none" />
              <select value={unit} onChange={(e) => setUnit(e.target.value)}
                className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-300">
                <option value="minute">minute(s)</option>
                <option value="hour">hour(s)</option>
                <option value="day">day(s)</option>
              </select>
            </div>
          )}
          {mode === 'heartbeat' && (
            <p className="text-[10px] text-slate-500">
              Runs on every heartbeat tick but <span className="text-slate-300">skips when there's nothing new</span> to distill (no source changes since the last run).
            </p>
          )}

          {err && <p className="text-[10px] text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="btn-ghost text-xs">Cancel</button>
            <button onClick={() => void create()} disabled={busy || !wikiId} className="btn-primary text-xs">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Create
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── A single trigger row (with inline interval/mode editor) ─────────────────

function TriggerRow({
  t, onChanged, onRunNow, onPause, onResume, onDelete,
}: {
  t: Trigger
  onChanged: () => void
  onRunNow: (id: string) => void
  onPause: (id: string) => void
  onResume: (id: string) => void
  onDelete: (id: string) => void
}) {
  const ModIcon = MODULE_ICONS[t.module] || Zap
  const [editing, setEditing] = useState(false)
  const initial = cronToInterval(t.cronSchedule) ?? { value: 10, unit: 'minute' }
  const [mode, setMode] = useState<'cron' | 'heartbeat'>(t.type === 'change_detection' ? 'heartbeat' : 'cron')
  const [value, setValue] = useState(initial.value)
  const [unit, setUnit] = useState(initial.unit)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await api.put(`/triggers/${t.id}`, {
        type: mode === 'heartbeat' ? 'change_detection' : 'cron',
        cronSchedule: mode === 'cron' ? intervalToCron(value, unit) : undefined,
      })
      setEditing(false)
      onChanged()
    } catch { alert('Failed to update trigger') }
    finally { setSaving(false) }
  }

  return (
    <div className="px-5 py-3 hover:bg-slate-800/30 transition-colors">
      <div className="flex items-center gap-3">
        <div className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_COLORS[t.status])} />
        <ModIcon size={14} className={cn('shrink-0', MODULE_COLORS[t.module])} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-200">{t.name}</p>
          <p className="text-[10px] text-slate-500">{t.module.toUpperCase()} · {describeSchedule(t)} · {t.runCount} runs</p>
        </div>
        {t.lastRunAt && (
          <span className="shrink-0 text-[10px] text-slate-600 flex items-center gap-1">
            <Clock size={10} /> {formatDistanceToNow(new Date(t.lastRunAt), { addSuffix: true })}
          </span>
        )}
        {t.lastError && <span className="shrink-0 text-[9px] text-red-400" title={t.lastError}>Error</span>}
        <div className="shrink-0 flex items-center gap-1">
          <button onClick={() => setEditing((v) => !v)} title="Edit schedule" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-violet-400">
            {editing ? <X size={12} /> : <Pencil size={12} />}
          </button>
          <button onClick={() => onRunNow(t.id)} title="Run now" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-indigo-400"><Play size={12} /></button>
          {t.status === 'active' ? (
            <button onClick={() => onPause(t.id)} title="Pause" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-amber-400"><Pause size={12} /></button>
          ) : (
            <button onClick={() => onResume(t.id)} title="Resume" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-emerald-400"><Play size={12} /></button>
          )}
          <button onClick={() => onDelete(t.id)} title="Delete" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-red-400"><Trash2 size={12} /></button>
        </div>
      </div>

      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'cron' | 'heartbeat')}
            className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200">
            <option value="cron">Fixed interval</option>
            <option value="heartbeat">Heartbeat (skips when idle)</option>
          </select>
          {mode === 'cron' && (
            <>
              <span className="text-[10px] text-slate-500">every</span>
              <input type="number" min={1} value={value} onChange={(e) => setValue(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-14 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-center text-[11px] text-slate-200" />
              <select value={unit} onChange={(e) => setUnit(e.target.value)}
                className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-300">
                <option value="minute">minute(s)</option>
                <option value="hour">hour(s)</option>
                <option value="day">day(s)</option>
              </select>
            </>
          )}
          <button onClick={() => void save()} disabled={saving}
            className="ml-auto flex items-center gap-1 rounded bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500 disabled:opacity-50">
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save
          </button>
        </div>
      )}
    </div>
  )
}

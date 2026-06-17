import { useState, useEffect, useRef } from 'react'
import {
  Webhook,
  Plus,
  Trash2,
  Send,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  CheckCircle2,
  Clock,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Webhook {
  id: string
  name: string
  url: string
  events: string[]
  isActive: boolean
  consecutiveFailures: number
  lastTriggeredAt: string | null
  createdAt: string
}

interface Delivery {
  id: string
  event: string
  payload: unknown
  responseStatus: number | null
  responseBody: string | null
  deliveredAt: string
  success: boolean
}

interface CreateFormState {
  name: string
  url: string
  secret: string
  events: string[]
}

const ALL_EVENTS = ['job.completed', 'compilation.created', 'pii.detected'] as const
type EventType = (typeof ALL_EVENTS)[number]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncateUrl(url: string, max = 40): string {
  return url.length > max ? url.slice(0, max) + '…' : url
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString()
}

function statusColor(code: number | null): string {
  if (code === null) return 'bg-slate-700 text-slate-400'
  if (code >= 200 && code < 300) return 'bg-emerald-900/60 text-emerald-400'
  return 'bg-red-900/60 text-red-400'
}

function eventBadgeColor(event: string): string {
  switch (event) {
    case 'job.completed':
      return 'bg-indigo-900/60 text-indigo-300'
    case 'compilation.created':
      return 'bg-purple-900/60 text-purple-300'
    case 'pii.detected':
      return 'bg-amber-900/60 text-amber-300'
    default:
      return 'bg-slate-800 text-slate-400'
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

interface Toast {
  id: number
  message: string
  type: 'success' | 'error'
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)

  function push(message: string, type: Toast['type'] = 'success') {
    const id = ++counter.current
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3000)
  }

  function dismiss(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  return { toasts, push, dismiss }
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<CreateFormState>({
    name: '',
    url: '',
    secret: '',
    events: [],
  })
  const [showSecret, setShowSecret] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Deliveries drawer — maps webhook id → delivery list
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({})
  const [deliveriesLoading, setDeliveriesLoading] = useState<string | null>(null)
  const [deliveriesError, setDeliveriesError] = useState<Record<string, string>>({})

  // Per-row state
  const [testingId, setTestingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const { toasts, push, dismiss } = useToasts()

  useEffect(() => {
    void loadWebhooks()
  }, [])

  async function loadWebhooks() {
    setLoading(true)
    setListError(null)
    try {
      const res = await api.get('/webhooks')
      setWebhooks(res.data.webhooks ?? [])
    } catch {
      setListError('Failed to load webhooks.')
    } finally {
      setLoading(false)
    }
  }

  // ── Create ────────────────────────────────────────────────────────────────

  function validateUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') {
        setUrlError('URL must start with https://')
        return false
      }
      setUrlError(null)
      return true
    } catch {
      setUrlError('Enter a valid URL')
      return false
    }
  }

  function toggleEvent(event: EventType) {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event],
    }))
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!validateUrl(form.url)) return
    if (!form.name.trim()) return

    setCreating(true)
    setCreateError(null)
    try {
      await api.post('/webhooks', {
        name: form.name.trim(),
        url: form.url.trim(),
        secret: form.secret.trim() || undefined,
        events: form.events.length > 0 ? form.events : undefined,
      })
      setForm({ name: '', url: '', secret: '', events: [] })
      setShowCreate(false)
      push('Webhook created')
      await loadWebhooks()
    } catch {
      setCreateError('Failed to create webhook.')
    } finally {
      setCreating(false)
    }
  }

  // ── Toggle active ─────────────────────────────────────────────────────────

  async function handleToggle(webhook: Webhook) {
    setTogglingId(webhook.id)
    setRowErrors((prev) => ({ ...prev, [webhook.id]: '' }))
    try {
      await api.put(`/webhooks/${webhook.id}`, { is_active: !webhook.isActive })
      setWebhooks((prev) =>
        prev.map((w) => (w.id === webhook.id ? { ...w, isActive: !w.isActive } : w))
      )
    } catch {
      setRowErrors((prev) => ({ ...prev, [webhook.id]: 'Toggle failed.' }))
    } finally {
      setTogglingId(null)
    }
  }

  // ── Test ──────────────────────────────────────────────────────────────────

  async function handleTest(id: string) {
    setTestingId(id)
    setRowErrors((prev) => ({ ...prev, [id]: '' }))
    try {
      await api.post(`/webhooks/${id}/test`, {})
      push('Test sent')
    } catch {
      setRowErrors((prev) => ({ ...prev, [id]: 'Test request failed.' }))
    } finally {
      setTestingId(null)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    setDeletingId(id)
    setRowErrors((prev) => ({ ...prev, [id]: '' }))
    try {
      await api.delete(`/webhooks/${id}`)
      setWebhooks((prev) => prev.filter((w) => w.id !== id))
      if (openDeliveries === id) setOpenDeliveries(null)
      push('Webhook deleted')
    } catch {
      setRowErrors((prev) => ({ ...prev, [id]: 'Delete failed.' }))
    } finally {
      setDeletingId(null)
    }
  }

  // ── Deliveries drawer ─────────────────────────────────────────────────────

  async function toggleDeliveries(id: string) {
    if (openDeliveries === id) {
      setOpenDeliveries(null)
      return
    }
    setOpenDeliveries(id)
    if (deliveries[id]) return // already loaded

    setDeliveriesLoading(id)
    setDeliveriesError((prev) => ({ ...prev, [id]: '' }))
    try {
      const res = await api.get(`/webhooks/${id}/deliveries`)
      setDeliveries((prev) => ({ ...prev, [id]: (res.data.deliveries ?? []).slice(0, 10) }))
    } catch {
      setDeliveriesError((prev) => ({ ...prev, [id]: 'Failed to load deliveries.' }))
    } finally {
      setDeliveriesLoading(null)
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Webhooks</h1>
          <p className="text-sm text-slate-500">
            Receive HTTP callbacks when events happen in your GCTRL workspace
          </p>
        </div>
        <Button
          onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          {showCreate ? <X size={14} /> : <Plus size={14} />}
          {showCreate ? 'Cancel' : 'Add Webhook'}
        </Button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-6">
          <h2 className="mb-4 text-sm font-semibold text-slate-200">New Webhook</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Name */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Name</label>
                <input
                  required
                  type="text"
                  placeholder="My Webhook"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40"
                />
              </div>

              {/* URL */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  Endpoint URL
                </label>
                <input
                  required
                  type="url"
                  placeholder="https://example.com/hooks"
                  value={form.url}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, url: e.target.value }))
                    if (urlError) validateUrl(e.target.value)
                  }}
                  onBlur={(e) => validateUrl(e.target.value)}
                  className={cn(
                    'w-full rounded-lg border bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 outline-none focus:ring-1',
                    urlError
                      ? 'border-red-500 focus:border-red-500 focus:ring-red-500/40'
                      : 'border-slate-700 focus:border-indigo-500 focus:ring-indigo-500/40'
                  )}
                />
                {urlError && <p className="mt-1 text-xs text-red-400">{urlError}</p>}
              </div>
            </div>

            {/* Secret */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">
                Secret <span className="text-slate-600">(optional)</span>
              </label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  placeholder="Signing secret"
                  value={form.secret}
                  onChange={(e) => setForm((prev) => ({ ...prev, secret: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 pr-9 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* Events */}
            <div>
              <label className="mb-2 block text-xs font-medium text-slate-400">
                Events <span className="text-slate-600">(empty = all)</span>
              </label>
              <div className="flex flex-wrap gap-3">
                {ALL_EVENTS.map((evt) => (
                  <label
                    key={evt}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:border-slate-600 hover:bg-slate-700/60"
                  >
                    <input
                      type="checkbox"
                      checked={form.events.includes(evt)}
                      onChange={() => toggleEvent(evt)}
                      className="accent-indigo-500"
                    />
                    <span className={cn('rounded px-1.5 py-0.5', eventBadgeColor(evt))}>{evt}</span>
                  </label>
                ))}
              </div>
            </div>

            {createError && (
              <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/40 px-3 py-2 text-xs text-red-400">
                <AlertCircle size={13} />
                {createError}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={creating}
                className="bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create Webhook'}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Webhook List */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm text-slate-500">
            Loading webhooks…
          </div>
        ) : listError ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-red-400">
            <AlertCircle size={15} />
            {listError}
          </div>
        ) : webhooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-500">
            <Webhook size={28} className="mb-3 opacity-40" />
            <p className="text-sm">No webhooks yet</p>
            <p className="mt-1 text-xs">Click "Add Webhook" to create your first endpoint</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {webhooks.map((webhook) => (
              <div key={webhook.id}>
                {/* Webhook Row */}
                <div className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    {/* Left: info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-200">{webhook.name}</span>
                        {webhook.consecutiveFailures > 0 && (
                          <span className="flex items-center gap-1 rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-400">
                            <AlertCircle size={10} />
                            {webhook.consecutiveFailures} failures
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 font-mono text-xs text-slate-500">
                        {truncateUrl(webhook.url)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {webhook.events.length > 0 ? (
                          webhook.events.map((evt) => (
                            <span
                              key={evt}
                              className={cn(
                                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                                eventBadgeColor(evt)
                              )}
                            >
                              {evt}
                            </span>
                          ))
                        ) : (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">
                            all events
                          </span>
                        )}
                      </div>
                      {webhook.lastTriggeredAt && (
                        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-slate-600">
                          <Clock size={9} />
                          Last triggered: {formatDate(webhook.lastTriggeredAt)}
                        </p>
                      )}
                    </div>

                    {/* Right: actions */}
                    <div className="flex shrink-0 items-center gap-2">
                      {/* Active toggle */}
                      <button
                        onClick={() => handleToggle(webhook)}
                        disabled={togglingId === webhook.id}
                        title={webhook.isActive ? 'Deactivate' : 'Activate'}
                        className="text-slate-400 transition-colors hover:text-slate-200 disabled:opacity-40"
                      >
                        {webhook.isActive ? (
                          <ToggleRight size={22} className="text-emerald-500" />
                        ) : (
                          <ToggleLeft size={22} className="text-slate-600" />
                        )}
                      </button>

                      {/* Test */}
                      <button
                        onClick={() => handleTest(webhook.id)}
                        disabled={testingId === webhook.id}
                        title="Send test event"
                        className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-700 disabled:opacity-40"
                      >
                        {testingId === webhook.id ? (
                          <span className="flex items-center gap-1">
                            <Send size={11} />
                            Sending…
                          </span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <Send size={11} />
                            Test
                          </span>
                        )}
                      </button>

                      {/* Deliveries toggle */}
                      <button
                        onClick={() => toggleDeliveries(webhook.id)}
                        title="View deliveries"
                        className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-700"
                      >
                        <span className="flex items-center gap-1">
                          {openDeliveries === webhook.id ? (
                            <ChevronUp size={11} />
                          ) : (
                            <ChevronDown size={11} />
                          )}
                          Deliveries
                        </span>
                      </button>

                      {/* Delete */}
                      <button
                        onClick={() => handleDelete(webhook.id)}
                        disabled={deletingId === webhook.id}
                        title="Delete webhook"
                        className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-400 transition-colors hover:border-red-800 hover:bg-red-950/40 hover:text-red-400 disabled:opacity-40"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Row-level error */}
                  {rowErrors[webhook.id] && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
                      <AlertCircle size={11} />
                      {rowErrors[webhook.id]}
                    </div>
                  )}
                </div>

                {/* Deliveries Drawer */}
                {openDeliveries === webhook.id && (
                  <div className="border-t border-slate-800 bg-slate-950/40 px-5 pb-4 pt-3">
                    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Recent Deliveries
                    </h3>

                    {deliveriesLoading === webhook.id ? (
                      <p className="text-xs text-slate-500">Loading deliveries…</p>
                    ) : deliveriesError[webhook.id] ? (
                      <div className="flex items-center gap-1.5 text-xs text-red-400">
                        <AlertCircle size={11} />
                        {deliveriesError[webhook.id]}
                      </div>
                    ) : !deliveries[webhook.id] || deliveries[webhook.id].length === 0 ? (
                      <p className="text-xs text-slate-600">No deliveries yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {deliveries[webhook.id].map((d) => (
                          <DeliveryRow key={d.id} delivery={d} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Toast Stack */}
      <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm shadow-xl',
              t.type === 'success'
                ? 'border-emerald-800/60 bg-emerald-950/90 text-emerald-300'
                : 'border-red-800/60 bg-red-950/90 text-red-300'
            )}
          >
            {t.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            {t.message}
            <button
              onClick={() => dismiss(t.id)}
              className="ml-2 text-current opacity-60 hover:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Delivery Row ─────────────────────────────────────────────────────────────

function DeliveryRow({ delivery }: { delivery: Delivery }) {
  const [expanded, setExpanded] = useState(false)
  const body = typeof delivery.responseBody === 'string' ? delivery.responseBody : ''
  const truncatedBody = body.length > 120 ? body.slice(0, 120) + '…' : body

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {delivery.success ? (
            <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
          ) : (
            <AlertCircle size={12} className="text-red-400 shrink-0" />
          )}
          <span className={cn('rounded px-1.5 py-0.5 font-medium', eventBadgeColor(delivery.event))}>
            {delivery.event}
          </span>
          {delivery.responseStatus !== null && (
            <span className={cn('rounded px-1.5 py-0.5 font-mono font-semibold', statusColor(delivery.responseStatus))}>
              {delivery.responseStatus}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-slate-600">
          <span>{new Date(delivery.deliveredAt).toLocaleString()}</span>
          {body && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-slate-500 hover:text-slate-300"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>
      </div>

      {body && (
        <div className="mt-2">
          <pre className="overflow-x-auto rounded bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
            {expanded ? body : truncatedBody}
          </pre>
        </div>
      )}
    </div>
  )
}

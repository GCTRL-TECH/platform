import { useState, useEffect } from 'react'
import {
  KeyRound,
  Plus,
  Trash2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertTriangle,
  Shield,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiKey {
  id: string
  name: string
  keyPrefix: string | null
  maxClearanceRank: number
  maxClearanceLevel: string | null
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

interface CreatedKey {
  id: string
  key: string
  name: string
  maxClearanceRank: number
  maxClearanceLevel?: string
  keyPrefix?: string
}

interface ApiKeysResponse {
  apiKeys: ApiKey[]
}

interface CreateKeyBody {
  name: string
  maxClearanceRank?: number
  expiresInDays?: number
}

// ─── Clearance Config ─────────────────────────────────────────────────────────

interface ClearanceLevel {
  rank: number
  label: string
  description: string
  badgeClass: string
  radioClass: string
}

const CLEARANCE_LEVELS: ClearanceLevel[] = [
  {
    rank: 0,
    label: 'PUBLIC',
    description: 'Can only see PUBLIC data',
    badgeClass: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20',
    radioClass: 'border-emerald-500 text-emerald-500',
  },
  {
    rank: 100,
    label: 'INTERNAL',
    description: 'Can see INTERNAL and below data',
    badgeClass: 'bg-blue-500/15 text-blue-400 border border-blue-500/20',
    radioClass: 'border-blue-500 text-blue-500',
  },
  {
    rank: 200,
    label: 'CONFIDENTIAL',
    description: 'Can see CONFIDENTIAL and below data',
    badgeClass: 'bg-amber-500/15 text-amber-400 border border-amber-500/20',
    radioClass: 'border-amber-500 text-amber-500',
  },
  {
    rank: 300,
    label: 'STRICTLY CONFIDENTIAL',
    description: 'Can see all data including strictly confidential',
    badgeClass: 'bg-red-500/15 text-red-400 border border-red-500/20',
    radioClass: 'border-red-500 text-red-500',
  },
]

const EXPIRE_OPTIONS: Array<{ label: string; value: number | undefined }> = [
  { label: 'Never', value: undefined },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '1 year', value: 365 },
]

// ─── Helper: get clearance config by rank ─────────────────────────────────────

function getClearance(rank: number): ClearanceLevel {
  return (
    CLEARANCE_LEVELS.find((c) => c.rank === rank) ??
    CLEARANCE_LEVELS[1] // fallback INTERNAL
  )
}

// ─── Helper: format date ──────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ─── ClearanceBadge ──────────────────────────────────────────────────────────

function ClearanceBadge({ rank }: { rank: number }) {
  const cfg = getClearance(rank)
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide',
        cfg.badgeClass
      )}
    >
      {cfg.label}
    </span>
  )
}

// ─── One-time Key Reveal ──────────────────────────────────────────────────────

interface KeyRevealBoxProps {
  createdKey: CreatedKey
  onDismiss: () => void
}

function KeyRevealBox({ createdKey, onDismiss }: KeyRevealBoxProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(createdKey.key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <div className="rounded-xl border border-emerald-700/40 bg-emerald-950/25 p-5">
      {/* Header */}
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
          <KeyRound size={18} className="text-emerald-400" />
        </div>
        <div>
          <p className="text-sm font-semibold text-emerald-300">
            API key created — <span className="text-white">{createdKey.name}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            Copy your key now. For security reasons, it will not be displayed again.
          </p>
        </div>
      </div>

      {/* Key display */}
      <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5">
        <code className="flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-[13px] text-emerald-300">
          {createdKey.key}
        </code>
        <button
          onClick={() => void handleCopy()}
          className={cn(
            'shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            copied
              ? 'bg-emerald-600/30 text-emerald-300'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white'
          )}
        >
          {copied ? (
            <span className="flex items-center gap-1.5">
              <Check size={12} /> Copied
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Copy size={12} /> Copy
            </span>
          )}
        </button>
      </div>

      {/* Warning */}
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-2.5">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
        <p className="text-xs text-red-300">
          <strong>This is the only time you'll see this key.</strong> Copy it now and store it
          somewhere safe. If you lose it, you'll need to create a new one.
        </p>
      </div>

      {/* Dismiss */}
      <div className="mt-4 flex justify-end">
        <Button variant="outline" size="sm" onClick={onDismiss}>
          I've copied it
        </Button>
      </div>
    </div>
  )
}

// ─── Create Form ──────────────────────────────────────────────────────────────

interface CreateFormProps {
  onCreated: (key: CreatedKey) => void
}

function CreateForm({ onCreated }: CreateFormProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [selectedRank, setSelectedRank] = useState<number>(100)
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError('')
    try {
      const body: CreateKeyBody = {
        name: name.trim(),
        maxClearanceRank: selectedRank,
        ...(expiresInDays !== undefined && { expiresInDays }),
      }
      const { data } = await api.post<CreatedKey>('/users/api-keys', body)
      onCreated(data)
      // Reset form
      setName('')
      setSelectedRank(100)
      setExpiresInDays(undefined)
      setOpen(false)
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to create key'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50">
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-slate-800/30"
      >
        <div className="flex items-center gap-2.5">
          <Plus size={15} className="text-indigo-400" />
          <span className="text-sm font-medium text-slate-200">Create new API key</span>
        </div>
        {open ? (
          <ChevronUp size={15} className="text-slate-500" />
        ) : (
          <ChevronDown size={15} className="text-slate-500" />
        )}
      </button>

      {/* Collapsible body */}
      {open && (
        <form onSubmit={(e) => void handleSubmit(e)} className="border-t border-slate-800 px-5 pb-5 pt-4">
          <div className="space-y-5">
            {/* Name field */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Key name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. gctrl-cli, automation-prod"
                required
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </div>

            {/* Clearance level */}
            <div>
              <label className="mb-2 block text-xs font-medium text-slate-400">
                Max clearance level
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {CLEARANCE_LEVELS.map((level) => (
                  <label
                    key={level.rank}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors',
                      selectedRank === level.rank
                        ? 'border-indigo-600/60 bg-indigo-950/30'
                        : 'border-slate-700 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/70'
                    )}
                  >
                    <input
                      type="radio"
                      name="clearanceRank"
                      value={level.rank}
                      checked={selectedRank === level.rank}
                      onChange={() => setSelectedRank(level.rank)}
                      className="mt-0.5 shrink-0 accent-indigo-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'inline-block rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide',
                            level.badgeClass
                          )}
                        >
                          {level.label}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">{level.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Expiry */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Expires in
              </label>
              <select
                value={expiresInDays ?? ''}
                onChange={(e) =>
                  setExpiresInDays(e.target.value === '' ? undefined : Number(e.target.value))
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 sm:w-48"
              >
                {EXPIRE_OPTIONS.map((opt) => (
                  <option key={opt.label} value={opt.value ?? ''}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Error */}
            {error && (
              <p className="rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-2 text-xs text-red-400">
                {error}
              </p>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!name.trim() || loading}>
                {loading ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <KeyRound size={13} />
                    Create key
                  </>
                )}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}

// ─── Keys Table ───────────────────────────────────────────────────────────────

interface KeysTableProps {
  keys: ApiKey[]
  onDelete: (id: string) => void
  deletingId: string | null
}

function KeysTable({ keys, onDelete, deletingId }: KeysTableProps) {
  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 py-14 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800/60">
          <KeyRound size={22} className="text-slate-500" />
        </div>
        <p className="text-sm font-medium text-slate-400">No API keys yet</p>
        <p className="mt-1 max-w-xs text-xs text-slate-600">
          Create one to authenticate CLI or automation access.
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800">
      {/* Table header */}
      <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] gap-x-4 border-b border-slate-800 bg-slate-900/80 px-5 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Name</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Clearance</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Key prefix</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Last used</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Expires</span>
        <span className="w-8" />
      </div>

      {/* Rows */}
      <div className="divide-y divide-slate-800/60">
        {keys.map((key) => (
          <div
            key={key.id}
            className={cn(
              'grid grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] items-center gap-x-4 px-5 py-3 transition-colors hover:bg-slate-800/20',
              deletingId === key.id && 'opacity-50'
            )}
          >
            {/* Name */}
            <div className="flex min-w-0 items-center gap-2.5">
              <KeyRound size={13} className="shrink-0 text-slate-500" />
              <span className="truncate text-sm font-medium text-slate-200">{key.name}</span>
            </div>

            {/* Clearance */}
            <div>
              <ClearanceBadge rank={key.maxClearanceRank} />
            </div>

            {/* Prefix */}
            <div>
              {key.keyPrefix ? (
                <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
                  {key.keyPrefix}…
                </code>
              ) : (
                <span className="text-xs text-slate-600">—</span>
              )}
            </div>

            {/* Last used */}
            <span className="text-xs text-slate-500">
              {key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}
            </span>

            {/* Expires */}
            <span
              className={cn(
                'text-xs',
                key.expiresAt && new Date(key.expiresAt) < new Date()
                  ? 'text-red-400'
                  : 'text-slate-500'
              )}
            >
              {key.expiresAt ? formatDate(key.expiresAt) : 'Never'}
            </span>

            {/* Delete */}
            <button
              onClick={() => onDelete(key.id)}
              disabled={deletingId === key.id}
              title="Revoke key"
              className="rounded-md p-1.5 text-slate-600 transition-colors hover:bg-red-950/30 hover:text-red-400 disabled:pointer-events-none disabled:opacity-40"
            >
              {deletingId === key.id ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Fetch keys on mount
  useEffect(() => {
    setLoading(true)
    setFetchError('')
    api
      .get<ApiKeysResponse>('/users/api-keys')
      .then(({ data }) => {
        setKeys(data.apiKeys ?? [])
      })
      .catch(() => {
        setFetchError('Failed to load API keys. Please try again.')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  function handleCreated(key: CreatedKey) {
    // Prepend new key stub to table (without the full secret)
    const stub: ApiKey = {
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix ?? null,
      maxClearanceRank: key.maxClearanceRank,
      maxClearanceLevel: key.maxClearanceLevel ?? null,
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    }
    setKeys((prev) => [stub, ...prev])
    setCreatedKey(key)
    // Scroll to top of page to show reveal box
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await api.delete(`/users/api-keys/${id}`)
      setKeys((prev) => prev.filter((k) => k.id !== id))
    } catch {
      // silently ignore — key stays visible so user can retry
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8">
      <div className="mx-auto max-w-4xl space-y-7">

        {/* ── Page header ────────────────────────────────────────────── */}
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10">
            <Shield size={22} className="text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-100">API Keys</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              API keys authenticate CLI and automation access.{' '}
              Each key's clearance level caps what data it can see.
            </p>
          </div>
        </div>

        {/* ── One-time key reveal (shown immediately after creation) ── */}
        {createdKey && (
          <KeyRevealBox
            createdKey={createdKey}
            onDismiss={() => setCreatedKey(null)}
          />
        )}

        {/* ── Create form ─────────────────────────────────────────────── */}
        <CreateForm onCreated={handleCreated} />

        {/* ── Keys list ───────────────────────────────────────────────── */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300">
              Your keys
              {!loading && keys.length > 0 && (
                <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-normal text-slate-500">
                  {keys.length}
                </span>
              )}
            </h2>
            {/* Clearance legend */}
            <div className="hidden items-center gap-3 sm:flex">
              {CLEARANCE_LEVELS.map((c) => (
                <span
                  key={c.rank}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[9px] font-bold tracking-wider',
                    c.badgeClass
                  )}
                >
                  {c.label}
                </span>
              ))}
            </div>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-slate-500" />
            </div>
          )}

          {/* Error state */}
          {!loading && fetchError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-800/40 bg-red-950/20 px-4 py-3">
              <AlertTriangle size={14} className="text-red-400" />
              <p className="text-xs text-red-400">{fetchError}</p>
            </div>
          )}

          {/* Table */}
          {!loading && !fetchError && (
            <KeysTable
              keys={keys}
              onDelete={(id) => void handleDelete(id)}
              deletingId={deletingId}
            />
          )}
        </section>
      </div>
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import {
  BookMarked,
  Loader2,
  Trash2,
  ChevronDown,
  ChevronUp,
  Plus,
  HardDrive,
  FolderOpen,
  Server,
  Globe,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  addLocalVault,
  listLocalVaults,
  deleteLocalVault,
  pickDirectory,
  supportsLocalVaults,
  type LocalVault,
} from '@/lib/localVaults'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ServerVault {
  id: string
  label: string
  vault_url: string
  is_active: boolean
  last_sync_at: string | null
  kind?: string
  folder_path?: string | null
}

type VaultKind = 'local' | 'folder' | 'rest'

interface UnifiedVault {
  id: string
  label: string
  kind: VaultKind
  detail: string // path / url / "Stored in this browser"
}

const KIND_META: Record<VaultKind, { label: string; icon: typeof HardDrive; badge: string }> = {
  local: { label: 'Local drive', icon: HardDrive, badge: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30' },
  folder: { label: 'Server folder', icon: Server, badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  rest: { label: 'REST API', icon: Globe, badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Reusable Obsidian vault manager: a unified list of vaults (local / server
 * folder / REST) plus three collapsed "Add" options. Rendered both on the
 * dedicated Obsidian page and inside Settings → Integrations. Self-contained:
 * loads its own data.
 */
export default function ObsidianVaultManager() {
  const [serverVaults, setServerVaults] = useState<ServerVault[]>([])
  const [localVaults, setLocalVaults] = useState<LocalVault[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // ── Add: local drive / network folder ──
  const [localError, setLocalError] = useState<string | null>(null)
  const [localOpen, setLocalOpen] = useState(false)
  const [addingLocal, setAddingLocal] = useState(false)

  // ── Add: server folder path (mounted) ──
  const [serverOpen, setServerOpen] = useState(false)
  const [serverLabel, setServerLabel] = useState('')
  const [serverPath, setServerPath] = useState('')
  const [addingServer, setAddingServer] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  // ── Add: Obsidian REST API vault (advanced) ──
  const [restOpen, setRestOpen] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newToken, setNewToken] = useState('')
  const [addingRest, setAddingRest] = useState(false)
  const [restError, setRestError] = useState<string | null>(null)

  const loadServerVaults = useCallback(async () => {
    try {
      const { data } = await api.get('/connectors/obsidian/vaults')
      setServerVaults((data.vaults || []) as ServerVault[])
    } catch {
      setServerVaults([])
    }
  }, [])

  const loadLocalVaults = useCallback(async () => {
    try {
      setLocalVaults(await listLocalVaults())
    } catch {
      setLocalVaults([])
    }
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    await Promise.all([loadServerVaults(), loadLocalVaults()])
    setLoading(false)
  }, [loadServerVaults, loadLocalVaults])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // Merge into one unified list.
  const vaults: UnifiedVault[] = [
    ...localVaults.map(
      (v): UnifiedVault => ({ id: v.id, label: v.label, kind: 'local', detail: 'Stored in this browser' })
    ),
    ...serverVaults.map((v): UnifiedVault => {
      const kind: VaultKind = v.kind === 'folder' ? 'folder' : 'rest'
      return {
        id: v.id,
        label: v.label,
        kind,
        detail: kind === 'folder' ? v.folder_path ?? 'server folder' : v.vault_url,
      }
    }),
  ]

  // ── Handlers ──

  const handleAddLocal = async () => {
    setLocalError(null)
    if (!supportsLocalVaults()) {
      setLocalError(
        "Your browser doesn't support persistent local folders — use Chrome or Edge, or add a server folder path / REST API vault instead."
      )
      return
    }
    setAddingLocal(true)
    try {
      const handle = await pickDirectory()
      if (!handle) return // cancelled
      const label = window.prompt('Name this vault', handle.name) ?? handle.name
      await addLocalVault(label, handle)
      await loadLocalVaults()
      setLocalOpen(false)
    } catch {
      setLocalError('Could not add that folder. Try again.')
    } finally {
      setAddingLocal(false)
    }
  }

  const handleAddServerVault = async () => {
    if (!serverLabel.trim() || !serverPath.trim()) return
    setAddingServer(true)
    setServerError(null)
    try {
      await api.post('/connectors/obsidian/folder-vaults', {
        label: serverLabel.trim(),
        folderPath: serverPath.trim(),
      })
      setServerLabel('')
      setServerPath('')
      setServerOpen(false)
      await loadServerVaults()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setServerError(e?.response?.data?.error ?? 'Failed to add server vault')
    } finally {
      setAddingServer(false)
    }
  }

  const handleAddRestVault = async () => {
    if (!newLabel.trim() || !newUrl.trim() || !newToken.trim()) return
    setAddingRest(true)
    setRestError(null)
    try {
      await api.post('/connectors/obsidian/vaults', {
        label: newLabel.trim(),
        vaultUrl: newUrl.trim(),
        apiToken: newToken.trim(),
      })
      setNewLabel('')
      setNewUrl('')
      setNewToken('')
      setRestOpen(false)
      await loadServerVaults()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setRestError(e?.response?.data?.error ?? 'Failed to add vault')
    } finally {
      setAddingRest(false)
    }
  }

  const handleDelete = async (vault: UnifiedVault) => {
    setDeletingId(vault.id)
    try {
      if (vault.kind === 'local') {
        await deleteLocalVault(vault.id)
        await loadLocalVaults()
      } else {
        await api.delete(`/connectors/obsidian/vaults/${vault.id}`)
        await loadServerVaults()
      }
    } catch {
      /* ignore */
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 size={18} className="animate-spin text-slate-500" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Unified vault list */}
      {vaults.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-slate-800 bg-slate-900/50 py-10">
          <BookMarked size={36} className="text-slate-600" />
          <h2 className="mt-3 text-sm font-semibold text-slate-200">No vaults yet</h2>
          <p className="mt-1 text-xs text-slate-500">Add a vault below to start extracting notes in KEX.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 divide-y divide-slate-800/60">
          {vaults.map((v) => {
            const meta = KIND_META[v.kind]
            const Icon = meta.icon
            return (
              <div key={`${v.kind}:${v.id}`} className="flex items-center gap-3 px-4 py-3">
                <Icon size={16} className="shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-slate-200">{v.label}</p>
                    <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium', meta.badge)}>
                      {meta.label}
                    </span>
                  </div>
                  <p className="truncate text-[10px] text-slate-600">{v.detail}</p>
                </div>
                <button
                  onClick={() => void handleDelete(v)}
                  disabled={deletingId === v.id}
                  title="Remove vault"
                  className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800 p-1.5 text-slate-500 hover:border-red-800 hover:text-red-400 disabled:opacity-40 transition-colors"
                >
                  {deletingId === v.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Add vault options (consistent collapsible style) ── */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Add a vault</p>

        {/* 1. Local drive / network folder */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 overflow-hidden">
          <button
            onClick={() => { setLocalOpen((v) => !v); setLocalError(null) }}
            className="flex w-full items-center justify-between px-4 py-2.5 text-xs text-slate-400 hover:bg-slate-800/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              <HardDrive size={12} className="text-indigo-400" /> Local drive / network folder
            </span>
            {localOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {localOpen && (
            <div className="border-t border-slate-800 px-4 py-4 space-y-3">
              <p className="text-[11px] leading-relaxed text-slate-500">
                Stored in this browser; pick the vault folder (a mapped Samba/network drive works too). No upload
                until you extract. Local vaults are read directly by your browser and{' '}
                <span className="text-slate-300">cannot be scheduled</span> — the server can't reach your drive.
                Chrome/Edge only.
              </p>
              {localError && <p className="text-[10px] text-red-400">{localError}</p>}
              <button
                onClick={() => void handleAddLocal()}
                disabled={addingLocal}
                className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {addingLocal ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
                Select vault folder
              </button>
            </div>
          )}
        </div>

        {/* 2. Server folder path (mounted) */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 overflow-hidden">
          <button
            onClick={() => { setServerOpen((v) => !v); setServerError(null) }}
            className="flex w-full items-center justify-between px-4 py-2.5 text-xs text-slate-400 hover:bg-slate-800/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Server size={12} className="text-amber-400" /> Server folder path (mounted)
            </span>
            {serverOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {serverOpen && (
            <div className="border-t border-slate-800 px-4 py-4 space-y-3">
              <p className="text-[11px] leading-relaxed text-slate-500">
                <span className="text-slate-300">For self-hosted / server-side vaults.</span> Point GCTRL at a vault
                directory that is mounted into the GCTRL server (under{' '}
                <code className="text-slate-400">/vaults</code>). The server reads the{' '}
                <code className="text-slate-400">.md</code> files directly from disk — no browser upload, no plugin,
                no token. These vaults <span className="text-slate-300">can be scheduled</span>.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  value={serverLabel}
                  onChange={(e) => setServerLabel(e.target.value)}
                  placeholder="Label (e.g. Server Vault)"
                  className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="text"
                  value={serverPath}
                  onChange={(e) => setServerPath(e.target.value)}
                  placeholder="/vaults/my-vault"
                  className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              {serverError && <p className="text-[10px] text-red-400">{serverError}</p>}
              <button
                onClick={() => void handleAddServerVault()}
                disabled={addingServer || !serverLabel.trim() || !serverPath.trim()}
                className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {addingServer ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Add server vault
              </button>
            </div>
          )}
        </div>

        {/* 3. Obsidian REST API vault (advanced) */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 overflow-hidden">
          <button
            onClick={() => { setRestOpen((v) => !v); setRestError(null) }}
            className="flex w-full items-center justify-between px-4 py-2.5 text-xs text-slate-400 hover:bg-slate-800/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Globe size={12} className="text-violet-400" /> Obsidian REST API vault (Advanced)
            </span>
            {restOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {restOpen && (
            <div className="border-t border-slate-800 px-4 py-4 space-y-3">
              <p className="text-[11px] leading-relaxed text-slate-500">
                Keeps a live link via the Obsidian{' '}
                <a
                  href="https://github.com/coddingtonbear/obsidian-local-rest-api"
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:underline"
                >
                  Local REST API
                </a>{' '}
                plugin. It only works when that plugin is reachable from the GCTRL server (default{' '}
                <code className="text-slate-400">https://127.0.0.1:27124</code>). On a remote/Docker GCTRL it can't
                reach your laptop's Obsidian — use a local or server folder vault there.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Label (e.g. Work Vault)"
                  className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="text"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="Vault URL (e.g. https://127.0.0.1:27124)"
                  className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="password"
                  value={newToken}
                  onChange={(e) => setNewToken(e.target.value)}
                  placeholder="API Token"
                  className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              {restError && <p className="text-[10px] text-red-400">{restError}</p>}
              <button
                onClick={() => void handleAddRestVault()}
                disabled={addingRest || !newLabel.trim() || !newUrl.trim() || !newToken.trim()}
                className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {addingRest ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Add REST vault
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

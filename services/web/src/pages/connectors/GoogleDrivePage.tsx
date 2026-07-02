import { useState, useEffect, useCallback } from 'react'
import {
  FolderOpen,
  File,
  FileText,
  FileSpreadsheet,
  Image,
  ChevronRight,
  Search,
  CheckSquare,
  Square,
  Zap,
  Loader2,
  FolderSync,
  Home,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  size?: string
  webViewLink?: string
  isFolder: boolean
  isExtractable: boolean
}

interface BreadcrumbItem {
  id: string
  name: string
}

interface SyncResult {
  folder?: string
  totalFiles?: number
  synced: number
  failed?: number
  results: Array<{ fileId?: string; name?: string; jobId?: string; error?: string }>
}

interface ConnectorSyncStatus {
  connectorId: string
  provider: string
  label: string
  lastSyncAt?: string | null
  jobCounts?: Record<string, number>
}

/** Compact sync-health badge fed by GET /connectors/sync-status. */
function SyncStatusBadge({ connectorId }: { connectorId: string | null }) {
  const [status, setStatus] = useState<ConnectorSyncStatus | null>(null)

  useEffect(() => {
    if (!connectorId) return
    void (async () => {
      try {
        const { data } = await api.get('/connectors/sync-status')
        const mine = (data.connectors || []).find(
          (c: ConnectorSyncStatus) => c.connectorId === connectorId,
        )
        setStatus(mine ?? null)
      } catch { /* non-fatal */ }
    })()
  }, [connectorId])

  if (!status) return null
  const counts = status.jobCounts ?? {}
  const failedCount = counts['failed'] ?? 0
  const completedCount = counts['completed'] ?? 0
  const lastSync = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'never'
  return (
    <span className="flex items-center gap-2 text-[10px] text-slate-500">
      <span>Last sync: {lastSync}</span>
      {completedCount > 0 && (
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400">
          {completedCount} extracted
        </span>
      )}
      {failedCount > 0 && (
        <span className="rounded-full bg-red-500/10 px-2 py-0.5 font-medium text-red-400">
          {failedCount} failed
        </span>
      )}
    </span>
  )
}

function getFileIcon(mimeType: string, isFolder: boolean) {
  if (isFolder) return FolderOpen
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('word')) return FileText
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return FileSpreadsheet
  if (mimeType.startsWith('image/')) return Image
  return File
}

function formatSize(size?: string): string {
  if (!size) return ''
  const bytes = parseInt(size)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export default function GoogleDrivePage() {
  const [connectorId, setConnectorId] = useState<string | null>(null)
  const [connectors, setConnectors] = useState<Array<{ id: string; providerEmail: string | null; label: string }>>([])
  const [files, setFiles] = useState<DriveFile[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([{ id: 'root', name: 'My Drive' }])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1]?.id || 'root'

  // Load Google connectors
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api.get('/connectors')
        const googleConns = (data.connectors || []).filter((c: { provider: string }) => c.provider === 'google')
        setConnectors(googleConns)
        if (googleConns.length > 0 && !connectorId) setConnectorId(googleConns[0].id)
      } catch { /* ignore */ }
    })()
  }, [])

  // Load files when folder changes
  const loadFiles = useCallback(async () => {
    if (!connectorId) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ connectorId })
      if (currentFolderId !== 'root') params.set('folderId', currentFolderId)
      if (search) params.set('q', search)

      const { data } = await api.get(`/connectors/google/drive/files?${params.toString()}`)
      setFiles(data.files || [])
    } catch (err) {
      console.error('Failed to load Drive files:', err)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [connectorId, currentFolderId, search])

  useEffect(() => { void loadFiles() }, [loadFiles])

  const navigateToFolder = (folderId: string, folderName: string) => {
    setBreadcrumbs((prev) => [...prev, { id: folderId, name: folderName }])
    setSelected(new Set())
    setSyncResult(null)
  }

  const navigateToBreadcrumb = (index: number) => {
    setBreadcrumbs((prev) => prev.slice(0, index + 1))
    setSelected(new Set())
    setSyncResult(null)
  }

  const toggleSelect = (fileId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const selectAllExtractable = () => {
    const extractable = files.filter((f) => f.isExtractable && !f.isFolder).map((f) => f.id)
    setSelected(new Set(extractable))
  }

  const handleSyncSelected = async () => {
    if (!connectorId || selected.size === 0) return
    setSyncing(true)
    setSyncResult(null)
    try {
      const fileIds = Array.from(selected)
      const { data } = await api.post('/connectors/google/drive/sync', { connectorId, fileIds })
      setSyncResult(data)
      setSelected(new Set())
    } catch (err) {
      console.error('Sync failed:', err)
    } finally {
      setSyncing(false)
    }
  }

  const handleSyncFolder = async () => {
    if (!connectorId || currentFolderId === 'root') return
    setSyncing(true)
    setSyncResult(null)
    try {
      const { data } = await api.post('/connectors/google/drive/sync/folder', {
        connectorId,
        folderId: currentFolderId,
        maxDepth: 5,
      })
      setSyncResult(data)
    } catch (err) {
      console.error('Folder sync failed:', err)
    } finally {
      setSyncing(false)
    }
  }

  if (connectors.length === 0) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-center">
          <FolderOpen size={48} className="mx-auto text-slate-600" />
          <h2 className="mt-4 text-lg font-semibold text-slate-200">No Google Account Connected</h2>
          <p className="mt-2 text-sm text-slate-500">
            Go to Settings &gt; Integrations to connect your Google Workspace account.
          </p>
        </div>
      </div>
    )
  }

  const folders = files.filter((f) => f.isFolder)
  const regularFiles = files.filter((f) => !f.isFolder)

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Google Drive</h1>
          <p className="text-xs text-slate-500">
            Browse files and folders. Select files or entire folders to extract knowledge.
          </p>
          <div className="mt-1">
            <SyncStatusBadge connectorId={connectorId} />
          </div>
        </div>
        {connectors.length > 1 && (
          <select
            value={connectorId || ''}
            onChange={(e) => { setConnectorId(e.target.value); setBreadcrumbs([{ id: 'root', name: 'My Drive' }]) }}
            className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300"
          >
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>{c.providerEmail || c.label}</option>
            ))}
          </select>
        )}
      </div>

      {/* Breadcrumbs + Search */}
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs">
          {breadcrumbs.map((crumb, i) => (
            <div key={crumb.id} className="flex shrink-0 items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="text-slate-600" />}
              <button
                onClick={() => navigateToBreadcrumb(i)}
                className={cn(
                  'rounded px-1.5 py-0.5 transition-colors',
                  i === breadcrumbs.length - 1
                    ? 'font-medium text-slate-200'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                )}
              >
                {i === 0 ? <Home size={12} className="inline" /> : null} {crumb.name}
              </button>
            </div>
          ))}
        </div>
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files..."
            className="w-48 rounded border border-slate-700 bg-slate-800 py-1.5 pl-7 pr-3 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-2">
        <div className="flex items-center gap-3">
          <button onClick={selectAllExtractable} className="text-[10px] text-indigo-400 hover:text-indigo-300">
            Select all extractable
          </button>
          {selected.size > 0 && (
            <span className="text-[10px] text-slate-500">{selected.size} selected</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {currentFolderId !== 'root' && (
            <button
              onClick={() => void handleSyncFolder()}
              disabled={syncing}
              className="flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              {syncing ? <Loader2 size={12} className="animate-spin" /> : <FolderSync size={12} />}
              Sync Entire Folder
            </button>
          )}
          <button
            onClick={() => void handleSyncSelected()}
            disabled={syncing || selected.size === 0}
            className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {syncing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            Extract Selected ({selected.size})
          </button>
        </div>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div className={cn(
          'rounded-lg border px-4 py-3 text-xs',
          syncResult.failed
            ? 'border-amber-800/50 bg-amber-950/20 text-amber-300'
            : 'border-emerald-800/50 bg-emerald-950/20 text-emerald-300'
        )}>
          {syncResult.folder
            ? `Folder "${syncResult.folder}": ${syncResult.synced} files sent to KEX${syncResult.failed ? `, ${syncResult.failed} failed` : ''} (${syncResult.totalFiles} total)`
            : `${syncResult.synced} files sent to KEX for extraction`}
        </div>
      )}

      {/* File list */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-slate-500" />
          </div>
        ) : files.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500">
            {search ? 'No files match your search' : 'This folder is empty'}
          </div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {/* Folders first */}
            {folders.map((file) => {
              const Icon = getFileIcon(file.mimeType, true)
              return (
                <button
                  key={file.id}
                  onClick={() => navigateToFolder(file.id, file.name)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-800/50 transition-colors"
                >
                  <Icon size={16} className="shrink-0 text-amber-400" />
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{file.name}</span>
                  <ChevronRight size={14} className="shrink-0 text-slate-600" />
                </button>
              )
            })}
            {/* Files */}
            {regularFiles.map((file) => {
              const Icon = getFileIcon(file.mimeType, false)
              const isSelected = selected.has(file.id)
              return (
                <div
                  key={file.id}
                  onClick={() => file.isExtractable && toggleSelect(file.id)}
                  className={cn(
                    'flex items-center gap-3 px-4 py-2.5 transition-colors',
                    file.isExtractable ? 'cursor-pointer hover:bg-slate-800/50' : 'opacity-40',
                    isSelected && 'bg-indigo-950/30'
                  )}
                >
                  <div className="shrink-0">
                    {file.isExtractable ? (
                      isSelected ? <CheckSquare size={14} className="text-indigo-400" /> : <Square size={14} className="text-slate-600" />
                    ) : (
                      <div className="h-3.5 w-3.5" />
                    )}
                  </div>
                  <Icon size={16} className={cn('shrink-0', file.isExtractable ? 'text-slate-400' : 'text-slate-700')} />
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-300">{file.name}</span>
                  <span className="shrink-0 text-[10px] text-slate-600">{formatSize(file.size)}</span>
                  <span className="shrink-0 text-[10px] text-slate-600">
                    {new Date(file.modifiedTime).toLocaleDateString()}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

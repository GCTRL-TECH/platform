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
  Home,
  Building2,
  Globe,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface TenantConfig {
  id: string
  tenant_id: string
  tenant_name: string
  sharepoint_root_url: string
}

interface SharePointSite {
  id: string
  name: string
  webUrl: string
}

interface SharePointFile {
  id: string
  name: string
  mimeType: string
  size?: number
  lastModifiedDateTime: string
  isFolder: boolean
  isExtractable: boolean
  driveId: string
}

interface BreadcrumbItem {
  id: string
  name: string
  driveId: string
}

interface SyncResult {
  synced: number
  failed: number
  results: Array<{ fileId?: string; name?: string; jobId?: string; error?: string }>
}

function getFileIcon(mimeType: string, isFolder: boolean) {
  if (isFolder) return FolderOpen
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('word')) return FileText
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return FileSpreadsheet
  if (mimeType.startsWith('image/')) return Image
  return File
}

function formatSize(size?: number): string {
  if (size === undefined || size === null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export default function SharePointPage() {
  const [tenants, setTenants] = useState<TenantConfig[]>([])
  const [tenantConfigId, setTenantConfigId] = useState<string | null>(null)
  const [sites, setSites] = useState<SharePointSite[]>([])
  const [selectedSite, setSelectedSite] = useState<SharePointSite | null>(null)
  const [files, setFiles] = useState<SharePointFile[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingSites, setLoadingSites] = useState(false)
  const [search, setSearch] = useState('')
  // breadcrumbs start after a site is entered; first crumb is site root
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)

  // Load tenants on mount
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api.get('/connectors/microsoft/sharepoint/tenants')
        const list: TenantConfig[] = data.tenants || []
        setTenants(list)
        if (list.length > 0) setTenantConfigId(list[0].id)
      } catch {
        /* ignore */
      }
    })()
  }, [])

  // Load sites when tenant changes
  useEffect(() => {
    if (!tenantConfigId) return
    setSelectedSite(null)
    setBreadcrumbs([])
    setFiles([])
    setSelected(new Set())
    setSyncResult(null)
    setLoadingSites(true)
    void (async () => {
      try {
        const { data } = await api.get(`/connectors/microsoft/sharepoint/sites?tenantConfigId=${tenantConfigId}`)
        setSites(data.sites || [])
      } catch {
        setSites([])
      } finally {
        setLoadingSites(false)
      }
    })()
  }, [tenantConfigId])

  const currentBreadcrumb = breadcrumbs[breadcrumbs.length - 1]

  const loadFiles = useCallback(async () => {
    if (!tenantConfigId || !selectedSite || breadcrumbs.length === 0) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ tenantConfigId, siteId: selectedSite.id })
      if (currentBreadcrumb) {
        params.set('driveId', currentBreadcrumb.driveId)
        if (currentBreadcrumb.id !== '__root__') params.set('itemId', currentBreadcrumb.id)
      }
      if (search) params.set('q', search)
      const { data } = await api.get(`/connectors/microsoft/sharepoint/files?${params.toString()}`)
      setFiles(data.files || [])
    } catch {
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [tenantConfigId, selectedSite, breadcrumbs, currentBreadcrumb, search])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const enterSite = (site: SharePointSite) => {
    setSelectedSite(site)
    // The site root uses a sentinel id; actual driveId will come from files response
    setBreadcrumbs([{ id: '__root__', name: site.name, driveId: '' }])
    setSelected(new Set())
    setSyncResult(null)
  }

  const navigateToFolder = (folderId: string, folderName: string, driveId: string) => {
    setBreadcrumbs((prev) => [...prev, { id: folderId, name: folderName, driveId }])
    setSelected(new Set())
    setSyncResult(null)
  }

  const navigateToBreadcrumb = (index: number) => {
    setBreadcrumbs((prev) => prev.slice(0, index + 1))
    setSelected(new Set())
    setSyncResult(null)
  }

  const backToSites = () => {
    setSelectedSite(null)
    setBreadcrumbs([])
    setFiles([])
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
    if (!tenantConfigId || !selectedSite || selected.size === 0 || !currentBreadcrumb) return
    setSyncing(true)
    setSyncResult(null)
    try {
      const fileIds = Array.from(selected)
      const { data } = await api.post('/connectors/microsoft/sharepoint/sync', {
        tenantConfigId,
        siteId: selectedSite.id,
        driveId: currentBreadcrumb.driveId,
        fileIds,
      })
      setSyncResult(data as SyncResult)
      setSelected(new Set())
    } catch {
      /* ignore */
    } finally {
      setSyncing(false)
    }
  }

  // No tenants configured
  if (tenants.length === 0) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-center">
          <Building2 size={48} className="mx-auto text-slate-600" />
          <h2 className="mt-4 text-lg font-semibold text-slate-200">No SharePoint Tenant Configured</h2>
          <p className="mt-2 text-sm text-slate-500">
            Go to Settings &gt; Integrations to add a Microsoft SharePoint tenant.
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
          <h1 className="text-xl font-bold text-slate-100">Microsoft SharePoint</h1>
          <p className="text-xs text-slate-500">
            Browse sites and files. Select files to extract knowledge into GCTRL.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-slate-500" />
          <select
            value={tenantConfigId || ''}
            onChange={(e) => setTenantConfigId(e.target.value)}
            className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 focus:border-indigo-500 focus:outline-none"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.tenant_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Site list view */}
      {!selectedSite && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 overflow-hidden">
          {loadingSites ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-slate-500" />
            </div>
          ) : sites.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-500">
              No SharePoint sites found for this tenant.
            </div>
          ) : (
            <div className="divide-y divide-slate-800/50">
              <div className="px-4 py-2.5">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  {sites.length} site{sites.length !== 1 ? 's' : ''}
                </p>
              </div>
              {sites.map((site) => (
                <button
                  key={site.id}
                  onClick={() => enterSite(site)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/50 transition-colors"
                >
                  <Building2 size={16} className="shrink-0 text-blue-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-200">{site.name}</p>
                    <p className="truncate text-[10px] text-slate-500">{site.webUrl}</p>
                  </div>
                  <ChevronRight size={14} className="shrink-0 text-slate-600" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* File browser view (inside a site) */}
      {selectedSite && (
        <>
          {/* Breadcrumbs + Search */}
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs">
              <button
                onClick={backToSites}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
              >
                <Home size={12} className="inline" /> Sites
              </button>
              {breadcrumbs.map((crumb, i) => (
                <div key={`${crumb.id}-${i}`} className="flex shrink-0 items-center gap-1">
                  <ChevronRight size={12} className="text-slate-600" />
                  <button
                    onClick={() => navigateToBreadcrumb(i)}
                    className={cn(
                      'rounded px-1.5 py-0.5 transition-colors',
                      i === breadcrumbs.length - 1
                        ? 'font-medium text-slate-200'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                    )}
                  >
                    {crumb.name}
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
              <button
                onClick={selectAllExtractable}
                className="text-[10px] text-indigo-400 hover:text-indigo-300"
              >
                Select all extractable
              </button>
              {selected.size > 0 && (
                <span className="text-[10px] text-slate-500">{selected.size} selected</span>
              )}
            </div>
            <button
              onClick={() => void handleSyncSelected()}
              disabled={syncing || selected.size === 0}
              className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {syncing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              Extract Selected ({selected.size})
            </button>
          </div>

          {/* Sync result banner */}
          {syncResult && (
            <div
              className={cn(
                'rounded-lg border px-4 py-3 text-xs',
                syncResult.failed > 0
                  ? 'border-amber-800/50 bg-amber-950/20 text-amber-300'
                  : 'border-emerald-800/50 bg-emerald-950/20 text-emerald-300'
              )}
            >
              {syncResult.synced} file{syncResult.synced !== 1 ? 's' : ''} sent to KEX for extraction
              {syncResult.failed > 0 ? `, ${syncResult.failed} failed` : ''}
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
                      onClick={() => navigateToFolder(file.id, file.name, file.driveId)}
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
                          isSelected ? (
                            <CheckSquare size={14} className="text-indigo-400" />
                          ) : (
                            <Square size={14} className="text-slate-600" />
                          )
                        ) : (
                          <div className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <Icon
                        size={16}
                        className={cn('shrink-0', file.isExtractable ? 'text-slate-400' : 'text-slate-700')}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-300">{file.name}</span>
                      <span className="shrink-0 text-[10px] text-slate-600">{formatSize(file.size)}</span>
                      <span className="shrink-0 text-[10px] text-slate-600">
                        {new Date(file.lastModifiedDateTime).toLocaleDateString()}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

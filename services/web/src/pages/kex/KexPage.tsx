import { useState, useCallback, useEffect } from 'react'
import { useDropzone } from 'react-dropzone'
import {
  Upload,
  Link as LinkIcon,
  FileText,
  Zap,
  AlertCircle,
  Info,
  File,
  X,
  Coins,
  ChevronDown,
  Plug,
  FolderOpen,
  FileSpreadsheet,
  Image,
  ChevronRight,
  Search,
  CheckSquare,
  Square,
  Loader2,
  Home,
  Timer,
  type LucideIcon,
} from 'lucide-react'
import { useApiQuery, useApiMutation, useUploadMutation } from '@/hooks/useApi'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { ExtractionsTable } from './components/ExtractionsTable'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtractResponse { jobId: string; status: string }

interface OntologyOption {
  id: string
  name: string
  scope: 'private' | 'shared' | 'public'
  entityTypeCount: number
}

interface OntologiesResponse { ontologies: OntologyOption[] }

type Tab = 'sources' | 'upload' | 'text' | 'url'

const ACCEPTED_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/csv': ['.csv'],
  'application/json': ['.json'],
  'application/xml': ['.xml'],
  'text/xml': ['.xml'],
  'text/plain': ['.txt'],
}

// ─── Component ───────────────────────────────────────────────────────────────

export function KexPage() {
  const { user } = useAuth()

  // Form state
  const [activeTab, setActiveTab] = useState<Tab>('sources')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [statusInfo, setStatusInfo] = useState<string | null>(null)
  const [selectedOntologyId, setSelectedOntologyId] = useState<string | null>(null)
  const [discoveryMode, setDiscoveryMode] = useState<'strict' | 'discover'>('discover')
  const [triggerMode, setTriggerMode] = useState<'none' | 'cron' | 'heartbeat'>('none')
  const [triggerCron, setTriggerCron] = useState('0 */6 * * *')
  const [autoFuseTarget, setAutoFuseTarget] = useState<string | null>(null)
  const [forceSingleGraphs, setForceSingleGraphs] = useState(false)
  const [refetchKey, setRefetchKey] = useState(0)

  // Connected sources state
  const [connectedSources, setConnectedSources] = useState<Array<{ id: string; provider: string; label: string; providerEmail: string | null }>>([])
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [driveFiles, setDriveFiles] = useState<Array<{ id: string; name: string; mimeType: string; modifiedTime: string; size?: string; isFolder: boolean; isExtractable: boolean }>>([])
  const [driveBreadcrumbs, setDriveBreadcrumbs] = useState<Array<{ id: string; name: string }>>([{ id: 'root', name: 'My Drive' }])
  const [driveSearch, setDriveSearch] = useState('')
  const [driveSelected, setDriveSelected] = useState<Set<string>>(new Set())
  const [driveLoading, setDriveLoading] = useState(false)
  const [driveSyncing, setDriveSyncing] = useState(false)
  // driveSyncResult state removed — info now shown via statusInfo bar

  // Ontologies
  const { data: ontologiesData } = useApiQuery<OntologiesResponse>(['ontologies'], '/ontologies')
  const ontologies = ontologiesData?.ontologies ?? []

  // Compilations for Auto-FUSE dropdown
  const { data: compilationsData } = useApiQuery<{ compilations: Array<{ id: string; name: string; nodeCount: number }> }>(['compilations'], '/kg/compilations')
  const compilationsList = compilationsData?.compilations ?? []

  useEffect(() => {
    if (user?.defaultOntologyId && !selectedOntologyId) setSelectedOntologyId(user.defaultOntologyId)
  }, [user?.defaultOntologyId])

  // Load connected sources
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api.get('/connectors')
        setConnectedSources(data.connectors || [])
      } catch { /* ignore */ }
    })()
  }, [])

  // Sources tab always available (web crawler works without OAuth)

  // Load drive files
  const currentDriveFolderId = driveBreadcrumbs[driveBreadcrumbs.length - 1]?.id || 'root'
  useEffect(() => {
    if (!selectedSource || selectedProvider !== 'google') return
    void (async () => {
      setDriveLoading(true)
      try {
        const params = new URLSearchParams({ connectorId: selectedSource })
        if (currentDriveFolderId !== 'root') params.set('folderId', currentDriveFolderId)
        if (driveSearch) params.set('q', driveSearch)
        const { data } = await api.get(`/connectors/google/drive/files?${params}`)
        setDriveFiles(data.files || [])
      } catch { setDriveFiles([]) }
      finally { setDriveLoading(false) }
    })()
  }, [selectedSource, selectedProvider, currentDriveFolderId, driveSearch])

  // Mutations
  const uploadMutation = useUploadMutation<ExtractResponse>('/kex/upload', {
    onSuccess: () => { setRefetchKey((k) => k + 1); setSelectedFile(null); setSubmitError(null) },
    onError: (err) => { setSubmitError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Upload failed') },
  })
  const extractMutation = useApiMutation<ExtractResponse>('/kex/extract', 'POST', {
    onSuccess: () => { setRefetchKey((k) => k + 1); setUrl(''); setText(''); setSubmitError(null) },
    onError: (err) => { setSubmitError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Extraction failed') },
  })

  // Create trigger if user set one — checks for duplicates first
  const maybeCreateTrigger = async (sourceName: string, config: Record<string, unknown>) => {
    if (triggerMode === 'none') return
    try {
      // Check if a trigger for this source already exists
      const { data: existing } = await api.get('/triggers')
      const triggers = (existing.triggers || []) as Array<{ name: string; config: Record<string, unknown> }>
      const duplicate = triggers.find((t) => {
        const tc = t.config || {}
        return tc.connectorId === config.connectorId && tc.folderId === config.folderId
      })
      if (duplicate) {
        setStatusInfo(`A trigger for this source already exists ("${duplicate.name}"). Go to Triggers to edit it.`)
        setTriggerMode('none')
        return
      }

      await api.post('/triggers', {
        name: sourceName,
        module: 'kex',
        type: triggerMode === 'cron' ? 'cron' : 'change_detection',
        cronSchedule: triggerMode === 'cron' ? triggerCron : '* * * * *',
        config: { ...config, ontologyId: selectedOntologyId || undefined, discoveryMode, compilationId: autoFuseTarget || undefined, forceSingleGraphs: forceSingleGraphs || undefined },
      })
      setTriggerMode('none')
      setStatusInfo(`Trigger "${sourceName}" created. Manage it on the Triggers page.`)
    } catch { /* non-fatal — extraction already happened */ }
  }

  // Drive handlers
  const handleDriveExtractSelected = async () => {
    if (!selectedSource || driveSelected.size === 0) return
    setDriveSyncing(true); ; setSubmitError(null)
    try {
      const { data } = await api.post('/connectors/google/drive/sync', {
        connectorId: selectedSource, fileIds: Array.from(driveSelected),
        ontologyId: selectedOntologyId || undefined, discoveryMode,
        compilationId: autoFuseTarget || undefined, forceSingleGraphs: forceSingleGraphs || undefined,
      })
      setDriveSelected(new Set()); setRefetchKey((k) => k + 1)
      // Show status info
      if (data.synced > 0) setStatusInfo(`${data.synced} file${data.synced > 1 ? 's' : ''} sent for extraction.`)
      else setStatusInfo('No new or modified files to extract.')
      // Create trigger if set
      const fileCount = data.synced || driveSelected.size
      await maybeCreateTrigger(
        `Google Drive: ${fileCount} file${fileCount > 1 ? 's' : ''}`,
        { connectorId: selectedSource, fileIds: Array.from(driveSelected) },
      )
    } catch (err: unknown) {
      setSubmitError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Sync failed')
    } finally { setDriveSyncing(false) }
  }

  const handleDriveSyncFolder = async () => {
    if (!selectedSource || currentDriveFolderId === 'root') return
    setDriveSyncing(true); ; setSubmitError(null)
    try {
      const { data } = await api.post('/connectors/google/drive/sync/folder', {
        connectorId: selectedSource, folderId: currentDriveFolderId, maxDepth: 5,
        ontologyId: selectedOntologyId || undefined, discoveryMode,
        compilationId: autoFuseTarget || undefined, forceSingleGraphs: forceSingleGraphs || undefined,
      })
      setRefetchKey((k) => k + 1)
      // Check if a trigger already exists for this folder
      let triggerHint = ''
      try {
        const { data: tData } = await api.get('/triggers')
        const existing = ((tData.triggers || []) as Array<{ name: string; config: Record<string, unknown> }>).find(
          (t) => t.config?.connectorId === selectedSource && t.config?.folderId === currentDriveFolderId
        )
        if (existing) triggerHint = ` A trigger "${existing.name}" is monitoring this folder — changes will be picked up automatically.`
      } catch { /* non-fatal */ }

      // Show status info
      const skipped = data.skipped || 0
      if (data.synced > 0 && skipped > 0) setStatusInfo(`${data.synced} new/modified file${data.synced > 1 ? 's' : ''} sent for extraction. ${skipped} unchanged skipped.${triggerHint}`)
      else if (data.synced > 0) setStatusInfo(`${data.synced} file${data.synced > 1 ? 's' : ''} sent for extraction.${triggerHint}`)
      else setStatusInfo(`No new or modified files found. ${skipped} file${skipped > 1 ? 's' : ''} already up to date.${triggerHint}`)
      // Create trigger if set
      const folderName = driveBreadcrumbs[driveBreadcrumbs.length - 1]?.name || 'folder'
      await maybeCreateTrigger(
        `Google Drive: ${folderName}/`,
        { connectorId: selectedSource, folderId: currentDriveFolderId },
      )
    } catch (err: unknown) {
      setSubmitError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Folder sync failed')
    } finally { setDriveSyncing(false) }
  }

  // Dropzone
  const onDrop = useCallback((accepted: File[]) => { if (accepted[0]) setSelectedFile(accepted[0]) }, [])
  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({ onDrop, accept: ACCEPTED_TYPES, maxFiles: 1 })

  // Submit
  const isSubmitting = uploadMutation.isPending || extractMutation.isPending || driveSyncing

  function handleSubmit() {
    setSubmitError(null)
    setStatusInfo(null)
    if (activeTab === 'upload' && selectedFile) {
      const fd = new FormData(); fd.append('file', selectedFile)
      if (selectedOntologyId) { fd.append('ontologyId', selectedOntologyId); fd.append('discoveryMode', discoveryMode) }
      uploadMutation.mutate(fd)
    } else if (activeTab === 'url' && url) {
      extractMutation.mutate({ data: { text: url, ontologyId: selectedOntologyId || undefined, discoveryMode } })
    } else if (activeTab === 'text' && text) {
      extractMutation.mutate({ data: { text, ontologyId: selectedOntologyId || undefined, discoveryMode } })
    } else if (activeTab === 'sources' && driveSelected.size > 0) {
      void handleDriveExtractSelected()
    } else if (activeTab === 'sources' && driveSelected.size === 0 && currentDriveFolderId !== 'root') {
      void handleDriveSyncFolder()
    } else if (activeTab === 'sources' && selectedProvider === 'webcrawler' && url.trim()) {
      // Web crawler extraction
      void (async () => {
        setDriveSyncing(true); setSubmitError(null)
        try {
          let crawlUrl = url.trim()
          if (crawlUrl && !crawlUrl.startsWith('http')) crawlUrl = `https://${crawlUrl}`
          const { data } = await api.post('/crawler/crawl', {
            url: crawlUrl, maxDepth: 3, maxPages: 50,
            ontologyId: selectedOntologyId || undefined, discoveryMode,
            compilationId: autoFuseTarget || undefined,
          })
          setStatusInfo(`Crawled ${data.extracted || 0} pages from ${url}. Check Your Extractions.`)
          setUrl('')
          setRefetchKey((k) => k + 1)
        } catch (err: unknown) {
          const errMsg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Crawl failed'
          setSubmitError(errMsg.includes('valid URL') ? 'Please enter a valid URL (e.g. https://example.com)' : errMsg)
        } finally { setDriveSyncing(false) }
      })()
    }
  }

  // Contextual button label
  function getButtonLabel(): string {
    if (isSubmitting) return 'Extracting...'
    if (activeTab === 'sources') {
      if (selectedProvider === 'webcrawler') return url.trim() ? 'Crawl & Extract Website' : 'Enter a URL to crawl'
      if (driveSelected.size === 1) return 'Extract Knowledge from File'
      if (driveSelected.size > 1) return `Extract Knowledge from ${driveSelected.size} Files`
      if (currentDriveFolderId !== 'root') return 'Extract Knowledge from Folder'
      return 'Select a source'
    }
    if (activeTab === 'upload') return 'Extract Knowledge from File'
    if (activeTab === 'text') return 'Extract Knowledge from Text'
    if (activeTab === 'url') return 'Extract Knowledge from URL'
    return 'Extract Knowledge'
  }

  const canSubmit =
    (activeTab === 'upload' && !!selectedFile) ||
    (activeTab === 'url' && !!url.trim()) ||
    (activeTab === 'text' && !!text.trim()) ||
    (activeTab === 'sources' && (driveSelected.size > 0 || currentDriveFolderId !== 'root' || (selectedProvider === 'webcrawler' && !!url.trim())))

  const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
    { id: 'sources' as Tab, label: 'Sources', icon: Plug },
    { id: 'upload', label: 'Upload File', icon: Upload },
    { id: 'text', label: 'Paste Text', icon: FileText },
    { id: 'url', label: 'Enter URL', icon: LinkIcon },
  ]

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Extraction card */}
      <div className="card">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Knowledge Extraction</h2>
            <p className="mt-0.5 text-xs text-slate-500">Extract structured knowledge from any source.</p>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1 text-[10px] text-amber-400">
            <Coins size={11} />
            <span>5 tokens/extract</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-lg bg-slate-800/50 p-1">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === tab.id ? 'bg-slate-700 text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-300'
                )}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* ── Tab: Upload ──────────────────────────────── */}
        {activeTab === 'upload' && (
          <div className="space-y-3">
            <div {...getRootProps()} className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 transition-colors', isDragActive ? 'border-blue-500 bg-blue-500/5' : 'border-slate-700 bg-slate-800/30 hover:border-slate-600')}>
              <input {...getInputProps()} />
              <Upload size={20} className={isDragActive ? 'text-blue-400' : 'text-slate-400'} />
              <p className="text-xs text-slate-400">{isDragActive ? 'Drop here' : 'Drag & drop or click — PDF, DOCX, CSV, JSON, XML, TXT'}</p>
            </div>
            {fileRejections.length > 0 && <p className="text-xs text-red-400">{fileRejections[0]?.errors[0]?.message}</p>}
            {selectedFile && (
              <div className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2">
                <File size={14} className="text-blue-400" />
                <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{selectedFile.name}</span>
                <span className="text-[10px] text-slate-500">{(selectedFile.size / 1024).toFixed(1)} KB</span>
                <button onClick={() => setSelectedFile(null)} className="text-slate-600 hover:text-slate-400"><X size={13} /></button>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Text ────────────────────────────────── */}
        {activeTab === 'text' && (
          <div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} className="input-field resize-none font-mono text-xs leading-relaxed" placeholder="Paste your text content here..." autoFocus />
            <p className="mt-1 text-right text-[10px] text-slate-600">{text.length.toLocaleString()} chars</p>
          </div>
        )}

        {/* ── Tab: URL ─────────────────────────────────── */}
        {activeTab === 'url' && (
          <div>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} className="input-field" placeholder="https://example.com/document" autoFocus />
            <p className="mt-1 text-[10px] text-slate-600">Public URLs only — we'll fetch and process the page content.</p>
          </div>
        )}

        {/* ── Tab: Connected Sources ───────────────────── */}
        {activeTab === 'sources' && (
          <div className="space-y-2">
            {!selectedSource ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {/* OAuth connected accounts */}
                {connectedSources.map((src) => (
                  <button key={src.id} onClick={() => { setSelectedSource(src.id); setSelectedProvider(src.provider); setDriveBreadcrumbs([{ id: 'root', name: 'My Drive' }]); setDriveSelected(new Set());  }}
                    className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2.5 text-left hover:border-slate-600 transition-colors">
                    <Plug size={13} className="text-slate-400" />
                    <div>
                      <p className="text-xs font-medium text-slate-200 capitalize">{src.provider === 'google' ? 'Google Drive' : src.provider}</p>
                      <p className="text-[10px] text-slate-500">{src.providerEmail || src.label}</p>
                    </div>
                  </button>
                ))}
                {/* Built-in sources (no OAuth needed) */}
                <button onClick={() => { setSelectedSource('webcrawler'); setSelectedProvider('webcrawler') }}
                  className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2.5 text-left hover:border-slate-600 transition-colors">
                  <Search size={13} className="text-indigo-400" />
                  <div>
                    <p className="text-xs font-medium text-slate-200">Crawl a Website</p>
                    <p className="text-[10px] text-slate-500">Extract from any URL recursively</p>
                  </div>
                </button>
              </div>
            ) : selectedProvider === 'webcrawler' ? (
              /* ── Web Crawler inline form ─────────────── */
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => { setSelectedSource(null); setSelectedProvider(null) }} className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"><X size={12} /></button>
                  <span className="text-xs font-medium text-slate-200">Crawl a Website</span>
                </div>
                <div>
                  <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none" placeholder="https://example.com" autoFocus />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-[10px] text-slate-500">Max Depth</label>
                    <input type="number" min={1} max={10} defaultValue={3} className="mt-0.5 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 focus:border-indigo-500 focus:outline-none" />
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-slate-500">Max Pages</label>
                    <input type="number" min={1} max={200} defaultValue={50} className="mt-0.5 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 focus:border-indigo-500 focus:outline-none" />
                  </div>
                </div>
                <p className="text-[10px] text-slate-600">Crawls the site recursively, extracts text from each page, and creates a batch extraction.</p>
              </div>
            ) : selectedProvider === 'google' ? (
              <div className="space-y-2">
                {/* Breadcrumbs + search */}
                <div className="flex items-center gap-2">
                  <button onClick={() => { setSelectedSource(null); setSelectedProvider(null) }} className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"><X size={12} /></button>
                  <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[11px]">
                    {driveBreadcrumbs.map((crumb, i) => (
                      <div key={crumb.id} className="flex shrink-0 items-center gap-0.5">
                        {i > 0 && <ChevronRight size={9} className="text-slate-600" />}
                        <button onClick={() => { setDriveBreadcrumbs((prev) => prev.slice(0, i + 1)); setDriveSelected(new Set());  }}
                          className={cn('rounded px-1 py-0.5', i === driveBreadcrumbs.length - 1 ? 'font-medium text-slate-200' : 'text-slate-500 hover:text-slate-300')}>
                          {i === 0 ? <Home size={9} className="inline" /> : null} {crumb.name}
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="relative">
                    <Search size={9} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input type="text" value={driveSearch} onChange={(e) => setDriveSearch(e.target.value)} placeholder="Search..." className="w-32 rounded border border-slate-700 bg-slate-800 py-1 pl-5 pr-2 text-[10px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none" />
                  </div>
                </div>

                {/* Select all */}
                <div className="flex items-center gap-2">
                  <button onClick={() => { const ext = driveFiles.filter((f) => f.isExtractable && !f.isFolder).map((f) => f.id); setDriveSelected(new Set(ext)) }} className="text-[10px] text-indigo-400 hover:text-indigo-300">Select all</button>
                  {driveSelected.size > 0 && <span className="text-[10px] text-slate-500">{driveSelected.size} selected</span>}
                </div>

                {/* Sync result */}
                {/* Sync result moved to statusInfo bar below */}

                {/* File list */}
                <div className="max-h-52 overflow-y-auto rounded border border-slate-800">
                  {driveLoading ? (
                    <div className="flex items-center justify-center py-6"><Loader2 size={14} className="animate-spin text-slate-500" /></div>
                  ) : driveFiles.length === 0 ? (
                    <p className="py-4 text-center text-[10px] text-slate-500">{driveSearch ? 'No matches' : 'Empty folder'}</p>
                  ) : (
                    <div className="divide-y divide-slate-800/50">
                      {driveFiles.filter((f) => f.isFolder).map((f) => (
                        <button key={f.id} onClick={() => { setDriveBreadcrumbs((prev) => [...prev, { id: f.id, name: f.name }]); setDriveSelected(new Set());  }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-800/50">
                          <FolderOpen size={12} className="shrink-0 text-amber-400" />
                          <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200">{f.name}</span>
                          <ChevronRight size={10} className="shrink-0 text-slate-600" />
                        </button>
                      ))}
                      {driveFiles.filter((f) => !f.isFolder).map((f) => {
                        const sel = driveSelected.has(f.id)
                        const Ic = f.mimeType.includes('spreadsheet') || f.mimeType.includes('csv') ? FileSpreadsheet : f.mimeType.startsWith('image/') ? Image : File
                        return (
                          <div key={f.id} onClick={() => f.isExtractable && setDriveSelected((prev) => { const next = new Set(prev); if (next.has(f.id)) next.delete(f.id); else next.add(f.id); return next })} className={cn('flex items-center gap-2 px-3 py-1.5', f.isExtractable ? 'cursor-pointer hover:bg-slate-800/50' : 'opacity-30', sel && 'bg-indigo-950/30')}>
                            {f.isExtractable ? (sel ? <CheckSquare size={11} className="shrink-0 text-indigo-400" /> : <Square size={11} className="shrink-0 text-slate-600" />) : <div className="h-3 w-3" />}
                            <Ic size={11} className="shrink-0 text-slate-400" />
                            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">{f.name}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">Browser for "{selectedProvider}" coming soon.</p>
            )}
          </div>
        )}

        {/* ── Extraction Options ──────────────────────────── */}
        <div className="mt-4 border-t border-slate-800 pt-3">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Extraction Options</p>
          <div className="space-y-2">
            {/* Ontology */}
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[11px] text-slate-400">Use Ontology</span>
              <div className="relative">
                <select value={selectedOntologyId || ''} onChange={(e) => setSelectedOntologyId(e.target.value || null)}
                  className="w-44 appearance-none rounded border border-slate-700 bg-slate-800 px-2 py-1 pr-6 text-[10px] text-slate-300 focus:border-indigo-500 focus:outline-none">
                  <option value="">None</option>
                  {ontologies.map((o) => (<option key={o.id} value={o.id}>{o.name} ({o.entityTypeCount})</option>))}
                </select>
                <ChevronDown size={9} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500" />
              </div>
            </div>
            {/* Mode */}
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[11px] text-slate-400">Mode</span>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 rounded bg-slate-800/50 p-0.5">
                  <button onClick={() => setDiscoveryMode('discover')} className={cn('rounded px-2.5 py-1 text-[10px] font-medium transition-colors', discoveryMode === 'discover' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>Discover</button>
                  <button onClick={() => setDiscoveryMode('strict')} className={cn('rounded px-2.5 py-1 text-[10px] font-medium transition-colors', discoveryMode === 'strict' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>Strict</button>
                </div>
                <span className="text-[10px] text-slate-600">
                  {discoveryMode === 'discover'
                    ? 'Extends the ontology with newly discovered entity types'
                    : 'Only extracts entity types defined in the selected ontology'}
                </span>
              </div>
            </div>
            {/* Trigger */}
            <div className="flex items-start gap-3">
              <span className="w-24 shrink-0 pt-1 text-[11px] text-slate-400">Trigger</span>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-0.5 rounded bg-slate-800/50 p-0.5">
                    <button onClick={() => setTriggerMode('none')} className={cn('rounded px-2.5 py-1 text-[10px] font-medium transition-colors', triggerMode === 'none' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>None</button>
                    <button onClick={() => setTriggerMode('cron')} className={cn('rounded px-2.5 py-1 text-[10px] font-medium transition-colors', triggerMode === 'cron' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>Schedule</button>
                    {activeTab === 'sources' && (
                      <button onClick={() => setTriggerMode('heartbeat')} className={cn('rounded px-2.5 py-1 text-[10px] font-medium transition-colors', triggerMode === 'heartbeat' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>On Heartbeat</button>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-600">
                    {triggerMode === 'none' ? 'One-time extraction' : triggerMode === 'cron' ? 'Re-extract on a fixed schedule' : 'Re-checks on every heartbeat tick'}
                  </span>
                </div>
                {triggerMode === 'cron' && (
                  <div className="flex items-center gap-1.5">
                    <Timer size={11} className="text-slate-500" />
                    <select value={triggerCron} onChange={(e) => setTriggerCron(e.target.value)} className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-300">
                      <option value="0 * * * *">Every hour</option>
                      <option value="0 */6 * * *">Every 6 hours</option>
                      <option value="0 0 * * *">Daily (midnight)</option>
                      <option value="0 2 * * *">Daily (2 AM)</option>
                      <option value="0 2 * * 1">Weekly (Mon 2 AM)</option>
                      <option value="*/15 * * * *">Every 15 min</option>
                    </select>
                  </div>
                )}
                {triggerMode === 'heartbeat' && (
                  <p className="text-[10px] text-slate-600">Runs on every heartbeat tick. Only new or modified files are re-extracted. Control the heartbeat interval on the Triggers page.</p>
                )}
              </div>
            </div>
            {/* Auto FUSE */}
            <div className="flex items-start gap-3">
              <span className="w-24 shrink-0 pt-1 text-[11px] text-slate-400">Auto FUSE</span>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <select value={autoFuseTarget || ''} onChange={(e) => { setAutoFuseTarget(e.target.value || null); if (!e.target.value) setForceSingleGraphs(false) }}
                      className="w-48 appearance-none rounded border border-slate-700 bg-slate-800 px-2 py-1 pr-6 text-[10px] text-slate-300 focus:border-indigo-500 focus:outline-none">
                      <option value="">None (standalone graph)</option>
                      {compilationsList.map((c) => (<option key={c.id} value={c.id}>{c.name} ({c.nodeCount} nodes)</option>))}
                    </select>
                    <ChevronDown size={9} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500" />
                  </div>
                  <span className="text-[10px] text-slate-600">
                    {autoFuseTarget ? 'Merge extraction into this graph' : 'Each extraction creates its own graph'}
                  </span>
                </div>
                {autoFuseTarget && (
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={forceSingleGraphs} onChange={(e) => setForceSingleGraphs(e.target.checked)}
                      className="h-3 w-3 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0" />
                    <span className="text-[10px] text-slate-500">Force single graphs — each file gets its own graph instead of merging into one</span>
                  </label>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Error */}
        {submitError && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        {/* Status info */}
        {statusInfo && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-300">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>{statusInfo}</span>
            <button onClick={() => setStatusInfo(null)} className="ml-auto shrink-0 text-indigo-500 hover:text-indigo-300">
              <X size={11} />
            </button>
          </div>
        )}

        {/* Submit button (contextual) */}
        <div className="mt-3 flex justify-end">
          <button onClick={handleSubmit} disabled={!canSubmit || isSubmitting} className="btn-primary">
            {isSubmitting ? (
              <><Loader2 size={14} className="animate-spin" /> {getButtonLabel()}</>
            ) : (
              <><Zap size={14} /> {getButtonLabel()}</>
            )}
          </button>
        </div>
      </div>

      {/* Extractions table (with batches, infinite scroll, search, threads) */}
      <ExtractionsTable refetchKey={refetchKey} />
    </div>
  )
}

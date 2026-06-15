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
  Building2,
  BookMarked,
  HardDrive,
  FolderOpen,
  FileSpreadsheet,
  Image,
  ChevronRight,
  Search,
  CheckSquare,
  Square,
  Check,
  Loader2,
  Home,
  Timer,
  type LucideIcon,
} from 'lucide-react'
import { useApiQuery, useApiMutation, useUploadMutation } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { ExtractionsTable } from './components/ExtractionsTable'
import LocalFolderManager from '@/components/connectors/LocalFolderManager'
import {
  listLocalVaults,
  getLocalVaultHandle,
  listVaultMarkdown,
  ensureReadPermission,
  type LocalVault,
} from '@/lib/localVaults'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtractResponse { jobId: string; status: string }

interface ClassificationLevel {
  id: string
  display_name: string
  name: string
  rank: number
  color: string
  is_system: boolean
}

interface OntologyOption {
  id: string
  name: string
  scope: 'private' | 'shared' | 'public'
  entityTypeCount: number
}

interface OntologiesResponse { ontologies: OntologyOption[] }

type Tab = 'sources' | 'upload' | 'text' | 'url'

// Popular document formats KEX now supports. Keep this list in sync with the
// `accept` string used by plain <input type="file"> pickers and the helper text.
const ACCEPTED_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md', '.markdown'],
  'text/csv': ['.csv'],
  'application/json': ['.json'],
  'text/html': ['.html', '.htm'],
  'application/xml': ['.xml'],
  'text/xml': ['.xml'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'],
  'application/vnd.oasis.opendocument.text': ['.odt'],
  'application/vnd.oasis.opendocument.presentation': ['.odp'],
  'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
}

// ─── Component ───────────────────────────────────────────────────────────────

export function KexPage() {
  const { user } = useAuth()

  // Form state
  const [activeTab, setActiveTab] = useState<Tab>('sources')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  // Per-file upload progress/status, keyed by a stable index within selectedFiles.
  type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error'
  const [fileStatuses, setFileStatuses] = useState<Record<number, { status: FileUploadStatus; error?: string }>>({})
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [statusInfo, setStatusInfo] = useState<string | null>(null)
  const [selectedOntologyId, setSelectedOntologyId] = useState<string | null>(null)
  const [discoveryMode, setDiscoveryMode] = useState<'strict' | 'discover'>('discover')
  const [triggerMode, setTriggerMode] = useState<'none' | 'cron' | 'heartbeat'>('none')
  const [triggerCron, setTriggerCron] = useState('0 */6 * * *')
  const [autoFuseTarget, setAutoFuseTarget] = useState<string | null>(null)
  const [forceSingleGraphs, setForceSingleGraphs] = useState(false)
  const [classificationLevelId, setClassificationLevelId] = useState<string | null>(null)
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

  // ── Obsidian source state ──
  type ObsidianVaultKind = 'local' | 'folder' | 'rest'
  interface ObsidianVaultOption { id: string; label: string; kind: ObsidianVaultKind; detail: string }
  interface ObsidianNote { path: string; name: string }
  const [obsidianVaults, setObsidianVaults] = useState<ObsidianVaultOption[]>([])
  const [obsidianVaultId, setObsidianVaultId] = useState<string | null>(null)
  const [obsidianNotes, setObsidianNotes] = useState<ObsidianNote[]>([])
  const [obsidianSelected, setObsidianSelected] = useState<Set<string>>(new Set())
  const [obsidianSearch, setObsidianSearch] = useState('')
  const [obsidianLoadingNotes, setObsidianLoadingNotes] = useState(false)
  const [obsidianNotesError, setObsidianNotesError] = useState<string | null>(null)
  const [obsidianProgress, setObsidianProgress] = useState<{ done: number; total: number } | null>(null)
  // Local FS directory handles, fetched lazily per vault (not serializable into state cleanly).
  const obsidianLocalMeta = obsidianVaults.find((v) => v.id === obsidianVaultId)
  const selectedObsidianVault = obsidianLocalMeta ?? null
  const obsidianLocalSelected =
    activeTab === 'sources' && selectedProvider === 'obsidian' && selectedObsidianVault?.kind === 'local'

  // Ontologies
  const { data: ontologiesData } = useApiQuery<OntologiesResponse>(['ontologies'], '/ontologies')
  const ontologies = ontologiesData?.ontologies ?? []

  // Compilations for Auto-FUSE dropdown
  const { data: compilationsData } = useApiQuery<{ compilations: Array<{ id: string; name: string; nodeCount: number }> }>(['compilations'], '/kg/compilations')

  // Classification levels for Classification dropdown
  const { data: classificationData } = useApiQuery<{ levels: ClassificationLevel[] }>(['classification', 'levels'], '/classification/levels')
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

  // Load Obsidian vaults (server: rest+folder, plus browser-local).
  const loadObsidianVaults = useCallback(async () => {
    const out: ObsidianVaultOption[] = []
    try {
      const local = await listLocalVaults()
      for (const v of local as LocalVault[]) out.push({ id: v.id, label: v.label, kind: 'local', detail: 'Local drive (this browser)' })
    } catch { /* ignore */ }
    try {
      const { data } = await api.get('/connectors/obsidian/vaults')
      for (const v of (data.vaults || []) as Array<{ id: string; label: string; kind?: string; vault_url: string; folder_path?: string | null }>) {
        const kind: ObsidianVaultKind = v.kind === 'folder' ? 'folder' : 'rest'
        out.push({ id: v.id, label: v.label, kind, detail: kind === 'folder' ? (v.folder_path ?? 'server folder') : v.vault_url })
      }
    } catch { /* ignore */ }
    setObsidianVaults(out)
  }, [])

  useEffect(() => { void loadObsidianVaults() }, [loadObsidianVaults])

  // Local Obsidian vaults can't be cron-triggered — force the trigger off.
  useEffect(() => { if (obsidianLocalSelected && triggerMode !== 'none') setTriggerMode('none') }, [obsidianLocalSelected, triggerMode])

  // List notes when an Obsidian vault is selected.
  useEffect(() => {
    if (selectedProvider !== 'obsidian' || !obsidianVaultId) return
    const vault = obsidianVaults.find((v) => v.id === obsidianVaultId)
    if (!vault) return
    void (async () => {
      setObsidianLoadingNotes(true)
      setObsidianNotesError(null)
      setObsidianSelected(new Set())
      try {
        if (vault.kind === 'local') {
          const handle = await getLocalVaultHandle(vault.id)
          if (!handle) throw new Error('This local vault is no longer available in this browser.')
          const granted = await ensureReadPermission(handle)
          if (!granted) throw new Error('Read permission was denied for this folder.')
          const md = await listVaultMarkdown(handle)
          setObsidianNotes(md.map((m) => ({ path: m.relPath, name: m.name })))
        } else if (vault.kind === 'folder') {
          const { data } = await api.get(`/connectors/obsidian/folder-vaults/${vault.id}/files`)
          setObsidianNotes((data.files || []).map((f: { path: string; basename: string }) => ({ path: f.path, name: f.basename })))
        } else {
          const { data } = await api.get(`/connectors/obsidian/files?vaultId=${vault.id}`)
          setObsidianNotes((data.files || []).map((f: { path: string; basename: string }) => ({ path: f.path, name: f.basename })))
        }
      } catch (err: unknown) {
        setObsidianNotes([])
        setObsidianNotesError(err instanceof Error ? err.message : 'Failed to list notes')
      } finally {
        setObsidianLoadingNotes(false)
      }
    })()
  }, [selectedProvider, obsidianVaultId, obsidianVaults])

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
  const queryClient = useQueryClient()
  const refreshBalance = () => queryClient.invalidateQueries({ queryKey: ['billing', 'balance'] })

  // Retained for type-compat / potential single-file callers; multi-file uploads go
  // through handleMultiUpload (per-file status). uploadMutation.isPending still feeds
  // isSubmitting for any path that uses it.
  const uploadMutation = useUploadMutation<ExtractResponse>('/kex/upload', {
    onSuccess: () => { setRefetchKey((k) => k + 1); setSelectedFiles([]); setSubmitError(null); refreshBalance() },
    onError: (err) => { setSubmitError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Upload failed') },
  })
  const extractMutation = useApiMutation<ExtractResponse>('/kex/extract', 'POST', {
    onSuccess: () => { setRefetchKey((k) => k + 1); setUrl(''); setText(''); setSubmitError(null); refreshBalance() },
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
        classificationLevelId: classificationLevelId || undefined,
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
        classificationLevelId: classificationLevelId || undefined,
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

  // ── Obsidian extraction ──
  const handleObsidianExtract = async () => {
    const vault = obsidianVaults.find((v) => v.id === obsidianVaultId)
    if (!vault || obsidianSelected.size === 0) return
    const paths = Array.from(obsidianSelected)
    setDriveSyncing(true); setSubmitError(null); setStatusInfo(null)
    try {
      if (vault.kind === 'local') {
        // Browser-driven: read each note from the directory handle and POST to /kex/extract.
        const handle = await getLocalVaultHandle(vault.id)
        if (!handle) throw new Error('This local vault is no longer available in this browser.')
        if (!(await ensureReadPermission(handle))) throw new Error('Read permission denied.')
        const byPath = new Map((await listVaultMarkdown(handle)).map((m) => [m.relPath, m]))
        let sent = 0, skipped = 0, done = 0
        setObsidianProgress({ done: 0, total: paths.length })
        const queue = [...paths]
        const worker = async () => {
          for (;;) {
            const p = queue.shift()
            if (!p) break
            const entry = byPath.get(p)
            try {
              if (!entry) { skipped++; continue }
              const file = await entry.fileHandle.getFile()
              const raw = await file.text()
              const body = `# ${entry.name}\n\n${raw}`.trim()
              if (body.replace(/\s+/g, '').length < 10) { skipped++; continue }
              await api.post('/kex/extract', {
                text: body,
                ontologyId: selectedOntologyId || undefined,
                discoveryMode,
                classificationLevelId: classificationLevelId || undefined,
                // Traceable origin: vault label + the note's path within the vault.
                sourceRef: `Obsidian (${vault.label}) / ${p}`,
              })
              sent++
            } catch { skipped++ }
            finally { done++; setObsidianProgress({ done, total: paths.length }) }
          }
        }
        await Promise.all([worker(), worker(), worker()])
        setObsidianProgress(null)
        setObsidianSelected(new Set())
        setRefetchKey((k) => k + 1); refreshBalance()
        setStatusInfo(`${sent} note${sent !== 1 ? 's' : ''} sent for extraction${skipped > 0 ? `, ${skipped} skipped` : ''}. Track them in Your Extractions.`)
        // Local vaults can't be cron-triggered — no maybeCreateTrigger here.
      } else if (vault.kind === 'folder') {
        const { data } = await api.post(`/connectors/obsidian/folder-vaults/${vault.id}/sync`, {
          paths,
          ontologyId: selectedOntologyId || undefined, discoveryMode,
          compilationId: autoFuseTarget || undefined, forceSingleGraphs: forceSingleGraphs || undefined,
          classificationLevelId: classificationLevelId || undefined,
        })
        setObsidianSelected(new Set()); setRefetchKey((k) => k + 1); refreshBalance()
        setStatusInfo(`${data.synced ?? paths.length} note${(data.synced ?? paths.length) !== 1 ? 's' : ''} sent for extraction.`)
        await maybeCreateTrigger(`Obsidian: ${vault.label}`, { vaultId: vault.id, kind: 'folder', paths })
      } else {
        const { data } = await api.post('/connectors/obsidian/sync', {
          vaultId: vault.id, paths,
          ontologyId: selectedOntologyId || undefined, discoveryMode,
          compilationId: autoFuseTarget || undefined, forceSingleGraphs: forceSingleGraphs || undefined,
          classificationLevelId: classificationLevelId || undefined,
        })
        setObsidianSelected(new Set()); setRefetchKey((k) => k + 1); refreshBalance()
        setStatusInfo(`${data.synced ?? paths.length} note${(data.synced ?? paths.length) !== 1 ? 's' : ''} sent for extraction.`)
        await maybeCreateTrigger(`Obsidian: ${vault.label}`, { vaultId: vault.id, kind: 'rest', paths })
      }
    } catch (err: unknown) {
      setObsidianProgress(null)
      setSubmitError(err instanceof Error ? err.message : 'Obsidian extraction failed')
    } finally { setDriveSyncing(false) }
  }

  // Dropzone — accepts multiple files (drag-drop or click). Appends to any already
  // selected, de-duplicating by name+size, and clears stale per-file statuses.
  const onDrop = useCallback((accepted: File[]) => {
    if (!accepted.length) return
    setSelectedFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`))
      const merged = [...prev]
      for (const f of accepted) {
        const key = `${f.name}:${f.size}`
        if (!seen.has(key)) { merged.push(f); seen.add(key) }
      }
      return merged
    })
    setFileStatuses({})
  }, [])
  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({ onDrop, accept: ACCEPTED_TYPES, multiple: true })

  // Submit
  const isSubmitting = uploadMutation.isPending || uploadingFiles || extractMutation.isPending || driveSyncing

  // Upload each selected file independently, tracking per-file status so the user
  // sees which succeeded/failed. One bad file doesn't abort the rest.
  async function handleMultiUpload(files: File[]) {
    setUploadingFiles(true)
    setSubmitError(null)
    setFileStatuses(Object.fromEntries(files.map((_, i) => [i, { status: 'pending' as const }])))
    let anySuccess = false
    let firstError: string | null = null
    const failedIdx: number[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!
      setFileStatuses((prev) => ({ ...prev, [i]: { status: 'uploading' } }))
      try {
        const fd = new FormData()
        fd.append('file', file)
        if (selectedOntologyId) { fd.append('ontologyId', selectedOntologyId); fd.append('discoveryMode', discoveryMode) }
        if (classificationLevelId) fd.append('classificationLevelId', classificationLevelId)
        await api.post('/kex/upload', fd, { headers: { 'Content-Type': undefined } })
        anySuccess = true
        setFileStatuses((prev) => ({ ...prev, [i]: { status: 'done' } }))
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Upload failed'
        firstError ??= msg
        failedIdx.push(i)
        setFileStatuses((prev) => ({ ...prev, [i]: { status: 'error', error: msg } }))
      }
    }
    setUploadingFiles(false)
    if (anySuccess) {
      setRefetchKey((k) => k + 1)
      refreshBalance()
      // Keep only the files that failed (so the user can retry); drop successes.
      setSelectedFiles((prev) => prev.filter((_, i) => failedIdx.includes(i)))
      setFileStatuses({})
    }
    if (firstError && !anySuccess) setSubmitError(firstError)
  }

  function handleSubmit() {
    setSubmitError(null)
    setStatusInfo(null)
    if (activeTab === 'upload' && selectedFiles.length > 0) {
      void handleMultiUpload(selectedFiles)
    } else if (activeTab === 'url' && url) {
      extractMutation.mutate({ data: { text: url, ontologyId: selectedOntologyId || undefined, discoveryMode, classificationLevelId: classificationLevelId || undefined } })
    } else if (activeTab === 'text' && text) {
      extractMutation.mutate({ data: { text, ontologyId: selectedOntologyId || undefined, discoveryMode, classificationLevelId: classificationLevelId || undefined } })
    } else if (activeTab === 'sources' && selectedProvider === 'obsidian' && obsidianSelected.size > 0) {
      void handleObsidianExtract()
    } else if (activeTab === 'sources' && selectedProvider !== 'obsidian' && driveSelected.size > 0) {
      void handleDriveExtractSelected()
    } else if (activeTab === 'sources' && selectedProvider === 'google' && driveSelected.size === 0 && currentDriveFolderId !== 'root') {
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
      if (selectedProvider === 'obsidian') {
        if (obsidianSelected.size === 1) return 'Extract 1 note'
        if (obsidianSelected.size > 1) return `Extract ${obsidianSelected.size} notes`
        return obsidianVaultId ? 'Select notes to extract' : 'Select a vault'
      }
      if (driveSelected.size === 1) return 'Extract Knowledge from File'
      if (driveSelected.size > 1) return `Extract Knowledge from ${driveSelected.size} Files`
      if (currentDriveFolderId !== 'root') return 'Extract Knowledge from Folder'
      return 'Select a source'
    }
    if (activeTab === 'upload') {
      if (selectedFiles.length > 1) return `Extract Knowledge from ${selectedFiles.length} Files`
      return 'Extract Knowledge from File'
    }
    if (activeTab === 'text') return 'Extract Knowledge from Text'
    if (activeTab === 'url') return 'Extract Knowledge from URL'
    return 'Extract Knowledge'
  }

  const canSubmit =
    (activeTab === 'upload' && selectedFiles.length > 0) ||
    (activeTab === 'url' && !!url.trim()) ||
    (activeTab === 'text' && !!text.trim()) ||
    (activeTab === 'sources' && selectedProvider === 'obsidian' && obsidianSelected.size > 0) ||
    (activeTab === 'sources' && selectedProvider !== 'obsidian' && (driveSelected.size > 0 || (selectedProvider === 'google' && currentDriveFolderId !== 'root') || (selectedProvider === 'webcrawler' && !!url.trim())))

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
              <p className="text-xs text-slate-400">{isDragActive ? 'Drop files here' : 'Drag & drop or click — add one or more files'}</p>
              <p className="text-[10px] text-slate-600">PDF, TXT, MD, CSV, JSON, HTML, DOCX, PPTX, XLSX, XLSM, ODT, ODP, ODS</p>
            </div>
            {fileRejections.length > 0 && (
              <p className="text-xs text-red-400">
                {fileRejections[0]?.errors[0]?.message}
                {fileRejections.length > 1 ? ` (+${fileRejections.length - 1} more rejected)` : ''}
              </p>
            )}
            {selectedFiles.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-500">{selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} selected</span>
                  {!uploadingFiles && (
                    <button onClick={() => { setSelectedFiles([]); setFileStatuses({}) }} className="text-[10px] text-slate-500 hover:text-slate-300">Clear all</button>
                  )}
                </div>
                {selectedFiles.map((file, i) => {
                  const st = fileStatuses[i]?.status
                  return (
                    <div key={`${file.name}:${file.size}:${i}`} className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2">
                      {st === 'uploading' ? (
                        <Loader2 size={14} className="shrink-0 animate-spin text-blue-400" />
                      ) : st === 'done' ? (
                        <Check size={14} className="shrink-0 text-emerald-400" />
                      ) : st === 'error' ? (
                        <AlertCircle size={14} className="shrink-0 text-red-400" />
                      ) : (
                        <File size={14} className="shrink-0 text-blue-400" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{file.name}</span>
                      {st === 'error' && fileStatuses[i]?.error && (
                        <span className="max-w-[40%] truncate text-[10px] text-red-400" title={fileStatuses[i]?.error}>{fileStatuses[i]?.error}</span>
                      )}
                      <span className="text-[10px] text-slate-500">{(file.size / 1024).toFixed(1)} KB</span>
                      {!uploadingFiles && (
                        <button
                          onClick={() => {
                            setSelectedFiles((prev) => prev.filter((_, idx) => idx !== i))
                            setFileStatuses({})
                          }}
                          className="text-slate-600 hover:text-slate-400"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  )
                })}
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
                {/* Local Folder — pick folders/files from THIS computer (browser-side) */}
                <button onClick={() => { setSelectedSource('localfolder'); setSelectedProvider('localfolder') }}
                  className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2.5 text-left hover:border-slate-600 transition-colors">
                  <FolderOpen size={13} className="text-cyan-400" />
                  <div>
                    <p className="text-xs font-medium text-slate-200">Local Folder</p>
                    <p className="text-[10px] text-slate-500">Ingest folders &amp; files from this computer</p>
                  </div>
                </button>
                {/* Google Drive — configure tile if not connected */}
                {!connectedSources.some((s) => s.provider === 'google') && (
                  <a href="/drive"
                    className="flex items-center gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-800/20 px-3 py-2.5 text-left hover:border-emerald-500/40 hover:bg-emerald-500/5 transition-colors">
                    <HardDrive size={13} className="text-slate-500" />
                    <div>
                      <p className="text-xs font-medium text-slate-400">Google Drive</p>
                      <p className="text-[10px] text-emerald-400/70">Connect →</p>
                    </div>
                  </a>
                )}
                {/* SharePoint — configure tile if not connected */}
                {!connectedSources.some((s) => s.provider === 'microsoft' || s.provider === 'sharepoint') && (
                  <a href="/sharepoint"
                    className="flex items-center gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-800/20 px-3 py-2.5 text-left hover:border-blue-500/40 hover:bg-blue-500/5 transition-colors">
                    <Building2 size={13} className="text-slate-500" />
                    <div>
                      <p className="text-xs font-medium text-slate-400">SharePoint</p>
                      <p className="text-[10px] text-blue-400/70">Connect →</p>
                    </div>
                  </a>
                )}
                {/* Obsidian — real source tile when vaults exist, else a "Connect" link */}
                {obsidianVaults.length > 0 ? (
                  <button onClick={() => { setSelectedSource('obsidian'); setSelectedProvider('obsidian'); setDriveSelected(new Set()); setObsidianVaultId(obsidianVaults[0]?.id ?? null); setObsidianSelected(new Set()) }}
                    className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2.5 text-left hover:border-slate-600 transition-colors">
                    <BookMarked size={13} className="text-violet-400" />
                    <div>
                      <p className="text-xs font-medium text-slate-200">Obsidian</p>
                      <p className="text-[10px] text-slate-500">{obsidianVaults.length} vault{obsidianVaults.length !== 1 ? 's' : ''}</p>
                    </div>
                  </button>
                ) : (
                  <a href="/obsidian"
                    className="flex items-center gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-800/20 px-3 py-2.5 text-left hover:border-violet-500/40 hover:bg-violet-500/5 transition-colors">
                    <BookMarked size={13} className="text-slate-500" />
                    <div>
                      <p className="text-xs font-medium text-slate-400">Obsidian</p>
                      <p className="text-[10px] text-violet-400/70">Connect →</p>
                    </div>
                  </a>
                )}
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
            ) : selectedProvider === 'localfolder' ? (
              /* ── Local Folder (browser File System Access API) ─────────── */
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => { setSelectedSource(null); setSelectedProvider(null) }} className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"><X size={12} /></button>
                  <span className="text-xs font-medium text-slate-200">Local Folder</span>
                </div>
                <LocalFolderManager onIngested={() => { setRefetchKey((k) => k + 1); refreshBalance() }} />
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
            ) : selectedProvider === 'obsidian' ? (
              <div className="space-y-2">
                {/* Vault selector */}
                <div className="flex items-center gap-2">
                  <button onClick={() => { setSelectedSource(null); setSelectedProvider(null); setObsidianVaultId(null); setObsidianNotes([]); setObsidianSelected(new Set()) }} className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"><X size={12} /></button>
                  <BookMarked size={12} className="shrink-0 text-violet-400" />
                  <select
                    value={obsidianVaultId || ''}
                    onChange={(e) => { setObsidianVaultId(e.target.value || null); setObsidianSelected(new Set()) }}
                    className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 focus:border-indigo-500 focus:outline-none"
                  >
                    {obsidianVaults.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} — {v.kind === 'local' ? 'Local drive' : v.kind === 'folder' ? 'Server folder' : 'REST API'}
                      </option>
                    ))}
                  </select>
                  <div className="relative">
                    <Search size={9} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input type="text" value={obsidianSearch} onChange={(e) => setObsidianSearch(e.target.value)} placeholder="Search..." className="w-32 rounded border border-slate-700 bg-slate-800 py-1 pl-5 pr-2 text-[10px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none" />
                  </div>
                </div>

                {/* Local-vault trigger caveat */}
                {selectedObsidianVault?.kind === 'local' && (
                  <p className="text-[10px] text-amber-400/80">Scheduled triggers need a server-mounted or REST vault.</p>
                )}

                {/* Select all */}
                {(() => {
                  const filtered = obsidianSearch
                    ? obsidianNotes.filter((n) => n.name.toLowerCase().includes(obsidianSearch.toLowerCase()) || n.path.toLowerCase().includes(obsidianSearch.toLowerCase()))
                    : obsidianNotes
                  return (
                    <>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setObsidianSelected(new Set(filtered.map((n) => n.path)))} className="text-[10px] text-indigo-400 hover:text-indigo-300">Select all</button>
                        {obsidianSelected.size > 0 && <span className="text-[10px] text-slate-500">{obsidianSelected.size} selected</span>}
                      </div>

                      {/* Note list */}
                      <div className="max-h-52 overflow-y-auto rounded border border-slate-800">
                        {obsidianLoadingNotes ? (
                          <div className="flex items-center justify-center py-6"><Loader2 size={14} className="animate-spin text-slate-500" /></div>
                        ) : obsidianNotesError ? (
                          <p className="py-4 px-3 text-center text-[10px] text-red-400">{obsidianNotesError}</p>
                        ) : filtered.length === 0 ? (
                          <p className="py-4 text-center text-[10px] text-slate-500">{obsidianSearch ? 'No matches' : 'No notes in this vault'}</p>
                        ) : (
                          <div className="divide-y divide-slate-800/50">
                            {filtered.map((n) => {
                              const sel = obsidianSelected.has(n.path)
                              return (
                                <div key={n.path} onClick={() => setObsidianSelected((prev) => { const next = new Set(prev); if (next.has(n.path)) next.delete(n.path); else next.add(n.path); return next })} className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-800/50', sel && 'bg-indigo-950/30')}>
                                  {sel ? <CheckSquare size={11} className="shrink-0 text-indigo-400" /> : <Square size={11} className="shrink-0 text-slate-600" />}
                                  <FileText size={11} className="shrink-0 text-slate-400" />
                                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">{n.name}</span>
                                  <span className="shrink-0 truncate text-[9px] text-slate-600">{n.path}</span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )
                })()}

                {/* Local extraction progress */}
                {obsidianProgress && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-[10px] text-slate-400"><Loader2 size={11} className="animate-spin text-indigo-400" /> Extracting… {obsidianProgress.done}/{obsidianProgress.total}</div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                      <div className="h-full bg-indigo-500 transition-all" style={{ width: `${obsidianProgress.total ? (obsidianProgress.done / obsidianProgress.total) * 100 : 0}%` }} />
                    </div>
                  </div>
                )}
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
                  <div className={cn('flex items-center gap-0.5 rounded bg-slate-800/50 p-0.5', obsidianLocalSelected && 'opacity-40 pointer-events-none')}>
                    <button onClick={() => setTriggerMode('none')} className={cn('rounded px-2.5 py-1 text-[10px] font-medium transition-colors', triggerMode === 'none' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>None</button>
                    <button onClick={() => setTriggerMode('cron')} className={cn('rounded px-2.5 py-1 text-[10px] font-medium transition-colors', triggerMode === 'cron' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>Schedule</button>
                    {activeTab === 'sources' && (
                      <button onClick={() => setTriggerMode('heartbeat')} className={cn('rounded px-2.5 py-1 text-[10px] font-medium transition-colors', triggerMode === 'heartbeat' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>On Heartbeat</button>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-600">
                    {obsidianLocalSelected ? 'Scheduled triggers need a server-mounted or REST vault.' : triggerMode === 'none' ? 'One-time extraction' : triggerMode === 'cron' ? 'Re-extract on a fixed schedule' : 'Re-checks on every heartbeat tick'}
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
            {/* Classification */}
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[11px] text-slate-400">Classification</span>
              <div className="relative flex items-center gap-2">
                <select value={classificationLevelId || ''} onChange={(e) => setClassificationLevelId(e.target.value || null)}
                  className="w-44 appearance-none rounded border border-slate-700 bg-slate-800 px-2 py-1 pr-6 text-[10px] text-slate-300 focus:border-indigo-500 focus:outline-none">
                  <option value="">Auto-detect</option>
                  {(classificationData?.levels ?? []).map((l) => (
                    <option key={l.id} value={l.id}>{l.display_name}</option>
                  ))}
                </select>
                <ChevronDown size={9} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500" />
                {classificationLevelId && (() => {
                  const level = (classificationData?.levels ?? []).find(l => l.id === classificationLevelId)
                  return level ? <span className="h-3 w-3 rounded-full" style={{ backgroundColor: level.color }} /> : null
                })()}
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

import { useCallback, useEffect, useState } from 'react'
import {
  FolderPlus,
  Folder,
  RefreshCw,
  Trash2,
  Loader2,
  FileUp,
  AlertTriangle,
  Clock,
  Check,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  supportsLocalFolders,
  addLocalFolder,
  listLocalFolders,
  ingestFolder,
  updateSettings,
  deleteLocalFolder,
  isSupportedFile,
  SUPPORTED_EXTS,
  type LocalFolderMeta,
  type IngestProgress,
} from '@/lib/localFolders'

interface ShowDirectoryPickerWindow {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>
}

/** Extraction options come from the KEX page's own selectors (shown BELOW the
 *  source panel) — we don't duplicate them here. They're snapshotted onto each
 *  folder at ingest time so the background auto-reingest can reuse them. */
export interface LocalFolderManagerProps {
  ontologyId: string | null
  compilationId: string | null
  classificationLevelId: string | null
  onIngested?: () => void
}

/** Self-contained manager for "Local Folder" KEX sources (browser-side). Pick
 *  folders / files from your own machine; all supported formats are pulled and
 *  sent through the normal KEX upload pipeline using the page's extraction
 *  options. A per-folder "Auto" toggle re-ingests changed files in the
 *  background while GCTRL is open. */
export default function LocalFolderManager({
  ontologyId,
  compilationId,
  classificationLevelId,
  onIngested,
}: LocalFolderManagerProps) {
  const supported = supportsLocalFolders()

  const [folders, setFolders] = useState<LocalFolderMeta[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<IngestProgress | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState(false)

  const load = useCallback(async () => {
    try { setFolders(await listLocalFolders()) } catch { /* ignore */ }
  }, [])

  useEffect(() => { void load() }, [load])

  const fmtTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never')

  // Snapshot the page's current extraction options for a folder record.
  const currentSettings = () => ({ ontologyId, compilationId, classificationLevelId })

  // ── Add a folder (persistent, auto-reingest capable) ──
  const handleAddFolder = async () => {
    setError(null); setStatus(null)
    const w = window as unknown as ShowDirectoryPickerWindow
    if (typeof w.showDirectoryPicker !== 'function') {
      setError('Folder picking needs Chrome or Edge over a secure context (open via http://localhost or HTTPS, not a LAN IP).')
      return
    }
    let handle: { name: string }
    try {
      handle = await w.showDirectoryPicker({ mode: 'read' })
    } catch (e) {
      // AbortError = user cancelled the picker; anything else is a real failure.
      if ((e as DOMException)?.name === 'AbortError') return
      setError(`Could not open folder picker: ${(e as Error)?.message ?? String(e)}`)
      return
    }
    try {
      // The handle type from localFolders' picker matches; cast through unknown.
      const meta = await addLocalFolder(handle.name, handle as never, currentSettings())
      await load()
      await runIngest(meta.id, false)
    } catch (e) {
      setError(`Could not add folder: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  // ── Ingest one folder (changed-only by default; force re-uploads all) ──
  const runIngest = async (id: string, force: boolean) => {
    setBusyId(id); setError(null); setStatus(null)
    setProgress({ total: 0, uploaded: 0, skipped: 0, failed: 0 })
    try {
      // Re-snapshot the page's live extraction options before each manual ingest.
      await updateSettings(id, currentSettings())
      const p = await ingestFolder(id, { force, onProgress: setProgress })
      const parts = [`${p.uploaded} sent`]
      if (p.skipped) parts.push(`${p.skipped} unchanged`)
      if (p.failed) parts.push(`${p.failed} failed`)
      setStatus(`${parts.join(', ')}. Track them in Your Extractions below.`)
      onIngested?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ingest failed')
    } finally {
      setBusyId(null); setProgress(null); void load()
    }
  }

  const handleToggleAuto = async (id: string, next: boolean) => {
    await updateSettings(id, { autoReingest: next }); await load()
  }
  const handleRemove = async (id: string) => {
    if (!confirm('Remove this local folder? (Already-extracted knowledge is kept.)')) return
    await deleteLocalFolder(id); await load()
  }

  // ── Ad-hoc one/many file upload (no persistence, works in any browser) ──
  const handlePickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter((f) => isSupportedFile(f.name))
    const totalPicked = (e.target.files ?? []).length
    e.target.value = '' // allow re-picking the same files
    if (picked.length === 0) {
      setError(totalPicked > 0 ? 'None of the selected files are a supported format.' : 'No files selected.')
      return
    }
    setUploadingFiles(true); setError(null); setStatus(null)
    let sent = 0, failed = 0
    for (const file of picked) {
      try {
        const fd = new FormData()
        fd.append('file', file, file.name)
        if (ontologyId) fd.append('ontologyId', ontologyId)
        if (classificationLevelId) fd.append('classificationLevelId', classificationLevelId)
        if (compilationId) fd.append('compilationId', compilationId)
        await api.post('/kex/upload', fd)
        sent++
      } catch { failed++ }
    }
    setUploadingFiles(false)
    setStatus(`${sent} file${sent !== 1 ? 's' : ''} sent for extraction${failed ? `, ${failed} failed` : ''}.`)
    onIngested?.()
  }

  return (
    <div className="space-y-3">
      {/* ── Actions ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void handleAddFolder()}
          className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          <FolderPlus size={14} /> Add folder
        </button>

        <label className="flex cursor-pointer items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors">
          {uploadingFiles ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />} Add files
          <input type="file" multiple className="hidden" onChange={(e) => void handlePickFiles(e)} />
        </label>

        <span className="text-[10px] text-slate-600">
          Uses the extraction options below · {SUPPORTED_EXTS.map((e) => `.${e}`).join(' ')}
        </span>
      </div>

      {!supported && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-500/90">
          <AlertTriangle size={12} />
          Persistent folders &amp; auto re-ingest need Chrome / Edge over localhost or HTTPS. Here, "Add files" still works as a one-shot upload.
        </p>
      )}

      {status && <p className="flex items-center gap-1.5 text-[11px] text-emerald-400"><Check size={12} /> {status}</p>}
      {error && <p className="flex items-center gap-1.5 text-[11px] text-red-400"><AlertTriangle size={12} /> {error}</p>}

      {/* ── Registered folders ───────────────────────────────────────── */}
      {folders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 py-6 text-center">
          <Folder size={18} className="mx-auto text-slate-600" />
          <p className="mt-2 text-xs text-slate-500">No local folders added yet</p>
          <p className="text-[10px] text-slate-600">"Add folder" pulls every supported file from a folder on this computer.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {folders.map((f) => {
            const ingesting = busyId === f.id
            return (
              <div key={f.id} className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800">
                    <Folder size={15} className="text-cyan-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-200">{f.label}</p>
                    <p className="flex items-center gap-1 text-[10px] text-slate-500">
                      <Clock size={10} /> Last sync: {fmtTime(f.lastSyncAt)}
                    </p>
                  </div>

                  <button
                    onClick={() => void handleToggleAuto(f.id, !f.settings.autoReingest)}
                    title="Periodically re-ingest changed files while GCTRL is open"
                    className={cn(
                      'flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-medium transition-colors',
                      f.settings.autoReingest
                        ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-400'
                        : 'border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-300',
                    )}
                  >
                    <RefreshCw size={11} />
                    {f.settings.autoReingest ? 'Auto on' : 'Auto off'}
                  </button>

                  <button
                    onClick={() => void runIngest(f.id, false)}
                    disabled={ingesting}
                    className="flex items-center gap-1.5 rounded bg-indigo-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                  >
                    {ingesting ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    {ingesting ? 'Ingesting…' : 'Ingest changed'}
                  </button>

                  <button
                    onClick={() => void handleRemove(f.id)}
                    className="rounded p-1 text-slate-600 hover:bg-slate-800 hover:text-red-400 transition-colors"
                    title="Remove folder"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                {ingesting && progress && (
                  <div className="mt-2 text-[10px] text-slate-500">
                    {progress.uploaded} sent · {progress.skipped} unchanged{progress.failed ? ` · ${progress.failed} failed` : ''}
                    {progress.total > 0 && ` · ${progress.uploaded + progress.skipped + progress.failed}/${progress.total}`}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

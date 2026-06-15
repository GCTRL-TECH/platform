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
  HardDriveUpload,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'
import {
  supportsLocalFolders,
  pickDirectory,
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

interface OntologyOption { id: string; name: string }
interface CompilationOption { id: string; name: string }
interface ClassificationLevel { id: string; name: string }

/** Self-contained manager for "Local Folder" KEX sources (browser-side). Lets the
 *  user pick folders / files from their own machine, ingest all supported formats,
 *  and enable a periodic re-ingest that skips unchanged files. */
export default function LocalFolderManager({ onIngested }: { onIngested?: () => void }) {
  const { user } = useAuth()
  const supported = supportsLocalFolders()

  const [folders, setFolders] = useState<LocalFolderMeta[]>([])
  const [ontologies, setOntologies] = useState<OntologyOption[]>([])
  const [compilations, setCompilations] = useState<CompilationOption[]>([])
  const [classifications, setClassifications] = useState<ClassificationLevel[]>([])

  // Defaults applied to newly added folders + ad-hoc file uploads.
  const [defOntology, setDefOntology] = useState<string | null>(null)
  const [defCompilation, setDefCompilation] = useState<string | null>(null)
  const [defClassification, setDefClassification] = useState<string | null>(null)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<IngestProgress | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState(false)

  const load = useCallback(async () => {
    try { setFolders(await listLocalFolders()) } catch { /* ignore */ }
  }, [])

  useEffect(() => { void load() }, [load])

  // Seed the default ontology from the user's profile.
  useEffect(() => {
    if (user?.defaultOntologyId && !defOntology) setDefOntology(user.defaultOntologyId)
  }, [user?.defaultOntologyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load ontology / compilation / classification options.
  useEffect(() => {
    void (async () => {
      try { const { data } = await api.get('/ontologies'); setOntologies(data.ontologies ?? []) } catch { /* ignore */ }
      try { const { data } = await api.get('/kg/compilations'); setCompilations(data.compilations ?? []) } catch { /* ignore */ }
      try { const { data } = await api.get('/classification/levels'); setClassifications(data.levels ?? []) } catch { /* ignore */ }
    })()
  }, [])

  const fmtTime = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString() : 'never'

  // ── Add a folder (persistent, auto-reingest capable) ──
  const handleAddFolder = async () => {
    setError(null); setStatus(null)
    const handle = await pickDirectory()
    if (!handle) return // user cancelled / unsupported
    const meta = await addLocalFolder(handle.name, handle, {
      ontologyId: defOntology,
      compilationId: defCompilation,
      classificationLevelId: defClassification,
    })
    await load()
    // Immediately ingest everything in the freshly-picked folder.
    await runIngest(meta.id, false)
  }

  // ── Ingest one folder (changed-only by default; force re-uploads all) ──
  const runIngest = async (id: string, force: boolean) => {
    setBusyId(id); setError(null); setStatus(null); setProgress({ total: 0, uploaded: 0, skipped: 0, failed: 0 })
    try {
      const p = await ingestFolder(id, { force, onProgress: setProgress })
      const parts = [`${p.uploaded} sent`]
      if (p.skipped) parts.push(`${p.skipped} unchanged`)
      if (p.failed) parts.push(`${p.failed} failed`)
      setStatus(`${parts.join(', ')}. Track them in Your Extractions.`)
      onIngested?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ingest failed')
    } finally {
      setBusyId(null); setProgress(null); void load()
    }
  }

  const handleToggleAuto = async (id: string, next: boolean) => {
    await updateSettings(id, { autoReingest: next }); await load()
  }
  const handleFolderSetting = async (id: string, partial: Parameters<typeof updateSettings>[1]) => {
    await updateSettings(id, partial); await load()
  }
  const handleRemove = async (id: string) => {
    if (!confirm('Remove this local folder? (Already-extracted knowledge is kept.)')) return
    await deleteLocalFolder(id); await load()
  }

  // ── Ad-hoc one/many file upload (no persistence) ──
  const handlePickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter((f) => isSupportedFile(f.name))
    e.target.value = '' // allow re-picking the same files
    if (picked.length === 0) { setError('No supported files selected.'); return }
    setUploadingFiles(true); setError(null); setStatus(null)
    let sent = 0, failed = 0
    for (const file of picked) {
      try {
        const fd = new FormData()
        fd.append('file', file, file.name)
        if (defOntology) fd.append('ontologyId', defOntology)
        if (defClassification) fd.append('classificationLevelId', defClassification)
        if (defCompilation) fd.append('compilationId', defCompilation)
        await api.post('/kex/upload', fd)
        sent++
      } catch { failed++ }
    }
    setUploadingFiles(false)
    setStatus(`${sent} file${sent !== 1 ? 's' : ''} sent for extraction${failed ? `, ${failed} failed` : ''}.`)
    onIngested?.()
  }

  const selectCls =
    'rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none'

  return (
    <div className="space-y-4">
      {/* ── Defaults + actions ───────────────────────────────────────── */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <HardDriveUpload size={16} className="text-indigo-400" />
          <h3 className="text-sm font-medium text-slate-200">Local Folder</h3>
          <span className="text-[11px] text-slate-500">— ingest folders & files from this computer</span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium text-slate-500">Ontology</span>
            <select className={selectCls} value={defOntology ?? ''} onChange={(e) => setDefOntology(e.target.value || null)}>
              <option value="">Auto / default</option>
              {ontologies.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium text-slate-500">Target compilation</span>
            <select className={selectCls} value={defCompilation ?? ''} onChange={(e) => setDefCompilation(e.target.value || null)}>
              <option value="">None</option>
              {compilations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium text-slate-500">Classification</span>
            <select className={selectCls} value={defClassification ?? ''} onChange={(e) => setDefClassification(e.target.value || null)}>
              <option value="">None</option>
              {classifications.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {supported ? (
            <button
              onClick={() => void handleAddFolder()}
              className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
            >
              <FolderPlus size={14} /> Add folder
            </button>
          ) : (
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors">
              <FolderPlus size={14} /> Add folder
              {/* Fallback for non-Chromium browsers: one-shot directory upload.
                  webkitdirectory/directory are non-standard, so spread them as
                  untyped attrs to keep TS happy. */}
              <input type="file" multiple className="hidden"
                {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                onChange={(e) => void handlePickFiles(e)} />
            </label>
          )}

          <label className="flex cursor-pointer items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors">
            {uploadingFiles ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />} Add files
            <input type="file" multiple className="hidden" onChange={(e) => void handlePickFiles(e)} />
          </label>

          <span className="text-[10px] text-slate-600">
            Supported: {SUPPORTED_EXTS.map((e) => `.${e}`).join(' ')}
          </span>
        </div>

        {!supported && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-500/90">
            <AlertTriangle size={12} />
            This browser can't watch folders for changes. Use Chrome / Edge for persistent folders &amp; auto re-ingest; here folders upload once.
          </p>
        )}

        {status && <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-400"><Check size={12} /> {status}</p>}
        {error && <p className="mt-2 flex items-center gap-1.5 text-[11px] text-red-400"><AlertTriangle size={12} /> {error}</p>}
      </div>

      {/* ── Registered folders ───────────────────────────────────────── */}
      {folders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 py-8 text-center">
          <Folder size={20} className="mx-auto text-slate-600" />
          <p className="mt-2 text-xs text-slate-500">No local folders added yet</p>
          <p className="text-[10px] text-slate-600">Click "Add folder" to pull every supported file from a folder on this computer.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {folders.map((f) => {
            const ingesting = busyId === f.id
            return (
              <div key={f.id} className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800">
                    <Folder size={15} className="text-indigo-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-200">{f.label}</p>
                    <p className="flex items-center gap-1 text-[10px] text-slate-500">
                      <Clock size={10} /> Last sync: {fmtTime(f.lastSyncAt)}
                    </p>
                  </div>

                  {/* Auto re-ingest toggle */}
                  <button
                    onClick={() => void handleToggleAuto(f.id, !f.settings.autoReingest)}
                    title={supported ? 'Periodically re-ingest changed files while GCTRL is open' : 'Auto re-ingest needs Chrome / Edge'}
                    disabled={!supported}
                    className={cn(
                      'flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-40',
                      f.settings.autoReingest
                        ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-400'
                        : 'border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-300',
                    )}
                  >
                    <RefreshCw size={11} className={f.settings.autoReingest ? 'animate-none' : ''} />
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

                {/* Per-folder targets (used by manual + auto re-ingest) */}
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <select className={selectCls} value={f.settings.ontologyId ?? ''} onChange={(e) => void handleFolderSetting(f.id, { ontologyId: e.target.value || null })}>
                    <option value="">Ontology: auto</option>
                    {ontologies.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <select className={selectCls} value={f.settings.compilationId ?? ''} onChange={(e) => void handleFolderSetting(f.id, { compilationId: e.target.value || null })}>
                    <option value="">Compilation: none</option>
                    {compilations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select className={selectCls} value={f.settings.classificationLevelId ?? ''} onChange={(e) => void handleFolderSetting(f.id, { classificationLevelId: e.target.value || null })}>
                    <option value="">Classification: none</option>
                    {classifications.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
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

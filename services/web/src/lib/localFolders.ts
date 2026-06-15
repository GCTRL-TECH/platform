// IndexedDB-backed store for "Local Folder" KEX sources — folders the user picks
// on THEIR OWN machine via the browser's File System Access API. The server can
// never read the user's local disk, so this is entirely client-side: we walk the
// picked directory, read each supported file, and upload it through the normal
// KEX upload endpoint. The FileSystemDirectoryHandle is structured-cloneable, so
// it persists across reloads in IndexedDB — which lets a periodic re-ingest
// re-open the same folder and skip files whose name+mtime+size are unchanged.
//
// Chrome / Edge / Brave only (File System Access API). Other browsers fall back
// to a one-shot <input webkitdirectory> upload (no persistence, no auto-reingest).

import { api } from '@/lib/api'
import {
  type FsDirectoryHandle,
  type FsFileHandle,
  type FsHandlePermissionDescriptor,
  pickDirectory,
  supportsLocalVaults,
} from '@/lib/localVaults'

// Re-export the capability check + picker under folder-oriented names.
export const supportsLocalFolders = supportsLocalVaults
export { pickDirectory }

// ─── Supported formats ───────────────────────────────────────────────────────
// Keep in sync with KEX `sources/file_handler.py` and KexPage `ACCEPTED_TYPES`.
// Lower-case, no dot. A file is ingested only if its extension is in this set.
export const SUPPORTED_EXTS = [
  'pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml',
  'yaml', 'yml', 'toml', 'rtf', 'epub', 'eml', 'msg',
  'docx', 'pptx', 'xlsx', 'xlsm', 'odt', 'odp', 'ods',
]

const SUPPORTED_SET = new Set(SUPPORTED_EXTS)

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function isSupportedFile(name: string): boolean {
  return SUPPORTED_SET.has(fileExt(name))
}

// ─── Per-folder settings + metadata ──────────────────────────────────────────

export interface LocalFolderSettings {
  ontologyId: string | null
  compilationId: string | null
  classificationLevelId: string | null
}

export const DEFAULT_SETTINGS: LocalFolderSettings = {
  ontologyId: null,
  compilationId: null,
  classificationLevelId: null,
}

export interface LocalFolderMeta {
  id: string
  label: string
  createdAt: number
  lastSyncAt: number | null
  settings: LocalFolderSettings
}

/** Per-file fingerprint of the last successful ingest. Skip when both match. */
interface FileStamp {
  mtime: number
  size: number
}

interface LocalFolderRecord extends LocalFolderMeta {
  handle: FsDirectoryHandle
  // relPath -> stamp of the file as it was when last successfully ingested.
  manifest: Record<string, FileStamp>
}

// ─── IndexedDB plumbing (own DB, parallel to gctrl-local-vaults) ─────────────

const DB_NAME = 'gctrl-local-folders'
const STORE = 'folders'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        t.oncomplete = () => db.close()
      })
  )
}

const toMeta = (r: LocalFolderRecord): LocalFolderMeta => ({
  id: r.id,
  label: r.label,
  createdAt: r.createdAt,
  lastSyncAt: r.lastSyncAt,
  settings: r.settings,
})

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function addLocalFolder(
  label: string,
  handle: FsDirectoryHandle,
  settings: Partial<LocalFolderSettings> = {},
): Promise<LocalFolderMeta> {
  const record: LocalFolderRecord = {
    id: crypto.randomUUID(),
    label: label.trim() || handle.name || 'Local Folder',
    createdAt: Date.now(),
    lastSyncAt: null,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    handle,
    manifest: {},
  }
  await tx('readwrite', (s) => s.put(record))
  return toMeta(record)
}

export async function listLocalFolders(): Promise<LocalFolderMeta[]> {
  const all = await tx<LocalFolderRecord[]>('readonly', (s) => s.getAll() as IDBRequest<LocalFolderRecord[]>)
  return all.map(toMeta).sort((a, b) => a.createdAt - b.createdAt)
}

async function getRecord(id: string): Promise<LocalFolderRecord | null> {
  const rec = await tx<LocalFolderRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<LocalFolderRecord | undefined>)
  return rec ?? null
}

export async function updateSettings(id: string, partial: Partial<LocalFolderSettings>): Promise<void> {
  const rec = await getRecord(id)
  if (!rec) return
  rec.settings = { ...rec.settings, ...partial }
  await tx('readwrite', (s) => s.put(rec))
}

export async function deleteLocalFolder(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}

// ─── Permissions + directory walking ─────────────────────────────────────────

/** Query, then (if needed) request read permission on a stored handle. Must be
 *  invoked from a user gesture for the request to be allowed to prompt. */
async function ensurePermission(handle: FsDirectoryHandle): Promise<boolean> {
  const desc: FsHandlePermissionDescriptor = { mode: 'read' }
  try {
    if (handle.queryPermission) {
      const cur = await handle.queryPermission(desc)
      if (cur === 'granted') return true
    }
    if (handle.requestPermission) {
      return (await handle.requestPermission(desc)) === 'granted'
    }
  } catch {
    return false
  }
  // No permission API (older implementations) → assume usable.
  return !handle.queryPermission
}

export interface FolderFile {
  relPath: string
  name: string
  size: number
  mtime: number
  handle: FsFileHandle
}

/** Recursively collect supported files under `handle`, skipping dot-dirs.
 *  Bounded at 5000 files so a huge tree can't hang the tab. */
export async function listFolderFiles(handle: FsDirectoryHandle): Promise<FolderFile[]> {
  const out: FolderFile[] = []
  const MAX = 5000

  async function walk(dir: FsDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, child] of dir.entries()) {
      if (out.length >= MAX) return
      if (child.kind === 'directory') {
        if (name.startsWith('.')) continue // skip .git, .obsidian, .trash, etc.
        await walk(child, prefix ? `${prefix}/${name}` : name)
      } else if (child.kind === 'file' && isSupportedFile(name)) {
        try {
          const file = await child.getFile()
          out.push({
            relPath: prefix ? `${prefix}/${name}` : name,
            name,
            size: file.size,
            mtime: file.lastModified,
            handle: child,
          })
        } catch {
          /* unreadable entry — skip */
        }
      }
    }
  }

  await walk(handle, '')
  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return out
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestProgress {
  total: number
  uploaded: number
  skipped: number
  failed: number
}

export interface IngestOptions {
  /** Re-upload every supported file, ignoring the unchanged-skip manifest. */
  force?: boolean
  /** Restrict to these relPaths (selective sync). Empty/undefined = whole folder. */
  subset?: string[]
  onProgress?: (p: IngestProgress) => void
}

/** Upload one file to KEX via the normal multipart upload endpoint.
 *  `Content-Type: undefined` lets the browser/axios set multipart + boundary
 *  (the shared api instance defaults to application/json, which would corrupt
 *  the upload) — same trick the Upload tab's useUploadMutation uses. */
async function uploadFile(file: File, name: string, settings: LocalFolderSettings): Promise<void> {
  const fd = new FormData()
  fd.append('file', file, name)
  if (settings.ontologyId) fd.append('ontologyId', settings.ontologyId)
  if (settings.classificationLevelId) fd.append('classificationLevelId', settings.classificationLevelId)
  if (settings.compilationId) fd.append('compilationId', settings.compilationId)
  await api.post('/kex/upload', fd, { headers: { 'Content-Type': undefined } })
}

/**
 * Ingest a stored folder: walk it, and for each supported file upload it unless
 * its name+mtime+size already matches the last successful ingest (skip). Updates
 * the per-file manifest + lastSyncAt on success. Resilient: per-file failures are
 * counted, never thrown. Throws only for folder-level problems (handle gone /
 * permission denied) so the caller can surface a single clear message.
 */
export async function ingestFolder(id: string, opts: IngestOptions = {}): Promise<IngestProgress> {
  const rec = await getRecord(id)
  if (!rec) throw new Error('This folder is no longer registered in this browser.')

  const granted = await ensurePermission(rec.handle)
  if (!granted) throw new Error('Read permission was denied for this folder.')

  let files = await listFolderFiles(rec.handle)
  if (opts.subset && opts.subset.length > 0) {
    const want = new Set(opts.subset)
    files = files.filter((f) => want.has(f.relPath))
  }

  const progress: IngestProgress = { total: files.length, uploaded: 0, skipped: 0, failed: 0 }
  opts.onProgress?.(progress)

  const manifest = rec.manifest ?? {}
  const queue = [...files]

  const worker = async () => {
    for (;;) {
      const f = queue.shift()
      if (!f) break
      // Skip unchanged: same path AND same mtime AND same size as last ingest.
      const prev = manifest[f.relPath]
      if (!opts.force && prev && prev.mtime === f.mtime && prev.size === f.size) {
        progress.skipped++
        opts.onProgress?.({ ...progress })
        continue
      }
      try {
        const file = await f.handle.getFile()
        await uploadFile(file, f.name, rec.settings)
        manifest[f.relPath] = { mtime: f.mtime, size: f.size }
        progress.uploaded++
      } catch {
        progress.failed++
      }
      opts.onProgress?.({ ...progress })
    }
  }

  // Bounded concurrency (mirror the Obsidian local-vault uploader).
  await Promise.all([worker(), worker(), worker()])

  // Persist the updated manifest + sync time (re-read to avoid clobbering a
  // settings change made during a long ingest).
  const fresh = (await getRecord(id)) ?? rec
  fresh.manifest = manifest
  fresh.lastSyncAt = Date.now()
  await tx('readwrite', (s) => s.put(fresh))

  return progress
}

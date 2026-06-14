// IndexedDB-backed store for "local" Obsidian vaults — folders the user picks in
// the browser via the File System Access API. The returned FileSystemDirectoryHandle
// is structured-cloneable, so it persists across reloads when stored in IndexedDB.
// These vaults are CLIENT-SIDE ONLY: the server can never read them, so they can't
// be cron-triggered. Chrome/Edge only.

// ─── Minimal ambient types (not in the default DOM lib) ──────────────────────
// `showDirectoryPicker`, the directory-handle async iterator, and the permission
// methods aren't typed by TypeScript's bundled DOM lib. Declare just what we use.

export type FsPermissionState = 'granted' | 'denied' | 'prompt'

export interface FsHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

export interface FsFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
}

export interface FsDirectoryHandle {
  kind: 'directory'
  name: string
  entries(): AsyncIterableIterator<[string, FsFileHandle | FsDirectoryHandle]>
  queryPermission?(desc?: FsHandlePermissionDescriptor): Promise<FsPermissionState>
  requestPermission?(desc?: FsHandlePermissionDescriptor): Promise<FsPermissionState>
}

// Browser-facing aliases so callers can use the standard names.
export type FileSystemDirectoryHandle = FsDirectoryHandle
export type FileSystemFileHandle = FsFileHandle

interface ShowDirectoryPickerWindow {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirectoryHandle>
}

export function supportsLocalVaults(): boolean {
  return typeof (window as unknown as ShowDirectoryPickerWindow).showDirectoryPicker === 'function'
}

export async function pickDirectory(): Promise<FsDirectoryHandle | null> {
  const w = window as unknown as ShowDirectoryPickerWindow
  if (!w.showDirectoryPicker) return null
  try {
    return await w.showDirectoryPicker({ mode: 'read' })
  } catch {
    // User cancelled the picker.
    return null
  }
}

// ─── Public metadata shape ───────────────────────────────────────────────────

export interface LocalVault {
  id: string
  label: string
  kind: 'local'
  createdAt: number
}

interface LocalVaultRecord extends LocalVault {
  handle: FsDirectoryHandle
}

// ─── IndexedDB plumbing ──────────────────────────────────────────────────────

const DB_NAME = 'gctrl-local-vaults'
const STORE = 'vaults'
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

const toMeta = (r: LocalVaultRecord): LocalVault => ({
  id: r.id,
  label: r.label,
  kind: 'local',
  createdAt: r.createdAt,
})

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function addLocalVault(label: string, handle: FsDirectoryHandle): Promise<LocalVault> {
  const record: LocalVaultRecord = {
    id: crypto.randomUUID(),
    label: label.trim() || handle.name || 'Local Vault',
    kind: 'local',
    createdAt: Date.now(),
    handle,
  }
  await tx('readwrite', (s) => s.put(record))
  return toMeta(record)
}

export async function listLocalVaults(): Promise<LocalVault[]> {
  const all = await tx<LocalVaultRecord[]>('readonly', (s) => s.getAll() as IDBRequest<LocalVaultRecord[]>)
  return all
    .map(toMeta)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function getLocalVaultHandle(id: string): Promise<FsDirectoryHandle | null> {
  const rec = await tx<LocalVaultRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<LocalVaultRecord | undefined>)
  return rec?.handle ?? null
}

export async function deleteLocalVault(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}

// ─── Vault walking + permissions ─────────────────────────────────────────────

export interface VaultMarkdownEntry {
  name: string
  relPath: string
  fileHandle: FsFileHandle
}

/** Recursively collect `.md` files, skipping `.obsidian/` and `.trash/`. */
export async function listVaultMarkdown(handle: FsDirectoryHandle): Promise<VaultMarkdownEntry[]> {
  const out: VaultMarkdownEntry[] = []

  async function walk(dir: FsDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, child] of dir.entries()) {
      if (child.kind === 'directory') {
        if (name === '.obsidian' || name === '.trash' || name.startsWith('.')) continue
        await walk(child, prefix ? `${prefix}/${name}` : name)
      } else if (child.kind === 'file' && name.toLowerCase().endsWith('.md')) {
        out.push({
          name: name.replace(/\.md$/i, ''),
          relPath: prefix ? `${prefix}/${name}` : name,
          fileHandle: child,
        })
      }
    }
  }

  await walk(handle, '')
  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return out
}

/** Ensure read permission on a handle. Must be called from a user gesture. */
export async function ensureReadPermission(handle: FsDirectoryHandle): Promise<boolean> {
  const desc: FsHandlePermissionDescriptor = { mode: 'read' }
  if (handle.queryPermission) {
    const current = await handle.queryPermission(desc)
    if (current === 'granted') return true
  }
  if (handle.requestPermission) {
    const next = await handle.requestPermission(desc)
    return next === 'granted'
  }
  // No permission API: assume the handle is usable (older implementations).
  return true
}

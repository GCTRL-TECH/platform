import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Database,
  Plus,
  Search,
  GitBranch,
  Hash,
  Clock,
  Calendar,
  ChevronRight,
  AlertCircle,
  Trash2,
  Layers,
  FolderPlus,
  Folder,
  ChevronLeft,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useApiQuery, useApiMutation } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal'

type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'

interface Compilation {
  id: string
  name: string
  description: string | null
  userId: string
  sourceJobIds: string[]
  classification: Classification
  version: number
  cronSchedule: string | null
  cronMode: string
  lastRefreshAt: string | null
  nodeCount: number
  edgeCount: number
  entityCount: number
  duplicateCount: number
  linkCount: number
  createdAt: string
  updatedAt: string
  folderId: string | null
}

interface CompilationsResponse {
  compilations: Compilation[]
}

interface CreateCompilationResponse {
  compilation: Compilation
}

interface KgFolder {
  id: string
  name: string
  userId: string
  parentFolderId: string | null
  position: number
  createdAt: string
  updatedAt: string
}

interface FoldersResponse {
  folders: KgFolder[]
}

const CLASSIFICATION_STYLES: Record<
  Classification,
  { badge: string; border: string; bg: string; label: string }
> = {
  PUBLIC: {
    badge: 'badge-green',
    border: 'border-emerald-500/20',
    bg: 'bg-emerald-500/5',
    label: 'Public',
  },
  INTERNAL: {
    badge: 'badge-blue',
    border: 'border-blue-500/20',
    bg: 'bg-blue-500/5',
    label: 'Internal',
  },
  CONFIDENTIAL: {
    badge: 'badge-yellow',
    border: 'border-amber-500/20',
    bg: 'bg-amber-500/5',
    label: 'Confidential',
  },
  RESTRICTED: {
    badge: 'badge-red',
    border: 'border-red-500/20',
    bg: 'bg-red-500/5',
    label: 'Restricted',
  },
}

const CLASSIFICATION_OPTIONS: Classification[] = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
]

// Modal for creating a new compilation
interface CreateModalProps {
  onClose: () => void
  onCreated: (id: string) => void
}

function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [classification, setClassification] = useState<Classification>('INTERNAL')
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const createMutation = useApiMutation<CreateCompilationResponse>(
    '/kg/compilations',
    'POST',
    {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: ['kg', 'compilations'] })
        onCreated(data.compilation.id)
      },
      onError: (err) => {
        setError(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            'Failed to create compilation'
        )
      },
    }
  )

  function handleSubmit() {
    setError(null)
    createMutation.mutate({
      data: {
        name: name.trim(),
        description: description.trim() || undefined,
        classification,
      },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <h3 className="mb-4 text-base font-semibold text-slate-100">New Knowledge Graph</h3>

        <div className="space-y-4">
          <div>
            <label className="label">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field"
              placeholder="e.g. Product Knowledge Base"
              autoFocus
            />
          </div>

          <div>
            <label className="label">
              Classification <span className="text-red-400">*</span>
            </label>
            <select
              value={classification}
              onChange={(e) => setClassification(e.target.value as Classification)}
              className="input-field"
            >
              {CLASSIFICATION_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {CLASSIFICATION_STYLES[c].label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">
              Description{' '}
              <span className="text-xs font-normal text-slate-600">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="input-field resize-none"
              placeholder="What knowledge does this graph contain?"
            />
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-slate-800 pt-4">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || createMutation.isPending}
            className="btn-primary"
          >
            {createMutation.isPending ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Creating...
              </>
            ) : (
              <>
                <Plus size={15} />
                Create
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function CompilationCard({
  compilation,
  onClick,
  onDelete,
}: {
  compilation: Compilation
  onClick: () => void
  onDelete: (id: string, name: string) => void
}) {
  const cls = CLASSIFICATION_STYLES[compilation.classification] ?? CLASSIFICATION_STYLES.INTERNAL

  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-compilation-id', compilation.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onClick}
      className={cn(
        'group relative flex w-full flex-col rounded-xl border bg-slate-900 p-5 text-left transition-all hover:border-slate-600 hover:bg-slate-800/60 cursor-grab active:cursor-grabbing',
        cls.border
      )}
    >
      {/* Delete button (top right, visible on hover) */}
      <div
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => { e.stopPropagation(); onDelete(compilation.id, compilation.name) }}
        role="button"
        title="Delete compilation"
      >
        <Trash2 size={14} className="text-slate-600 hover:text-red-400 transition-colors" />
      </div>

      {/* Header row */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-800">
          {compilation.sourceJobIds.length > 1 ? (
            <Layers size={17} className="text-violet-400 group-hover:text-violet-300 transition-colors" />
          ) : (
            <Database size={17} className="text-slate-400 group-hover:text-slate-300 transition-colors" />
          )}
        </div>
        <span className={cls.badge}>{cls.label}</span>
      </div>

      {/* Name */}
      <h4 className="mb-1 text-sm font-semibold text-slate-200 group-hover:text-slate-100 transition-colors">
        {compilation.name}
      </h4>

      {/* Compilation subtitle */}
      {compilation.sourceJobIds.length > 1 && (
        <p className="mb-1 text-xs text-violet-400/70">
          {compilation.sourceJobIds.length} sources
          {compilation.lastRefreshAt
            ? ` · Updated ${formatDistanceToNow(new Date(compilation.lastRefreshAt), { addSuffix: true })}`
            : ''}
        </p>
      )}

      {/* Description */}
      {compilation.description && (
        <p className="mb-3 line-clamp-2 text-xs text-slate-500">{compilation.description}</p>
      )}

      {/* Stats row */}
      <div className="mt-auto flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Hash size={12} />
          <span>{(compilation.entityCount || compilation.nodeCount).toLocaleString()} entities</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <GitBranch size={12} />
          <span>{compilation.edgeCount.toLocaleString()} relations</span>
        </div>
        {compilation.cronSchedule && (
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Calendar size={12} />
            <span className="font-mono">{compilation.cronSchedule}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-600">
          <Clock size={12} />
          {compilation.lastRefreshAt
            ? formatDistanceToNow(new Date(compilation.lastRefreshAt), { addSuffix: true })
            : 'Never refreshed'}
        </div>
        <ChevronRight
          size={14}
          className="text-slate-700 opacity-0 group-hover:opacity-100 transition-opacity"
        />
      </div>
    </button>
  )
}

export function KGListPage() {
  const navigate = useNavigate()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterClassification, setFilterClassification] = useState<Classification | 'ALL'>('ALL')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const queryClient = useQueryClient()

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [folderPath, setFolderPath] = useState<KgFolder[]>([])

  const { data: foldersData } = useApiQuery<FoldersResponse>(
    ['kg', 'folders'],
    '/kg/folders'
  )
  const allFolders = foldersData?.folders ?? []

  async function handleDeleteCompilation() {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      const { apiDelete } = await import('@/lib/api')
      await apiDelete(`/kg/compilations/${deleteTarget.id}`)
      queryClient.invalidateQueries({ queryKey: ['kg', 'compilations'] })
      setDeleteTarget(null)
    } catch {} finally {
      setIsDeleting(false)
    }
  }

  const { data, isLoading, error } = useApiQuery<CompilationsResponse>(
    ['kg', 'compilations'],
    '/kg/compilations'
  )
  const compilations = data?.compilations ?? []

  const filtered = compilations.filter((c) => {
    const matchesSearch =
      searchQuery === '' ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (c.description ?? '').toLowerCase().includes(searchQuery.toLowerCase())
    const matchesClassification =
      filterClassification === 'ALL' || c.classification === filterClassification
    return matchesSearch && matchesClassification
  })

  const foldersInView = allFolders.filter(
    (f) => (f.parentFolderId ?? null) === currentFolderId
  )

  const compilationsInFolder = filtered.filter(
    (c) => (c.folderId ?? null) === currentFolderId
  )

  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)

  async function handleMoveToFolder(compilationId: string, folderId: string | null) {
    try {
      const { apiPut } = await import('@/lib/api')
      await apiPut(`/kg/folders/move/${compilationId}`, { folderId })
      queryClient.invalidateQueries({ queryKey: ['kg', 'compilations'] })
    } catch {}
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return
    try {
      const { apiPost } = await import('@/lib/api')
      await apiPost('/kg/folders', {
        name: newFolderName.trim(),
        parentFolderId: currentFolderId,
      })
      queryClient.invalidateQueries({ queryKey: ['kg', 'folders'] })
      setNewFolderName('')
      setShowCreateFolder(false)
    } catch {}
  }

  async function handleDeleteFolder(folderId: string) {
    try {
      const { apiDelete } = await import('@/lib/api')
      await apiDelete(`/kg/folders/${folderId}`)
      queryClient.invalidateQueries({ queryKey: ['kg', 'folders'] })
      queryClient.invalidateQueries({ queryKey: ['kg', 'compilations'] })
      if (currentFolderId === folderId) {
        setCurrentFolderId(null)
        setFolderPath([])
      }
    } catch {}
  }

  function navigateToFolder(folder: KgFolder) {
    setFolderPath((prev) => [...prev, folder])
    setCurrentFolderId(folder.id)
  }

  function navigateUp() {
    setFolderPath((prev) => {
      const newPath = prev.slice(0, -1)
      setCurrentFolderId(newPath.length > 0 ? newPath[newPath.length - 1]!.id : null)
      return newPath
    })
  }

  function navigateToBreadcrumb(index: number) {
    if (index < 0) {
      setCurrentFolderId(null)
      setFolderPath([])
    } else {
      const newPath = folderPath.slice(0, index + 1)
      setCurrentFolderId(newPath[newPath.length - 1]!.id)
      setFolderPath(newPath)
    }
  }

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-100">Knowledge Graphs</h2>
          <p className="mt-1 text-sm text-slate-500">
            Manage and explore your knowledge compilations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateFolder(true)}
            className="btn-secondary"
          >
            <FolderPlus size={15} />
            New Folder
          </button>
          <button onClick={() => setShowCreateModal(true)} className="btn-primary">
            <Plus size={15} />
            New Compilation
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input-field pl-9"
            placeholder="Search knowledge graphs..."
          />
        </div>
        <select
          value={filterClassification}
          onChange={(e) =>
            setFilterClassification(e.target.value as Classification | 'ALL')
          }
          className="input-field w-auto min-w-[160px]"
        >
          <option value="ALL">All Classifications</option>
          {CLASSIFICATION_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {CLASSIFICATION_STYLES[c].label}
            </option>
          ))}
        </select>
      </div>

      {/* Breadcrumb */}
      {folderPath.length > 0 && (
        <div className="flex items-center gap-1.5 text-sm">
          <button
            onClick={() => navigateToBreadcrumb(-1)}
            className="text-slate-500 hover:text-slate-300 transition-colors"
          >
            Knowledge Graphs
          </button>
          {folderPath.map((f, i) => (
            <span key={f.id} className="flex items-center gap-1.5">
              <ChevronRight size={12} className="text-slate-700" />
              <button
                onClick={() => navigateToBreadcrumb(i)}
                className={cn(
                  'transition-colors',
                  i === folderPath.length - 1
                    ? 'text-slate-200 font-medium'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                {f.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-4 py-24 text-center">
          <AlertCircle size={32} className="text-red-400" />
          <div>
            <p className="text-sm font-medium text-slate-300">Failed to load knowledge graphs</p>
            <p className="mt-0.5 text-xs text-slate-500">Check your connection and try again.</p>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-24 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-800">
            <Database size={24} className="text-slate-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-400">
              {compilations.length === 0
                ? 'No knowledge graphs yet'
                : 'No results match your filters'}
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              {compilations.length === 0
                ? 'Create a compilation or run a FUSE merge to get started'
                : 'Try adjusting your search or filter'}
            </p>
          </div>
          {compilations.length === 0 && (
            <button onClick={() => setShowCreateModal(true)} className="btn-primary">
              <Plus size={15} />
              New Compilation
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Folder cards */}
          {foldersInView.map((folder) => (
            <button
              key={folder.id}
              onClick={() => navigateToFolder(folder)}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOverFolderId(folder.id)
              }}
              onDragLeave={() => setDragOverFolderId(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverFolderId(null)
                const compilationId = e.dataTransfer.getData('application/x-compilation-id')
                if (compilationId) handleMoveToFolder(compilationId, folder.id)
              }}
              className={cn(
                'group relative flex w-full items-center gap-3 rounded-xl border bg-slate-900 p-4 text-left transition-all hover:border-slate-600 hover:bg-slate-800/60',
                dragOverFolderId === folder.id
                  ? 'border-amber-400/60 bg-amber-400/5 ring-1 ring-amber-400/30'
                  : 'border-slate-700/50'
              )}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-800">
                <Folder size={17} className="text-amber-400/80 group-hover:text-amber-300 transition-colors" />
              </div>
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold text-slate-200 truncate">{folder.name}</h4>
                <p className="text-xs text-slate-600">
                  {filtered.filter((c) => c.folderId === folder.id).length} graphs
                </p>
              </div>
              <ChevronRight size={14} className="text-slate-700 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div
                className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder.id) }}
                role="button"
                title="Delete folder (contents move up)"
              >
                <Trash2 size={12} className="text-slate-600 hover:text-red-400 transition-colors" />
              </div>
            </button>
          ))}

          {/* Back button when inside a folder — also a drop target to move card up */}
          {currentFolderId && (
            <button
              onClick={navigateUp}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOverFolderId('__parent__')
              }}
              onDragLeave={() => setDragOverFolderId(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverFolderId(null)
                const compilationId = e.dataTransfer.getData('application/x-compilation-id')
                if (compilationId) {
                  const parentId = folderPath.length > 1 ? folderPath[folderPath.length - 2]!.id : null
                  handleMoveToFolder(compilationId, parentId)
                }
              }}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-dashed bg-slate-900/50 p-4 text-left transition-all hover:border-slate-600 hover:text-slate-400',
                dragOverFolderId === '__parent__'
                  ? 'border-amber-400/60 bg-amber-400/5 text-amber-300'
                  : 'border-slate-700/50 text-slate-500'
              )}
            >
              <ChevronLeft size={17} />
              <span className="text-sm">Back</span>
            </button>
          )}

          {/* Compilation cards */}
          {compilationsInFolder.map((compilation) => (
            <CompilationCard
              key={compilation.id}
              compilation={compilation}
              onClick={() => navigate(`/graphs/${compilation.id}`)}
              onDelete={(id, name) => setDeleteTarget({ id, name })}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreateModal && (
        <CreateModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(id) => {
            setShowCreateModal(false)
            navigate(`/graphs/${id}`)
          }}
        />
      )}

      {/* Create folder */}
      {showCreateFolder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <h3 className="mb-4 text-base font-semibold text-slate-100">New Folder</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              className="input-field"
              placeholder="Folder name"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={() => { setShowCreateFolder(false); setNewFolderName('') }} className="btn-secondary">
                Cancel
              </button>
              <button onClick={handleCreateFolder} disabled={!newFolderName.trim()} className="btn-primary">
                <FolderPlus size={15} />
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDeleteModal
        open={!!deleteTarget}
        title="Delete Knowledge Graph"
        description={`This will permanently delete the compilation "${deleteTarget?.name ?? ''}". Source graphs used in this compilation will not be affected.`}
        confirmPhrase="delete"
        confirmText="Delete Graph"
        onConfirm={handleDeleteCompilation}
        onCancel={() => setDeleteTarget(null)}
        isDeleting={isDeleting}
      />
    </div>
  )
}

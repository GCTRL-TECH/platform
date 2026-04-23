import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen,
  Plus,
  Upload,
  AlertCircle,
  ChevronRight,
  Hash,
  Layers,
  Globe,
  Lock,
  Users,
  Trash2,
  Tag,
  type LucideIcon,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useApiQuery, useApiMutation } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal'
import { apiPost, apiDelete } from '@/lib/api'

type OntologyScope = 'private' | 'shared' | 'public'

interface Ontology {
  id: string
  userId: string
  name: string
  description: string | null
  version: number
  parentOntologyId: string | null
  scope: OntologyScope
  source: string | null
  entityTypeCount: number
  createdAt: string
  updatedAt: string
}

interface OntologiesResponse {
  ontologies: Ontology[]
}

interface CreateOntologyResponse {
  ontology: Ontology
}

const SCOPE_STYLES: Record<
  OntologyScope,
  { badge: string; icon: LucideIcon; label: string; border: string }
> = {
  private: {
    badge: 'badge-slate',
    icon: Lock,
    label: 'Private',
    border: 'border-slate-700/50',
  },
  shared: {
    badge: 'badge-blue',
    icon: Users,
    label: 'Shared',
    border: 'border-blue-500/20',
  },
  public: {
    badge: 'badge-green',
    icon: Globe,
    label: 'Public',
    border: 'border-emerald-500/20',
  },
}

type ScopeFilter = 'all' | 'mine' | 'shared' | 'public'

// ─── Create Modal ─────────────────────────────────────────────────────────────

interface CreateModalProps {
  onClose: () => void
  onCreated: (id: string) => void
}

function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<OntologyScope>('private')
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const createMutation = useApiMutation<CreateOntologyResponse>(
    '/ontologies',
    'POST',
    {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: ['ontologies'] })
        onCreated(data.ontology.id)
      },
      onError: (err) => {
        setError(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
            'Failed to create ontology'
        )
      },
    }
  )

  function handleSubmit() {
    setError(null)
    createMutation.mutate({
      data: { name: name.trim(), description: description.trim() || undefined, scope },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <h3 className="mb-4 text-base font-semibold text-slate-100">New Ontology</h3>

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
              placeholder="e.g. CRM Entities"
              autoFocus
            />
          </div>

          <div>
            <label className="label">Scope</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as OntologyScope)}
              className="input-field"
            >
              <option value="private">Private — only you</option>
              <option value="shared">Shared — team members</option>
              <option value="public">Public — everyone</option>
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
              placeholder="What entities and relationships does this ontology define?"
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

// ─── Ontology Card ────────────────────────────────────────────────────────────

function OntologyCard({
  ontology,
  onClick,
  onDelete,
}: {
  ontology: Ontology
  onClick: () => void
  onDelete: (id: string, name: string) => void
}) {
  const scopeStyle = SCOPE_STYLES[ontology.scope] || SCOPE_STYLES.private
  const ScopeIcon = scopeStyle.icon

  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative flex w-full flex-col rounded-xl border bg-slate-900 p-5 text-left transition-all hover:border-slate-600 hover:bg-slate-800/60',
        scopeStyle.border
      )}
    >
      {/* Delete button */}
      <div
        className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(ontology.id, ontology.name)
        }}
        role="button"
        title="Delete ontology"
      >
        <Trash2 size={14} className="text-slate-600 transition-colors hover:text-red-400" />
      </div>

      {/* Header row */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-800">
          <BookOpen
            size={17}
            className="text-slate-400 transition-colors group-hover:text-slate-300"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {ontology.source && ontology.source !== 'import' && (
            <span className="badge-slate text-xs">
              <Tag size={10} />
              {ontology.source}
            </span>
          )}
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
              ontology.scope === 'private' && 'bg-slate-800 text-slate-400',
              ontology.scope === 'shared' && 'bg-blue-500/10 text-blue-400',
              ontology.scope === 'public' && 'bg-emerald-500/10 text-emerald-400'
            )}
          >
            <ScopeIcon size={10} />
            {scopeStyle.label}
          </span>
        </div>
      </div>

      {/* Name */}
      <h4 className="mb-1 text-sm font-semibold text-slate-200 transition-colors group-hover:text-slate-100">
        {ontology.name}
      </h4>

      {/* Description */}
      {ontology.description && (
        <p className="mb-3 line-clamp-2 text-xs text-slate-500">{ontology.description}</p>
      )}

      {/* Stats row */}
      <div className="mt-auto flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Hash size={12} />
          <span>{ontology.entityTypeCount} entity types</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Layers size={12} />
          <span>v{ontology.version}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-600">
          {formatDistanceToNow(new Date(ontology.updatedAt), { addSuffix: true })}
        </div>
        <ChevronRight
          size={14}
          className="text-slate-700 opacity-0 transition-opacity group-hover:opacity-100"
        />
      </div>
    </button>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function OntologyListPage() {
  const navigate = useNavigate()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useApiQuery<OntologiesResponse>(
    ['ontologies'],
    '/ontologies'
  )
  const allOntologies = data?.ontologies || []

  const filtered = allOntologies.filter((o) => {
    if (scopeFilter === 'shared') return o.scope === 'shared'
    if (scopeFilter === 'public') return o.scope === 'public'
    return true
  })

  async function handleDelete() {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await apiDelete(`/ontologies/${deleteTarget.id}`)
      queryClient.invalidateQueries({ queryKey: ['ontologies'] })
      setDeleteTarget(null)
    } catch {
      // silent
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportError(null)

    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown

      // Accept either a raw export object or { data: ... }
      const data =
        (parsed as Record<string, unknown>)['export'] || parsed

      await apiPost('/ontologies/import', { data })
      queryClient.invalidateQueries({ queryKey: ['ontologies'] })
    } catch (err) {
      setImportError('Failed to import ontology. Make sure the file is a valid Databorg ontology JSON.')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const SCOPE_TABS: { key: ScopeFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'mine', label: 'My Ontologies' },
    { key: 'shared', label: 'Shared' },
    { key: 'public', label: 'Public' },
  ]

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-100">Ontologies</h2>
          <p className="mt-1 text-sm text-slate-500">
            Define entity types, properties, and match rules for knowledge extraction.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImportFile}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="btn-secondary"
          >
            <Upload size={15} />
            Import
          </button>
          <button onClick={() => setShowCreateModal(true)} className="btn-primary">
            <Plus size={15} />
            New Ontology
          </button>
        </div>
      </div>

      {/* Import error */}
      {importError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{importError}</span>
        </div>
      )}

      {/* Scope filter tabs */}
      <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-slate-900/50 p-1 w-fit">
        {SCOPE_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setScopeFilter(tab.key)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-all',
              scopeFilter === tab.key
                ? 'bg-slate-700 text-slate-100 shadow-sm'
                : 'text-slate-500 hover:text-slate-300'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-4 py-24 text-center">
          <AlertCircle size={32} className="text-red-400" />
          <div>
            <p className="text-sm font-medium text-slate-300">Failed to load ontologies</p>
            <p className="mt-0.5 text-xs text-slate-500">Check your connection and try again.</p>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-24 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-800">
            <BookOpen size={24} className="text-slate-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-400">
              {allOntologies.length === 0 ? 'No ontologies yet' : 'No results for this filter'}
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              {allOntologies.length === 0
                ? 'Create an ontology or import one to define entity schemas'
                : 'Try a different scope filter'}
            </p>
          </div>
          {allOntologies.length === 0 && (
            <button onClick={() => setShowCreateModal(true)} className="btn-primary">
              <Plus size={15} />
              New Ontology
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((ontology) => (
            <OntologyCard
              key={ontology.id}
              ontology={ontology}
              onClick={() => navigate(`/ontologies/${ontology.id}`)}
              onDelete={(id, name) => setDeleteTarget({ id, name })}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreateModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(id) => {
            setShowCreateModal(false)
            navigate(`/ontologies/${id}`)
          }}
        />
      )}

      <ConfirmDeleteModal
        open={!!deleteTarget}
        title="Delete Ontology"
        description={`This will permanently delete "${deleteTarget?.name || ''}" and all its entity types, properties, and match rules. This cannot be undone.`}
        confirmPhrase="delete"
        confirmText="Delete Ontology"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        isDeleting={isDeleting}
      />
    </div>
  )
}

import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  BookOpen,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Download,
  AlertCircle,
  ArrowLeft,
  Tag,
  Sliders,
  FileJson,
  Star,
  type LucideIcon,
} from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'
import { cn } from '@/lib/utils'
import { apiPost, apiDelete, apiPut } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OntologyProperty {
  id: string
  entityTypeId: string
  name: string
  dataType: string
  required: boolean
  searchable: boolean
  weightInMatching: number
  createdAt: string
}

interface OntologyEntityType {
  id: string
  ontologyId: string
  qid: string | null
  name: string
  aliases: string[]
  description: string | null
  parentQid: string | null
  confidenceThreshold: number | null
  color: string | null
  createdAt: string
  properties: OntologyProperty[]
}

interface OntologyMatchRule {
  id: string
  ontologyId: string
  entityTypeA: string
  entityTypeB: string
  canMatch: boolean
  similarityMetric: string | null
  threshold: number | null
  blockingStrategy: string | null
  propertiesToMatch: string[]
  createdAt: string
}

interface OntologyDetail {
  id: string
  userId: string
  name: string
  description: string | null
  version: number
  scope: string
  source: string | null
  entityTypeCount: number
  entityTypes: OntologyEntityType[]
  matchRules: OntologyMatchRule[]
  createdAt: string
  updatedAt: string
}

interface OntologyDetailResponse {
  ontology: OntologyDetail
}

type ActiveTab = 'entity-types' | 'match-rules' | 'export'

// ─── Property Row ─────────────────────────────────────────────────────────────

function PropertyRow({
  property,
  ontologyId,
  onDeleted,
}: {
  property: OntologyProperty
  ontologyId: string
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      await apiDelete(`/ontologies/${ontologyId}/properties/${property.id}`)
      onDeleted()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs">
      <span className="flex-1 font-medium text-slate-300">{property.name}</span>
      <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-slate-400">
        {property.dataType}
      </span>
      {property.required && (
        <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-400">required</span>
      )}
      {property.searchable && (
        <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-400">searchable</span>
      )}
      <span className="text-slate-600">w={property.weightInMatching?.toFixed(1)}</span>
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 text-slate-600 hover:text-red-400"
        title="Delete property"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

// ─── Add Property Form ────────────────────────────────────────────────────────

function AddPropertyForm({
  ontologyId,
  entityTypeId,
  onAdded,
  onCancel,
}: {
  ontologyId: string
  entityTypeId: string
  onAdded: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [dataType, setDataType] = useState('string')
  const [required, setRequired] = useState(false)
  const [searchable, setSearchable] = useState(true)
  const [weight, setWeight] = useState('1.0')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await apiPost(`/ontologies/${ontologyId}/entity-types/${entityTypeId}/properties`, {
        name: name.trim(),
        dataType,
        required,
        searchable,
        weightInMatching: parseFloat(weight) || 1.0,
      })
      onAdded()
    } catch {
      setError('Failed to add property')
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2">
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input-field flex-1 text-xs py-1.5"
          placeholder="Property name"
          autoFocus
        />
        <select
          value={dataType}
          onChange={(e) => setDataType(e.target.value)}
          className="input-field text-xs py-1.5 w-28"
        >
          {['string', 'number', 'boolean', 'date', 'url', 'email', 'text'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          type="number"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          className="input-field text-xs py-1.5 w-16"
          placeholder="weight"
          min={0}
          max={10}
          step={0.1}
          title="Weight in matching"
        />
      </div>
      <div className="flex items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="rounded"
          />
          Required
        </label>
        <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={searchable}
            onChange={(e) => setSearchable(e.target.checked)}
            className="rounded"
          />
          Searchable
        </label>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={onCancel} className="btn-ghost text-xs py-1 px-2">Cancel</button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="btn-primary text-xs py-1 px-2"
          >
            {saving ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Entity Type Row ──────────────────────────────────────────────────────────

function EntityTypeRow({
  entityType,
  ontologyId,
  onRefresh,
}: {
  entityType: OntologyEntityType
  ontologyId: string
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [addingProp, setAddingProp] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDeleteType() {
    setDeleting(true)
    try {
      await apiDelete(`/ontologies/${ontologyId}/entity-types/${entityType.id}`)
      onRefresh()
    } finally {
      setDeleting(false)
    }
  }

  const dotColor = entityType.color || '#64748b'

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50">
      {/* Type header row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-3 text-left"
        >
          <div
            className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/10"
            style={{ backgroundColor: dotColor }}
          />
          <span className="font-medium text-slate-200">{entityType.name}</span>
          {entityType.qid && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-slate-500">
              {entityType.qid}
            </span>
          )}
          {entityType.aliases && entityType.aliases.length > 0 && (
            <div className="flex gap-1">
              {entityType.aliases.slice(0, 3).map((alias) => (
                <span
                  key={alias}
                  className="rounded-full bg-slate-800 px-1.5 py-0.5 text-xs text-slate-500"
                >
                  {alias}
                </span>
              ))}
              {entityType.aliases.length > 3 && (
                <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-xs text-slate-500">
                  +{entityType.aliases.length - 3}
                </span>
              )}
            </div>
          )}
          <span className="ml-auto text-xs text-slate-600">
            {entityType.properties.length} props ·{' '}
            threshold {((entityType.confidenceThreshold || 0.8) * 100).toFixed(0)}%
          </span>
          {expanded ? (
            <ChevronDown size={14} className="text-slate-500" />
          ) : (
            <ChevronRight size={14} className="text-slate-500" />
          )}
        </button>
        <button
          onClick={handleDeleteType}
          disabled={deleting}
          className="shrink-0 text-slate-600 transition-colors hover:text-red-400"
          title="Delete entity type"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Expanded: properties */}
      {expanded && (
        <div className="border-t border-slate-800 px-4 pb-4 pt-3 space-y-2">
          {entityType.description && (
            <p className="mb-3 text-xs text-slate-500">{entityType.description}</p>
          )}

          {entityType.properties.length > 0 ? (
            <div className="space-y-1.5">
              {entityType.properties.map((p) => (
                <PropertyRow
                  key={p.id}
                  property={p}
                  ontologyId={ontologyId}
                  onDeleted={onRefresh}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-600">No properties defined yet.</p>
          )}

          {addingProp ? (
            <AddPropertyForm
              ontologyId={ontologyId}
              entityTypeId={entityType.id}
              onAdded={() => {
                setAddingProp(false)
                onRefresh()
              }}
              onCancel={() => setAddingProp(false)}
            />
          ) : (
            <button
              onClick={() => setAddingProp(true)}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-400 transition-colors mt-2"
            >
              <Plus size={12} />
              Add property
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Add Entity Type Form ─────────────────────────────────────────────────────

function AddEntityTypeForm({
  ontologyId,
  onAdded,
  onCancel,
}: {
  ontologyId: string
  onAdded: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [qid, setQid] = useState('')
  const [aliases, setAliases] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#3b82f6')
  const [confidenceThreshold, setConfidenceThreshold] = useState('0.8')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await apiPost(`/ontologies/${ontologyId}/entity-types`, {
        name: name.trim(),
        qid: qid.trim() || undefined,
        aliases: aliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        description: description.trim() || undefined,
        color,
        confidenceThreshold: parseFloat(confidenceThreshold) || 0.8,
      })
      onAdded()
    } catch {
      setError('Failed to add entity type')
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
      <h4 className="text-sm font-medium text-slate-300">Add Entity Type</h4>
      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label text-xs">Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-field text-sm"
            placeholder="e.g. Company"
            autoFocus
          />
        </div>
        <div>
          <label className="label text-xs">QID (optional)</label>
          <input
            type="text"
            value={qid}
            onChange={(e) => setQid(e.target.value)}
            className="input-field text-sm"
            placeholder="e.g. Q4830453"
          />
        </div>
        <div>
          <label className="label text-xs">Aliases (comma-separated)</label>
          <input
            type="text"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            className="input-field text-sm"
            placeholder="org, organization"
          />
        </div>
        <div>
          <label className="label text-xs">Confidence Threshold</label>
          <input
            type="number"
            value={confidenceThreshold}
            onChange={(e) => setConfidenceThreshold(e.target.value)}
            className="input-field text-sm"
            min={0}
            max={1}
            step={0.05}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label className="label text-xs">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input-field text-sm"
            placeholder="What does this entity type represent?"
          />
        </div>
        <div>
          <label className="label text-xs">Color</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded-lg border border-slate-700 bg-slate-800 p-1"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} className="btn-secondary text-sm">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="btn-primary text-sm"
        >
          {saving ? 'Adding...' : 'Add Entity Type'}
        </button>
      </div>
    </div>
  )
}

// ─── Match Rules Tab ──────────────────────────────────────────────────────────

function MatchRulesTab({
  ontologyId,
  matchRules,
  entityTypes,
  onRefresh,
}: {
  ontologyId: string
  matchRules: OntologyMatchRule[]
  entityTypes: OntologyEntityType[]
  onRefresh: () => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [typeA, setTypeA] = useState('')
  const [typeB, setTypeB] = useState('')
  const [canMatch, setCanMatch] = useState(true)
  const [metric, setMetric] = useState('jaccard')
  const [threshold, setThreshold] = useState('0.85')
  const [propsToMatch, setPropsToMatch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const typeNames = entityTypes.map((et) => et.name)

  async function handleAddRule() {
    if (!typeA || !typeB) return
    setSaving(true)
    setError(null)
    try {
      await apiPost(`/ontologies/${ontologyId}/match-rules`, {
        entityTypeA: typeA,
        entityTypeB: typeB,
        canMatch,
        similarityMetric: metric,
        threshold: parseFloat(threshold) || 0.85,
        propertiesToMatch: propsToMatch
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      })
      setShowAdd(false)
      setTypeA('')
      setTypeB('')
      onRefresh()
    } catch {
      setError('Failed to add match rule')
      setSaving(false)
    }
  }

  async function handleDeleteRule(ruleId: string) {
    try {
      await apiDelete(`/ontologies/${ontologyId}/match-rules/${ruleId}`)
      onRefresh()
    } catch {
      // silent
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Define which entity types can be matched and how similarity is computed.
        </p>
        <button onClick={() => setShowAdd(true)} className="btn-primary">
          <Plus size={15} />
          Add Rule
        </button>
      </div>

      {showAdd && (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
          <h4 className="text-sm font-medium text-slate-300">New Match Rule</h4>
          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label text-xs">Entity Type A *</label>
              <select
                value={typeA}
                onChange={(e) => setTypeA(e.target.value)}
                className="input-field text-sm"
              >
                <option value="">Select type...</option>
                {typeNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className="label text-xs">Entity Type B *</label>
              <select
                value={typeB}
                onChange={(e) => setTypeB(e.target.value)}
                className="input-field text-sm"
              >
                <option value="">Select type...</option>
                {typeNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className="label text-xs">Similarity Metric</label>
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                className="input-field text-sm"
              >
                {['jaccard', 'cosine', 'levenshtein', 'trigram', 'exact'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label text-xs">Threshold (0–1)</label>
              <input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="input-field text-sm"
                min={0}
                max={1}
                step={0.05}
              />
            </div>
          </div>

          <div>
            <label className="label text-xs">Properties to Match (comma-separated)</label>
            <input
              type="text"
              value={propsToMatch}
              onChange={(e) => setPropsToMatch(e.target.value)}
              className="input-field text-sm"
              placeholder="name, email, phone"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={canMatch}
              onChange={(e) => setCanMatch(e.target.checked)}
              className="rounded"
            />
            Can match (uncheck to explicitly block matching)
          </label>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={() => setShowAdd(false)} className="btn-secondary text-sm">
              Cancel
            </button>
            <button
              onClick={handleAddRule}
              disabled={!typeA || !typeB || saving}
              className="btn-primary text-sm"
            >
              {saving ? 'Adding...' : 'Add Rule'}
            </button>
          </div>
        </div>
      )}

      {matchRules.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <Sliders size={28} className="text-slate-700" />
          <p className="text-sm text-slate-500">No match rules defined yet.</p>
          <p className="text-xs text-slate-600">Rules guide the FUSE engine on entity resolution.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-800">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50">
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500">Type A</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500">Type B</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500">Can Match</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500">Metric</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500">Threshold</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500">Properties</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {matchRules.map((rule) => (
                <tr
                  key={rule.id}
                  className="group border-b border-slate-800 last:border-0 hover:bg-slate-800/30 transition-colors"
                >
                  <td className="px-4 py-3 text-sm font-medium text-slate-300">{rule.entityTypeA}</td>
                  <td className="px-4 py-3 text-sm font-medium text-slate-300">{rule.entityTypeB}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        rule.canMatch
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-red-500/10 text-red-400'
                      )}
                    >
                      {rule.canMatch ? 'Yes' : 'Blocked'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {rule.similarityMetric || '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {rule.threshold != null ? (rule.threshold * 100).toFixed(0) + '%' : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {rule.propertiesToMatch && rule.propertiesToMatch.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {rule.propertiesToMatch.map((p) => (
                          <span
                            key={p}
                            className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-500"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-600">all</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleDeleteRule(rule.id)}
                      className="opacity-0 transition-opacity group-hover:opacity-100 text-slate-600 hover:text-red-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Export Tab ───────────────────────────────────────────────────────────────

function ExportTab({
  ontologyId,
  ontologyName,
}: {
  ontologyId: string
  ontologyName: string
}) {
  const [exporting, setExporting] = useState(false)
  const [exportData, setExportData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleExport() {
    setExporting(true)
    setError(null)
    try {
      const result = await apiPost<{ export: Record<string, unknown> }>(`/ontologies/${ontologyId}/export`, {})
      setExportData(result.export)
    } catch {
      setError('Export failed. Try again.')
    } finally {
      setExporting(false)
    }
  }

  function handleDownload() {
    if (!exportData) return
    const json = JSON.stringify(exportData, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${ontologyName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_ontology.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const previewJson = exportData
    ? JSON.stringify(exportData, null, 2).split('\n').slice(0, 30).join('\n') +
      (JSON.stringify(exportData, null, 2).split('\n').length > 30 ? '\n...' : '')
    : null

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-800">
            <FileJson size={20} className="text-slate-400" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-slate-200">Export as JSON</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Download the complete ontology including all entity types, properties, and match rules.
              The exported file can be re-imported into any Databorg instance.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={handleExport}
                disabled={exporting}
                className="btn-secondary"
              >
                {exporting ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300" />
                    Generating...
                  </>
                ) : (
                  <>
                    <FileJson size={15} />
                    Preview Export
                  </>
                )}
              </button>
              {exportData && (
                <button onClick={handleDownload} className="btn-primary">
                  <Download size={15} />
                  Download JSON
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {previewJson && (
        <div className="rounded-xl border border-slate-800 bg-slate-950">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
            <span className="text-xs font-medium text-slate-500">JSON Preview</span>
            <button onClick={handleDownload} className="btn-ghost text-xs py-1 px-2">
              <Download size={12} />
              Download
            </button>
          </div>
          <pre className="overflow-x-auto p-4 text-xs text-slate-400 leading-relaxed">
            {previewJson}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── Main Detail Page ─────────────────────────────────────────────────────────

export function OntologyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, updateUser } = useAuth()
  const [activeTab, setActiveTab] = useState<ActiveTab>('entity-types')
  const [showAddType, setShowAddType] = useState(false)
  const [settingDefault, setSettingDefault] = useState(false)

  const { data, isLoading, error, refetch } = useApiQuery<OntologyDetailResponse>(
    ['ontologies', id],
    `/ontologies/${id}`
  )

  const ontology = data?.ontology

  function handleRefresh() {
    void refetch()
  }

  async function handleSetDefault() {
    if (!id) return
    setSettingDefault(true)
    try {
      await apiPut('/users/me/settings', { defaultOntologyId: id })
      updateUser({ defaultOntologyId: id })
    } finally {
      setSettingDefault(false)
    }
  }

  const TABS: { key: ActiveTab; label: string; icon: LucideIcon }[] = [
    { key: 'entity-types', label: 'Entity Types', icon: Tag },
    { key: 'match-rules', label: 'Match Rules', icon: Sliders },
    { key: 'export', label: 'Export', icon: Download },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
      </div>
    )
  }

  if (error || !ontology) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <AlertCircle size={32} className="text-red-400" />
        <p className="text-sm text-slate-300">Ontology not found or failed to load.</p>
        <button onClick={() => navigate('/ontologies')} className="btn-secondary">
          <ArrowLeft size={15} />
          Back to Ontologies
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate('/ontologies')}
          className="mb-3 flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
        >
          <ArrowLeft size={14} />
          Ontologies
        </button>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800">
              <BookOpen size={19} className="text-slate-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-100">{ontology.name}</h2>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 font-medium',
                    ontology.scope === 'private' && 'bg-slate-800 text-slate-400',
                    ontology.scope === 'shared' && 'bg-blue-500/10 text-blue-400',
                    ontology.scope === 'public' && 'bg-emerald-500/10 text-emerald-400'
                  )}
                >
                  {ontology.scope}
                </span>
                <span>v{ontology.version}</span>
                <span>{ontology.entityTypeCount} entity types</span>
                {ontology.source && <span>{ontology.source}</span>}
              </div>
            </div>
          </div>
          <div>
            {user?.defaultOntologyId === id ? (
              <span className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-xs font-medium text-amber-400">
                <Star size={13} className="fill-amber-400" />
                Default Ontology
              </span>
            ) : (
              <button
                onClick={() => void handleSetDefault()}
                disabled={settingDefault}
                className="btn-secondary text-sm"
              >
                {settingDefault ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300" />
                    Setting...
                  </>
                ) : (
                  <>
                    <Star size={13} />
                    Set as Default
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {ontology.description && (
          <p className="mt-3 text-sm text-slate-500">{ontology.description}</p>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-slate-800">
        {TABS.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-all',
                activeTab === tab.key
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              )}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'entity-types' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">
              {ontology.entityTypes.length} entity type
              {ontology.entityTypes.length !== 1 ? 's' : ''} defined.
            </p>
            <button
              onClick={() => setShowAddType(true)}
              className="btn-primary"
            >
              <Plus size={15} />
              Add Entity Type
            </button>
          </div>

          {showAddType && (
            <AddEntityTypeForm
              ontologyId={ontology.id}
              onAdded={() => {
                setShowAddType(false)
                handleRefresh()
              }}
              onCancel={() => setShowAddType(false)}
            />
          )}

          {ontology.entityTypes.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Tag size={28} className="text-slate-700" />
              <p className="text-sm text-slate-500">No entity types yet.</p>
              <p className="text-xs text-slate-600">
                Add entity types to define what the ontology can extract.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {ontology.entityTypes.map((et) => (
                <EntityTypeRow
                  key={et.id}
                  entityType={et}
                  ontologyId={ontology.id}
                  onRefresh={handleRefresh}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'match-rules' && (
        <MatchRulesTab
          ontologyId={ontology.id}
          matchRules={ontology.matchRules}
          entityTypes={ontology.entityTypes}
          onRefresh={handleRefresh}
        />
      )}

      {activeTab === 'export' && (
        <ExportTab ontologyId={ontology.id} ontologyName={ontology.name} />
      )}
    </div>
  )
}

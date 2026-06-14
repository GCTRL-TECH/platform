import { useState, useEffect } from 'react'
import { Lock, Pencil, Trash2, Plus, X, Save } from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClassificationLevel {
  id: string
  name: string
  display_name: string
  rank: number
  color: string
  is_system: boolean
  icon: string | null
  description: string | null
}

interface LevelsResponse {
  levels: ClassificationLevel[]
}

interface LevelForm {
  name: string
  display_name: string
  rank: number
  color: string
  description: string
  icon: string
}

const DEFAULT_FORM: LevelForm = {
  name: '',
  display_name: '',
  rank: 100,
  color: '#6366f1',
  description: '',
  icon: '',
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ClassificationPage() {
  const [levels, setLevels] = useState<ClassificationLevel[] | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState<LevelForm>(DEFAULT_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<LevelForm>(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: queryData, isLoading } = useApiQuery<LevelsResponse>(
    ['classification', 'levels'],
    '/classification/levels',
  )

  // Seed local state from query once (on first load); after that mutations keep it fresh
  useEffect(() => {
    if (queryData?.levels && levels === null) {
      setLevels(queryData.levels)
    }
  }, [queryData, levels])

  const displayLevels = (levels ?? []).slice().sort((a, b) => a.rank - b.rank)
  const systemLevels = displayLevels.filter((l) => l.is_system)
  const customLevels = displayLevels.filter((l) => !l.is_system)

  // ── Add ──────────────────────────────────────────────────────────────────────

  async function handleAdd() {
    if (!addForm.name.trim() || !addForm.display_name.trim()) return
    setSaving(true); setError(null)
    try {
      const { data } = await api.post<ClassificationLevel>('/classification/levels', {
        name: addForm.name.trim().toUpperCase(),
        display_name: addForm.display_name.trim(),
        rank: addForm.rank,
        color: addForm.color,
        description: addForm.description.trim() || undefined,
        icon: addForm.icon.trim() || undefined,
      })
      setLevels((prev) => [...(prev ?? []), data])
      setShowAddForm(false)
      setAddForm(DEFAULT_FORM)
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to create level'
      )
    } finally {
      setSaving(false)
    }
  }

  // ── Edit ─────────────────────────────────────────────────────────────────────

  function startEdit(level: ClassificationLevel) {
    setEditingId(level.id)
    setEditForm({
      name: level.name,
      display_name: level.display_name,
      rank: level.rank,
      color: level.color,
      description: level.description ?? '',
      icon: level.icon ?? '',
    })
    setError(null)
  }

  async function handleSaveEdit(id: string) {
    setSaving(true); setError(null)
    try {
      const { data } = await api.put<ClassificationLevel>(`/classification/levels/${id}`, {
        name: editForm.name.trim().toUpperCase(),
        display_name: editForm.display_name.trim(),
        rank: editForm.rank,
        color: editForm.color,
        description: editForm.description.trim() || undefined,
        icon: editForm.icon.trim() || undefined,
      })
      setLevels((prev) =>
        (prev ?? []).map((l) => (l.id === id ? data : l))
      )
      setEditingId(null)
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to update level'
      )
    } finally {
      setSaving(false)
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this classification level?')) return
    setError(null)
    try {
      await api.delete(`/classification/levels/${id}`)
      setLevels((prev) => (prev ?? []).filter((l) => l.id !== id))
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to delete level'
      )
    }
  }

  // ─── Row renderer (shared by both groups) ─────────────────────────────────────

  function renderLevelRow(level: ClassificationLevel) {
    return (
      <tr key={level.id} className={cn('hover:bg-slate-800/30 transition-colors', editingId === level.id && 'bg-slate-800/40')}>
        {editingId === level.id ? (
          /* ── Edit row ── */
          <>
            <td className="px-3 py-2">
              <input
                type="color"
                value={editForm.color}
                onChange={(e) => setEditForm((f) => ({ ...f, color: e.target.value }))}
                className="h-6 w-8 cursor-pointer rounded border border-slate-700 bg-transparent"
              />
            </td>
            <td className="px-3 py-2">
              <input
                type="text"
                value={editForm.display_name}
                onChange={(e) => setEditForm((f) => ({ ...f, display_name: e.target.value }))}
                className="w-36 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 focus:border-indigo-500 focus:outline-none"
              />
            </td>
            <td className="px-3 py-2">
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                className="w-36 rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-200 focus:border-indigo-500 focus:outline-none"
              />
            </td>
            <td className="px-3 py-2">
              <input
                type="number"
                min={1}
                max={1000}
                value={editForm.rank}
                onChange={(e) => setEditForm((f) => ({ ...f, rank: Number(e.target.value) }))}
                className="w-16 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 focus:border-indigo-500 focus:outline-none"
              />
            </td>
            <td className="px-3 py-2" />
            <td className="px-3 py-2 text-right">
              <div className="flex items-center justify-end gap-1">
                <button
                  onClick={() => void handleSaveEdit(level.id)}
                  disabled={saving}
                  className="flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  <Save size={11} /> Save
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
                >
                  <X size={12} />
                </button>
              </div>
            </td>
          </>
        ) : (
          /* ── View row ── */
          <>
            <td className="px-3 py-2.5">
              <span
                className="inline-block h-4 w-4 rounded-full border border-white/10"
                style={{ backgroundColor: level.color }}
              />
            </td>
            <td className="px-3 py-2.5 font-medium text-slate-200">{level.display_name}</td>
            <td className="px-3 py-2.5 font-mono text-slate-400">{level.name}</td>
            <td className="px-3 py-2.5 text-slate-400">{level.rank}</td>
            <td className="px-3 py-2.5">
              {level.is_system ? (
                <span className="inline-flex items-center gap-1 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-400">
                  <Lock size={9} /> system
                </span>
              ) : null}
            </td>
            <td className="px-3 py-2.5 text-right">
              {!level.is_system && (
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => startEdit(level)}
                    className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
                    title="Edit"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => void handleDelete(level.id)}
                    className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
              {level.is_system && (
                <Lock size={11} className="ml-auto text-slate-700" />
              )}
            </td>
          </>
        )}
      </tr>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="card">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Data Classification Levels</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Manage ISO 27001-aligned classification levels. System levels cannot be modified.
            </p>
          </div>
          <button
            onClick={() => { setShowAddForm(true); setError(null) }}
            disabled={showAddForm}
            className="btn-primary"
          >
            <Plus size={14} />
            Add Custom Level
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)}><X size={12} /></button>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50">
                <th className="px-3 py-2 text-left font-medium text-slate-500">Color</th>
                <th className="px-3 py-2 text-left font-medium text-slate-500">Display Name</th>
                <th className="px-3 py-2 text-left font-medium text-slate-500">Name (code)</th>
                <th className="px-3 py-2 text-left font-medium text-slate-500">Rank</th>
                <th className="px-3 py-2 text-left font-medium text-slate-500">System</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {isLoading && levels === null ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">Loading...</td>
                </tr>
              ) : (
                <>
                  {/* Standard ISO 27001 levels (system, read-only) */}
                  <tr className="bg-slate-900/40">
                    <td colSpan={6} className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      Standard ISO 27001 Levels
                    </td>
                  </tr>
                  {systemLevels.map(renderLevelRow)}

                  {/* Custom levels */}
                  <tr className="bg-slate-900/40">
                    <td colSpan={6} className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      Custom Levels
                    </td>
                  </tr>
                  {customLevels.length === 0 && !showAddForm ? (
                    <tr>
                      <td colSpan={6} className="py-4 text-center text-[11px] text-slate-600">
                        No custom levels yet — click "Add Custom Level" to create one.
                      </td>
                    </tr>
                  ) : (
                    customLevels.map(renderLevelRow)
                  )}
                </>
              )}

              {/* ── Add row (inline form at bottom) ── */}
              {showAddForm && (
                <tr className="bg-indigo-950/20">
                  <td className="px-3 py-2">
                    <input
                      type="color"
                      value={addForm.color}
                      onChange={(e) => setAddForm((f) => ({ ...f, color: e.target.value }))}
                      className="h-6 w-8 cursor-pointer rounded border border-slate-700 bg-transparent"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={addForm.display_name}
                      onChange={(e) => setAddForm((f) => ({ ...f, display_name: e.target.value }))}
                      placeholder="Display Name"
                      autoFocus
                      className="w-36 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={addForm.name}
                      onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="NAME_CODE"
                      className="w-36 rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={addForm.rank}
                      onChange={(e) => setAddForm((f) => ({ ...f, rank: Number(e.target.value) }))}
                      className="w-16 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 focus:border-indigo-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={addForm.description}
                      onChange={(e) => setAddForm((f) => ({ ...f, description: e.target.value }))}
                      placeholder="Description (optional)"
                      className="w-40 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => void handleAdd()}
                        disabled={saving || !addForm.name.trim() || !addForm.display_name.trim()}
                        className="flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50"
                      >
                        <Save size={11} /> Save
                      </button>
                      <button
                        onClick={() => { setShowAddForm(false); setAddForm(DEFAULT_FORM); setError(null) }}
                        className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <p className="mt-3 text-[10px] text-slate-600">
          Standard ISO levels: PUBLIC (#22c55e), INTERNAL (#3b82f6), CONFIDENTIAL (#f59e0b), STRICTLY_CONFIDENTIAL (#ef4444).
          System levels are read-only.
        </p>
      </div>
    </div>
  )
}

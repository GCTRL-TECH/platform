import { useState } from 'react'
import { Loader2, Trash2, AlertTriangle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useApiQuery } from '@/hooks/useApi'
import { Modal } from '@/components/ui/Modal'

export interface JobFootprint {
  chunks?: { count: number }
  graphFootprint?: { nodes: number; nodesExclusive: number; rels: number; relsExclusive: number }
}

export interface UnlinkResult {
  ok: boolean
  purged: boolean
  refreshQueued: boolean
  nodesDeleted: number
  relationshipsDeleted: number
  chunksDeleted: number
  vectorsDeleted: number
}

export interface DeleteResult {
  ok: boolean
  chunksDeleted: number
  vectorsDeleted: number
  nodesDeleted: number
  relationshipsDeleted: number
  sourceDocumentsDeleted: number
  dossiersStaled: number
  compilationsUnlinked: number
}

export function describeUnlink(r: UnlinkResult): string {
  const parts = `${r.nodesDeleted} nodes, ${r.relationshipsDeleted} relationships, ${r.chunksDeleted} chunks and ${r.vectorsDeleted} vectors removed`
  return `${r.purged ? 'Extraction purged. ' : 'Removed from this knowledge base. '}${parts}.${r.refreshQueued ? ' A refresh was queued.' : ''}`
}

export function describeDelete(r: DeleteResult): string {
  return `Extraction deleted: ${r.nodesDeleted} nodes, ${r.relationshipsDeleted} relationships, ${r.chunksDeleted} chunks, ${r.vectorsDeleted} vectors and ${r.sourceDocumentsDeleted} source documents removed; ${r.compilationsUnlinked} knowledge bases unlinked.`
}

function errMsg(e: unknown): string {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Request failed'
}

function FootprintNumbers({ jobId, open }: { jobId: string; open: boolean }) {
  const { data, isLoading } = useApiQuery<{ job: JobFootprint }>(['kex', 'jobs', jobId], `/kex/jobs/${jobId}`, {
    enabled: open && !!jobId,
  })
  const fp = data?.job?.graphFootprint
  if (isLoading) return <p className="text-xs text-slate-500">Loading footprint...</p>
  if (!fp) return null
  return (
    <ul className="mt-3 space-y-1 rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-3 text-xs text-slate-300">
      <li>Chunks: <span className="font-mono text-slate-100">{data?.job?.chunks?.count ?? 0}</span></li>
      <li>Nodes: <span className="font-mono text-slate-100">{fp.nodes}</span> ({fp.nodesExclusive} exclusive)</li>
      <li>Relationships: <span className="font-mono text-slate-100">{fp.rels}</span> ({fp.relsExclusive} exclusive)</li>
    </ul>
  )
}

interface BaseProps {
  open: boolean
  jobId: string
  jobLabel?: string
  onClose: () => void
}

interface UnlinkProps extends BaseProps {
  compilationId: string
  compilationName?: string
  /** True when the job is linked to no other knowledge base. */
  isLastKb?: boolean
  onDone: (r: UnlinkResult) => void
}

export function UnlinkDialog({ open, jobId, jobLabel, compilationId, compilationName, isLastKb, onClose, onDone }: UnlinkProps) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const { data } = await api.post<UnlinkResult>(`/kex/jobs/${jobId}/unlink`, { compilationId })
      void qc.invalidateQueries({ queryKey: ['kex', 'jobs'] })
      void qc.invalidateQueries({ queryKey: ['kg'] })
      void qc.invalidateQueries({ queryKey: ['fuse', 'jobs'] })
      onDone(data)
      onClose()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Remove from knowledge base"
      size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            onClick={() => void run()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Remove
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-300">
        Remove <span className="font-medium text-slate-100">{jobLabel ?? 'this extraction'}</span> from{' '}
        <span className="font-medium text-slate-100">{compilationName ?? 'this knowledge base'}</span>?
      </p>
      <p className="mt-2 text-xs text-slate-500">
        Knowledge produced only by this extraction is deleted from the knowledge base. Shared elements stay.
        {isLastKb && ' This is the last knowledge base it belongs to, so everything it produced is purged.'}
      </p>
      <FootprintNumbers jobId={jobId} open={open} />
      {error && (
        <p className="mt-3 flex items-start gap-2 text-xs text-red-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{error}</p>
      )}
    </Modal>
  )
}

interface DeleteProps extends BaseProps {
  onDone: (r: DeleteResult) => void
}

export function DeleteEverywhereDialog({ open, jobId, jobLabel, onClose, onDone }: DeleteProps) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const { data } = await api.delete<DeleteResult>(`/kex/jobs/${jobId}`)
      void qc.invalidateQueries({ queryKey: ['kex', 'jobs'] })
      void qc.invalidateQueries({ queryKey: ['kg'] })
      onDone(data)
      onClose()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Delete everywhere"
      size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            onClick={() => void run()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete everywhere
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-300">
        Delete <span className="font-medium text-slate-100">{jobLabel ?? 'this extraction'}</span> and everything it produced from
        all knowledge bases? This cannot be undone.
      </p>
      <p className="mt-2 text-xs text-slate-500">Shared nodes and relationships that other extractions also produced stay.</p>
      <FootprintNumbers jobId={jobId} open={open} />
      {error && (
        <p className="mt-3 flex items-start gap-2 text-xs text-red-400"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{error}</p>
      )}
    </Modal>
  )
}

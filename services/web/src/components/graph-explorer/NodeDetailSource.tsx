/**
 * NodeDetailSource tab — most-recent source job + "Open in KEX" link.
 *
 * Note: Neo4j stores only the most recent _source_job on the entity, so this
 * is a single-job summary by design.
 */

import { ExternalLink, FileWarning, Layers } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useApiQuery } from '@/hooks/useApi'
import { SourceJobLabel, type SourceJobInfo } from '@/components/SourceJobLabel'
import type { EntityDetail } from './types'

interface KexJobsResponse {
  jobs?: SourceJobInfo[]
}

interface NodeDetailSourceProps {
  detail: EntityDetail | null
  isLoading: boolean
}

export function NodeDetailSource({ detail, isLoading }: NodeDetailSourceProps) {
  const navigate = useNavigate()
  const { data: kexData } = useApiQuery<KexJobsResponse>(['kex', 'jobs'], '/kex/jobs')
  const kexJobs = kexData?.jobs

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-500" />
      </div>
    )
  }

  const job = detail?.lastSourceJob
  if (!job?.id) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <FileWarning size={22} className="text-slate-700" />
        <p className="text-sm text-slate-500">
          No source job recorded for this entity.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-500 leading-relaxed">
        <Layers size={11} className="inline mr-1.5 -mt-0.5 text-slate-600" />
        Most-recent source job — Neo4j only stores the latest. Earlier sources
        contributing to this entity are visible in chunk metadata.
      </p>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
        <div className="px-3 py-3 border-b border-slate-800">
          <SourceJobLabel jobId={job.id} jobs={kexJobs} />
        </div>
        <div className="px-3 py-2.5 space-y-1.5">
          {job.source && (
            <div className="flex items-baseline gap-2 text-xs">
              <span className="w-16 text-[10px] uppercase tracking-wide text-slate-500">
                Source
              </span>
              <span className="text-slate-300 break-all">{job.source}</span>
            </div>
          )}
          {job.createdAt && (
            <div className="flex items-baseline gap-2 text-xs">
              <span className="w-16 text-[10px] uppercase tracking-wide text-slate-500">
                Created
              </span>
              <span className="text-slate-300">{job.createdAt}</span>
            </div>
          )}
          <div className="flex items-baseline gap-2 text-xs">
            <span className="w-16 text-[10px] uppercase tracking-wide text-slate-500">
              Job ID
            </span>
            <span className="font-mono text-[10px] text-slate-500 break-all">
              {job.id}
            </span>
          </div>
        </div>

        <div className="border-t border-slate-800 px-3 py-2">
          <button
            onClick={() => navigate(`/kex/${job.id}`)}
            className="w-full flex items-center justify-center gap-1.5 rounded-md bg-indigo-500/10 border border-indigo-500/40 px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors"
          >
            Open in KEX
            <ExternalLink size={11} />
          </button>
        </div>
      </div>
    </div>
  )
}

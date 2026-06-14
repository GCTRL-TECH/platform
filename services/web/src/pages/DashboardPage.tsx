import { useNavigate } from 'react-router-dom'
import { Zap, Network, ArrowRight, Clock, type LucideIcon } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useAuth } from '@/hooks/useAuth'
import { useApiQuery } from '@/hooks/useApi'
import { cn } from '@/lib/utils'

interface KexJob {
  id: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  input?: string
}

interface KexJobsResponse {
  jobs: KexJob[]
}

interface StatCardProps {
  label: string
  value: string | number
  icon: LucideIcon
  iconColor: string
  iconBg: string
  badge?: string
  badgeColor?: string
}

function StatCard({ label, value, icon: Icon, iconColor, iconBg, badge, badgeColor }: StatCardProps) {
  return (
    <div className="card flex items-start gap-4">
      <div className={cn('flex h-11 w-11 items-center justify-center rounded-xl', iconBg)}>
        <Icon size={20} className={iconColor} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate-500">{label}</p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-100">{value}</span>
          {badge && (
            <span className={cn('badge text-xs', badgeColor)}>
              {badge}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

const STATUS_BADGE: Record<string, { className: string; label: string }> = {
  pending: { className: 'badge-yellow', label: 'Pending' },
  processing: { className: 'badge-blue', label: 'Processing' },
  completed: { className: 'badge-green', label: 'Completed' },
  failed: { className: 'badge-red', label: 'Failed' },
}

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const { data: jobsData, isLoading: jobsLoading } = useApiQuery<KexJobsResponse>(
    ['kex', 'jobs'],
    '/kex/jobs'
  )
  const { data: compsData } = useApiQuery<{ compilations: unknown[] }>(
    ['kg', 'compilations'],
    '/kg/compilations'
  )

  const jobs = jobsData?.jobs ?? []
  const recentJobs = jobs.slice(0, 5)
  const completedJobs = jobs.filter((j) => j.status === 'completed').length
  const graphCount = compsData?.compilations?.length ?? 0

  return (
    <div className="space-y-8 animate-slide-up">
      {/* Welcome */}
      <div>
        <h2 className="text-2xl font-bold text-slate-100">
          Welcome back, {user?.name?.split(' ')[0] ?? 'there'}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Here's what's happening in your knowledge workspace.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="Total Extractions"
          value={jobs?.length ?? 0}
          icon={Zap}
          iconColor="text-blue-400"
          iconBg="bg-blue-500/10"
          badge={completedJobs > 0 ? `${completedJobs} completed` : undefined}
          badgeColor="badge-green"
        />
        <StatCard
          label="Knowledge Graphs"
          value={graphCount}
          icon={Network}
          iconColor="text-violet-400"
          iconBg="bg-violet-500/10"
        />
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/kex')}
          className="btn-primary"
        >
          <Zap size={15} />
          New Extraction
        </button>
        <button
          onClick={() => navigate('/graphs')}
          className="btn-secondary"
        >
          <Network size={14} />
          Browse Graphs
        </button>
      </div>

      {/* Recent Jobs */}
      <div className="card p-0 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <h3 className="text-sm font-semibold text-slate-200">Recent Extractions</h3>
          <button
            onClick={() => navigate('/kex')}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-400 transition-colors"
          >
            View all
            <ArrowRight size={13} />
          </button>
        </div>

        {jobsLoading ? (
          <div className="flex items-center justify-center py-12">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
          </div>
        ) : recentJobs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800">
              <Zap size={20} className="text-slate-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-400">No extractions yet</p>
              <p className="mt-0.5 text-xs text-slate-600">Run your first extraction to get started</p>
            </div>
            <button onClick={() => navigate('/kex')} className="btn-primary mt-1">
              Start extracting
            </button>
          </div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-800 bg-slate-900/50">
              <tr>
                <th className="table-header">Type</th>
                <th className="table-header">Status</th>
                <th className="table-header">Created</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {recentJobs.map((job) => {
                const statusInfo = STATUS_BADGE[job.status] ?? { className: 'badge-slate', label: job.status }
                return (
                  <tr key={job.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="table-cell">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-800">
                          <Zap size={13} className="text-blue-400" />
                        </div>
                        <span className="font-medium text-slate-300 capitalize">{job.type}</span>
                      </div>
                    </td>
                    <td className="table-cell">
                      <span className={statusInfo.className}>{statusInfo.label}</span>
                    </td>
                    <td className="table-cell">
                      <div className="flex items-center gap-1.5 text-slate-500">
                        <Clock size={13} />
                        {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                      </div>
                    </td>
                    <td className="table-cell text-right">
                      <button
                        onClick={() => navigate(`/kex/${job.id}`)}
                        className="text-xs text-slate-500 hover:text-blue-400 transition-colors"
                      >
                        View →
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

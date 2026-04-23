import { useState, useEffect } from 'react'
import { Coins, TrendingDown, BarChart3, Clock, Zap, ArrowUpRight } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface BalanceData {
  balance: number
  tier: string
  tierLimit: number
}

interface UsageSummary {
  byAction: Array<{ action: string; totalSpent: number; count: number }>
  byDay: Array<{ date: string; totalSpent: number; count: number }>
  total: { tokensSpent: number; actions: number }
  period: { days: number; since: string }
}

interface UsageEntry {
  id: string
  action: string
  tokensSpent: number
  jobId: string | null
  createdAt: string
}

const TIER_COLORS: Record<string, string> = {
  free: 'text-slate-400',
  starter: 'text-blue-400',
  pro: 'text-purple-400',
  enterprise: 'text-amber-400',
}

const ACTION_LABELS: Record<string, string> = {
  kex_extract: 'KEX Extract',
  kex_upload: 'KEX Upload',
  fuse_merge: 'FUSE Merge',
  rag_query: 'RAG Query',
  kg_refresh: 'KG Refresh',
  connector_sync: 'Connector Sync',
}

export default function TokenDashboard() {
  const [balance, setBalance] = useState<BalanceData | null>(null)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [recentUsage, setRecentUsage] = useState<UsageEntry[]>([])
  const [days, setDays] = useState(30)

  useEffect(() => {
    void loadData()
  }, [days])

  async function loadData() {
    try {
      const [balRes, sumRes, usageRes] = await Promise.all([
        api.get('/billing/balance'),
        api.get(`/billing/usage/summary?days=${days}`),
        api.get(`/billing/usage?days=${days}`),
      ])
      setBalance(balRes.data)
      setSummary(sumRes.data)
      setRecentUsage(usageRes.data.usage || [])
    } catch (err) {
      console.error('Failed to load billing data:', err)
    }
  }

  const usagePercent = balance
    ? Math.min(100, ((balance.tierLimit - balance.balance) / balance.tierLimit) * 100)
    : 0

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Token Dashboard</h1>
          <p className="text-sm text-slate-500">Monitor your GCTRL usage and token balance</p>
        </div>
        <div className="flex gap-2">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                d === days
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Top Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Balance */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Coins size={14} />
            Token Balance
          </div>
          <p className="mt-2 text-3xl font-bold text-slate-100">
            {balance?.balance?.toLocaleString() ?? '...'}
          </p>
          <div className="mt-3">
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Used</span>
              <span>{Math.round(usagePercent)}%</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-slate-800">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  usagePercent > 80 ? 'bg-red-500' : usagePercent > 50 ? 'bg-amber-500' : 'bg-emerald-500'
                )}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Tier */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Zap size={14} />
            Current Tier
          </div>
          <p className={cn('mt-2 text-3xl font-bold capitalize', TIER_COLORS[balance?.tier ?? 'free'])}>
            {balance?.tier ?? '...'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {balance?.tierLimit?.toLocaleString() ?? '...'} tokens/month
          </p>
        </div>

        {/* Spent This Period */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <TrendingDown size={14} />
            Spent ({days}d)
          </div>
          <p className="mt-2 text-3xl font-bold text-slate-100">
            {summary?.total.tokensSpent?.toLocaleString() ?? '0'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {summary?.total.actions?.toLocaleString() ?? '0'} actions
          </p>
        </div>

        {/* Daily Average */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <BarChart3 size={14} />
            Daily Average
          </div>
          <p className="mt-2 text-3xl font-bold text-slate-100">
            {summary ? Math.round((summary.total.tokensSpent || 0) / days).toLocaleString() : '0'}
          </p>
          <p className="mt-1 text-xs text-slate-500">tokens/day</p>
        </div>
      </div>

      {/* Usage by Action */}
      {summary && summary.byAction.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-200">Usage by Action</h2>
          <div className="space-y-3">
            {summary.byAction.map((item) => {
              const maxSpent = Math.max(...summary.byAction.map((a) => a.totalSpent))
              const pct = maxSpent > 0 ? (item.totalSpent / maxSpent) * 100 : 0
              return (
                <div key={item.action}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-300">
                      {ACTION_LABELS[item.action] || item.action}
                    </span>
                    <span className="text-slate-500">
                      {item.totalSpent} tokens ({item.count} actions)
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-indigo-500/60"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Daily Usage Chart (simple bar representation) */}
      {summary && summary.byDay.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-200">Daily Usage</h2>
          <div className="flex items-end gap-1" style={{ height: 120 }}>
            {summary.byDay.map((day) => {
              const maxDay = Math.max(...summary.byDay.map((d) => d.totalSpent))
              const height = maxDay > 0 ? (day.totalSpent / maxDay) * 100 : 0
              const dateStr = new Date(day.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })
              return (
                <div
                  key={day.date}
                  className="group relative flex-1"
                  style={{ minWidth: 4 }}
                >
                  <div
                    className="w-full rounded-t bg-indigo-500/50 transition-colors hover:bg-indigo-400/70"
                    style={{ height: `${Math.max(height, 2)}%` }}
                  />
                  <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[9px] text-slate-300 whitespace-nowrap group-hover:block z-10">
                    {dateStr}: {day.totalSpent} tokens
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Recent Activity */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <h2 className="mb-4 text-sm font-semibold text-slate-200">Recent Activity</h2>
        {recentUsage.length === 0 ? (
          <p className="text-xs text-slate-500">No usage recorded yet</p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {recentUsage.slice(0, 50).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between rounded-lg px-3 py-2 text-xs hover:bg-slate-800/50"
              >
                <div className="flex items-center gap-3">
                  <Clock size={12} className="text-slate-600" />
                  <span className="font-medium text-slate-300">
                    {ACTION_LABELS[entry.action] || entry.action}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-slate-500">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <span className="font-mono text-red-400">-{entry.tokensSpent}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upgrade CTA */}
      {balance && balance.tier !== 'enterprise' && (
        <div className="flex items-center justify-between rounded-xl border border-indigo-900/30 bg-indigo-950/20 p-5">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">Need more tokens?</h3>
            <p className="mt-1 text-xs text-slate-500">
              Upgrade your tier for more monthly tokens and premium features.
            </p>
          </div>
          <button className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition-colors">
            Upgrade
            <ArrowUpRight size={12} />
          </button>
        </div>
      )}
    </div>
  )
}


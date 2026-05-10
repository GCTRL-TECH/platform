import { Bell, Coins } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useApiQuery } from '@/hooks/useApi'
import { cn } from '@/lib/utils'

interface HeaderProps {
  title: string
}

const TIER_COLORS: Record<string, string> = {
  free: 'badge-slate',
  starter: 'badge-blue',
  pro: 'badge-green',
  enterprise: 'badge-yellow',
}

interface BalanceResponse {
  balance: number
  tier: string
  tierLimit: number
}

export function Header({ title }: HeaderProps) {
  const { user } = useAuth()

  // Live balance: refetches every 10s and on window focus.
  // Auth context's user.tokensBalance is set once at login; without this
  // the header keeps stale numbers after extractions/merges deduct tokens.
  const { data: balanceData } = useApiQuery<BalanceResponse>(
    ['billing', 'balance'],
    '/billing/balance',
    {
      enabled: !!user,
      refetchInterval: 10_000,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    }
  )

  const liveBalance = balanceData?.balance ?? user?.tokensBalance ?? 0
  const liveTier = balanceData?.tier ?? user?.tier ?? 'free'
  const tierBadgeClass = TIER_COLORS[liveTier] ?? 'badge-slate'

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6 backdrop-blur-sm">
      {/* Page title */}
      <h1 className="text-lg font-semibold text-slate-100">{title}</h1>

      {/* Right section */}
      <div className="flex items-center gap-3">
        {/* Token balance — live, refetched every 10s */}
        {user && (
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5">
            <Coins size={14} className="text-amber-400" />
            <span className="text-sm font-medium text-slate-200">
              {liveBalance.toLocaleString()}
            </span>
            <span className="text-xs text-slate-500">tokens</span>
            {liveTier && (
              <span className={cn(tierBadgeClass, 'ml-1 text-[10px]')}>
                {liveTier}
              </span>
            )}
          </div>
        )}

        {/* Notification bell */}
        <button className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors">
          <Bell size={16} />
          {/* Notification dot placeholder */}
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-blue-500" />
        </button>
      </div>
    </header>
  )
}

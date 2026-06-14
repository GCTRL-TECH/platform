import { useApiQuery } from './useApi'
import { useAuth } from './useAuth'

export interface TokenBalance {
  balance: number
  tier: string
  tierLimit: number
}

/**
 * Single source of truth for the user's token balance across the entire app.
 *
 * Every component that displays "tokens remaining" (Header, Settings account
 * tab, Settings license tab, License card) MUST use this hook so the number is
 * identical everywhere and updates in lockstep.
 *
 * Backed by `GET /billing/balance`, which returns the real-time license-plane
 * balance: `credits_allocated - credits_used - unsynced_token_usage`. This is
 * the same value that reconciles with the central license server once the
 * heartbeat ships pending usage.
 *
 * The shared TanStack-Query key `['billing','balance']` means all callers read
 * one cache entry — one fetch, one number, refetched together every 10s.
 */
export function useTokenBalance() {
  const { user } = useAuth()

  const query = useApiQuery<TokenBalance>(
    ['billing', 'balance'],
    '/billing/balance',
    {
      enabled: !!user,
      refetchInterval: 10_000,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  )

  // Fall back to the login-time snapshot only until the first live fetch lands.
  const balance = query.data?.balance ?? user?.tokensBalance ?? 0
  const tier = query.data?.tier ?? user?.tier ?? 'free'
  const tierLimit = query.data?.tierLimit ?? 0

  return { balance, tier, tierLimit, isLoading: query.isLoading, query }
}

export const CREDIT_COSTS = {
  kex_ner: 1,
  kex_extract: 25,
  fuse_merge: 10,
  talk_query: 5,
} as const;

export type CreditAction = keyof typeof CREDIT_COSTS;

export const TIER_MONTHLY_CREDITS: Record<string, number> = {
  free: 3_000,
  starter: 25_000,
  pro: 100_000,
  enterprise: 999_999_999,
};

export const TIER_OVERDRAFT_LIMITS: Record<string, number> = {
  free: 0,
  starter: -5_000,
  pro: -10_000,
  enterprise: -999_999,
};

export const TIER_RATE_LIMITS: Record<string, number> = {
  free: 1,
  starter: 3,
  pro: 10,
  enterprise: 999,
};

export function calculateCredits(action: CreditAction, chars: number): number {
  const costPer1000 = CREDIT_COSTS[action];
  if (action === 'fuse_merge' || action === 'talk_query') {
    return costPer1000;
  }
  return Math.ceil((chars / 1000) * costPer1000);
}

export const CREDIT_COSTS = {
  kex_ner: 1,
  kex_extract: 25,
  fuse_merge: 10,
  talk_query: 5,
} as const;

export type CreditAction = keyof typeof CREDIT_COSTS;

// Unlimited paid tiers use a large integer sentinel because credits_balance is
// an INTEGER column and cannot hold Infinity. The authoritative "never deny"
// behaviour comes from isUnlimitedTier() below, not from this number.
export const TIER_MONTHLY_CREDITS: Record<string, number> = {
  free: 1_000_000,
  business: 999_999_999,
  enterprise: 999_999_999,
};

/**
 * True for tiers that get unlimited credits and must NEVER be denied for
 * insufficient balance.
 *
 * `starter`/`pro` are transitional aliases for the old paid tiers: they are
 * still accepted here until the DB migration has renamed every row to
 * `business`, after which they can be dropped. Case-insensitive.
 */
export function isUnlimitedTier(tier: string): boolean {
  const t = (tier ?? '').toLowerCase();
  return t === 'business' || t === 'enterprise' || t === 'starter' || t === 'pro';
}

/**
 * Monthly credit grant for a tier, safe against legacy/unknown tier strings.
 * Unlimited tiers (incl. the starter/pro aliases) resolve to the sentinel;
 * anything unrecognised falls back to the free grant so a stale tier can never
 * produce an undefined/NaN balance.
 */
export function monthlyCreditsFor(tier: string): number {
  if (isUnlimitedTier(tier)) return TIER_MONTHLY_CREDITS.business;
  return TIER_MONTHLY_CREDITS[(tier ?? '').toLowerCase()] ?? TIER_MONTHLY_CREDITS.free;
}

export const TIER_OVERDRAFT_LIMITS: Record<string, number> = {
  free: 0,
  business: -999_999_999,
  enterprise: -999_999_999,
};

export const TIER_RATE_LIMITS: Record<string, number> = {
  free: 1,
  business: 100,
  enterprise: 999,
};

export function calculateCredits(action: CreditAction, chars: number): number {
  const costPer1000 = CREDIT_COSTS[action];
  if (action === 'fuse_merge' || action === 'talk_query') {
    return costPer1000;
  }
  return Math.ceil((chars / 1000) * costPer1000);
}

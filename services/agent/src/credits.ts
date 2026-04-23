export const CREDIT_COSTS = {
  kex_ner: 1,
  kex_extract: 25,
  fuse_merge: 10,
  talk_query: 5,
} as const;

export type CreditAction = keyof typeof CREDIT_COSTS;

export function calculateCredits(action: CreditAction, chars: number): number {
  const cost = CREDIT_COSTS[action];
  if (action === 'fuse_merge' || action === 'talk_query') return cost;
  return Math.ceil((chars / 1000) * cost);
}

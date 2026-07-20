import Stripe from 'stripe';
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' });

export const STRIPE_PRICES: Record<string, { tier: string; credits: number }> = {
  // The old "pro" price is now the single paid "business" price (unlimited).
  // Fall back to the legacy STRIPE_PRICE_PRO env var so existing deployments
  // keep resolving until they set STRIPE_PRICE_BUSINESS. The starter price/tier
  // has been removed.
  [process.env.STRIPE_PRICE_BUSINESS ?? process.env.STRIPE_PRICE_PRO ?? '']: { tier: 'business', credits: 999_999_999 },
};

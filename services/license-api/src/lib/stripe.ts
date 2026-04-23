import Stripe from 'stripe';
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' });

export const STRIPE_PRICES: Record<string, { tier: string; credits: number }> = {
  [process.env.STRIPE_PRICE_STARTER ?? '']: { tier: 'starter', credits: 25_000 },
  [process.env.STRIPE_PRICE_PRO ?? '']: { tier: 'pro', credits: 100_000 },
};

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { stripe, STRIPE_PRICES } from '../lib/stripe.js';
import { db } from '../db/index.js';
import { users, licenses } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { generateLicenseKey } from '../lib/licenseKey.js';
import { sendEmail } from '../lib/email.js';
import { TIER_MONTHLY_CREDITS, TIER_OVERDRAFT_LIMITS } from '../lib/credits.js';

const router = Router();

router.post('/v1/webhooks/stripe', async (req: Request, res: Response): Promise<void> => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    if (!userId) { res.json({ ok: true }); return; }

    const priceId = (session as any).line_items?.data?.[0]?.price?.id ?? '';
    const tierInfo = STRIPE_PRICES[priceId] ?? { tier: 'starter', credits: 25_000 };

    await db.update(users)
      .set({
        tier: tierInfo.tier,
        creditsBalance: TIER_MONTHLY_CREDITS[tierInfo.tier],
        overdraftLimit: TIER_OVERDRAFT_LIMITS[tierInfo.tier],
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: session.subscription as string,
      })
      .where(eq(users.id, userId));

    const key = generateLicenseKey();
    await db.insert(licenses).values({ userId, licenseKey: key, tier: tierInfo.tier, status: 'inactive' });

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    await sendEmail('license_issued', user.email, { licenseKey: key, tier: tierInfo.tier });
    await sendEmail('subscription_confirmed', user.email, { tier: tierInfo.tier });
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    await db.update(users)
      .set({ tier: 'free', creditsBalance: TIER_MONTHLY_CREDITS['free'], overdraftLimit: 0 })
      .where(eq(users.stripeSubscriptionId, sub.id));
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    if (invoice.billing_reason === 'subscription_cycle') {
      const subId = typeof invoice.subscription === 'string' ? invoice.subscription : (invoice.subscription as any)?.id;
      if (subId) {
        const [user] = await db.select().from(users).where(eq(users.stripeSubscriptionId, subId)).limit(1);
        if (user) {
          await db.update(users)
            .set({ creditsBalance: TIER_MONTHLY_CREDITS[user.tier] })
            .where(eq(users.id, user.id));
        }
      }
    }
  }

  res.json({ ok: true });
});

export default router;

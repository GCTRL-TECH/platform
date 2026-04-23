import { Request, Response, NextFunction } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { users, tokenUsage } from '../models/schema.js';

export const tokenCost = (cost: number, action?: string) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = req.user.sub;

    // Check balance
    const [user] = await db
      .select({ tokensBalance: users.tokensBalance })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    if (user.tokensBalance < cost) {
      res.status(402).json({
        error: 'Insufficient token balance',
        balance: user.tokensBalance,
        required: cost,
      });
      return;
    }

    // Hook into response to deduct only on success (2xx)
    const originalJson = res.json.bind(res);

    res.json = (body: unknown) => {
      const statusCode = res.statusCode;

      if (statusCode >= 200 && statusCode < 300) {
        // Deduct tokens and log asynchronously - don't block the response
        const actionName = action ?? req.path.replace(/^\//, '').replace(/\//g, '_');
        const jobId: string | undefined =
          typeof body === 'object' && body !== null && 'jobId' in body
            ? (body as Record<string, unknown>)['jobId'] as string
            : undefined;

        setImmediate(async () => {
          try {
            await db.transaction(async (tx) => {
              await tx
                .update(users)
                .set({
                  tokensBalance: sql`${users.tokensBalance} - ${cost}`,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, userId));

              await tx.insert(tokenUsage).values({
                userId,
                action: actionName,
                tokensSpent: cost,
                jobId: jobId ?? null,
              });
            });
          } catch (err) {
            console.error('[tokenMeter] Failed to deduct tokens:', err);
          }
        });
      }

      return originalJson(body);
    };

    next();
  };
};

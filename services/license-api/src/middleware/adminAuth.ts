import { Request, Response, NextFunction } from 'express';
import { verifyLicenseJWT } from '../lib/jwt.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const claims = await verifyLicenseJWT(auth.slice(7));
    const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    if (!user || user.role !== 'admin') {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    (req as any).adminUser = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

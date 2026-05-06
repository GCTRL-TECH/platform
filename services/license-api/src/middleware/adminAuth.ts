import { Request, Response, NextFunction } from 'express';
import { jwtVerify } from 'jose';
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

  const token = auth.slice(7);

  // Try HS256 session JWT (portal browser login)
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const { payload } = await jwtVerify(token, secret);
    const [user] = await db.select().from(users).where(eq(users.id, payload.sub!)).limit(1);
    if (user?.role === 'admin' && !user.suspended) {
      (req as any).adminUser = user;
      next();
      return;
    }
    res.status(403).json({ error: 'Admin only' });
    return;
  } catch {
    // Not a valid HS256 JWT — fall through to RS256
  }

  // Try RS256 license JWT (machine / legacy admin)
  try {
    const claims = await verifyLicenseJWT(token);
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

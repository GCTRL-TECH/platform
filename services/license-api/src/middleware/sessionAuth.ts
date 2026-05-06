import { Request, Response, NextFunction } from 'express';
import { jwtVerify } from 'jose';

function getSecret() {
  return new TextEncoder().encode(process.env.JWT_SECRET!);
}

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  tier: string;
}

declare global {
  namespace Express {
    interface Request {
      sessionUser?: SessionUser;
    }
  }
}

export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { payload } = await jwtVerify(auth.slice(7), getSecret());
    req.sessionUser = {
      id: payload.sub!,
      email: payload['email'] as string,
      role: payload['role'] as string,
      tier: payload['tier'] as string,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

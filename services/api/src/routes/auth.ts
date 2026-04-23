import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { users } from '../models/schema.js';
import { config } from '../config.js';
import { validate } from '../middleware/validate.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/mail.js';
import { JwtPayload } from '../middleware/auth.js';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  name: z.string().min(1, 'Name is required').max(255, 'Name is too long').trim(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
});

const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const signAccessToken = (user: {
  id: string;
  email: string;
  role: JwtPayload['role'];
  clearance: JwtPayload['clearance'];
}): string => {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      clearance: user.clearance,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiresIn }
  );
};

const signRefreshToken = (userId: string): string => {
  return jwt.sign({ sub: userId }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  });
};

const safeUser = (user: {
  id: string;
  email: string;
  name: string;
  role: string;
  clearance: string;
  emailVerified: boolean;
  tokensBalance: number;
  tier: string;
  createdAt: Date;
}) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  clearance: user.clearance,
  emailVerified: user.emailVerified,
  tokensBalance: user.tokensBalance,
  tier: user.tier,
  createdAt: user.createdAt,
});

// ─── POST /register ───────────────────────────────────────────────────────────

router.post(
  '/register',
  validate(registerSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { email, password, name } = req.body as z.infer<typeof registerSchema>;

    try {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

      if (existing.length > 0) {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      const verificationToken = randomBytes(32).toString('hex');

      const [user] = await db
        .insert(users)
        .values({
          email: email.toLowerCase(),
          passwordHash,
          name,
          verificationToken,
        })
        .returning();

      if (!user) {
        res.status(500).json({ error: 'Failed to create user' });
        return;
      }

      // Send verification email - don't block registration on mail failure
      sendVerificationEmail(user.email, verificationToken).catch((err) => {
        console.error('[auth] Failed to send verification email:', err);
      });

      res.status(201).json({ user: safeUser(user) });
    } catch (err) {
      console.error('[auth/register]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /login ─────────────────────────────────────────────────────────────

router.post(
  '/login',
  validate(loginSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;

    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

      if (!user) {
        // Constant-time response to prevent user enumeration
        await bcrypt.hash('dummy', 1);
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      const passwordValid = await bcrypt.compare(password, user.passwordHash);

      if (!passwordValid) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      const token = signAccessToken(user);
      const refreshToken = signRefreshToken(user.id);

      res.json({ token, refreshToken, user: safeUser(user) });
    } catch (err) {
      console.error('[auth/login]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /refresh ────────────────────────────────────────────────────────────

router.post(
  '/refresh',
  validate(refreshSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;

    try {
      const payload = jwt.verify(
        refreshToken,
        config.jwt.refreshSecret
      ) as { sub: string };

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1);

      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }

      const token = signAccessToken(user);
      const newRefreshToken = signRefreshToken(user.id);

      res.json({ token, refreshToken: newRefreshToken, user: safeUser(user) });
    } catch (err) {
      if (
        err instanceof jwt.TokenExpiredError ||
        err instanceof jwt.JsonWebTokenError
      ) {
        res.status(401).json({ error: 'Invalid or expired refresh token' });
      } else {
        console.error('[auth/refresh]', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }
);

// ─── POST /forgot-password ────────────────────────────────────────────────────

router.post(
  '/forgot-password',
  validate(forgotPasswordSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as z.infer<typeof forgotPasswordSchema>;

    // Always return 200 to prevent user enumeration
    const GENERIC_RESPONSE = {
      message: 'If that email exists, a reset link has been sent.',
    };

    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

      if (!user) {
        res.json(GENERIC_RESPONSE);
        return;
      }

      const resetToken = randomBytes(32).toString('hex');
      const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db
        .update(users)
        .set({ resetToken, resetTokenExpires, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      sendPasswordResetEmail(user.email, resetToken).catch((err) => {
        console.error('[auth] Failed to send password reset email:', err);
      });

      res.json(GENERIC_RESPONSE);
    } catch (err) {
      console.error('[auth/forgot-password]', err);
      res.json(GENERIC_RESPONSE); // Still don't leak errors
    }
  }
);

// ─── POST /reset-password ─────────────────────────────────────────────────────

router.post(
  '/reset-password',
  validate(resetPasswordSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { token, password } = req.body as z.infer<typeof resetPasswordSchema>;

    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.resetToken, token))
        .limit(1);

      if (!user || !user.resetToken || !user.resetTokenExpires) {
        res.status(400).json({ error: 'Invalid or expired reset token' });
        return;
      }

      if (user.resetTokenExpires < new Date()) {
        res.status(400).json({ error: 'Reset token has expired' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

      await db
        .update(users)
        .set({
          passwordHash,
          resetToken: null,
          resetTokenExpires: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      res.json({ message: 'Password reset successfully' });
    } catch (err) {
      console.error('[auth/reset-password]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /verify-email ───────────────────────────────────────────────────────

router.post(
  '/verify-email',
  validate(verifyEmailSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body as z.infer<typeof verifyEmailSchema>;

    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.verificationToken, token))
        .limit(1);

      if (!user) {
        res.status(400).json({ error: 'Invalid verification token' });
        return;
      }

      if (user.emailVerified) {
        res.json({ message: 'Email already verified' });
        return;
      }

      await db
        .update(users)
        .set({
          emailVerified: true,
          verificationToken: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      res.json({ message: 'Email verified successfully' });
    } catch (err) {
      console.error('[auth/verify-email]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;

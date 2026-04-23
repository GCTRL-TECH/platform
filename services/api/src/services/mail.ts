import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config.js';

let transporter: Transporter | null = null;

const getTransporter = (): Transporter => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: false,
      ignoreTLS: true,
    });
  }
  return transporter;
};

const FROM_ADDRESS = '"GCTRL" <noreply@GCTRL.local>';

export const sendVerificationEmail = async (
  to: string,
  token: string
): Promise<void> => {
  const verifyUrl = `${config.frontendUrl}/verify-email?token=${token}`;

  await getTransporter().sendMail({
    from: FROM_ADDRESS,
    to,
    subject: 'Verify your GCTRL account',
    html: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #1a1a2e; border-bottom: 2px solid #6c63ff; padding-bottom: 16px;">
            Welcome to GCTRL
          </h1>
          <p style="color: #333; font-size: 16px; line-height: 1.6;">
            Thanks for signing up. Please verify your email address to activate your account.
          </p>
          <a href="${verifyUrl}"
             style="display: inline-block; margin: 24px 0; padding: 14px 32px;
                    background-color: #6c63ff; color: white; text-decoration: none;
                    border-radius: 6px; font-size: 16px; font-weight: 600;">
            Verify Email
          </a>
          <p style="color: #666; font-size: 14px;">
            Or copy this link: <a href="${verifyUrl}" style="color: #6c63ff;">${verifyUrl}</a>
          </p>
          <p style="color: #999; font-size: 12px; margin-top: 40px; border-top: 1px solid #eee; padding-top: 16px;">
            If you did not create a GCTRL account, you can safely ignore this email.
          </p>
        </body>
      </html>
    `,
    text: `Welcome to GCTRL!\n\nVerify your email: ${verifyUrl}\n\nIf you did not sign up, ignore this email.`,
  });
};

export const sendPasswordResetEmail = async (
  to: string,
  token: string,
  resetUrl?: string
): Promise<void> => {
  const url = resetUrl ?? `${config.frontendUrl}/reset-password?token=${token}`;

  await getTransporter().sendMail({
    from: FROM_ADDRESS,
    to,
    subject: 'Reset your GCTRL password',
    html: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #1a1a2e; border-bottom: 2px solid #6c63ff; padding-bottom: 16px;">
            Password Reset
          </h1>
          <p style="color: #333; font-size: 16px; line-height: 1.6;">
            We received a request to reset your GCTRL password.
            Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.
          </p>
          <a href="${url}"
             style="display: inline-block; margin: 24px 0; padding: 14px 32px;
                    background-color: #6c63ff; color: white; text-decoration: none;
                    border-radius: 6px; font-size: 16px; font-weight: 600;">
            Reset Password
          </a>
          <p style="color: #666; font-size: 14px;">
            Or copy this link: <a href="${url}" style="color: #6c63ff;">${url}</a>
          </p>
          <p style="color: #999; font-size: 12px; margin-top: 40px; border-top: 1px solid #eee; padding-top: 16px;">
            If you did not request a password reset, you can safely ignore this email.
            Your password will not be changed.
          </p>
        </body>
      </html>
    `,
    text: `Reset your GCTRL password:\n\n${url}\n\nThis link expires in 1 hour.\n\nIf you did not request this, ignore this email.`,
  });
};


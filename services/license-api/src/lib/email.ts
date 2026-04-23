import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM = 'GCTRL <no-reply@gctrl.tech>';

type EmailTemplate =
  | 'welcome' | 'verify_email' | 'password_reset'
  | 'license_issued' | 'subscription_confirmed'
  | 'low_credits' | 'credits_exhausted'
  | 'update_available' | 'update_required'
  | 'license_expiring' | 'license_cancelled';

const subjects: Record<EmailTemplate, string> = {
  welcome: 'Welcome to Ground Control',
  verify_email: 'Verify your email',
  password_reset: 'Reset your password',
  license_issued: 'Your GCTRL License Key',
  subscription_confirmed: 'Subscription activated',
  low_credits: 'Credits running low',
  credits_exhausted: 'Credits exhausted',
  update_available: 'GCTRL update available',
  update_required: 'Action required: GCTRL update',
  license_expiring: 'Subscription renews in 3 days',
  license_cancelled: 'Subscription cancelled',
};

function renderBody(template: EmailTemplate, data: Record<string, unknown>): string {
  const base = (content: string) => `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">Ground Control</h2>
      ${content}
      <hr style="margin-top:32px;border:none;border-top:1px solid #eee"/>
      <p style="color:#888;font-size:12px">gctrl.tech — structured knowledge, locally owned</p>
    </div>`;

  switch (template) {
    case 'license_issued':
      return base(`
        <p>Your license key for the <strong>${data['tier']}</strong> plan:</p>
        <pre style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:18px;letter-spacing:2px">${data['licenseKey']}</pre>
        <p>Install GCTRL with:</p>
        <pre style="background:#1a1a1a;color:#fff;padding:16px;border-radius:8px">curl -fsSL https://gctrl.tech/install | bash</pre>
        <p>You will be prompted to enter the key above.</p>`);
    case 'low_credits':
      return base(`<p>Your GCTRL credit balance is running low: <strong>${data['balance']} credits remaining</strong>.</p>
        <a href="https://gctrl.tech/billing" style="background:#6366f1;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Top up credits</a>`);
    case 'update_required':
      return base(`<p>A required update for GCTRL is available (v${data['version']}).</p>
        <p><strong>Action required by ${data['deadline']}:</strong></p>
        <pre style="background:#1a1a1a;color:#fff;padding:16px;border-radius:8px">curl -fsSL https://gctrl.tech/update | bash</pre>
        <p>${data['changelog']}</p>`);
    case 'license_cancelled':
      return base(`<p>Your GCTRL subscription has been cancelled.</p>
        <p>Your installation will continue to work until <strong>${data['graceEndsAt']}</strong>.</p>
        <a href="https://gctrl.tech/billing" style="background:#6366f1;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Reactivate</a>`);
    default:
      return base(`<p>${JSON.stringify(data)}</p>`);
  }
}

export async function sendEmail(
  template: EmailTemplate,
  to: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to,
    subject: subjects[template],
    html: renderBody(template, data),
  });
}

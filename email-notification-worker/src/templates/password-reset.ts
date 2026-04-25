import type { RenderedTemplate } from '../types';
import { escapeHtml, safeUrl } from '../template-engine';

export function passwordReset(data: Record<string, unknown>): RenderedTemplate {
  const name = escapeHtml(data.name ?? 'there');
  const resetUrl = safeUrl(data.resetUrl, 'https://example.com/reset');
  const safeResetUrl = escapeHtml(resetUrl);
  const expiresMinutes = Number(data.expiresMinutes ?? 30);

  const subject = 'Reset your password';

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
    <h1 style="margin: 0 0 16px;">Password reset</h1>
    <p>Hi ${name}, we received a request to reset the password for this email address.</p>
    <p>Click the button below to choose a new password. This link expires in ${expiresMinutes} minutes.</p>
    <p style="margin-top: 24px;">
      <a href="${safeResetUrl}" style="background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Reset password</a>
    </p>
    <p style="margin-top: 24px; color: #555; font-size: 14px;">Or paste this URL into your browser:<br><span style="word-break: break-all;">${safeResetUrl}</span></p>
    <p style="margin-top: 32px; color: #888; font-size: 12px;">If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
  </body>
</html>`;

  const text = `Password reset

Hi ${data.name ?? 'there'}, we received a request to reset the password for this email address.

Reset your password (link expires in ${expiresMinutes} minutes):
${resetUrl}

If you didn't request a password reset, you can safely ignore this email.`;

  return { subject, html, text };
}

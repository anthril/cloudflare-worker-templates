import type { RenderedTemplate } from '../types';
import { escapeHtml, safeUrl } from '../template-engine';

export function welcome(data: Record<string, unknown>): RenderedTemplate {
  const name = escapeHtml(data.name ?? 'there');
  const productName = escapeHtml(data.productName ?? 'our product');
  const ctaUrl = safeUrl(data.ctaUrl);
  const safeCtaUrl = escapeHtml(ctaUrl);

  const subject = `Welcome to ${String(data.productName ?? 'our product')}`;

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
    <h1 style="margin: 0 0 16px;">Welcome, ${name}!</h1>
    <p>Thanks for signing up for ${productName}. Here are a few things you can do next:</p>
    <ul>
      <li>Explore your dashboard</li>
      <li>Invite teammates</li>
      <li>Read the getting-started guide</li>
    </ul>
    <p style="margin-top: 24px;">
      <a href="${safeCtaUrl}" style="background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Get started</a>
    </p>
    <p style="margin-top: 32px; color: #888; font-size: 12px;">If this wasn't you, you can safely ignore this email.</p>
  </body>
</html>`;

  const text = `Welcome, ${data.name ?? 'there'}!

Thanks for signing up for ${data.productName ?? 'our product'}.

Get started: ${ctaUrl}

If this wasn't you, you can safely ignore this email.`;

  return { subject, html, text };
}

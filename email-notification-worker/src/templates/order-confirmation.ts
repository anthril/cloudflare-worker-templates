import type { RenderedTemplate } from '../types';
import { escapeHtml, safeUrl } from '../template-engine';

interface LineItem {
  name: string;
  qty: number;
  price: string;
}

export function orderConfirmation(data: Record<string, unknown>): RenderedTemplate {
  const orderNumber = escapeHtml(data.orderNumber ?? 'N/A');
  const customerName = escapeHtml(data.customerName ?? 'Customer');
  const total = escapeHtml(data.total ?? '0.00');
  const currency = escapeHtml(data.currency ?? 'USD');
  // safeUrl returns the fallback for missing/invalid URLs. Use an empty
  // fallback so the "Track shipment" CTA is suppressed rather than pointing
  // to a placeholder domain when trackingUrl isn't supplied.
  const trackingUrl = typeof data.trackingUrl === 'string' ? safeUrl(data.trackingUrl, '') : '';

  const items = Array.isArray(data.items) ? (data.items as LineItem[]) : [];
  const itemsHtml = items
    .map(
      (item) =>
        `<tr>
           <td style="padding: 8px 0;">${escapeHtml(item.name)} &times;${escapeHtml(item.qty)}</td>
           <td style="padding: 8px 0; text-align: right;">${escapeHtml(item.price)}</td>
         </tr>`
    )
    .join('');
  const itemsText = items.map((item) => `  - ${item.name} x${item.qty} — ${item.price}`).join('\n');

  const subject = `Order #${String(data.orderNumber ?? 'N/A')} confirmed`;

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
    <h1 style="margin: 0 0 16px;">Thanks for your order, ${customerName}!</h1>
    <p>We've received order <strong>#${orderNumber}</strong> and are getting it ready.</p>
    <table style="width: 100%; border-top: 1px solid #eee; border-bottom: 1px solid #eee; margin: 16px 0;">
      ${itemsHtml}
      <tr>
        <td style="padding: 12px 0; border-top: 1px solid #eee;"><strong>Total</strong></td>
        <td style="padding: 12px 0; border-top: 1px solid #eee; text-align: right;"><strong>${total} ${currency}</strong></td>
      </tr>
    </table>
    ${trackingUrl ? `<p><a href="${escapeHtml(trackingUrl)}" style="background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Track shipment</a></p>` : ''}
    <p style="margin-top: 32px; color: #888; font-size: 12px;">Need help? Just reply to this email.</p>
  </body>
</html>`;

  const text = `Thanks for your order, ${data.customerName ?? 'Customer'}!

Order #${data.orderNumber ?? 'N/A'}
${itemsText}

Total: ${data.total ?? '0.00'} ${data.currency ?? 'USD'}
${trackingUrl ? `\nTrack shipment: ${trackingUrl}` : ''}

Need help? Just reply to this email.`;

  return { subject, html, text };
}

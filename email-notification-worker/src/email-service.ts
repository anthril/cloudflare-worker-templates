import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, Env, SendResult } from './types';
import { renderTemplate } from './template-engine';

const REQUIRED_SMTP_SECRETS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'DKIM_PRIVATE_KEY',
  'DKIM_SELECTOR',
  'DKIM_DOMAIN',
  'FROM_EMAIL',
  'FROM_NAME',
] as const;

/**
 * Build a nodemailer transport configured for the current env.
 *
 * Fails fast if any required secret is missing so the error surfaces in logs
 * once at batch start instead of being buried in an SMTP-level failure for
 * every message in the batch.
 *
 * On Cloudflare Workers, nodemailer's SMTP transport connects via
 * node:net / node:tls — routed through cloudflare:sockets by the
 * `nodejs_compat` polyfill. Port 465 uses implicit TLS; 587 uses STARTTLS
 * (nodemailer negotiates automatically when `secure=false`).
 */
export function buildTransport(env: Env): Transporter {
  for (const key of REQUIRED_SMTP_SECRETS) {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `Missing required secret: ${key}. Set it with: wrangler secret put ${key}`
      );
    }
  }

  const port = Number(env.SMTP_PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid SMTP_PORT: ${env.SMTP_PORT}`);
  }

  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
    // nodemailer DKIM-signs the outgoing message using this private key.
    // The receiving MTA verifies by fetching the matching public key from
    // <DKIM_SELECTOR>._domainkey.<DKIM_DOMAIN> TXT — see scripts/setup-dns.ts.
    dkim: {
      domainName: env.DKIM_DOMAIN,
      keySelector: env.DKIM_SELECTOR,
      privateKey: env.DKIM_PRIVATE_KEY,
    },
  });
}

/**
 * Render the message's template and hand it to nodemailer for delivery.
 * Throws on SMTP / transport errors — the caller retries via the Queue.
 *
 * Pass the same `transporter` for every message in a batch to avoid
 * re-negotiating TLS per send.
 */
export async function sendEmail(
  transporter: Transporter,
  msg: EmailMessage,
  env: Env
): Promise<SendResult> {
  const rendered = renderTemplate(msg.template, msg.templateData);

  const info = await transporter.sendMail({
    from: `"${env.FROM_NAME}" <${env.FROM_EMAIL}>`,
    to: msg.recipient,
    replyTo: env.REPLY_TO_EMAIL,
    subject: msg.subject ?? rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      'X-Entity-Ref-ID': msg.message_id,
      ...(msg.idempotency_key ? { 'X-Idempotency-Key': msg.idempotency_key } : {}),
    },
  });

  return {
    providerMessageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}

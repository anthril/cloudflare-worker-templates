/**
 * Email Notification Worker
 *
 * Queue-driven email sender. Exposes:
 *   POST /send              Enqueue an email (bearer auth, idempotent)
 *   GET  /status/:id        Look up delivery status for a message_id
 *   GET  /health            Health check
 *
 * The same worker also consumes from the `email-notifications` queue and
 * performs the actual SMTP send via nodemailer. Failed sends retry with
 * capped exponential backoff (sourced from msg.attempts so the counter
 * persists across deliveries), eventually landing in
 * `email-notifications-dlq`.
 */

import type { EmailMessage, Env, SendRequest } from './types';
import { checkAuth } from './auth';
import { validateSendRequest } from './validation';
import { checkAndSetIdempotency } from './idempotency';
import { insertQueued, markFailed, markSent } from './delivery-log';
import { buildTransport, sendEmail } from './email-service';
import { json, preflight } from './utils';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight();

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({
        status: 'ok',
        service: 'email-notification-worker',
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === '/send' && request.method === 'POST') {
      return handleSend(request, env);
    }

    const statusMatch = url.pathname.match(/^\/status\/([A-Za-z0-9-]+)$/);
    if (statusMatch && request.method === 'GET') {
      const authError = checkAuth(request, env);
      if (authError) return authError;
      return handleStatus(statusMatch[1], env);
    }

    return json({ error: 'Not found' }, 404);
  },

  async queue(batch: MessageBatch<EmailMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`[Queue] Processing batch of ${batch.messages.length} messages`);

    // Build the transport once per batch and reuse it across sends so we
    // don't re-negotiate TLS for every message. If the transport can't be
    // built (missing secret, bad port), fail every message in the batch
    // with the same clear error so the retry or DLQ path is consistent.
    let transporter;
    try {
      transporter = buildTransport(env);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Queue] Cannot build SMTP transport: ${errMsg}`);
      for (const msg of batch.messages) {
        await markFailed(env, msg.body.message_id, errMsg, msg.attempts);
        env.EMAIL_METRICS.writeDataPoint({
          blobs: ['failed', msg.body.template, msg.body.recipient],
          doubles: [1, msg.attempts],
          indexes: [msg.body.message_id],
        });
        msg.retry({ delaySeconds: computeBackoffSeconds(msg.attempts) });
      }
      return;
    }

    for (const msg of batch.messages) {
      const body = msg.body;
      const attempt = msg.attempts;

      try {
        console.log(`[Queue] Sending ${body.message_id} (template=${body.template}, attempt=${attempt})`);
        const result = await sendEmail(transporter, body, env);
        await markSent(env, body.message_id, result.providerMessageId);

        env.EMAIL_METRICS.writeDataPoint({
          blobs: ['sent', body.template, body.recipient],
          doubles: [1, attempt],
          indexes: [body.message_id],
        });

        console.log(`[Queue] Sent ${body.message_id} (provider_id=${result.providerMessageId ?? 'n/a'})`);
        msg.ack();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Queue] Send failed for ${body.message_id} (attempt ${attempt}):`, errMsg);

        await markFailed(env, body.message_id, errMsg, attempt);

        env.EMAIL_METRICS.writeDataPoint({
          blobs: ['failed', body.template, body.recipient],
          doubles: [1, attempt],
          indexes: [body.message_id],
        });

        msg.retry({ delaySeconds: computeBackoffSeconds(attempt) });
      }
    }
  },
} satisfies ExportedHandler<Env, EmailMessage>;

async function handleSend(request: Request, env: Env): Promise<Response> {
  const authError = checkAuth(request, env);
  if (authError) return authError;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const validation = validateSendRequest(parsed);
  if (!validation.ok) return json({ error: validation.error }, 400);

  const req: SendRequest = validation.value;

  if (req.idempotency_key) {
    const seen = await checkAndSetIdempotency(env, req.idempotency_key);
    if (seen) {
      return json(
        { status: 'duplicate', idempotency_key: req.idempotency_key },
        200
      );
    }
  }

  const messageId = crypto.randomUUID();
  await insertQueued(env, messageId, req);

  const message: EmailMessage = {
    message_id: messageId,
    recipient: req.recipient,
    subject: req.subject,
    template: req.template,
    templateData: req.templateData ?? {},
    idempotency_key: req.idempotency_key,
    enqueued_at: new Date().toISOString(),
  };

  try {
    await env.EMAIL_QUEUE.send(message);
  } catch (err) {
    console.error(`[Send] Failed to enqueue ${messageId}:`, err);
    await markFailed(env, messageId, `enqueue failed: ${err instanceof Error ? err.message : String(err)}`, 0);
    return json({ error: 'Failed to enqueue' }, 500);
  }

  return json({ status: 'queued', message_id: messageId }, 202);
}

async function handleStatus(messageId: string, env: Env): Promise<Response> {
  const row = await env.DELIVERY_LOG
    .prepare(
      `select message_id, recipient, template, subject, status,
              provider_message_id, attempts, last_error,
              idempotency_key, created_at, updated_at
         from deliveries
        where message_id = ?`
    )
    .bind(messageId)
    .first();

  if (!row) return json({ error: 'Not found' }, 404);
  return json({ delivery: row });
}

/**
 * Capped exponential backoff driven by the Cloudflare Queue's own attempt
 * counter (msg.attempts is 1 on first delivery, 2 on first retry, etc.):
 *
 *   attempt 1 -> 60s
 *   attempt 2 -> 120s
 *   attempt 3 -> 240s
 *   attempt 4 -> 480s
 *   attempt 5 -> 960s
 *   attempt 6+ -> 3600s (cap)
 */
function computeBackoffSeconds(attempt: number): number {
  const base = 60;
  const value = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(value, 3600);
}

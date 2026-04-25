import type { Env, SendRequest } from './types';

/** Insert a new delivery row in the 'queued' state. Called by the HTTP producer. */
export async function insertQueued(env: Env, messageId: string, req: SendRequest): Promise<void> {
  await env.DELIVERY_LOG
    .prepare(
      `insert into deliveries
         (message_id, recipient, template, subject, status, attempts, idempotency_key)
       values (?, ?, ?, ?, 'queued', 0, ?)`
    )
    .bind(
      messageId,
      req.recipient,
      req.template,
      req.subject ?? null,
      req.idempotency_key ?? null
    )
    .run();
}

/** Mark a delivery as sent and record the provider's message id. */
export async function markSent(
  env: Env,
  messageId: string,
  providerMessageId: string | undefined
): Promise<void> {
  await env.DELIVERY_LOG
    .prepare(
      `update deliveries
          set status = 'sent',
              provider_message_id = ?,
              attempts = attempts + 1,
              updated_at = datetime('now')
        where message_id = ?`
    )
    .bind(providerMessageId ?? null, messageId)
    .run();
}

/** Mark a delivery as failed and record the error. Attempts is bumped each call. */
export async function markFailed(
  env: Env,
  messageId: string,
  error: string,
  attempt: number
): Promise<void> {
  await env.DELIVERY_LOG
    .prepare(
      `update deliveries
          set status = 'failed',
              last_error = ?,
              attempts = ?,
              updated_at = datetime('now')
        where message_id = ?`
    )
    .bind(error.slice(0, 2000), attempt, messageId)
    .run();
}

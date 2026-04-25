import type { Env } from './types';

const NAMESPACE = 'idem:';
const DEFAULT_TTL_SECONDS = 86_400; // 24h

/**
 * SETNX-style idempotency check against KV.
 *
 * Returns true if the key was already seen (caller should respond "duplicate").
 * Returns false if this is a fresh key — in which case the key has now been
 * written and subsequent calls within the TTL window will return true.
 *
 * Note: KV is eventually consistent; a race between two near-simultaneous
 * requests with the same key may briefly let both through. For stronger
 * guarantees, layer a Durable Object in front of this — but for email
 * idempotency, KV's window is typically sufficient given the SMTP send
 * latency already dominates.
 */
export async function checkAndSetIdempotency(env: Env, key: string): Promise<boolean> {
  const storageKey = NAMESPACE + key;
  const existing = await env.IDEMPOTENCY.get(storageKey);
  if (existing !== null) return true;

  const ttl = parseTtl(env.IDEMPOTENCY_TTL_SECONDS);
  await env.IDEMPOTENCY.put(storageKey, new Date().toISOString(), { expirationTtl: ttl });
  return false;
}

function parseTtl(raw: string | undefined): number {
  if (!raw) return DEFAULT_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 60) return DEFAULT_TTL_SECONDS;
  return Math.floor(parsed);
}

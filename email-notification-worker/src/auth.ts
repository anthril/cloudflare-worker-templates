import type { Env } from './types';
import { json } from './utils';

/**
 * Bearer-token check for POST /send. Returns a Response on failure, null on success.
 * Uses constant-time comparison to avoid leaking token length via timing.
 */
export function checkAuth(request: Request, env: Env): Response | null {
  if (!env.API_BEARER_TOKEN) {
    return json(
      { error: 'API_BEARER_TOKEN not configured. Set it with: npx wrangler secret put API_BEARER_TOKEN' },
      500
    );
  }

  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const presented = header.slice('Bearer '.length);
  if (!timingSafeEqual(presented, env.API_BEARER_TOKEN)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) result |= aBytes[i] ^ bBytes[i];
  return result === 0;
}

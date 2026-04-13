/**
 * WooCommerce Product Embedding Worker
 *
 * Handles:
 * 1. Scheduled (cron): Automatic WooCommerce → Vectorize product sync
 * 2. POST /sync-products: Manual trigger for product sync (auth required)
 * 3. GET /status: Last sync status and stats
 * 4. POST /validate: Test all external credentials (auth required)
 * 5. GET /health: Health check
 */

import type { Env } from './types';
import { syncAllProducts } from './sync-products';

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log(`[Cron] Product sync triggered at ${new Date().toISOString()}`);
    ctx.waitUntil(
      syncAllProducts(env)
        .then(result => console.log('[Cron] Product sync result:', JSON.stringify(result)))
        .catch(err => console.error('[Cron] Product sync failed:', err))
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({
        status: 'ok',
        service: 'woocommerce-product-sync',
        timestamp: new Date().toISOString(),
      });
    }

    // GET /status — last sync info (no auth required, aggregate stats only)
    if (url.pathname === '/status' && request.method === 'GET') {
      const lastSync = await env.PRODUCT_DATA.get('_sync:latest', 'json');
      return Response.json({
        service: 'woocommerce-product-sync',
        last_sync: lastSync || null,
        timestamp: new Date().toISOString(),
      });
    }

    // POST /sync-products — manual sync trigger (auth required)
    if (url.pathname === '/sync-products' && request.method === 'POST') {
      const authError = checkAuth(request, env);
      if (authError) return authError;

      console.log('[Manual] Product sync triggered');
      ctx.waitUntil(
        syncAllProducts(env)
          .then(result => console.log('[Manual] Product sync result:', JSON.stringify(result)))
          .catch(err => console.error('[Manual] Product sync failed:', err))
      );
      return Response.json({ status: 'sync_started', message: 'Product sync is running in the background' });
    }

    // POST /validate — test all credentials (auth required)
    if (url.pathname === '/validate' && request.method === 'POST') {
      const authError = checkAuth(request, env);
      if (authError) return authError;

      const results = await validateCredentials(env);
      const allOk = results.woocommerce.ok && results.openai.ok && results.vectorize.ok;
      return Response.json(results, { status: allOk ? 200 : 502 });
    }

    return new Response('Not found', { status: 404 });
  },
};

/**
 * Check bearer token auth. Returns a Response if auth fails, null if auth passes.
 */
function checkAuth(request: Request, env: Env): Response | null {
  if (!env.SYNC_AUTH_TOKEN) {
    return Response.json(
      { error: 'SYNC_AUTH_TOKEN secret not configured. Set it with: npx wrangler secret put SYNC_AUTH_TOKEN' },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.SYNC_AUTH_TOKEN}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

/**
 * Test all external credentials without triggering a full sync.
 */
async function validateCredentials(env: Env): Promise<{
  woocommerce: { ok: boolean; error?: string; product_count?: number };
  openai: { ok: boolean; error?: string };
  vectorize: { ok: boolean; error?: string; vector_count?: number };
}> {
  // Test WooCommerce API
  let woocommerce: { ok: boolean; error?: string; product_count?: number };
  try {
    const auth = btoa(`${env.WOOCOMMERCE_KEY}:${env.WOOCOMMERCE_SECRET}`);
    const res = await fetch(
      `${env.WOOCOMMERCE_URL}/wp-json/wc/v3/products?per_page=1&status=publish`,
      { headers: { 'Authorization': `Basic ${auth}` } }
    );
    if (res.ok) {
      const totalProducts = parseInt(res.headers.get('X-WP-Total') || '0', 10);
      woocommerce = { ok: true, product_count: totalProducts };
    } else {
      const errorText = await res.text().catch(() => 'Unknown error');
      woocommerce = { ok: false, error: `HTTP ${res.status}: ${errorText.substring(0, 200)}` };
    }
  } catch (err) {
    woocommerce = { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }

  // Test OpenAI Embeddings API
  let openai: { ok: boolean; error?: string };
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'test' }),
    });
    if (res.ok) {
      openai = { ok: true };
    } else {
      const errorText = await res.text().catch(() => 'Unknown error');
      openai = { ok: false, error: `HTTP ${res.status}: ${errorText.substring(0, 200)}` };
    }
  } catch (err) {
    openai = { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }

  // Test Vectorize index
  let vectorize: { ok: boolean; error?: string; vector_count?: number };
  try {
    const info = await env.PRODUCTS_INDEX.describe();
    vectorize = { ok: true, vector_count: info.vectorCount };
  } catch (err) {
    vectorize = { ok: false, error: err instanceof Error ? err.message : 'Index not accessible' };
  }

  return { woocommerce, openai, vectorize };
}

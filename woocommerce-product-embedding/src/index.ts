/**
 * WooCommerce Product Embedding Worker
 *
 * Handles:
 * 1. Scheduled (cron): Weekly full WooCommerce → Vectorize product sync
 * 2. POST /sync-products: Manual trigger for product sync
 * 3. GET /health: Health check
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

    if (url.pathname === '/sync-products' && request.method === 'POST') {
      console.log('[Manual] Product sync triggered');
      ctx.waitUntil(
        syncAllProducts(env)
          .then(result => console.log('[Manual] Product sync result:', JSON.stringify(result)))
          .catch(err => console.error('[Manual] Product sync failed:', err))
      );
      return Response.json({ status: 'sync_started', message: 'Product sync is running in the background' });
    }

    return new Response('Not found', { status: 404 });
  },
};

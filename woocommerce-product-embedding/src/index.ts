/**
 * WooCommerce Product Embedding Worker
 *
 * Handles:
 * 1. Scheduled (cron): Automatic WooCommerce → Vectorize product sync
 * 2. POST /sync-products: Manual trigger for full product sync (auth required)
 * 3. POST /webhook/woocommerce: WooCommerce webhook receiver (HMAC verified)
 * 4. Queue consumer: Processes webhook events (upsert/delete individual products)
 * 5. GET /status: Last sync status and stats
 * 6. POST /validate: Test all external credentials (auth required)
 * 7. GET /health: Health check
 */

import type { Env, QueueMessage, WooCommerceProduct } from './types';
import { syncAllProducts, syncSingleProduct, deleteSingleProduct } from './sync-products';
import { verifyWebhookSignature } from './utils';

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
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

    // POST /sync-products — manual full sync trigger (auth required)
    // Runs inline (not waitUntil) because large catalogs exceed the waitUntil time limit.
    // The caller waits for the response, which includes the full sync result.
    if (url.pathname === '/sync-products' && request.method === 'POST') {
      const authError = checkAuth(request, env);
      if (authError) return authError;

      console.log('[Manual] Product sync triggered');
      try {
        const result = await syncAllProducts(env);
        console.log('[Manual] Product sync result:', JSON.stringify(result));
        return Response.json({ status: 'sync_complete', result });
      } catch (err) {
        console.error('[Manual] Product sync failed:', err);
        return Response.json(
          { status: 'sync_failed', error: err instanceof Error ? err.message : 'Unknown error' },
          { status: 500 }
        );
      }
    }

    // POST /validate — test all credentials (auth required)
    if (url.pathname === '/validate' && request.method === 'POST') {
      const authError = checkAuth(request, env);
      if (authError) return authError;

      const results = await validateCredentials(env);
      const allOk = results.woocommerce.ok && results.openai.ok && results.vectorize.ok;
      return Response.json(results, { status: allOk ? 200 : 502 });
    }

    // POST /webhook/woocommerce — WooCommerce webhook receiver
    // POST /webhook/woocommerce — WooCommerce webhook receiver
    if (url.pathname === '/webhook/woocommerce' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    // GET/HEAD /webhook/woocommerce — WooCommerce may probe the URL before saving
    if (url.pathname === '/webhook/woocommerce' && (request.method === 'GET' || request.method === 'HEAD')) {
      return Response.json({ status: 'ok', endpoint: 'woocommerce-webhook' });
    }

    return new Response('Not found', { status: 404 });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Queue] Processing batch of ${batch.messages.length} messages`);

    // Deduplicate: if multiple messages target the same product_id, keep only the latest
    const latestByProductId = new Map<number, Message<QueueMessage>>();

    for (const msg of batch.messages) {
      const productId = msg.body.product_id;
      const existing = latestByProductId.get(productId);

      if (!existing || msg.body.enqueued_at > existing.body.enqueued_at) {
        if (existing) {
          existing.ack();
          console.log(`[Queue] Deduped older message for product ${productId}`);
        }
        latestByProductId.set(productId, msg);
      } else {
        msg.ack();
        console.log(`[Queue] Deduped older message for product ${productId}`);
      }
    }

    // Process deduplicated messages
    for (const [productId, msg] of latestByProductId) {
      try {
        if (msg.body.action === 'upsert') {
          console.log(`[Queue] Upserting product ${productId} (topic: ${msg.body.webhook_topic})`);
          await syncSingleProduct(msg.body.product, env);
          console.log(`[Queue] Successfully upserted product ${productId}`);
        } else if (msg.body.action === 'delete') {
          console.log(`[Queue] Deleting product ${productId} (topic: ${msg.body.webhook_topic})`);
          await deleteSingleProduct(productId, env);
          console.log(`[Queue] Successfully deleted product ${productId}`);
        }

        msg.ack();
      } catch (err) {
        console.error(`[Queue] Error processing product ${productId} (action: ${msg.body.action}):`, err);
        msg.retry({ delaySeconds: 10 });
      }
    }
  },
} satisfies ExportedHandler<Env, QueueMessage>;

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
 * Handle incoming WooCommerce webhook.
 * Validates HMAC signature, parses topic, enqueues to Cloudflare Queue.
 * Returns 200 immediately — WooCommerce disables webhooks that respond slowly or with non-2xx.
 */
async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // Check topic FIRST — WooCommerce sends a verification ping when creating a webhook.
  // The ping may not include a valid signature or may use topic "action.woocommerce_deliver_webhook_async".
  // We must return 200 for pings or WooCommerce will refuse to save the webhook.
  const topic = request.headers.get('x-wc-webhook-topic') || '';
  const resource = request.headers.get('x-wc-webhook-resource') || '';
  const event = request.headers.get('x-wc-webhook-event') || '';

  // Handle verification pings and non-product webhooks (return 200 immediately)
  if (!topic || resource !== 'product') {
    console.log(`[Webhook] Ping/non-product webhook: topic=${topic}, resource=${resource} — returning 200`);
    return Response.json({ status: 'ok', reason: 'ping accepted' });
  }

  if (!env.WOOCOMMERCE_WEBHOOK_SECRET) {
    console.error('[Webhook] WOOCOMMERCE_WEBHOOK_SECRET not configured');
    return Response.json(
      { error: 'Webhook secret not configured. Set it with: npx wrangler secret put WOOCOMMERCE_WEBHOOK_SECRET' },
      { status: 500 }
    );
  }

  // Read raw body (must be raw bytes for HMAC verification, not re-serialized JSON)
  const rawBody = await request.arrayBuffer();

  // Verify HMAC-SHA256 signature
  const signature = request.headers.get('x-wc-webhook-signature');
  if (!signature) {
    console.warn('[Webhook] Missing X-WC-Webhook-Signature header');
    return Response.json({ error: 'Missing signature' }, { status: 401 });
  }

  const isValid = await verifyWebhookSignature(rawBody, env.WOOCOMMERCE_WEBHOOK_SECRET, signature);
  if (!isValid) {
    console.warn('[Webhook] Invalid webhook signature');
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  if (!topic || resource !== 'product') {
    console.log(`[Webhook] Ignoring non-product webhook: topic=${topic}, resource=${resource}`);
    return Response.json({ status: 'ignored', reason: 'not a product webhook' });
  }

  // Parse JSON payload
  let payload: Record<string, unknown>;
  try {
    const decoder = new TextDecoder();
    payload = JSON.parse(decoder.decode(rawBody));
  } catch (err) {
    console.error('[Webhook] Failed to parse JSON payload:', err);
    return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  // Extract product ID
  const productId = typeof payload.id === 'number' ? payload.id : null;
  if (!productId) {
    console.error('[Webhook] Missing or invalid product ID in payload');
    return Response.json({ error: 'Missing product ID' }, { status: 400 });
  }

  // Build queue message
  const now = new Date().toISOString();
  let message: QueueMessage;

  if (event === 'deleted') {
    message = {
      action: 'delete',
      product_id: productId,
      webhook_topic: topic,
      enqueued_at: now,
    };
  } else if (event === 'created' || event === 'updated' || event === 'restored') {
    message = {
      action: 'upsert',
      product_id: productId,
      product: payload as unknown as WooCommerceProduct,
      webhook_topic: topic,
      enqueued_at: now,
    };
  } else {
    console.log(`[Webhook] Ignoring unknown product event: ${event}`);
    return Response.json({ status: 'ignored', reason: `unknown event: ${event}` });
  }

  // Enqueue
  try {
    await env.PRODUCT_SYNC_QUEUE.send(message);
    console.log(`[Webhook] Enqueued ${message.action} for product ${productId} (topic: ${topic})`);
  } catch (err) {
    console.error(`[Webhook] Failed to enqueue message for product ${productId}:`, err);
    return Response.json({ error: 'Failed to enqueue' }, { status: 500 });
  }

  return Response.json({
    status: 'queued',
    action: message.action,
    product_id: productId,
  });
}

/**
 * Test all external credentials without triggering a full sync.
 */
async function validateCredentials(env: Env): Promise<{
  woocommerce: { ok: boolean; error?: string; product_count?: number };
  openai: { ok: boolean; error?: string };
  vectorize: { ok: boolean; error?: string; vector_count?: number };
}> {
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

  let vectorize: { ok: boolean; error?: string; vector_count?: number };
  try {
    const info = await env.PRODUCTS_INDEX.describe();
    vectorize = { ok: true, vector_count: info.vectorCount };
  } catch (err) {
    vectorize = { ok: false, error: err instanceof Error ? err.message : 'Index not accessible' };
  }

  return { woocommerce, openai, vectorize };
}

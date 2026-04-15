/**
 * Product Search API — Gateway Worker
 *
 * Provides a search API over the Vectorize index and KV store populated by
 * the woocommerce-product-embedding worker. Designed for consumption by
 * AI agents, automation tools (n8n), and any HTTP client.
 *
 * Endpoints:
 * - POST /           Semantic product search (embed → Vectorize → results)
 * - GET /product/:id Full product lookup by WooCommerce ID (KV read)
 * - GET /health      Health check
 */

interface Env {
  PRODUCTS_INDEX: Vectorize;
  PRODUCT_DATA: KVNamespace;
  OPENAI_API_KEY: string;
  API_SECRET: string;
}

interface SearchRequest {
  query: string;
  topK?: number;
  includeFullProduct?: boolean;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check (no auth)
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok', service: 'product-search-api', timestamp: new Date().toISOString() });
    }

    // All other endpoints require auth
    const authError = checkAuth(request, env);
    if (authError) return authError;

    // POST / — semantic product search
    if (url.pathname === '/' && request.method === 'POST') {
      return handleSearch(request, env);
    }

    // GET /product/:id — full product lookup by WooCommerce ID
    const productMatch = url.pathname.match(/^\/product\/(\d+)$/);
    if (productMatch && request.method === 'GET') {
      return handleProductLookup(productMatch[1], env);
    }

    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

/**
 * Semantic product search: embed query → Vectorize → optional KV enrichment.
 */
async function handleSearch(request: Request, env: Env): Promise<Response> {
  let body: SearchRequest;
  try {
    body = (await request.json()) as SearchRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.query || typeof body.query !== 'string') {
    return json({ error: 'Missing or invalid field: query' }, 400);
  }

  const query = body.query.trim();
  if (query.length === 0) {
    return json({ error: 'Query must not be empty' }, 400);
  }

  if (query.length > 2000) {
    return json({ error: 'Query exceeds maximum length of 2000 characters' }, 400);
  }

  // Step 1: Generate embedding via OpenAI
  const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: query, model: 'text-embedding-3-small' }),
  });

  if (!embeddingResponse.ok) {
    const errorText = await embeddingResponse.text().catch(() => 'Unknown error');
    console.error(`[Search] OpenAI embedding error (${embeddingResponse.status}): ${errorText}`);
    return json({ error: 'Embedding generation failed' }, 502);
  }

  const embeddingData = (await embeddingResponse.json()) as {
    data: [{ embedding: number[] }];
  };
  const vector = embeddingData.data[0].embedding;

  // Step 2: Query Vectorize
  const topK = Math.min(Math.max(body.topK || 5, 1), 50);
  const results = await env.PRODUCTS_INDEX.query(vector, {
    topK,
    returnMetadata: 'all',
  });

  // Step 3: Build response, optionally enriching with full KV data
  const products = await Promise.all(
    results.matches.map(async (match) => {
      const result: Record<string, unknown> = {
        id: match.id,
        score: match.score,
        metadata: match.metadata,
      };

      if (body.includeFullProduct) {
        const wooId = match.id.replace('product_', '');
        const fullProduct = await env.PRODUCT_DATA.get(`product:${wooId}`, 'json');
        if (fullProduct) result.fullProduct = fullProduct;
      }

      return result;
    })
  );

  return json({
    success: true,
    query,
    count: products.length,
    results: products,
  });
}

/**
 * Full product lookup by WooCommerce ID from KV.
 */
async function handleProductLookup(id: string, env: Env): Promise<Response> {
  const product = await env.PRODUCT_DATA.get(`product:${id}`, 'json');

  if (!product) {
    return json({ success: false, error: 'Product not found' }, 404);
  }

  return json({ success: true, product });
}

/**
 * Check Bearer token authentication. Returns a Response on failure, null on success.
 */
function checkAuth(request: Request, env: Env): Response | null {
  if (!env.API_SECRET) {
    return json(
      { error: 'API_SECRET not configured. Set it with: npx wrangler secret put API_SECRET' },
      500
    );
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.API_SECRET}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  return null;
}

/**
 * JSON response helper with CORS headers.
 */
function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: CORS_HEADERS,
  });
}

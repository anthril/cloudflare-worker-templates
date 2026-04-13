# Connecting AI Agents to Product Search

This guide shows how to connect AI agents, automation tools, and applications to the product vectors and KV data created by this worker.

---

## Data Schema

**Vectorize Index: `products`**
- Dimensions: 1536 (`text-embedding-3-small`)
- Distance metric: cosine
- Vector ID format: `product_{woocommerce_id}`
- Metadata fields: `name`, `price`, `sale_price`, `sku`, `short_description`, `product_url`, `product_image_url`, `woocommerce_id`, `stock_quantity`, `categories`

**KV Namespace: `PRODUCT_DATA`**
- Key format: `product:{woocommerce_id}`
- Value: Full product JSON (dimensions, weight, images, attributes, etc.)
- TTL: 30 days (refreshed on each sync)

## Embedding Model Compatibility

Your Vectorize index uses **OpenAI `text-embedding-3-small`** (1536 dimensions). Any system querying it **must** generate embeddings with the same model. Cloudflare Workers AI models (like `@cf/baai/bge-base-en-v1.5` at 768 dimensions) produce incompatible vectors and cannot query this index.

---

## Recommended Architecture: Gateway Worker

For all integrations, the recommended approach is a **Gateway Worker** — a lightweight Cloudflare Worker that accepts a search query, generates an embedding, queries Vectorize, enriches with KV data, and returns JSON.

```
Client (any) ──HTTP POST──> Product Search Worker ──binding──> Vectorize
                                                   ──binding──> KV
                                                   ──fetch───> OpenAI Embeddings
```

**Why a Gateway Worker instead of calling APIs directly?**
- Single HTTP call instead of 3+ (embed → query → KV reads)
- OpenAI API key stays server-side
- Worker bindings are faster than REST APIs
- Centralized auth and rate limiting

### Gateway Worker Code

Create a new Worker (e.g., `product-search-api`):

**wrangler.toml**

```toml
name = "product-search-api"
main = "src/index.ts"
compatibility_date = "2025-01-06"
compatibility_flags = ["nodejs_compat"]

[[vectorize]]
binding = "PRODUCTS_INDEX"
index_name = "products"

[[kv_namespaces]]
binding = "PRODUCT_DATA"
id = "your-kv-namespace-id"

# Secrets: OPENAI_API_KEY, API_SECRET
```

**src/index.ts**

```typescript
interface Env {
  PRODUCTS_INDEX: Vectorize;
  PRODUCT_DATA: KVNamespace;
  OPENAI_API_KEY: string;
  API_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    // Authenticate
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.API_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json() as {
      query: string;
      topK?: number;
      includeFullProduct?: boolean;
    };

    if (!body.query) {
      return Response.json({ error: 'Missing field: query' }, { status: 400 });
    }

    // Step 1: Generate embedding
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: body.query, model: 'text-embedding-3-small' }),
    });

    if (!embRes.ok) {
      return Response.json({ error: 'Embedding generation failed' }, { status: 502 });
    }

    const embData = await embRes.json() as { data: [{ embedding: number[] }] };
    const vector = embData.data[0].embedding;

    // Step 2: Query Vectorize
    const topK = Math.min(body.topK || 5, 50);
    const results = await env.PRODUCTS_INDEX.query(vector, {
      topK,
      returnMetadata: 'all',
    });

    // Step 3: Optionally enrich with full product data
    const products = await Promise.all(
      results.matches.map(async (match) => {
        const result: Record<string, unknown> = {
          id: match.id,
          score: match.score,
          metadata: match.metadata,
        };

        if (body.includeFullProduct) {
          const wooId = match.id.replace('product_', '');
          const full = await env.PRODUCT_DATA.get(`product:${wooId}`, 'json');
          if (full) result.fullProduct = full;
        }

        return result;
      })
    );

    return Response.json({
      success: true,
      query: body.query,
      count: products.length,
      results: products,
    });
  },
} satisfies ExportedHandler<Env>;
```

**Deploy:**

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put API_SECRET    # generate with: openssl rand -hex 32
npx wrangler deploy
```

Your search API is now live at `https://product-search-api.<subdomain>.workers.dev`.

---

## Integration Examples

### 1. Cloudflare Workers (Service Bindings)

Another Worker in the same account can bind directly to the Vectorize index and KV namespace.

**wrangler.toml** (consuming Worker):

```toml
name = "my-agent-worker"
main = "src/index.ts"

[[vectorize]]
binding = "PRODUCTS_INDEX"
index_name = "products"

[[kv_namespaces]]
binding = "PRODUCT_DATA"
id = "your-kv-namespace-id"
```

Then use `env.PRODUCTS_INDEX.query()` and `env.PRODUCT_DATA.get()` directly — the same APIs the sync worker uses.

**Alternative: Service binding** to the Gateway Worker (zero-latency internal call):

```toml
[[services]]
binding = "PRODUCT_SEARCH"
service = "product-search-api"
```

```typescript
const response = await env.PRODUCT_SEARCH.fetch(
  new Request('https://internal/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer your-api-secret',
    },
    body: JSON.stringify({ query: 'wireless headphones', topK: 5 }),
  })
);
const data = await response.json();
```

---

### 2. Cloudflare Workers AI

Workers AI embedding models (e.g., `@cf/baai/bge-base-en-v1.5` at 768 dims) are **incompatible** with this index (1536 dims). Two options:

**Option A (Recommended):** Use OpenAI `text-embedding-3-small` from within the Worker to query the existing index — same as the Gateway Worker pattern above.

**Option B:** Create a separate Vectorize index with Workers AI dimensions and dual-index products:

```bash
npx wrangler vectorize create products-bge --dimensions=768 --metric=cosine
```

```typescript
// Workers AI embedding (free on Workers paid plan)
const embResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
  text: ['wireless headphones'],
});
const vector = embResponse.data[0];

const results = await env.PRODUCTS_INDEX_BGE.query(vector, {
  topK: 5,
  returnMetadata: 'all',
});
```

This avoids the OpenAI dependency but requires re-embedding all products with the Workers AI model and keeping both indexes in sync.

---

### 3. OpenAI JavaScript SDK (Node.js / Bun / Deno)

**Via Gateway Worker (recommended):**

```typescript
const SEARCH_URL = 'https://product-search-api.<subdomain>.workers.dev';
const API_KEY = 'your-api-secret';

async function searchProducts(query: string, topK = 5) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query, topK }),
  });
  return res.json();
}

const results = await searchProducts('bluetooth speaker waterproof');
for (const r of results.results) {
  console.log(`${r.metadata.name} — $${r.metadata.price} (score: ${r.score.toFixed(3)})`);
}
```

**Direct REST API (no Gateway Worker):**

```typescript
import OpenAI from 'openai';

const openai = new OpenAI();
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

// Step 1: Generate embedding
const embResponse = await openai.embeddings.create({
  input: 'organic skincare serum',
  model: 'text-embedding-3-small',
});
const vector = embResponse.data[0].embedding;

// Step 2: Query Vectorize REST API
const searchRes = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/products/query`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ vector, topK: 5, returnMetadata: 'all' }),
  }
);
const data = await searchRes.json();
console.log(data.result.matches);
```

> **Note:** The direct approach requires 3+ HTTP calls (embed + query + N KV reads) and exposes your Cloudflare API token to the client environment. The Gateway Worker approach is faster and more secure.

---

### 4. n8n

n8n can connect via the Gateway Worker using the **HTTP Request Tool** node in an AI Agent workflow.

**AI Agent + HTTP Request Tool:**

1. Add an **AI Agent** node with your preferred chat model
2. Attach an **HTTP Request Tool** sub-node with:

| Setting | Value |
|---------|-------|
| Method | POST |
| URL | `https://product-search-api.<subdomain>.workers.dev` |
| Authentication | Header Auth |
| Header Name | `Authorization` |
| Header Value | `Bearer your-api-secret` |
| Send Body | JSON |

3. Set the Tool **Description** (this is what the LLM reads):

```
Search for products in the catalog by semantic similarity.
Use when the user asks about products or needs recommendations.
Send a JSON body with "query" (required) and "topK" (optional, default 5).
Returns product names, prices, URLs, images, and stock levels.
```

4. Set the Body (JSON expression):

```json
{
  "query": "={{ $fromAI('searchQuery', 'The product search query text') }}",
  "topK": 5
}
```

The `$fromAI()` function lets the AI Agent dynamically fill in parameter values from conversation context.

**Simple HTTP Request (non-AI workflow):**

For workflows triggered by webhooks, schedules, or other events — just use a standard HTTP Request node:

- Method: POST
- URL: `https://product-search-api.<subdomain>.workers.dev`
- Headers: `Authorization: Bearer your-api-secret`
- Body: `{"query": "{{ $json.userMessage }}", "topK": 10}`

---

### 5. Anthropic Claude (Tool Use)

Use the Claude Messages API with a `search_products` tool definition. When Claude decides to search, your code calls the Gateway Worker and returns results.

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();
const SEARCH_URL = 'https://product-search-api.<subdomain>.workers.dev';
const SEARCH_KEY = 'your-api-secret';

const searchTool: Anthropic.Messages.Tool = {
  name: 'search_products',
  description:
    'Search the product catalog using semantic similarity. ' +
    'Use when the user asks about products or wants recommendations. ' +
    'Returns product names, prices, URLs, and relevance scores.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Natural language search query' },
      topK: { type: 'number', description: 'Number of results (1-20, default 5)' },
    },
    required: ['query'],
  },
};

// Execute the tool
async function executeSearch(input: { query: string; topK?: number }): Promise<string> {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SEARCH_KEY}`,
    },
    body: JSON.stringify({ query: input.query, topK: input.topK || 5 }),
  });
  return await res.text();
}

// Agentic loop
async function chat(userMessage: string): Promise<string> {
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 4096,
    system: 'You are a helpful shopping assistant. Use search_products to find items.',
    tools: [searchTool],
    messages,
  });

  // Loop: handle tool calls until Claude gives a final answer
  while (response.stop_reason === 'tool_use') {
    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    );

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      const result = await executeSearch(tool.input as { query: string; topK?: number });
      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 4096,
      system: 'You are a helpful shopping assistant. Use search_products to find items.',
      tools: [searchTool],
      messages,
    });
  }

  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// Usage
const answer = await chat('I need wireless headphones under $100 for running');
console.log(answer);
```

---

### 6. Any HTTP Client (cURL / Python / Go)

The Gateway Worker is a standard REST API. Any HTTP client works.

**cURL:**

```bash
curl -X POST https://product-search-api.<subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-secret" \
  -d '{"query": "organic cotton t-shirt", "topK": 5}'
```

**Python:**

```python
import requests

response = requests.post(
    'https://product-search-api.<subdomain>.workers.dev',
    json={'query': 'vintage leather jacket', 'topK': 5},
    headers={'Authorization': 'Bearer your-api-secret'},
    timeout=30,
)
data = response.json()
for product in data['results']:
    print(f"{product['metadata']['name']} — ${product['metadata']['price']}")
```

**Response format:**

```json
{
  "success": true,
  "query": "organic cotton t-shirt",
  "count": 3,
  "results": [
    {
      "id": "product_1234",
      "score": 0.892,
      "metadata": {
        "name": "Organic Cotton Basic Tee",
        "price": 29.99,
        "sale_price": 24.99,
        "sku": "OCT-BLK-M",
        "short_description": "Soft organic cotton crew neck t-shirt",
        "product_url": "https://store.example.com/products/organic-cotton-tee",
        "product_image_url": "https://store.example.com/images/oct-blk.jpg",
        "woocommerce_id": 1234,
        "stock_quantity": 45,
        "categories": "Clothing, T-Shirts"
      }
    }
  ]
}
```

---

## Quick Reference

| Integration | Approach | # HTTP Calls |
|---|---|---|
| Cloudflare Worker (same account) | Direct Vectorize + KV bindings | 0 (bindings) |
| Cloudflare Worker (service binding) | Internal RPC to Gateway Worker | 0 (internal) |
| OpenAI SDK / Node.js | HTTP to Gateway Worker | 1 |
| n8n | HTTP Request Tool to Gateway Worker | 1 |
| Claude / Anthropic | tool_use loop calling Gateway Worker | 1 per search |
| Python / Go / cURL | HTTP to Gateway Worker | 1 |
| Workers AI | Separate index or OpenAI via Worker | 0 (bindings) |
| Direct REST API (no Worker) | OpenAI + Cloudflare APIs | 3+ |

## REST APIs (for direct access without Gateway Worker)

| API | Endpoint |
|-----|----------|
| Vectorize Query | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/vectorize/v2/indexes/products/query` |
| KV Read | `GET https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/product%3A{woo_id}` |
| OpenAI Embed | `POST https://api.openai.com/v1/embeddings` |

Both Cloudflare APIs require a `Bearer` token via the `Authorization` header (use a Cloudflare API Token scoped to Vectorize + KV). KV keys with colons must be URL-encoded (`product:123` → `product%3A123`).

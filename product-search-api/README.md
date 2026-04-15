# Product Search API Worker

A Cloudflare Worker that provides semantic product search over a Vectorize index and KV store. Designed as the read/query companion to the [woocommerce-product-embedding](../woocommerce-product-embedding/) worker.

## How It Works

```
Client (any) ──POST /──> Product Search API ──binding──> Vectorize (semantic search)
                                             ──binding──> KV (full product data)
                                             ──fetch───> OpenAI (query embeddings)
```

1. Client sends a natural language search query
2. Worker generates an embedding via OpenAI `text-embedding-3-small`
3. Worker queries the Vectorize index for the most similar product vectors
4. Worker optionally enriches results with full product data from KV
5. Returns ranked results as JSON

The Vectorize index and KV store are populated by the [woocommerce-product-embedding](../woocommerce-product-embedding/) worker. This worker only reads from them.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Get your KV namespace ID (created by woocommerce-product-embedding)
npx wrangler kv list

# 3. Set the KV namespace ID in wrangler.toml
# Edit [[kv_namespaces]] → id = "your-kv-namespace-id"

# 4. Set secrets
npx wrangler secret put OPENAI_API_KEY    # Your OpenAI API key
npx wrangler secret put API_SECRET        # Generate with: openssl rand -hex 32

# 5. Deploy
npx wrangler deploy
```

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers paid plan
- [woocommerce-product-embedding](../woocommerce-product-embedding/) deployed and synced (creates the Vectorize index + KV namespace)
- [OpenAI API key](https://platform.openai.com/api-keys) for generating query embeddings
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Link to existing resources

This worker reads from the same Vectorize index and KV namespace created by `woocommerce-product-embedding`. You need to configure the KV namespace ID in `wrangler.toml`.

Get the namespace ID:

```bash
npx wrangler kv list
```

Find the namespace created by the embedding worker and copy its `id`. Then edit `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "PRODUCT_DATA"
id = "your-kv-namespace-id"    # ← paste here
```

The Vectorize index binding (`PRODUCTS_INDEX` → `"products"`) matches automatically — no configuration needed if you used the default name.

### 3. Set secrets

```bash
# OpenAI API key for generating query embeddings
npx wrangler secret put OPENAI_API_KEY

# Bearer token for authenticating API requests
# Generate one: openssl rand -hex 32
npx wrangler secret put API_SECRET
```

### 4. Deploy

```bash
npx wrangler deploy
```

Your search API is now live at `https://product-search-api.<your-subdomain>.workers.dev`.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/` | Bearer token | Semantic product search |
| `GET` | `/product/:id` | Bearer token | Full product lookup by WooCommerce ID |
| `GET` | `/health` | None | Health check |
| `OPTIONS` | `/*` | None | CORS preflight |

All authenticated endpoints require:

```
Authorization: Bearer <API_SECRET>
```

### POST / — Semantic Search

Search the product catalog using natural language.

**Request:**

```json
{
  "query": "wireless bluetooth headphones",
  "topK": 5,
  "includeFullProduct": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Natural language search text (max 2000 chars) |
| `topK` | number | No | Number of results (1–50, default 5) |
| `includeFullProduct` | boolean | No | Include full KV data per result (default `false`) |

**Response:**

```json
{
  "success": true,
  "query": "wireless bluetooth headphones",
  "count": 3,
  "results": [
    {
      "id": "product_1234",
      "score": 0.892,
      "metadata": {
        "name": "Premium Wireless Headphones",
        "price": 79.99,
        "sale_price": 0,
        "sku": "WH-PRO-100",
        "short_description": "High-quality wireless headphones with noise cancellation...",
        "product_url": "https://your-store.com/product/wireless-headphones",
        "product_image_url": "https://your-store.com/wp-content/uploads/headphones.jpg",
        "woocommerce_id": 1234,
        "stock_quantity": 45,
        "categories": "Electronics, Headphones"
      }
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `results[].score` | Relevance score (0–1, higher is better) |
| `results[].metadata` | Product summary from Vectorize metadata |
| `results[].fullProduct` | Full KV data (only when `includeFullProduct: true`) |

### GET /product/:id — Product Lookup

Get full product details by WooCommerce ID. Returns the complete product record from KV including dimensions, weight, attributes, full description, and all images.

**Response:**

```json
{
  "success": true,
  "product": {
    "woocommerce_id": 1234,
    "name": "Premium Wireless Headphones",
    "description": "<p>Full HTML product description...</p>",
    "short_description": "High-quality wireless headphones...",
    "regular_price": "79.99",
    "price": "79.99",
    "sale_price": "",
    "sku": "WH-PRO-100",
    "stock_quantity": 45,
    "weight": "0.35",
    "dimensions": { "length": "20", "width": "18", "height": "8" },
    "categories": [{ "name": "Electronics" }, { "name": "Headphones" }],
    "attributes": [
      { "name": "Color", "options": ["Black", "White"] },
      { "name": "Connectivity", "options": ["Bluetooth 5.3"] }
    ],
    "permalink": "https://your-store.com/product/wireless-headphones",
    "images": [
      { "id": 5678, "src": "https://your-store.com/uploads/headphones.jpg", "alt": "Headphones" }
    ]
  }
}
```

**Error (404):** `{"success": false, "error": "Product not found"}`

### GET /health — Health Check

No authentication required.

```json
{
  "status": "ok",
  "service": "product-search-api",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

---

## Configuration Reference

### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for `text-embedding-3-small` |
| `API_SECRET` | Yes | Bearer token for authenticating requests |

### Bindings

| Binding | Type | Shared With | Description |
|---------|------|-------------|-------------|
| `PRODUCTS_INDEX` | Vectorize | woocommerce-product-embedding | Product vectors (1536 dims, cosine) |
| `PRODUCT_DATA` | KV | woocommerce-product-embedding | Full product JSON (30-day TTL) |

---

## Relationship with woocommerce-product-embedding

These two workers form a **read/write split** architecture:

| Worker | Role | Operations |
|--------|------|------------|
| [woocommerce-product-embedding](../woocommerce-product-embedding/) | **Writer** | Syncs products from WooCommerce → generates embeddings → writes to Vectorize + KV |
| product-search-api (this worker) | **Reader** | Accepts search queries → generates query embedding → reads from Vectorize + KV |

**Shared resources:**
- Both bind to the same Vectorize index (`PRODUCTS_INDEX` → `"products"`)
- Both bind to the same KV namespace (`PRODUCT_DATA`)

**Deploy order:**
1. Deploy `woocommerce-product-embedding` first
2. Run an initial product sync
3. Then deploy this `product-search-api` worker

The embedding worker keeps products up to date via WooCommerce webhooks + weekly cron. This search worker always reads the latest data.

---

## Connecting AI Agents

This worker is designed to be called by AI agents as a tool. An example n8n AI Agent workflow is included at [`examples/n8n-workflow.json`](./examples/n8n-workflow.json).

For more integration patterns (Anthropic Claude tool use, OpenAI SDK, cURL, Python), see the [INTEGRATIONS.md](../woocommerce-product-embedding/INTEGRATIONS.md) in the woocommerce-product-embedding template.

---

## Local Development

```bash
# Copy example env vars
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your API keys

# Start dev server
npm run dev

# Test health
curl http://localhost:8787/health

# Test search
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-here" \
  -d '{"query": "wireless headphones", "topK": 3}'

# Test product lookup
curl http://localhost:8787/product/12345 \
  -H "Authorization: Bearer your-secret-here"
```

---

## Testing

See [`examples/test-cases.example.json`](./examples/test-cases.example.json) for a complete set of test cases covering search queries, product lookups, and edge cases.

Quick smoke test after deployment:

```bash
BASE_URL="https://product-search-api.<your-subdomain>.workers.dev"
API_KEY="your-api-secret"

# Health check
curl $BASE_URL/health

# Search
curl -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"query": "your product search here", "topK": 3}'

# Auth rejection (should return 401)
curl -X POST $BASE_URL \
  -H "Content-Type: application/json" \
  -d '{"query": "test"}'
```

---

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local dev server |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run tail` | Stream live logs |
| `npm run types` | Generate TypeScript types |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **401 Unauthorized** | Check that `Authorization: Bearer <token>` matches the `API_SECRET` secret |
| **502 Embedding generation failed** | Verify `OPENAI_API_KEY` is valid. Check OpenAI API status. |
| **Empty search results** | Ensure `woocommerce-product-embedding` has synced products. Check with `GET /status` on that worker. |
| **"API_SECRET not configured"** | Run `npx wrangler secret put API_SECRET` |
| **404 on product lookup** | The product ID may not exist in KV. Verify with a search first. |
| **KV binding error** | Ensure the KV `id` in `wrangler.toml` matches the namespace created by the embedding worker |

---

## License

MIT

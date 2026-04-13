# WooCommerce Product Embedding Worker

A Cloudflare Worker that syncs WooCommerce products to [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) for semantic search, with full product data stored in [KV](https://developers.cloudflare.com/kv/).

## How It Works

```
WooCommerce REST API
        │
        ▼
  Fetch all published products (paginated)
        │
        ▼
  OpenAI text-embedding-3-small
  (generate 1536-dim embeddings)
        │
        ├──────────────────────┐
        ▼                      ▼
  Cloudflare Vectorize    Cloudflare KV
  (searchable vectors     (full product JSON
   with metadata)          with 30-day TTL)
```

**Sync triggers:**
- **Cron schedule** — Weekly automatic sync (configurable)
- **Manual HTTP** — `POST /sync-products` for on-demand sync (auth required)

**Additional features:**
- Deleted product cleanup (stale vectors removed automatically)
- Credential validation endpoint
- Sync status tracking
- Retry with exponential backoff for API failures

## Quick Start (5 minutes)

```bash
# 1. Install dependencies
npm install

# 2. Create Vectorize index
npm run setup

# 3. Edit wrangler.toml — set your store URL
#    WOOCOMMERCE_URL = "https://your-store.com"

# 4. Set secrets
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put WOOCOMMERCE_KEY
npx wrangler secret put WOOCOMMERCE_SECRET
npx wrangler secret put SYNC_AUTH_TOKEN    # optional, for HTTP endpoint auth

# 5. Deploy (KV auto-provisions on first deploy)
npm run deploy
```

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers paid plan
- [WooCommerce](https://woocommerce.com/) store with REST API enabled
- [OpenAI API key](https://platform.openai.com/api-keys)
- [Node.js](https://nodejs.org/) 18+ and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
# Create Vectorize index (1536 dimensions for OpenAI text-embedding-3-small)
npm run setup
# Or manually: npx wrangler vectorize create products --dimensions=1536 --metric=cosine
```

> **Note:** The KV namespace is auto-provisioned on first deploy — no manual creation needed.

### 3. Configure environment variables

Edit `wrangler.toml`:

```toml
[vars]
WOOCOMMERCE_URL = "https://your-store.com"
```

### 4. Set secrets

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put WOOCOMMERCE_KEY
npx wrangler secret put WOOCOMMERCE_SECRET
```

**WooCommerce API keys:** Generate at `WordPress Admin → WooCommerce → Settings → Advanced → REST API → Add key`.
- Description: Any name (e.g., "Product Sync Worker")
- User: Your admin user
- Permissions: **Read** (only read access is needed)
- The consumer key starts with `ck_` and the secret starts with `cs_`

**Optional — for HTTP endpoint authentication:**
```bash
# Generate a secure token
openssl rand -hex 32
# Then set it
npx wrangler secret put SYNC_AUTH_TOKEN
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Validate credentials

After deploying, test that all credentials are working:

```bash
curl -X POST https://your-worker.workers.dev/validate \
  -H "Authorization: Bearer YOUR_SYNC_AUTH_TOKEN"
```

This will test WooCommerce API, OpenAI API, and Vectorize connectivity.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check |
| `GET` | `/status` | No | Last sync status and stats |
| `POST` | `/sync-products` | Bearer token | Trigger manual product sync |
| `POST` | `/validate` | Bearer token | Test all external credentials |

## Cron Schedule

The default schedule syncs weekly on Saturday at 18:00 UTC. Adjust in `wrangler.toml`:

```toml
[triggers]
crons = ["0 18 * * 6"]   # Saturday 18:00 UTC
# crons = ["0 0 * * *"]  # Daily at midnight UTC
# crons = ["0 */6 * * *"] # Every 6 hours
```

## Configuration Reference

### Environment Variables (`[vars]`)

| Variable | Description |
|----------|-------------|
| `WOOCOMMERCE_URL` | Your WooCommerce store URL (e.g., `https://your-store.com`) |
| `ENVIRONMENT` | Environment label (default: `production`) |

### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for embedding generation |
| `WOOCOMMERCE_KEY` | Yes | WooCommerce REST API consumer key (`ck_...`) |
| `WOOCOMMERCE_SECRET` | Yes | WooCommerce REST API consumer secret (`cs_...`) |
| `SYNC_AUTH_TOKEN` | No | Bearer token for `/sync-products` and `/validate` endpoints |

### Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `PRODUCTS_INDEX` | Vectorize | Vector index for semantic product search |
| `PRODUCT_DATA` | KV Namespace | Full product JSON + sync metadata |

## What Gets Synced

For each published WooCommerce product:

**Vectorize** (for search):
- Embedding of combined: name + description + categories + attributes
- Metadata: name, price, sale_price, SKU, stock, categories, URLs

**KV** (for full data retrieval):
- Complete product JSON including dimensions, weight, images, attributes
- 30-day TTL (refreshed on each sync)

## Querying Products

Use Vectorize to search products from another Worker:

```typescript
const results = await env.PRODUCTS_INDEX.query(embedding, {
  topK: 5,
  returnMetadata: 'all',
});

// Get full product data from KV
for (const match of results.matches) {
  const wooId = match.metadata?.woocommerce_id;
  const product = await env.PRODUCT_DATA.get(`product:${wooId}`, 'json');
}
```

## Connecting AI Agents

See **[INTEGRATIONS.md](INTEGRATIONS.md)** for complete guides on connecting:

- **Cloudflare Workers** (direct bindings or service bindings)
- **Cloudflare Workers AI** (compatibility notes for different embedding models)
- **OpenAI JavaScript SDK** (Node.js / Bun / Deno)
- **n8n** (AI Agent with HTTP Request Tool)
- **Anthropic Claude** (tool use pattern)
- **Any HTTP client** (cURL, Python, Go, etc.)

The guide includes a ready-to-deploy **Gateway Worker** that exposes product search as a simple REST API for any integration.

## Cost Estimates

- **OpenAI text-embedding-3-small**: ~$0.02 per 1M tokens
- **Typical sync** (500 products, ~200 tokens/product): ~100K tokens = **~$0.002 per sync**
- **Weekly sync for 500 products**: ~$0.10/year
- Cloudflare Workers, KV, and Vectorize have generous free tier limits

## Product Limits

- Default maximum: **5,000 products** (100 pages × 50 per page)
- To increase: modify `MAX_PAGES` in `src/sync-products.ts`
- Higher product counts increase OpenAI API costs proportionally

## Local Development

```bash
# Copy example env file
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your real credentials

# Start local dev server
npm run dev

# Trigger a sync (replace with your token)
curl -X POST http://localhost:8787/sync-products \
  -H "Authorization: Bearer YOUR_SYNC_AUTH_TOKEN"
```

## Development

```bash
npm run dev    # Start local dev server
npm run tail   # Stream live logs
npm run types  # Generate TypeScript types from wrangler.toml
npm run setup  # Create Vectorize index
```

## Troubleshooting

**WooCommerce API error 401:**
- Invalid consumer key or secret
- Ensure the API key has "Read" permissions
- Run `POST /validate` to test credentials

**WooCommerce API error 404:**
- Wrong `WOOCOMMERCE_URL` in wrangler.toml
- WooCommerce REST API may not be enabled (check Permalinks settings)

**OpenAI error 401:**
- Invalid or expired API key

**OpenAI error 429:**
- Rate limited — the worker includes automatic retry with backoff
- For very large catalogs, reduce `CHUNK_SIZE` in `src/sync-products.ts`

**Sync succeeds but no products found:**
- Ensure products have `status: publish` in WooCommerce
- Check `/status` endpoint to see last sync results
- Run `/validate` to test all connections

## License

MIT

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
   with metadata)          with 14-day TTL)
```

**Sync triggers:**
- **Cron schedule** — Weekly automatic sync (configurable)
- **Manual HTTP** — `POST /sync-products` for on-demand sync

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
npx wrangler vectorize create products --dimensions=1536 --metric=cosine

# Create KV namespace for full product data
npx wrangler kv namespace create PRODUCT_DATA
```

Update `wrangler.toml` with the KV namespace ID from the output.

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

**WooCommerce API keys:** Generate at `WooCommerce → Settings → Advanced → REST API` in your WordPress admin. Use "Read" permissions.

### 5. Deploy

```bash
npm run deploy
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/sync-products` | Trigger manual product sync |

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

| Secret | Description |
|--------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for embedding generation |
| `WOOCOMMERCE_KEY` | WooCommerce REST API consumer key |
| `WOOCOMMERCE_SECRET` | WooCommerce REST API consumer secret |

### Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `PRODUCTS_INDEX` | Vectorize | Vector index for semantic product search |
| `PRODUCT_DATA` | KV Namespace | Full product JSON (keyed as `product:{id}`) |

## What Gets Synced

For each published WooCommerce product:

**Vectorize** (for search):
- Embedding of combined: name + description + categories + attributes
- Metadata: name, price, sale_price, SKU, stock, categories, URLs

**KV** (for full data retrieval):
- Complete product JSON including dimensions, weight, images, attributes
- 14-day TTL (refreshed on each sync)

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

## Development

```bash
npm run dev    # Start local dev server
npm run tail   # Stream live logs
npm run types  # Generate TypeScript types from wrangler.toml
```

## License

MIT

# Cloudflare Worker Templates

Production-ready Cloudflare Worker templates for common integrations. Each template is a standalone project you can clone, configure, and deploy.

## Templates

| Template | Description | Key Integrations |
|----------|-------------|------------------|
| [Twilio Voice Agent](./twilio-voice-agent/) | AI-powered voice agent using Twilio Media Streams + OpenAI Realtime API | Twilio, OpenAI, HubSpot CRM, Cloudflare Durable Objects, Vectorize |
| [WooCommerce Product Embedding](./woocommerce-product-embedding/) | Sync WooCommerce products to Cloudflare Vectorize for semantic search | WooCommerce, OpenAI Embeddings, Cloudflare Vectorize, KV |
| [Product Search API](./product-search-api/) | Gateway Worker for semantic product search over Vectorize + KV | OpenAI Embeddings, Cloudflare Vectorize, KV |
| [Email Notification Worker](./email-notification-worker/) | Queue-driven email sender with nodemailer SMTP + DKIM signing | nodemailer, Cloudflare Queues, D1, KV, Analytics Engine, DNS API |

## Architecture

```
                                    ┌─────────────────────────┐
                                    │      WooCommerce        │
                                    │    (Product Store)      │
                                    └────────────┬────────────┘
                                                 │
                              Webhooks (real-time) + Cron (weekly)
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CLOUDFLARE WORKERS                                 │
│                                                                             │
│  ┌───────────────────────────────┐    WRITE    ┌──────────────────────┐     │
│  │  woocommerce-product-embedding│────────────>│  Vectorize Index     │     │
│  │                               │             │  (products)          │     │
│  │  Sync products, generate      │             │  1536-dim embeddings │     │
│  │  embeddings, manage lifecycle │──┐          └──────────┬───────────┘     │
│  └───────────────────────────────┘  │                     │                 │
│                                     │ WRITE               │ READ            │
│                                     ▼                     │                 │
│                              ┌──────────────┐             │                 │
│                              │  KV Store    │             │                 │
│                              │  (products)  │             │                 │
│                              │  Full JSON   │             │                 │
│                              └──────┬───────┘             │                 │
│                                     │                     │                 │
│                                     │ READ                │                 │
│                                     │                     │                 │
│  ┌───────────────────────────────┐  │                     │                 │
│  │  product-search-api           │<─┘                     │                 │
│  │                               │<───────────────────────┘                 │
│  │  Semantic search gateway      │                                          │
│  │  Bearer token auth            │──── OpenAI (query embeddings)            │
│  └──────────────┬────────────────┘                                          │
│                 │                                                            │
│                 │          ┌───────────────────────────────┐                 │
│                 │          │  twilio-voice-agent            │                │
│                 │          │                               │                 │
│                 │          │  AI voice conversations       │                 │
│                 │          │  Durable Objects sessions     │── Twilio        │
│                 │          │  CRM integration              │── HubSpot       │
│                 │          │  Product search tool          │── OpenAI        │
│                 │          └──────────────┬────────────────┘                 │
│                 │                         │                                  │
└─────────────────┼─────────────────────────┼──────────────────────────────────┘
                  │                         │
    ──────────────┼─────────────────────────┼──────────────────
    CONSUMERS     │                         │
                  ▼                         ▼
         ┌────────────────┐        ┌────────────────┐
         │  n8n / HTTP    │        │  Phone Call     │
         │  AI Agents     │        │  (Twilio)       │
         │  Any REST      │        │                 │
         │  client        │        │                 │
         └────────────────┘        └────────────────┘
```

**Shared resources:** `woocommerce-product-embedding` writes to Vectorize + KV. Both `product-search-api` and `twilio-voice-agent` read from them.

**Deploy order:** `woocommerce-product-embedding` first → sync products → then deploy `product-search-api` and/or `twilio-voice-agent`.

---

## Getting Started

1. Choose a template from the table above
2. Copy the template directory to your project
3. Follow the template's README for setup and configuration
4. Deploy with `npx wrangler deploy`

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers paid plan
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)

## Structure

```
cloudflare-worker-templates/
├── twilio-voice-agent/           # Voice agent with CRM integration
│   ├── src/
│   │   ├── index.ts              # Worker entry point
│   │   ├── config/               # Agent configuration
│   │   ├── agents/               # AI agent instructions & tools
│   │   ├── durable-objects/      # Session management (Durable Objects)
│   │   ├── tools/                # Tool implementations
│   │   └── utils/                # Logging utilities
│   ├── wrangler.toml
│   └── README.md
│
├── woocommerce-product-embedding/ # Product sync & vector search
│   ├── src/
│   │   ├── index.ts              # Worker entry point
│   │   ├── sync-products.ts      # WooCommerce sync logic
│   │   ├── types.ts              # TypeScript interfaces
│   │   └── utils.ts              # Embedding utilities
│   ├── wrangler.toml
│   └── README.md
│
├── product-search-api/            # Gateway API for product search
│   ├── src/
│   │   └── index.ts              # Worker entry point
│   ├── examples/
│   │   ├── n8n-workflow.json     # n8n AI Agent workflow template
│   │   └── test-cases.example.json
│   ├── wrangler.toml
│   └── README.md
│
├── email-notification-worker/     # Queue-driven SMTP sender (nodemailer + DKIM)
│   ├── src/
│   │   ├── index.ts              # fetch + queue handlers
│   │   ├── email-service.ts      # nodemailer transport
│   │   ├── template-engine.ts    # HTML + text template renderer
│   │   ├── templates/            # welcome, password-reset, order-confirmation
│   │   ├── delivery-log.ts       # D1 helpers
│   │   └── idempotency.ts        # KV helpers
│   ├── scripts/                  # generate-dkim, setup-dns, send-test
│   ├── migrations/               # D1 schema
│   ├── wrangler.toml
│   └── README.md
│
├── LICENSE
└── README.md
```

## License

MIT

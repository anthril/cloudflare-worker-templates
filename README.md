# Cloudflare Worker Templates

Production-ready Cloudflare Worker templates for common integrations. Each template is a standalone project you can clone, configure, and deploy.

## Templates

| Template | Description | Key Integrations |
|----------|-------------|------------------|
| [Twilio Voice Agent](./twilio-voice-agent/) | AI-powered voice agent using Twilio Media Streams + OpenAI Realtime API | Twilio, OpenAI, HubSpot CRM, Cloudflare Durable Objects, Vectorize |
| [WooCommerce Product Embedding](./woocommerce-product-embedding/) | Sync WooCommerce products to Cloudflare Vectorize for semantic search | WooCommerce, OpenAI Embeddings, Cloudflare Vectorize, KV |

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
├── LICENSE
└── README.md
```

## License

MIT

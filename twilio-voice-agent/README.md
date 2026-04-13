# Twilio Voice Agent

An AI-powered voice agent built on Cloudflare Workers using [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams) and [OpenAI's Realtime API](https://platform.openai.com/docs/guides/realtime). Handles inbound calls, searches products, answers questions from a knowledge base, collects customer details, and transfers to human agents when needed.

## Architecture

```
Incoming Call
     │
     ▼
Twilio Voice Webhook (POST /twilio/voice-webhook)
     │  Returns TwiML → opens Media Stream
     ▼
Cloudflare Durable Object (TwilioVoiceSessionDO)
     │  Manages per-call WebSocket session
     │
     ├── Twilio WebSocket (G.711 µ-law audio)
     │        ↕ bidirectional audio bridge
     └── OpenAI Realtime WebSocket (g711_ulaw)
              │
              ├── Tool calls → ToolExecutor
              │     ├── search_products (Vectorize)
              │     ├── search_knowledge_base (Vectorize)
              │     ├── collect_customer_info
              │     ├── collect_shipping_address
              │     ├── set_address_type
              │     ├── transfer_to_human
              │     ├── send_slack_message
              │     └── end_call
              │
              └── Audio responses → Twilio → Caller
```

**Key features:**
- Zero-transcoding audio bridge (G.711 µ-law native on both sides)
- Acknowledge-then-execute pattern for slow tools (AI speaks while tools run)
- 2-phase max call duration alarm (wrap-up → force-close)
- Loop detection and conversation recovery

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers paid plan
- [Twilio account](https://www.twilio.com/try-twilio) with a phone number
- [OpenAI API key](https://platform.openai.com/api-keys) with Realtime API access
- [Node.js](https://nodejs.org/) 18+ and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
# Create Vectorize indexes
npx wrangler vectorize create products --dimensions=1536 --metric=cosine
npx wrangler vectorize create knowledge-base --dimensions=1536 --metric=cosine

# Create KV namespace for product data
npx wrangler kv namespace create PRODUCT_DATA
```

Update `wrangler.toml` with the KV namespace ID from the output.

### 3. Set secrets

```bash
npx wrangler secret put OPENAI_API_KEY
```

Optional secrets:
```bash
npx wrangler secret put SLACK_ACCESS_TOKEN      # for Slack notifications
```

### 4. Configure the agent

Edit `src/config/agentConfig.ts` to set your company details:

```typescript
export const DEFAULT_CONFIG: AgentConfig = {
  companyName: 'Acme Corp',
  agentName: 'Sarah',
  warehouseLocation: 'Chicago Warehouse',
  timezone: 'America/Chicago',
  locale: 'en-US',
  defaultCountry: 'US',
};
```

Or set via environment variables in `wrangler.toml`:
```toml
[vars]
COMPANY_NAME = "Acme Corp"
AGENT_NAME = "Sarah"
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Configure Twilio

1. Go to your Twilio phone number settings
2. Set the **Voice webhook URL** to: `https://your-worker.your-subdomain.workers.dev/twilio/voice-webhook`
3. Method: POST
4. Optionally set **Status callback URL** to: `https://your-worker.your-subdomain.workers.dev/twilio/status-callback`

## Tool Reference

| Tool | Category | Description |
|------|----------|-------------|
| `search_products` | Search | Vector search across product catalog |
| `search_knowledge_base` | Search | Vector search for FAQ/policy answers |
| `collect_customer_info` | Info Collection | Record name, email, phone, company |
| `collect_shipping_address` | Info Collection | Record delivery address |
| `set_address_type` | Info Collection | Commercial or Residential |
| `transfer_to_human` | Call Management | Arrange callback + send Slack notification |
| `send_slack_message` | Notifications | Send Slack notification |
| `end_call` | Call Management | Terminate call gracefully |

## Customization

### Agent Persona & Instructions

Edit `src/agents/voiceAgent.ts` to customize:
- Conversation flow and steps
- Industry-specific language
- Transfer rules and thresholds
- Recovery scripts for different scenarios

### Adding/Removing Tools

1. Add/remove tool definitions in `src/agents/voiceAgent.ts` → `getToolDefinitions()`
2. Add/remove implementations in `src/tools/ToolExecutor.ts` → `execute()` switch + method
3. Update SLOW_TOOLS set in `src/durable-objects/TwilioVoiceSessionDO.ts` if the tool involves network calls

## Development

```bash
npm run dev    # Start local dev server (note: WebSocket testing requires deployment)
npm run tail   # Stream live logs from deployed worker
npm run types  # Generate TypeScript types from wrangler.toml
```

## Troubleshooting

**No audio / one-way audio:**
- Verify Twilio webhook URL is correct and using HTTPS
- Check that OpenAI API key has Realtime API access
- Review logs with `npm run tail`

**Tool calls not executing:**
- Ensure all required secrets are set (`npx wrangler secret list`)

**Call drops after 30 minutes:**
- This is the default max duration. Adjust `MAX_CALL_DURATION_MINUTES` in wrangler.toml

## License

MIT

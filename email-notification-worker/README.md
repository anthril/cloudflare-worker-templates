# Email Notification Worker

Queue-driven email notification worker for Cloudflare Workers. Exposes an authenticated `POST /send` endpoint that enqueues messages to a Cloudflare Queue; a consumer inside the same worker renders the HTML template and delivers the message over SMTP using **nodemailer** with DKIM signing.

Designed to be provider-agnostic — point it at any SMTP endpoint (Amazon SES, Resend, SendGrid, Mailgun, Postmark, self-hosted Postfix, …) by setting four secrets.

---

## How it works

```
HTTP caller ─POST /send─► Worker.fetch()
                              │
                              ├─ bearer auth
                              ├─ validate payload
                              ├─ idempotency check (KV SETNX, 24h TTL)
                              ├─ insert deliveries row (status='queued')
                              └─ EMAIL_QUEUE.send(msg)  ──► Cloudflare Queue
                                                              │
                                                              ▼
                                        Worker.queue(batch)  ◄── consumer
                                              │
                                              ├─ render template (HTML + text)
                                              ├─ nodemailer SMTP send + DKIM sign
                                              ├─ mark deliveries row 'sent' | 'failed'
                                              ├─ write Analytics Engine datapoint
                                              └─ ack() or retry({delaySeconds})
```

Exhausted retries (default: 5) land in `email-notifications-dlq`.

---

## Features

- **Provider-agnostic SMTP** — nodemailer connects via `cloudflare:sockets` under `nodejs_compat`
- **DKIM signing** — done client-side by nodemailer, verified against your `<selector>._domainkey.<domain>` TXT record
- **Idempotency** — caller-supplied key deduplicates repeated sends across a configurable window (default 24h)
- **Delivery log** — D1 table records every send with status, provider message id, attempts, and last error
- **Observable** — Analytics Engine events for `sent`/`failed`, structured Worker logs with `[Queue]`/`[Send]` prefixes
- **Retry + DLQ** — capped exponential backoff (60s, 120s, 240s … 1h cap), failures land in a dead-letter queue
- **Three starter templates** — welcome, password reset, order confirmation (all HTML + plain text)

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers **paid** plan (Queues requires paid)
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A domain hosted in **Cloudflare DNS** that you'll send from (a dedicated subdomain like `mail.example.com` is recommended so your apex reputation stays isolated)
- SMTP credentials from any provider (see `.dev.vars.example` for common ones)

---

## Quick start

```bash
cd email-notification-worker
npm install
cp .dev.vars.example .dev.vars
```

### 1. Provision Cloudflare resources

```bash
npm run setup:queues     # creates email-notifications + email-notifications-dlq
npm run setup:kv         # creates IDEMPOTENCY namespace — paste the returned id into wrangler.toml
npm run setup:d1         # creates email_deliveries D1 — paste the returned database_id into wrangler.toml
npm run setup:d1:migrate # applies migrations/0001_init.sql to the D1 database
```

Edit `wrangler.toml` and uncomment + populate the `id` / `database_id` lines that the commands above returned.

### 2. Generate a DKIM keypair

```bash
npm run generate:dkim
```

Writes `dkim-private.pem` and `dkim-public.pem`. The script prints the exact DNS record value to publish. **Do not commit these files — they are in `.gitignore`.**

### 3. Publish DNS records (SPF / DKIM / DMARC)

```bash
export CLOUDFLARE_API_TOKEN=your-token-with-zone-dns-edit
export CLOUDFLARE_ZONE_ID=your-zone-id                     # dashboard → Overview
export SENDING_DOMAIN=mail.example.com
export DKIM_SELECTOR=s1
export SPF_INCLUDE=amazonses.com                           # your provider's SPF include
export DMARC_RUA=mailto:dmarc@example.com                  # where DMARC reports go
npm run setup:dns
```

Verify:

```bash
dig TXT mail.example.com +short
dig TXT s1._domainkey.mail.example.com +short
dig TXT _dmarc.mail.example.com +short
```

### 4. Push secrets

```bash
echo "$(openssl rand -hex 32)" | wrangler secret put API_BEARER_TOKEN
wrangler secret put SMTP_HOST                      # e.g. email-smtp.us-east-1.amazonaws.com
wrangler secret put SMTP_PORT                      # 587 or 465
wrangler secret put SMTP_USER
wrangler secret put SMTP_PASS
wrangler secret put DKIM_PRIVATE_KEY < dkim-private.pem
echo "s1" | wrangler secret put DKIM_SELECTOR
echo "mail.example.com" | wrangler secret put DKIM_DOMAIN
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Send a test

```bash
export WORKER_URL=https://email-notification-worker.<your-account>.workers.dev
export API_BEARER_TOKEN=<the-token-you-set>
export RECIPIENT=you@example.com
npm run test:send
```

Tail logs in another terminal: `npm run tail`.

---

## Configuration

### Environment variables (`[vars]` in `wrangler.toml`)

| Variable                     | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `FROM_EMAIL`                 | From address (must be within `DKIM_DOMAIN`)        |
| `FROM_NAME`                  | Display name used in the From header               |
| `REPLY_TO_EMAIL`             | Optional Reply-To header                           |
| `IDEMPOTENCY_TTL_SECONDS`    | How long idempotency keys dedupe (default: 86400)  |
| `ENVIRONMENT`                | Free-form tag for logs/metrics                     |

### Secrets

| Secret              | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `API_BEARER_TOKEN`  | Required in `Authorization: Bearer <token>` on `/send`    |
| `SMTP_HOST`         | SMTP server hostname                                      |
| `SMTP_PORT`         | `587` (STARTTLS) or `465` (implicit TLS)                  |
| `SMTP_USER`         | SMTP username                                             |
| `SMTP_PASS`         | SMTP password / API key                                   |
| `DKIM_PRIVATE_KEY`  | PEM-encoded RSA private key (paired with DNS public key)  |
| `DKIM_SELECTOR`     | Selector in the DNS record name (e.g. `s1`)               |
| `DKIM_DOMAIN`       | Sending domain (the `d=` tag on the DKIM signature)       |

### Production: rotate credentials via Cloudflare Secrets Store (recommended)

Plain `wrangler secret put` stores the value against a specific worker version — rotating SMTP or DKIM credentials requires a redeploy, which means a short window where old and new versions run side-by-side. For production you almost certainly want Cloudflare **Secrets Store** instead: secrets live outside any single worker, `put` takes effect immediately, and rotation needs no redeploy.

**Setup (one-time):**

```bash
# 1. Create the store
npm run setup:secrets-store
# → prints a store_id

# 2. Uncomment [[secrets_store_secrets]] in wrangler.toml and paste the store_id
#    [[secrets_store_secrets]]
#    binding = "SMTP_SECRETS"
#    store_id = "<paste-here>"
#    secret_name = "smtp-credentials"

# 3. Write the JSON blob (fields map to env.SMTP_* at read time)
wrangler secrets-store secret put --store-id <id> smtp-credentials \
  --value '{"host":"smtp.example.com","port":"587","user":"u","pass":"p"}'

# 4. Same pattern for the DKIM private key — a second secret keeps concerns separate
wrangler secrets-store secret put --store-id <id> dkim-private-key \
  --value "$(cat dkim-private.pem)"
```

**Wire it up:** uncomment the `SMTP_SECRETS` line in [`src/types.ts`](./src/types.ts), then at the top of `buildTransport()` in [`src/email-service.ts`](./src/email-service.ts) prefer the store when present:

```typescript
async function resolveSmtpConfig(env: Env) {
  if (env.SMTP_SECRETS) {
    const raw = await env.SMTP_SECRETS.get();
    const parsed = JSON.parse(raw) as { host: string; port: string; user: string; pass: string };
    return parsed;
  }
  return { host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS };
}
```

**Rotate:** re-run `wrangler secrets-store secret put`. The next batch picks up the new value on its next transport build — no redeploy.

Plain `wrangler secret put` remains fully supported and is what the Quick Start uses. Skip this section if you're just kicking the tyres.

---

## API

### `POST /send`

Auth: `Authorization: Bearer <API_BEARER_TOKEN>`
Content-Type: `application/json`

**Body:**

```json
{
  "recipient": "user@example.com",
  "template": "welcome",
  "templateData": { "name": "Ada", "productName": "Lovelace Labs" },
  "subject": "Optional override",
  "idempotency_key": "signup-user-123"
}
```

**Responses:**

- `202 Accepted` — `{ "status": "queued", "message_id": "<uuid>" }`
- `200 OK` — `{ "status": "duplicate", "idempotency_key": "..." }` when the idempotency key is still in the dedupe window
- `400 Bad Request` — validation failed, body echoes the specific error
- `401 Unauthorized` — missing/bad bearer token
- `500 Internal Server Error` — failed to enqueue (rare; Queue outage)

### `GET /status/:message_id`

Auth: bearer token (same as `/send`).
Returns the D1 delivery row for a previously-sent message.

```json
{
  "delivery": {
    "message_id": "...",
    "recipient": "user@example.com",
    "template": "welcome",
    "status": "sent",
    "provider_message_id": "<01000190...@us-east-1.amazonses.com>",
    "attempts": 1,
    "last_error": null,
    "created_at": "2026-04-25 10:22:00",
    "updated_at": "2026-04-25 10:22:03"
  }
}
```

### `GET /health`

No auth. Returns `{ "status": "ok", "service": "email-notification-worker", "timestamp": "..." }`.

---

## Templates

Starter templates live in `src/templates/`. Each is a pure function `(data) => { subject, html, text }` — no network calls, no randomness, safe to cache.

To add one:

1. Create `src/templates/<name>.ts` following the shape of `welcome.ts`
2. Add the name to the `TemplateName` union in `src/types.ts`
3. Register it in `REGISTRY` inside `src/template-engine.ts`
4. Add it to `KNOWN_TEMPLATES` in `src/validation.ts`

Always run user-supplied values through `escapeHtml()` before interpolating into HTML.

---

## Observability

### Logs

```bash
npm run tail
```

Structured prefixes: `[Queue]`, `[Send]`.

### Analytics Engine queries

Each send writes a datapoint with `blobs=[status, template, recipient]`, `doubles=[1, attempt]`, `indexes=[message_id]`. Query with wrangler:

```bash
wrangler analytics-engine sql \
  "SELECT blob1, count() FROM email_notification_events GROUP BY blob1"
```

### D1 queries

```bash
wrangler d1 execute email_deliveries --remote --command \
  "select status, count(*) from deliveries group by status"
```

### Dead-letter queue

```bash
wrangler queues consumer get email-notifications-dlq
```

---

## Provider-specific notes

The template programs the **generic** SPF/DKIM/DMARC records. Some providers need additional records:

| Provider   | SMTP host                             | Extra DNS                                                                 |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------- |
| Amazon SES | `email-smtp.<region>.amazonaws.com`   | `_amazonses.<domain>` TXT verification token                              |
| Resend     | `smtp.resend.com`                     | Provider-managed DKIM (skip `generate:dkim`; configure in Resend dashboard) |
| SendGrid   | `smtp.sendgrid.net`                   | Three CNAME records for DKIM (managed by SendGrid, replaces TXT method)   |
| Mailgun    | `smtp.mailgun.org`                    | `mx._domainkey` CNAME replaces the TXT DKIM record                        |
| Postmark   | `smtp.postmarkapp.com`                | Postmark-managed DKIM via `20<year>pm._domainkey` CNAME                   |

If you're using a provider that manages DKIM for you, you can skip `npm run generate:dkim` and leave `DKIM_*` secrets blank — remove the `dkim` block in `src/email-service.ts`. SPF and DMARC still need to be set either way.

---

## Cloudflare zone requirements

- DNS records created by `setup-dns.ts` are **DNS-only** (grey cloud). SPF/DKIM/DMARC are TXT so proxying is not applicable, but any CNAMEs for bounce handling must also be grey-clouded.
- Keep **Cloudflare Email Routing disabled** on the sending subdomain. Email Routing is an inbound-only feature; if enabled on the apex, it auto-creates MX/SPF that will conflict with outbound sending configuration — use a dedicated subdomain.
- Enable **DNSSEC** on the zone (DNS → Settings) for strict DKIM integrity.
- Cloudflare Workers cannot act as an outbound SMTP relay. All outbound mail goes through your chosen third-party SMTP provider via nodemailer.

---

## Troubleshooting

**`553 Relay access denied` / auth failures on send**
SMTP credentials are wrong, or the From address isn't authorized for your account. Check your provider dashboard — most require you to verify the sending domain before it will accept mail.

**`dkim=fail` in the recipient's raw headers**
Public key in DNS doesn't match the private key in the secret. Re-run `generate:dkim`, `setup:dns`, and `wrangler secret put DKIM_PRIVATE_KEY < dkim-private.pem` together.

**Messages stuck in `queued` status forever**
Queue consumer isn't deploying — check `wrangler tail` for errors on the `queue()` handler. Common cause: missing `nodejs_compat` flag, missing secret, or D1 `database_id` not filled in.

**Gmail places mail in spam even with SPF/DKIM/DMARC `pass`**
Warm up the sending domain — new domains get throttled regardless of DNS. Keep volume low for the first week, respond to DMARC reports, and consider publishing a BIMI record once authentication is consistently passing.

**nodemailer bundle too large**
Unlike the other templates in this repo, this worker has a runtime dependency (`nodemailer` ≈ 400KB bundled). Workers paid plan supports up to 10 MB; if you're on free tier, you cannot deploy this template as-is.

---

## Project layout

```
email-notification-worker/
├── src/
│   ├── index.ts                   # fetch + queue handlers
│   ├── email-service.ts           # nodemailer transport + sendMail
│   ├── template-engine.ts         # renderTemplate + escapeHtml
│   ├── templates/                 # welcome, password-reset, order-confirmation
│   ├── delivery-log.ts            # D1 helpers
│   ├── idempotency.ts             # KV helpers
│   ├── auth.ts                    # bearer-token check
│   ├── validation.ts              # POST /send body validator
│   ├── utils.ts                   # CORS, json(), email regex
│   └── types.ts                   # Env + message shapes
├── scripts/
│   ├── generate-dkim.ts           # 2048-bit RSA keypair
│   ├── setup-dns.ts               # Cloudflare DNS API automation
│   └── send-test.ts               # exercise POST /send
├── migrations/
│   └── 0001_init.sql              # D1 schema: deliveries table
├── examples/
│   ├── send-request.example.json
│   └── queue-message.example.json
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .dev.vars.example
└── README.md
```

---

## License

MIT

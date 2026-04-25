/**
 * Fire a test email through the deployed worker.
 *
 * Usage:
 *   WORKER_URL=https://email-notification-worker.<acct>.workers.dev \
 *   API_BEARER_TOKEN=... \
 *   RECIPIENT=you@example.com \
 *   npm run test:send
 *
 * Optional:
 *   TEMPLATE=welcome | password-reset | order-confirmation  (default: welcome)
 *   IDEMPOTENCY_KEY=<key>                                    (default: none)
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const workerUrl = required('WORKER_URL').replace(/\/$/, '');
const token = required('API_BEARER_TOKEN');
const recipient = required('RECIPIENT');
const template = (process.env.TEMPLATE ?? 'welcome') as 'welcome' | 'password-reset' | 'order-confirmation';
const idempotencyKey = process.env.IDEMPOTENCY_KEY;

const sampleData: Record<string, Record<string, unknown>> = {
  'welcome': {
    name: 'Ada',
    productName: 'Lovelace Labs',
    ctaUrl: 'https://app.example.com/onboarding',
  },
  'password-reset': {
    name: 'Ada',
    resetUrl: 'https://app.example.com/reset?token=abc',
    expiresMinutes: 30,
  },
  'order-confirmation': {
    orderNumber: 'A-1042',
    customerName: 'Ada Lovelace',
    items: [
      { name: 'Analytical Engine kit', qty: 1, price: '499.00' },
      { name: 'Punch card bundle', qty: 2, price: '18.00' },
    ],
    total: '535.00',
    currency: 'USD',
    trackingUrl: 'https://tracking.example.com/A-1042',
  },
};

async function main() {
  const body = {
    recipient,
    template,
    templateData: sampleData[template],
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };

  console.log(`POST ${workerUrl}/send`);
  console.log('Body:', JSON.stringify(body, null, 2));

  const res = await fetch(`${workerUrl}/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const result = await res.json().catch(() => ({}));
  console.log(`\nStatus: ${res.status}`);
  console.log('Response:', JSON.stringify(result, null, 2));

  if (!res.ok && res.status !== 202) process.exit(1);

  const messageId = (result as { message_id?: string }).message_id;
  if (messageId) {
    console.log(`\nCheck delivery status:`);
    console.log(`  curl -H "Authorization: Bearer $API_BEARER_TOKEN" ${workerUrl}/status/${messageId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

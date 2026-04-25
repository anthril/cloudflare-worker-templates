/**
 * Environment bindings. Mirrors wrangler.toml.
 *
 * Note: SMTP_SECRETS is commented out because the Secrets Store binding is
 * optional. If you enable [[secrets_store_secrets]] in wrangler.toml, also
 * uncomment the field here and the loader branch in email-service.ts.
 */
export interface Env {
  EMAIL_QUEUE: Queue<EmailMessage>;
  IDEMPOTENCY: KVNamespace;
  DELIVERY_LOG: D1Database;
  EMAIL_METRICS: AnalyticsEngineDataset;
  // SMTP_SECRETS?: SecretsStoreSecret;

  API_BEARER_TOKEN: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  DKIM_PRIVATE_KEY: string;
  DKIM_SELECTOR: string;
  DKIM_DOMAIN: string;

  FROM_EMAIL: string;
  FROM_NAME: string;
  REPLY_TO_EMAIL?: string;
  IDEMPOTENCY_TTL_SECONDS?: string;
  ENVIRONMENT?: string;
}

/** Supported template identifiers. Extend alongside src/templates/. */
export type TemplateName = 'welcome' | 'password-reset' | 'order-confirmation';

/** Incoming HTTP request shape for POST /send. */
export interface SendRequest {
  recipient: string;
  template: TemplateName;
  templateData?: Record<string, unknown>;
  /** Optional subject override. If omitted, the template's default subject is used. */
  subject?: string;
  /** Caller-supplied key. Repeat calls with the same key short-circuit to a duplicate response. */
  idempotency_key?: string;
}

/**
 * Internal queue message — what the consumer receives.
 *
 * Note: retry count is NOT stored on the body. Cloudflare Queues tracks
 * deliveries via the `attempts` property on the runtime Message wrapper,
 * so the consumer reads `msg.attempts` instead of a body field.
 */
export interface EmailMessage {
  message_id: string;
  recipient: string;
  subject?: string;
  template: TemplateName;
  templateData: Record<string, unknown>;
  idempotency_key?: string;
  enqueued_at: string;
}

/** Rendered template output. */
export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

/** Delivery status column values in the D1 `deliveries` table. */
export type DeliveryStatus = 'queued' | 'sent' | 'failed';

/** Result returned by email-service.sendEmail. */
export interface SendResult {
  providerMessageId?: string;
  accepted: string[];
  rejected: string[];
}

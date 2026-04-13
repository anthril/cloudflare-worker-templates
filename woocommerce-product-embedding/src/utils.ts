/**
 * Fetch wrapper with exponential backoff retry logic.
 * Handles rate limiting (429) and server errors (5xx) gracefully.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.ok) return response;

    // Retry on rate limit or server errors
    if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
      await response.text().catch(() => {}); // Consume body
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : baseDelayMs * Math.pow(2, attempt);
      console.warn(`[Retry] Attempt ${attempt + 1}/${maxRetries}, waiting ${delay}ms (status: ${response.status})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    return response; // Non-retryable error
  }
  throw new Error(`fetchWithRetry: All ${maxRetries + 1} attempts failed`);
}

/**
 * Generate embeddings for a batch of texts using OpenAI API.
 * Batches up to 20 texts per API call for efficiency.
 */
export async function generateEmbeddings(
  texts: string[],
  apiKey: string
): Promise<number[][]> {
  const BATCH_SIZE = 20;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await fetchWithRetry('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: batch,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Embeddings API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    allEmbeddings.push(...sorted.map(d => d.embedding));

    // Rate limit between batches
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return allEmbeddings;
}

/**
 * Build searchable text from a WooCommerce product.
 * Concatenates product fields into a single string for embedding generation.
 */
export function buildSearchableText(product: {
  name: string;
  short_description?: string;
  description?: string;
  categories?: Array<{ name: string }>;
  attributes?: Array<{ name: string; options: string[] }>;
}): string {
  return [
    product.name,
    product.short_description || '',
    product.description || '',
    (product.categories || []).map(c => c.name).join(' '),
    (product.attributes || []).map(a => `${a.name}: ${a.options.join(', ')}`).join(' '),
  ].join(' ').replace(/<[^>]*>/g, ''); // Strip HTML tags
}

/**
 * Strip HTML tags from a string.
 */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Verify WooCommerce webhook HMAC-SHA256 signature.
 *
 * WooCommerce signs the raw request body using the webhook secret
 * and sends the base64-encoded HMAC-SHA256 in X-WC-Webhook-Signature.
 *
 * @param rawBody  - The raw request body bytes (NOT re-serialized JSON)
 * @param secret   - The webhook secret configured in WooCommerce
 * @param signature - The value of X-WC-Webhook-Signature header
 * @returns true if the signature is valid
 */
export async function verifyWebhookSignature(
  rawBody: ArrayBuffer,
  secret: string,
  signature: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signed = await crypto.subtle.sign('HMAC', key, rawBody);
  const expectedSignature = arrayBufferToBase64(signed);

  return timingSafeEqual(expectedSignature, signature);
}

/** Convert ArrayBuffer to base64 string. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

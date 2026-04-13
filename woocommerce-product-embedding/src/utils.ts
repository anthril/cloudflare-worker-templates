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

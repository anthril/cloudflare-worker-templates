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

    const response = await fetch('https://api.openai.com/v1/embeddings', {
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

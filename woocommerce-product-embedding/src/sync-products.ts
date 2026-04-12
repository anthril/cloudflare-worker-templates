import type { Env, WooCommerceProduct } from './types';
import { generateEmbeddings, buildSearchableText, stripHtml } from './utils';

const PER_PAGE = 50;
const MAX_PAGES = 100; // Safety limit: 5000 products max
const VECTORIZE_BATCH_SIZE = 100; // Vectorize upsert limit per call

/**
 * Sync all published WooCommerce products to Vectorize + KV.
 */
export async function syncAllProducts(env: Env): Promise<{
  synced: number;
  errors: number;
  deleted: number;
}> {
  console.log('[ProductSync] Starting full WooCommerce product sync');
  const startTime = Date.now();

  const auth = btoa(`${env.WOOCOMMERCE_KEY}:${env.WOOCOMMERCE_SECRET}`);
  const allProducts: WooCommerceProduct[] = [];
  let page = 1;

  // Step 1: Fetch all published products from WooCommerce
  while (page <= MAX_PAGES) {
    console.log(`[ProductSync] Fetching page ${page}...`);
    const response = await fetch(
      `${env.WOOCOMMERCE_URL}/wp-json/wc/v3/products?per_page=${PER_PAGE}&page=${page}&status=publish`,
      { headers: { 'Authorization': `Basic ${auth}` } }
    );

    if (!response.ok) {
      console.error(`[ProductSync] WooCommerce API error on page ${page}: ${response.status} ${response.statusText}`);
      break;
    }

    const products = await response.json() as WooCommerceProduct[];
    console.log(`[ProductSync] Page ${page}: ${products.length} products`);

    if (products.length === 0) break;
    allProducts.push(...products);

    if (products.length < PER_PAGE) break;
    page++;
  }

  console.log(`[ProductSync] Total products fetched: ${allProducts.length}`);

  // Step 2: Generate embeddings in batches
  let synced = 0;
  let errors = 0;
  const syncedWooIds = new Set<number>();

  // Process in chunks to manage memory and API limits
  const CHUNK_SIZE = 20;
  for (let i = 0; i < allProducts.length; i += CHUNK_SIZE) {
    const chunk = allProducts.slice(i, i + CHUNK_SIZE);

    try {
      const searchTexts = chunk.map(p => buildSearchableText(p));
      const embeddings = await generateEmbeddings(searchTexts, env.OPENAI_API_KEY);

      // Build Vectorize vectors
      const vectors: VectorizeVector[] = chunk.map((product, idx) => ({
        id: `product_${product.id}`,
        values: embeddings[idx],
        metadata: {
          name: product.name,
          price: parseFloat(product.regular_price || product.price) || 0,
          sale_price: parseFloat(product.sale_price) || 0,
          sku: product.sku || '',
          short_description: stripHtml(product.short_description || '').substring(0, 500),
          product_url: product.permalink || '',
          product_image_url: product.images?.[0]?.src || '',
          woocommerce_id: product.id,
          stock_quantity: product.stock_quantity || 0,
          categories: (product.categories || []).map(c => c.name).join(', '),
        },
      }));

      // Upsert to Vectorize
      await env.PRODUCTS_INDEX.upsert(vectors);

      // Store full product data in KV
      const kvPromises = chunk.map(product =>
        env.PRODUCT_DATA.put(
          `product:${product.id}`,
          JSON.stringify({
            woocommerce_id: product.id,
            name: product.name,
            description: product.description,
            short_description: product.short_description,
            regular_price: product.regular_price,
            price: product.price,
            sale_price: product.sale_price,
            sku: product.sku,
            stock_quantity: product.stock_quantity,
            weight: product.weight,
            dimensions: product.dimensions,
            categories: product.categories,
            attributes: product.attributes,
            permalink: product.permalink,
            images: product.images,
          }),
          { expirationTtl: 60 * 60 * 24 * 14 } // 14 day TTL
        )
      );
      await Promise.all(kvPromises);

      for (const p of chunk) syncedWooIds.add(p.id);
      synced += chunk.length;
      console.log(`[ProductSync] Synced batch ${Math.floor(i / CHUNK_SIZE) + 1}: ${chunk.length} products`);
    } catch (err) {
      console.error(`[ProductSync] Error processing batch starting at index ${i}:`, err);
      errors += chunk.length;
    }
  }

  // Step 3: Verify synced vectors (batch getByIds in chunks of 20)
  let deleted = 0;
  try {
    const allIds = allProducts.map(p => `product_${p.id}`);
    let verifiedCount = 0;
    for (let i = 0; i < allIds.length; i += 20) {
      const batch = allIds.slice(i, i + 20);
      const existing = await env.PRODUCTS_INDEX.getByIds(batch);
      verifiedCount += existing.length;
    }
    console.log(`[ProductSync] Verified ${verifiedCount} vectors in index`);
  } catch (err) {
    console.error('[ProductSync] Error during verification:', err);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[ProductSync] Complete: ${synced} synced, ${errors} errors, ${deleted} deleted in ${duration}s`);

  return { synced, errors, deleted };
}

import type { Env, WooCommerceProduct, SyncResult } from './types';
import { generateEmbeddings, buildSearchableText, stripHtml, fetchWithRetry } from './utils';

const PER_PAGE = 50;
const MAX_PAGES = 100; // Safety limit: 5000 products max
const CHUNK_SIZE = 20;

/**
 * Sync all published WooCommerce products to Vectorize + KV.
 */
export async function syncAllProducts(env: Env): Promise<SyncResult> {
  console.log('[ProductSync] Starting full WooCommerce product sync');
  const startTime = Date.now();

  const auth = btoa(`${env.WOOCOMMERCE_KEY}:${env.WOOCOMMERCE_SECRET}`);
  const allProducts: WooCommerceProduct[] = [];
  let page = 1;

  // Step 1: Fetch all published products from WooCommerce
  while (page <= MAX_PAGES) {
    console.log(`[ProductSync] Fetching page ${page}...`);
    const response = await fetchWithRetry(
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

  // Step 2: Generate embeddings and sync in batches
  let synced = 0;
  let errors = 0;

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

      // Store full product data in KV (30-day TTL — 3x safety margin for weekly sync)
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
          { expirationTtl: 60 * 60 * 24 * 30 } // 30 day TTL
        )
      );
      await Promise.all(kvPromises);

      synced += chunk.length;
      console.log(`[ProductSync] Synced batch ${Math.floor(i / CHUNK_SIZE) + 1}: ${chunk.length} products`);
    } catch (err) {
      console.error(`[ProductSync] Error processing batch starting at index ${i}:`, err);
      errors += chunk.length;
    }
  }

  // Step 3: Clean up deleted products
  let deleted = 0;
  try {
    const currentIds = allProducts.map(p => p.id);
    const previousIdsRaw = await env.PRODUCT_DATA.get('_sync:product_ids', 'json') as number[] | null;

    if (previousIdsRaw) {
      const currentIdSet = new Set(currentIds);
      const removedIds = previousIdsRaw.filter(id => !currentIdSet.has(id));

      if (removedIds.length > 0) {
        // Delete stale vectors from Vectorize
        const vectorIds = removedIds.map(id => `product_${id}`);
        await env.PRODUCTS_INDEX.deleteByIds(vectorIds);

        // Delete stale product data from KV
        await Promise.all(removedIds.map(id => env.PRODUCT_DATA.delete(`product:${id}`)));

        deleted = removedIds.length;
        console.log(`[ProductSync] Deleted ${deleted} stale products`);
      }
    }

    // Store current product IDs for next sync comparison (no TTL)
    await env.PRODUCT_DATA.put('_sync:product_ids', JSON.stringify(currentIds));
  } catch (err) {
    console.error('[ProductSync] Error during stale product cleanup:', err);
  }

  // Step 4: Store sync metadata (no TTL — persists indefinitely)
  const durationSeconds = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
  const result: SyncResult = {
    synced,
    errors,
    deleted,
    total_products: allProducts.length,
    duration_seconds: durationSeconds,
    completed_at: new Date().toISOString(),
  };

  try {
    await env.PRODUCT_DATA.put('_sync:latest', JSON.stringify(result));
  } catch (err) {
    console.error('[ProductSync] Error storing sync metadata:', err);
  }

  console.log(`[ProductSync] Complete: ${synced} synced, ${errors} errors, ${deleted} deleted in ${durationSeconds}s`);
  return result;
}

/**
 * Sync a single product: generate embedding, upsert to Vectorize, store in KV.
 * Used by the queue consumer for webhook-driven updates.
 */
export async function syncSingleProduct(
  product: WooCommerceProduct,
  env: Env
): Promise<void> {
  const searchText = buildSearchableText(product);
  const embeddings = await generateEmbeddings([searchText], env.OPENAI_API_KEY);

  const vector: VectorizeVector = {
    id: `product_${product.id}`,
    values: embeddings[0],
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
  };

  await env.PRODUCTS_INDEX.upsert([vector]);

  await env.PRODUCT_DATA.put(
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
    { expirationTtl: 60 * 60 * 24 * 30 } // 30 day TTL
  );
}

/**
 * Delete a single product from Vectorize and KV.
 * Used by the queue consumer for webhook-driven deletes.
 * Idempotent: deleting a non-existent product is a no-op.
 */
export async function deleteSingleProduct(
  productId: number,
  env: Env
): Promise<void> {
  await Promise.all([
    env.PRODUCTS_INDEX.deleteByIds([`product_${productId}`]),
    env.PRODUCT_DATA.delete(`product:${productId}`),
  ]);
}

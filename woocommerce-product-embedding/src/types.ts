export interface Env {
  PRODUCTS_INDEX: Vectorize;
  PRODUCT_DATA: KVNamespace;
  PRODUCT_SYNC_QUEUE: Queue<QueueMessage>;
  OPENAI_API_KEY: string;
  WOOCOMMERCE_URL: string;
  WOOCOMMERCE_KEY: string;
  WOOCOMMERCE_SECRET: string;
  SYNC_AUTH_TOKEN?: string;
  WOOCOMMERCE_WEBHOOK_SECRET?: string;
  ENVIRONMENT?: string;
}

export interface WooCommerceProduct {
  id: number;
  name: string;
  description: string;
  short_description: string;
  regular_price: string;
  price: string;
  sale_price: string;
  sku: string;
  stock_quantity: number | null;
  weight: string;
  dimensions: { length: string; width: string; height: string };
  categories: Array<{ name: string }>;
  attributes: Array<{ name: string; options: string[] }>;
  permalink: string;
  images: Array<{ id: number; src: string; alt: string }>;
}

export interface SyncResult {
  synced: number;
  errors: number;
  deleted: number;
  total_products: number;
  duration_seconds: number;
  completed_at: string;
}

/** Queue message for product upsert (create/update/restore) */
export interface QueueMessageUpsert {
  action: 'upsert';
  product_id: number;
  product: WooCommerceProduct;
  webhook_topic: string;
  enqueued_at: string;
}

/** Queue message for product delete */
export interface QueueMessageDelete {
  action: 'delete';
  product_id: number;
  webhook_topic: string;
  enqueued_at: string;
}

/** Discriminated union of all queue message types */
export type QueueMessage = QueueMessageUpsert | QueueMessageDelete;

export interface Env {
  PRODUCTS_INDEX: Vectorize;
  PRODUCT_DATA: KVNamespace;
  OPENAI_API_KEY: string;
  WOOCOMMERCE_URL: string;
  WOOCOMMERCE_KEY: string;
  WOOCOMMERCE_SECRET: string;
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
  stock_quantity: number;
  weight: string;
  dimensions: { length: string; width: string; height: string };
  categories: Array<{ name: string }>;
  attributes: Array<{ name: string; options: string[] }>;
  permalink: string;
  images: Array<{ id: number; src: string; alt: string }>;
}

/**
 * Vector Search Accuracy Test Suite
 *
 * Tests the quality of product embeddings by running queries against
 * the Vectorize index and comparing results against expected outcomes.
 *
 * Usage: npx tsx scripts/test-queries.ts
 *
 * Required env vars:
 *   OPENAI_API_KEY        - OpenAI API key for generating query embeddings
 *   CLOUDFLARE_API_TOKEN  - Cloudflare API token with Vectorize read access
 *   CF_ACCOUNT_ID         - Your Cloudflare account ID
 *
 * Optional env vars:
 *   VECTORIZE_INDEX       - Vectorize index name (default: "products")
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Config ──────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const VECTORIZE_INDEX = process.env.VECTORIZE_INDEX || 'products';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable');
  process.exit(1);
}
if (!CF_API_TOKEN) {
  console.error('Missing CLOUDFLARE_API_TOKEN environment variable');
  process.exit(1);
}
if (!CF_ACCOUNT_ID) {
  console.error('Missing CF_ACCOUNT_ID environment variable');
  process.exit(1);
}

// ─── Types ───────────────────────────────────────────────────────

interface ProductLookupExpect {
  top_k: number;
  must_contain_any: string[];
  min_score: number;
  max_rank?: number;
}

interface CategoryQueryExpect {
  top_k: number;
  must_contain_categories: string[];
  min_relevant: number;
  min_score: number;
}

interface TestCase {
  query: string;
  type: 'product_lookup' | 'category_query';
  expect: ProductLookupExpect | CategoryQueryExpect;
}

interface VectorMatch {
  id: string;
  score: number;
  metadata?: {
    name?: string;
    price?: number;
    sku?: string;
    categories?: string;
    woocommerce_id?: number;
    [key: string]: unknown;
  };
}

interface TestResult {
  query: string;
  type: string;
  status: 'pass' | 'fail' | 'warn';
  details: string;
  topResult: string;
  topScore: number;
  matchRank: number | null;
  results: VectorMatch[];
}

// ─── API Functions ───────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: text, model: 'text-embedding-3-small' }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${err.substring(0, 200)}`);
  }

  const data = await res.json() as { data: [{ embedding: number[] }] };
  return data.data[0].embedding;
}

async function queryVectorize(vector: number[], topK: number): Promise<VectorMatch[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_INDEX}/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ vector, topK, returnMetadata: 'all' }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vectorize API error (${res.status}): ${err.substring(0, 200)}`);
  }

  const data = await res.json() as {
    success: boolean;
    result: { matches: VectorMatch[] };
  };

  return data.result.matches;
}

// ─── Evaluation Functions ────────────────────────────────────────

function evaluateProductLookup(results: VectorMatch[], expect: ProductLookupExpect): TestResult {
  const topResult = results[0]?.metadata?.name || 'No results';
  const topScore = results[0]?.score || 0;

  let matchRank: number | null = null;
  for (let i = 0; i < results.length; i++) {
    const name = (results[i].metadata?.name || '').toLowerCase();
    for (const expected of expect.must_contain_any) {
      if (name.includes(expected.toLowerCase())) {
        matchRank = i + 1;
        break;
      }
    }
    if (matchRank !== null) break;
  }

  const maxRank = expect.max_rank || expect.top_k;

  if (matchRank !== null && matchRank <= maxRank && topScore >= expect.min_score) {
    return {
      query: '', type: 'product_lookup', status: 'pass',
      details: `Expected match found at rank ${matchRank}`,
      topResult, topScore, matchRank, results,
    };
  }

  if (matchRank !== null && topScore < expect.min_score) {
    return {
      query: '', type: 'product_lookup', status: 'warn',
      details: `Match at rank ${matchRank} but top score ${topScore.toFixed(3)} < ${expect.min_score}`,
      topResult, topScore, matchRank, results,
    };
  }

  return {
    query: '', type: 'product_lookup', status: 'fail',
    details: `Expected [${expect.must_contain_any.join(' | ')}] not found in top ${expect.top_k}`,
    topResult, topScore, matchRank, results,
  };
}

function evaluateCategoryQuery(results: VectorMatch[], expect: CategoryQueryExpect): TestResult {
  const topResult = results[0]?.metadata?.name || 'No results';
  const topScore = results[0]?.score || 0;

  let relevantCount = 0;
  for (const result of results) {
    const categories = (result.metadata?.categories || '').toLowerCase();
    for (const expectedCat of expect.must_contain_categories) {
      if (categories.includes(expectedCat.toLowerCase())) {
        relevantCount++;
        break;
      }
    }
  }

  if (relevantCount >= expect.min_relevant && topScore >= expect.min_score) {
    return {
      query: '', type: 'category_query', status: 'pass',
      details: `${relevantCount}/${results.length} results in expected categories (min: ${expect.min_relevant})`,
      topResult, topScore, matchRank: null, results,
    };
  }

  if (relevantCount > 0 && (relevantCount < expect.min_relevant || topScore < expect.min_score)) {
    return {
      query: '', type: 'category_query', status: 'warn',
      details: `${relevantCount}/${results.length} relevant (min: ${expect.min_relevant}), score: ${topScore.toFixed(3)}`,
      topResult, topScore, matchRank: null, results,
    };
  }

  return {
    query: '', type: 'category_query', status: 'fail',
    details: `0/${results.length} results matched categories [${expect.must_contain_categories.join(', ')}]`,
    topResult, topScore, matchRank: null, results,
  };
}

// ─── Report Formatting ──────────────────────────────────────────

function formatReport(testResults: TestResult[]): void {
  const lookups = testResults.filter(r => r.type === 'product_lookup');
  const categories = testResults.filter(r => r.type === 'category_query');

  console.log('');
  console.log('='.repeat(72));
  console.log('  Product Vector Search — Accuracy Test Report');
  console.log('='.repeat(72));

  if (lookups.length > 0) {
    console.log('');
    console.log('  Product Lookup Tests');
    console.log('  ' + '-'.repeat(68));

    for (const r of lookups) {
      const icon = r.status === 'pass' ? '\x1b[32mPASS\x1b[0m' : r.status === 'warn' ? '\x1b[33mWARN\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`  ${icon}  "${r.query}"`);
      console.log(`        -> #1: ${r.topResult} (score: ${r.topScore.toFixed(3)})`);
      console.log(`        -> ${r.details}`);
      console.log('');
    }
  }

  if (categories.length > 0) {
    console.log('  Category / Use-Case Tests');
    console.log('  ' + '-'.repeat(68));

    for (const r of categories) {
      const icon = r.status === 'pass' ? '\x1b[32mPASS\x1b[0m' : r.status === 'warn' ? '\x1b[33mWARN\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`  ${icon}  "${r.query}"`);
      console.log(`        -> #1: ${r.topResult} (score: ${r.topScore.toFixed(3)})`);
      console.log(`        -> ${r.details}`);
      console.log('');
    }
  }

  const passed = testResults.filter(r => r.status === 'pass').length;
  const warned = testResults.filter(r => r.status === 'warn').length;
  const failed = testResults.filter(r => r.status === 'fail').length;
  const total = testResults.length;
  const avgTopScore = testResults.reduce((sum, r) => sum + r.topScore, 0) / total;
  const rankResults = testResults.filter(r => r.matchRank !== null);
  const avgRank = rankResults.length > 0
    ? rankResults.reduce((sum, r) => sum + (r.matchRank || 0), 0) / rankResults.length
    : 0;

  console.log('='.repeat(72));
  console.log(`  Summary: ${passed}/${total} passed, ${failed} failed, ${warned} warnings`);
  console.log(`  Average top score: ${avgTopScore.toFixed(3)}`);
  if (rankResults.length > 0) {
    console.log(`  Average rank of expected product: ${avgRank.toFixed(1)}`);
  }
  console.log('='.repeat(72));
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const testCasesPath = resolve(__dirname, 'test-cases.json');

  if (!existsSync(testCasesPath)) {
    console.error(`\nTest cases file not found: ${testCasesPath}`);
    console.error('Copy the example file to get started:');
    console.error('  cp scripts/test-cases.example.json scripts/test-cases.json');
    console.error('Then edit test-cases.json with your actual product names and categories.\n');
    process.exit(1);
  }

  const testCases: TestCase[] = JSON.parse(readFileSync(testCasesPath, 'utf-8'));

  console.log(`\nRunning ${testCases.length} test queries against ${VECTORIZE_INDEX}...\n`);

  const results: TestResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    process.stdout.write(`  [${i + 1}/${testCases.length}] "${tc.query.substring(0, 50)}"... `);

    try {
      const embedding = await generateEmbedding(tc.query);
      const matches = await queryVectorize(embedding, tc.expect.top_k);

      let result: TestResult;
      if (tc.type === 'product_lookup') {
        result = evaluateProductLookup(matches, tc.expect as ProductLookupExpect);
      } else {
        result = evaluateCategoryQuery(matches, tc.expect as CategoryQueryExpect);
      }

      result.query = tc.query;
      results.push(result);

      const statusIcon = result.status === 'pass' ? '\x1b[32mok\x1b[0m' : result.status === 'warn' ? '\x1b[33mwarn\x1b[0m' : '\x1b[31mfail\x1b[0m';
      console.log(statusIcon);
    } catch (err) {
      console.log('\x1b[31merror\x1b[0m');
      results.push({
        query: tc.query, type: tc.type, status: 'fail',
        details: `Error: ${err instanceof Error ? err.message : 'Unknown'}`,
        topResult: 'N/A', topScore: 0, matchRank: null, results: [],
      });
    }

    if (i < testCases.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  formatReport(results);

  const failCount = results.filter(r => r.status === 'fail').length;
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

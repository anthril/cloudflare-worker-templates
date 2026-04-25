/**
 * Program SPF, DKIM, and DMARC records into a Cloudflare DNS zone via the API.
 *
 * Reads from process.env:
 *   CLOUDFLARE_API_TOKEN   — token with Zone.DNS:Edit on the target zone
 *   CLOUDFLARE_ZONE_ID     — zone id (from Cloudflare dashboard, Overview)
 *   SENDING_DOMAIN         — e.g. mail.example.com
 *   DKIM_SELECTOR          — e.g. s1  (must match the nodemailer selector)
 *   SPF_INCLUDE            — optional; e.g. "amazonses.com" or "_spf.resend.com"
 *   DMARC_RUA              — optional; mailto for DMARC aggregate reports
 *
 * Reads the DKIM public key from dkim-public.pem (created by generate-dkim.ts).
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... SENDING_DOMAIN=mail.example.com \
 *   DKIM_SELECTOR=s1 SPF_INCLUDE=amazonses.com DMARC_RUA=mailto:dmarc@example.com \
 *   npm run setup:dns
 *
 * Safe to re-run: if a record with the same type+name exists, the script
 * updates it instead of creating a duplicate.
 */

import { readFileSync } from 'node:fs';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

interface DnsRecord {
  id?: string;
  type: 'TXT' | 'CNAME' | 'MX';
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  comment?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const apiToken = required('CLOUDFLARE_API_TOKEN');
const zoneId = required('CLOUDFLARE_ZONE_ID');
const sendingDomain = required('SENDING_DOMAIN');
const dkimSelector = required('DKIM_SELECTOR');
const spfInclude = process.env.SPF_INCLUDE;
const dmarcRua = process.env.DMARC_RUA;

const dkimPublicPem = readFileSync('dkim-public.pem', 'utf8');
const dkimPublicBase64 = dkimPublicPem
  .replace(/-----BEGIN PUBLIC KEY-----/g, '')
  .replace(/-----END PUBLIC KEY-----/g, '')
  .replace(/\s+/g, '');

const records: DnsRecord[] = [
  {
    type: 'TXT',
    name: sendingDomain,
    content: spfInclude
      ? `v=spf1 include:${spfInclude} -all`
      : 'v=spf1 -all',
    comment: 'SPF — authorizes providers to send on behalf of this domain',
  },
  {
    type: 'TXT',
    name: `${dkimSelector}._domainkey.${sendingDomain}`,
    content: `v=DKIM1; k=rsa; p=${dkimPublicBase64}`,
    comment: 'DKIM public key — paired with nodemailer DKIM_PRIVATE_KEY',
  },
  {
    type: 'TXT',
    name: `_dmarc.${sendingDomain}`,
    content: dmarcRua
      ? `v=DMARC1; p=quarantine; rua=${dmarcRua}; adkim=s; aspf=s`
      : 'v=DMARC1; p=quarantine; adkim=s; aspf=s',
    comment: 'DMARC — policy + aggregate reporting',
  },
];

async function cfFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CLOUDFLARE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as { success: boolean; errors?: unknown; result?: T };
  if (!body.success) {
    throw new Error(`Cloudflare API error (${res.status}): ${JSON.stringify(body.errors)}`);
  }
  return body.result as T;
}

async function findExisting(record: DnsRecord): Promise<DnsRecord | null> {
  const params = new URLSearchParams({ type: record.type, name: record.name });
  const results = await cfFetch<DnsRecord[]>(`/zones/${zoneId}/dns_records?${params}`);
  return results[0] ?? null;
}

async function upsert(record: DnsRecord): Promise<'created' | 'updated'> {
  const existing = await findExisting(record);
  const payload = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl ?? 3600,
    proxied: false, // SPF/DKIM/DMARC TXT and mail CNAMEs must not be proxied
    comment: record.comment,
  };

  if (existing?.id) {
    await cfFetch(`/zones/${zoneId}/dns_records/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return 'updated';
  }

  await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return 'created';
}

async function main() {
  console.log(`Zone: ${zoneId}`);
  console.log(`Sending domain: ${sendingDomain}\n`);

  for (const record of records) {
    try {
      const action = await upsert(record);
      console.log(`  ✓ ${action.padEnd(7)} ${record.type.padEnd(5)} ${record.name}`);
    } catch (err) {
      console.error(`  ✗ failed  ${record.type.padEnd(5)} ${record.name}:`, err);
      process.exitCode = 1;
    }
  }

  console.log('\nDone. Verify with:');
  console.log(`  dig TXT ${sendingDomain} +short`);
  console.log(`  dig TXT ${dkimSelector}._domainkey.${sendingDomain} +short`);
  console.log(`  dig TXT _dmarc.${sendingDomain} +short`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

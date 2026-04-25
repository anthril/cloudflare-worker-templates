/**
 * Generate a 2048-bit RSA keypair for DKIM signing.
 *
 * Writes:
 *   dkim-private.pem  — pipe this to `wrangler secret put DKIM_PRIVATE_KEY`
 *   dkim-public.pem   — extract the inner base64 body; that's the `p=` value
 *                       for your <selector>._domainkey.<domain> TXT record
 *
 * Prints to stdout the ready-to-paste DNS record value so the output can be
 * scripted into setup-dns.ts or pasted into the Cloudflare dashboard.
 *
 * Usage: npm run generate:dkim
 */

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync('dkim-private.pem', privateKey, { mode: 0o600 });
writeFileSync('dkim-public.pem', publicKey, { mode: 0o644 });

// Strip PEM armor + newlines — the DKIM TXT record uses the raw base64 body.
const dkimPublicBase64 = publicKey
  .replace(/-----BEGIN PUBLIC KEY-----/g, '')
  .replace(/-----END PUBLIC KEY-----/g, '')
  .replace(/\s+/g, '');

console.log('\n✅ DKIM keypair generated.\n');
console.log('Private key written to: dkim-private.pem');
console.log('Public key written to:  dkim-public.pem');
console.log('\nUpload the private key as a secret:');
console.log('  wrangler secret put DKIM_PRIVATE_KEY < dkim-private.pem\n');
console.log('Publish this TXT record in Cloudflare DNS:');
console.log('  Name:  <selector>._domainkey.<your-sending-domain>');
console.log('  Type:  TXT');
console.log(`  Value: v=DKIM1; k=rsa; p=${dkimPublicBase64}\n`);
console.log('Or pass the public key to setup-dns.ts (reads dkim-public.pem automatically).');

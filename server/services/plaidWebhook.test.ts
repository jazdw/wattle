import { describe, expect, it } from 'vitest';
import { bytesToBase64Url, sha256Hex } from '../lib/encoding';
import { verifyPlaidWebhook } from './plaidWebhook';

const encode = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

async function setup() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (payload: unknown, kid: string) => {
    const head = `${encode({ alg: 'ES256', kid, typ: 'JWT' })}.${encode(payload)}`;
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(head));
    return `${head}.${bytesToBase64Url(new Uint8Array(signature))}`;
  };
  const plaid = { getWebhookVerificationKey: async () => ({ ...jwk, expired_at: null }) as never };
  return { sign, plaid };
}

describe('verifyPlaidWebhook', () => {
  const now = new Date('2026-10-09T00:00:00Z');
  const body = '{"webhook_type":"HOLDINGS","webhook_code":"DEFAULT_UPDATE"}';

  it('accepts a correctly signed, fresh webhook', async () => {
    const { sign, plaid } = await setup();
    const jwt = await sign({ iat: now.getTime() / 1000, request_body_sha256: await sha256Hex(body) }, 'k1');
    expect(await verifyPlaidWebhook(plaid, jwt, body, now)).toBe(true);
  });

  it('rejects a tampered body, a stale token and a missing header', async () => {
    const { sign, plaid } = await setup();
    const jwt = await sign({ iat: now.getTime() / 1000, request_body_sha256: await sha256Hex(body) }, 'k2');
    expect(await verifyPlaidWebhook(plaid, jwt, body.replace('HOLDINGS', 'ITEM'), now)).toBe(false);
    const stale = await sign({ iat: now.getTime() / 1000 - 600, request_body_sha256: await sha256Hex(body) }, 'k3');
    expect(await verifyPlaidWebhook(plaid, stale, body, now)).toBe(false);
    expect(await verifyPlaidWebhook(plaid, undefined, body, now)).toBe(false);
  });
});

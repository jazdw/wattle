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

describe('verification key cache', () => {
  it('re-fetches keys after an hour and rejects retired keys', async () => {
    const { sign, plaid } = await setup();
    let calls = 0;
    let retired = false;
    const counting = {
      getWebhookVerificationKey: async () => {
        calls += 1;
        const key = (await plaid.getWebhookVerificationKey()) as Record<string, unknown>;
        return { ...key, expired_at: retired ? 1 : null } as never;
      },
    };
    const body = '{"webhook_type":"HOLDINGS"}';
    const check = async (date: Date) => {
      const jwt = await sign({ iat: date.getTime() / 1000, request_body_sha256: await sha256Hex(body) }, 'rotating');
      return verifyPlaidWebhook(counting, jwt, body, date);
    };
    const t0 = new Date('2026-10-09T00:00:00Z');
    expect(await check(t0)).toBe(true);
    expect(await check(new Date(t0.getTime() + 30 * 60_000))).toBe(true);
    expect(calls).toBe(1); // cached within the hour

    retired = true;
    expect(await check(new Date(t0.getTime() + 61 * 60_000))).toBe(false);
    expect(calls).toBe(2);
  });

  it('rejects webhooks when the key lookup fails', async () => {
    const { sign } = await setup();
    const failing = {
      getWebhookVerificationKey: async () => {
        throw new Error('network');
      },
    };
    const now = new Date('2026-10-09T00:00:00Z');
    const jwt = await sign({ iat: now.getTime() / 1000, request_body_sha256: await sha256Hex('{}') }, 'unknown-kid');
    expect(await verifyPlaidWebhook(failing, jwt, '{}', now)).toBe(false);
  });
});

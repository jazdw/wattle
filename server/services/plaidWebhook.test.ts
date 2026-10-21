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

describe('key lookups from unverified requests', () => {
  const counter = () => {
    const calls: string[] = [];
    const plaid = {
      getWebhookVerificationKey: async (kid: string) => {
        calls.push(kid);
        throw new Error('INVALID_WEBHOOK_VERIFICATION_KEY_ID');
      },
    };
    return { calls, plaid };
  };
  const forged = async (sign: (payload: unknown, kid: string) => Promise<string>, kid: string, at: Date) =>
    sign({ iat: at.getTime() / 1000, request_body_sha256: await sha256Hex('{}') }, kid);

  it("doesn't ask Plaid about malformed key ids", async () => {
    const { sign } = await setup();
    const { calls, plaid } = counter();
    const at = new Date('2026-11-01T00:00:00Z');
    expect(await verifyPlaidWebhook(plaid, await forged(sign, '../../etc', at), '{}', at)).toBe(false);
    expect(await verifyPlaidWebhook(plaid, await forged(sign, 'x'.repeat(65), at), '{}', at)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('asks about an unknown key id once every five minutes', async () => {
    const { sign } = await setup();
    const { calls, plaid } = counter();
    const at = new Date('2026-11-02T00:00:00Z');
    for (let i = 0; i < 5; i += 1) expect(await verifyPlaidWebhook(plaid, await forged(sign, 'made-up', at), '{}', at)).toBe(false);
    expect(calls).toEqual(['made-up']);
    const later = new Date(at.getTime() + 6 * 60_000);
    await verifyPlaidWebhook(plaid, await forged(sign, 'made-up', later), '{}', later);
    expect(calls).toEqual(['made-up', 'made-up']);
  });

  it('makes only a few lookups a minute, and still verifies with a cached key', async () => {
    const { sign, plaid: real } = await setup();
    const { calls, plaid: failing } = counter();
    const at = new Date('2026-11-03T00:00:00Z');
    // Plaid's real key, already cached.
    const body = '{"webhook_type":"HOLDINGS"}';
    const genuine = async () => sign({ iat: at.getTime() / 1000, request_body_sha256: await sha256Hex(body) }, 'real-key');
    expect(await verifyPlaidWebhook(real, await genuine(), body, at)).toBe(true);

    for (let i = 0; i < 30; i += 1) await verifyPlaidWebhook(failing, await forged(sign, `flood-${i}`, at), '{}', at);
    expect(calls.length).toBeLessThan(10);
    expect(await verifyPlaidWebhook(failing, await genuine(), body, at)).toBe(true);
  });
});

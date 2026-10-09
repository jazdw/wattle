/**
 * Plaid webhook verification. Plaid signs each webhook with an ES256 JWT in
 * the `Plaid-Verification` header; its payload carries the SHA-256 of the raw
 * body and an `iat` timestamp.
 * https://plaid.com/docs/api/webhooks/webhook-verification/
 */
import { base64ToBytes, safeEqual, sha256Hex } from '../lib/encoding';
import type { PlaidApi } from '../adapters/plaid';

const MAX_AGE_SECONDS = 5 * 60;
const keyCache = new Map<string, JsonWebKey & { expired_at?: number | null }>();

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64ToBytes(segment))) as T;
}

export async function verifyPlaidWebhook(
  plaid: Pick<PlaidApi, 'getWebhookVerificationKey'>,
  jwt: string | undefined,
  rawBody: string,
  now: Date,
): Promise<boolean> {
  if (!jwt) return false;
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header: { alg?: string; kid?: string };
  let payload: { iat?: number; request_body_sha256?: string };
  try {
    header = decodeJson(headerSegment);
    payload = decodeJson(payloadSegment);
  } catch {
    return false;
  }
  if (header.alg !== 'ES256' || !header.kid) return false;

  let jwk = keyCache.get(header.kid);
  if (!jwk) {
    jwk = (await plaid.getWebhookVerificationKey(header.kid)) as unknown as JsonWebKey & {
      expired_at?: number | null;
    };
    keyCache.set(header.kid, jwk);
  }
  if (jwk.expired_at) return false;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64ToBytes(signatureSegment),
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  if (!valid) return false;

  if (typeof payload.iat !== 'number' || now.getTime() / 1000 - payload.iat > MAX_AGE_SECONDS) return false;
  if (typeof payload.request_body_sha256 !== 'string') return false;
  return safeEqual(await sha256Hex(rawBody), payload.request_body_sha256);
}

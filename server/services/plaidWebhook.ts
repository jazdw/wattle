/**
 * Plaid webhook verification. Plaid signs each webhook with an ES256 JWT in
 * the `Plaid-Verification` header; its payload carries the SHA-256 of the raw
 * body and an `iat` timestamp.
 * https://plaid.com/docs/api/webhooks/webhook-verification/
 *
 * The JWT is verified with `jose`. Plaid's public keys come from its API
 * (/webhook_verification_key/get, authenticated with our Plaid credentials),
 * so they're cached here: in this Worker instance's memory, per key id,
 * re-checked hourly so a key Plaid retires (`expired_at`) stops being trusted.
 *
 * The webhook is open to anyone, and the key id comes from the unverified
 * header, so lookups are limited: key ids must look like one, an id Plaid
 * didn't give a key for isn't asked about again for a while, and each
 * instance makes only a few lookups a minute. Plaid's real key is normally
 * cached, so a flood of made-up ids can't hold up genuine webhooks for long.
 */
import { importJWK, jwtVerify, type JWK } from 'jose';
import { safeEqual, sha256Hex } from '../lib/encoding';
import type { PlaidApi } from '../adapters/plaid';

const MAX_AGE = '5 minutes';
const KEY_TTL_MS = 60 * 60 * 1000;
/** How long a key id Plaid had no key for is refused without asking again. */
const FAILED_TTL_MS = 5 * 60 * 1000;
/** Key lookups each instance may make per minute. */
const LOOKUPS_PER_MINUTE = 10;
const KID_PATTERN = /^[\w-]{1,64}$/;
type PlaidJwk = JWK & { expired_at?: number | null };
const keyCache = new Map<string, { key: PlaidJwk; fetchedAt: number }>();
const failedKids = new Map<string, number>();
let recentLookups: number[] = [];

async function plaidKey(
  plaid: Pick<PlaidApi, 'getWebhookVerificationKey'>,
  kid: string | undefined,
  now: Date,
): Promise<PlaidJwk> {
  if (!kid || !KID_PATTERN.test(kid)) throw new Error('Plaid webhook JWT has no valid key id');
  const at = now.getTime();
  const cached = keyCache.get(kid);
  if (cached && at - cached.fetchedAt < KEY_TTL_MS) return cached.key;
  const failedAt = failedKids.get(kid);
  if (failedAt !== undefined && at - failedAt < FAILED_TTL_MS) throw new Error('Plaid had no key for this id recently');
  recentLookups = recentLookups.filter((time) => at - time < 60_000);
  if (recentLookups.length >= LOOKUPS_PER_MINUTE) throw new Error('Too many webhook key lookups');
  recentLookups.push(at);
  let key: PlaidJwk;
  try {
    key = (await plaid.getWebhookVerificationKey(kid)) as unknown as PlaidJwk;
  } catch (error) {
    if (failedKids.size > 1000) failedKids.clear();
    failedKids.set(kid, at);
    throw error;
  }
  keyCache.set(kid, { key, fetchedAt: at });
  return key;
}

export async function verifyPlaidWebhook(
  plaid: Pick<PlaidApi, 'getWebhookVerificationKey'>,
  jwt: string | undefined,
  rawBody: string,
  now: Date,
): Promise<boolean> {
  if (!jwt) return false;
  try {
    const { payload } = await jwtVerify(
      jwt,
      async (header) => {
        const jwk = await plaidKey(plaid, header.kid, now);
        if (jwk.expired_at) throw new Error('Plaid webhook key has expired');
        return importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, 'ES256');
      },
      { algorithms: ['ES256'], maxTokenAge: MAX_AGE, currentDate: now },
    );
    // The signature covers a hash of the body; check it's the body we got.
    const expected = payload.request_body_sha256;
    return typeof expected === 'string' && safeEqual(await sha256Hex(rawBody), expected);
  } catch {
    return false;
  }
}

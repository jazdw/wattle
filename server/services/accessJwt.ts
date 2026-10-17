/**
 * Cloudflare Access token verification (optional second lock).
 *
 * When the app sits behind Cloudflare Access, every request Access lets
 * through carries `Cf-Access-Jwt-Assertion`: an RS256 JWT signed by Access
 * for your team. Checking it means a request that didn't come through Access
 * (a disabled or mis-scoped policy, another route to the Worker) is refused
 * even though Wattle's own sign-in would otherwise be the only barrier.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 *
 * Verification uses `jose`. Its remote key set fetches
 * https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, keeps the keys in
 * this Worker instance's memory for an hour, and refetches early (at most
 * once a minute) when a token names a key id it hasn't seen — Access rotates
 * keys every 6 weeks and keeps the old one valid for 7 days.
 */
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AccessConfig {
  /** Team domain, e.g. "myteam.cloudflareaccess.com". */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  audience: string;
}

/** One key set per issuer, per Worker instance (in memory). */
const keySets = new Map<string, JWTVerifyGetKey>();

/** "myteam", "myteam.cloudflareaccess.com" or "https://myteam.cloudflareaccess.com" → issuer URL. */
export function accessIssuer(teamDomain: string): string {
  const host = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${host.includes('.') ? host : `${host}.cloudflareaccess.com`}`;
}

function keySetFor(issuer: string, fetchFn?: typeof fetch): JWTVerifyGetKey {
  let keySet = keySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cacheMaxAge: 60 * 60 * 1000,
      cooldownDuration: 60 * 1000,
      ...(fetchFn ? { [customFetch]: fetchFn } : {}),
    });
    keySets.set(issuer, keySet);
  }
  return keySet;
}

/** True when `token` is a valid Access token for this team and application. */
export async function verifyAccessToken(
  config: AccessConfig,
  token: string | undefined,
  now: Date,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (!token) return false;
  const issuer = accessIssuer(config.teamDomain);
  try {
    await jwtVerify(token, keySetFor(issuer, fetchFn), {
      issuer,
      audience: config.audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp'],
      clockTolerance: 60,
      currentDate: now,
    });
    return true;
  } catch {
    // Bad signature, wrong issuer/audience, expired, or keys unavailable:
    // fail closed.
    return false;
  }
}

/** Test hook: forget cached key sets. */
export function clearAccessKeyCache(): void {
  keySets.clear();
}

/**
 * Google sign-in via openid-client (OpenID-certified; same author as jose).
 *
 * Google's endpoints are pinned below rather than read from its discovery
 * document, so a sign-in makes no extra request. The ID token arrives
 * directly from Google's token endpoint over TLS, so (per OpenID Connect)
 * openid-client validates its claims — issuer, audience, expiry, nonce —
 * without needing Google's signing keys.
 *
 * The flow uses PKCE (the code only works with the verifier this browser
 * holds), `state` (the callback belongs to a sign-in this browser started)
 * and `nonce` (the ID token was minted for this sign-in).
 */
import * as oidc from 'openid-client';

const GOOGLE: oidc.ServerMetadata = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
};

/** What the browser keeps (in a short-lived HttpOnly cookie) between redirect and callback. */
export interface PendingSignIn {
  state: string;
  verifier: string;
  nonce: string;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

function configuration(clientId: string, clientSecret: string): oidc.Configuration {
  return new oidc.Configuration(GOOGLE, clientId, clientSecret);
}

export function callbackUrl(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/api/auth/google/callback`;
}

/** Start a sign-in: the Google URL to redirect to, and what to remember. */
export async function startSignIn(
  clientId: string,
  requestUrl: string,
): Promise<{ url: URL; pending: PendingSignIn }> {
  const pending = { state: oidc.randomState(), verifier: oidc.randomPKCECodeVerifier(), nonce: oidc.randomNonce() };
  // The client secret is only needed for the token exchange.
  const url = oidc.buildAuthorizationUrl(configuration(clientId, ''), {
    redirect_uri: callbackUrl(requestUrl),
    scope: 'openid email profile',
    prompt: 'select_account',
    access_type: 'online',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier),
    code_challenge_method: 'S256',
  });
  return { url, pending };
}

/**
 * Finish a sign-in: exchange the code (with the PKCE verifier), check state
 * and nonce, and return the profile from the validated ID token. Throws on
 * any failure.
 */
export async function finishSignIn(
  clientId: string,
  clientSecret: string,
  requestUrl: string,
  pending: PendingSignIn,
): Promise<GoogleProfile> {
  const tokens = await oidc.authorizationCodeGrant(
    configuration(clientId, clientSecret),
    new URL(requestUrl),
    {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    },
    { redirect_uri: callbackUrl(requestUrl) },
  );
  const claims = tokens.claims();
  if (!claims?.sub || typeof claims.email !== 'string') throw new Error('Google ID token has no email.');
  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    picture: typeof claims.picture === 'string' ? claims.picture : undefined,
  };
}

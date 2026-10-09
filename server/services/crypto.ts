/**
 * Encryption at rest for aggregator access tokens (AES-256-GCM, WebCrypto).
 *
 * TOKEN_ENC_KEY holds one or more base64 32-byte keys: either a bare key
 * (version "v1") or "v2:<key>,v1:<key>". The first key encrypts; any listed
 * key decrypts, so keys can be rotated by prepending a new version.
 *
 * Ciphertext format: `<version>.<iv>.<ciphertext>` (base64url). The additional
 * authenticated data binds a token to its household and connection, so a
 * ciphertext copied to another row will not decrypt.
 */
import { base64ToBytes, bytesToBase64Url } from '../lib/encoding';

export interface TokenKeys {
  current: string;
  keys: Map<string, CryptoKey>;
}

const keyCache = new Map<string, Promise<TokenKeys>>();

export function loadTokenKeys(config: string | undefined): Promise<TokenKeys> {
  if (!config) throw new Error('TOKEN_ENC_KEY is not configured.');
  let cached = keyCache.get(config);
  if (!cached) {
    cached = importKeys(config);
    keyCache.set(config, cached);
  }
  return cached;
}

async function importKeys(config: string): Promise<TokenKeys> {
  const entries = config
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(':');
      return separator > 0 ? [part.slice(0, separator), part.slice(separator + 1)] : ['v1', part];
    });
  if (entries.length === 0) throw new Error('TOKEN_ENC_KEY is empty.');

  const keys = new Map<string, CryptoKey>();
  for (const [version, encoded] of entries) {
    const raw = base64ToBytes(encoded);
    if (raw.length !== 32) throw new Error(`TOKEN_ENC_KEY ${version} must be 32 bytes (base64).`);
    keys.set(version, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return { current: entries[0][0], keys };
}

export async function encryptToken(keys: TokenKeys, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    keys.keys.get(keys.current)!,
    new TextEncoder().encode(plaintext),
  );
  return `${keys.current}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(keys: TokenKeys, value: string, aad: string): Promise<string> {
  const [version, iv, ciphertext] = value.split('.');
  const key = keys.keys.get(version);
  if (!key || !iv || !ciphertext) throw new Error('Unknown token key version.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv), additionalData: new TextEncoder().encode(aad) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export function tokenAad(householdId: string, connectionId: string): string {
  return `${householdId}:${connectionId}`;
}

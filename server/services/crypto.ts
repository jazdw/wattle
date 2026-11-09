/**
 * Encryption at rest for aggregator access tokens (AES-256-GCM, WebCrypto).
 *
 * TOKEN_ENC_KEY holds one or more base64 32-byte keys: either a bare key
 * (version "v1") or "v2:<key>,v1:<key>". The first key encrypts; any listed
 * key decrypts.
 *
 * Rotating to a key you hold (the current one can't be read back from the
 * Worker): set it as TOKEN_ENC_KEY_NEXT. It then encrypts, the current key
 * still decrypts, and the nightly job re-encrypts every stored token with it
 * (./tokenRotation). Once none are left on the old key, set TOKEN_ENC_KEY to
 * the new key and delete TOKEN_ENC_KEY_NEXT. A token whose version isn't
 * listed is tried with every key (the wrong one fails GCM's check), so the
 * new key works there with its version prefix or without.
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

/** TOKEN_ENC_KEY with TOKEN_ENC_KEY_NEXT, when set, first: the next version after the highest listed (or its own). */
export function withNextKey(current: string | undefined, next: string | undefined): string | undefined {
  const upcoming = next?.trim();
  if (!upcoming) return current;
  const parts = (current ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.indexOf(':') > 0 ? part : `v1:${part}`));
  const keyOf = (part: string) => part.slice(part.indexOf(':') + 1);
  const nextKey = upcoming.indexOf(':') > 0 ? keyOf(upcoming) : upcoming;
  // Already the key that encrypts (the swap done, the extra secret left set): nothing to add.
  if (parts.length > 0 && keyOf(parts[0]) === nextKey) return parts.join(',');
  const highest = Math.max(0, ...parts.map((part) => Number(part.slice(1, part.indexOf(':'))) || 0));
  const labelled = upcoming.indexOf(':') > 0 ? upcoming : `v${highest + 1}:${upcoming}`;
  return [labelled, ...parts.filter((part) => keyOf(part) !== nextKey)].join(',');
}

/** Whether a stored token is under a key other than the one that encrypts (so the nightly job re-encrypts it). */
export function needsRotation(keys: TokenKeys, value: string): boolean {
  return value.split('.')[0] !== keys.current;
}

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
  if (!iv || !ciphertext) throw new Error('Not an encrypted token.');
  const open = (key: CryptoKey) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), additionalData: new TextEncoder().encode(aad) }, key, base64ToBytes(ciphertext));
  const key = keys.keys.get(version);
  if (key) return new TextDecoder().decode(await open(key));
  // A version not listed (the new key set without its prefix): each key in turn, the wrong ones failing GCM's check.
  for (const candidate of keys.keys.values()) {
    try {
      return new TextDecoder().decode(await open(candidate));
    } catch {
      // Not this key.
    }
  }
  throw new Error('Unknown token key version.');
}

export function tokenAad(householdId: string, connectionId: string): string {
  return `${householdId}:${connectionId}`;
}

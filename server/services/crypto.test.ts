import { describe, expect, it } from 'vitest';
import { TEST_KEY } from '../../test/helpers';
import { decryptToken, encryptToken, loadTokenKeys, needsRotation, withNextKey } from './crypto';

describe('token encryption', () => {
  it('round-trips and binds to the AAD', async () => {
    const keys = await loadTokenKeys(TEST_KEY);
    const sealed = await encryptToken(keys, 'access-sandbox-123', 'h1:c1');
    expect(sealed).not.toContain('access-sandbox');
    expect(await decryptToken(keys, sealed, 'h1:c1')).toBe('access-sandbox-123');
    await expect(decryptToken(keys, sealed, 'h2:c1')).rejects.toThrow();
  });

  it('decrypts with older key versions after rotation', async () => {
    const oldKeys = await loadTokenKeys(`v1:${TEST_KEY}`);
    const sealed = await encryptToken(oldKeys, 'secret', 'aad');
    const fresh = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const rotated = await loadTokenKeys(`v2:${fresh},v1:${TEST_KEY}`);
    expect(await decryptToken(rotated, sealed, 'aad')).toBe('secret');
    expect((await encryptToken(rotated, 'x', 'aad')).startsWith('v2.')).toBe(true);
  });

  it('puts a new key to rotate to first, as the next version after the highest', async () => {
    const fresh = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect(withNextKey(TEST_KEY, undefined)).toBe(TEST_KEY);
    expect(withNextKey(TEST_KEY, fresh)).toBe(`v2:${fresh},v1:${TEST_KEY}`);
    expect(withNextKey(`v3:${TEST_KEY}`, fresh)).toBe(`v4:${fresh},v3:${TEST_KEY}`);
    // Swapped already, the extra secret still set: nothing to add.
    expect(withNextKey(`v2:${fresh}`, fresh)).toBe(`v2:${fresh}`);
    const keys = await loadTokenKeys(withNextKey(TEST_KEY, fresh));
    expect(needsRotation(keys, await encryptToken(await loadTokenKeys(TEST_KEY), 'x', 'aad'))).toBe(true);
    expect(needsRotation(keys, await encryptToken(keys, 'x', 'aad'))).toBe(false);
  });

  it('decrypts a token whose key is set without its version prefix, by trying each key', async () => {
    const fresh = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const sealed = await encryptToken(await loadTokenKeys(`v2:${fresh}`), 'secret', 'aad');
    // The new key set bare (read as v1): still opens v2's tokens.
    expect(await decryptToken(await loadTokenKeys(fresh), sealed, 'aad')).toBe('secret');
    // Not with the wrong key.
    await expect(decryptToken(await loadTokenKeys(TEST_KEY), sealed, 'aad')).rejects.toThrow();
  });
});

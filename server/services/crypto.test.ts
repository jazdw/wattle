import { describe, expect, it } from 'vitest';
import { TEST_KEY } from '../../test/helpers';
import { decryptToken, encryptToken, loadTokenKeys } from './crypto';

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
});

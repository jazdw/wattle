import { describe, expect, it } from 'vitest';
import { ProviderHttpError } from '../server/adapters/marketData';
import { ProviderBackoffError, withBackoff } from '../server/services/backoff';
import { createTestDeps } from './helpers';

describe('provider back-off', () => {
  it('stops calling a provider for 15 minutes after "too many requests", everywhere', async () => {
    const deps = await createTestDeps();
    let calls = 0;
    let limited = true;
    const provider = {
      name: 'fake',
      async closes() {
        calls += 1;
        if (limited) throw new ProviderHttpError('Fake', 429);
        return 'closes';
      },
    };
    const wrapped = withBackoff(provider, 'fake', () => deps);
    expect(wrapped.name).toBe('fake'); // non-methods pass through

    await expect(wrapped.closes()).rejects.toBeInstanceOf(ProviderHttpError);
    expect(calls).toBe(1);
    // Backing off: not called again, here or from another request's wrapper.
    await expect(wrapped.closes()).rejects.toBeInstanceOf(ProviderBackoffError);
    await expect(withBackoff(provider, 'fake', () => deps).closes()).rejects.toBeInstanceOf(ProviderBackoffError);
    expect(calls).toBe(1);

    // Fifteen minutes later it tries again.
    limited = false;
    const later = new Date(deps.now().getTime() + 15 * 60_000 + 1);
    deps.now = () => later;
    expect(await withBackoff(provider, 'fake', () => deps).closes()).toBe('closes');
    expect(calls).toBe(2);
  });

  it('ignores other errors', async () => {
    const deps = await createTestDeps();
    let calls = 0;
    const provider = {
      async closes() {
        calls += 1;
        throw new ProviderHttpError('Fake', 500);
      },
    };
    const wrapped = withBackoff(provider, 'fake', () => deps);
    await expect(wrapped.closes()).rejects.toBeInstanceOf(ProviderHttpError);
    await expect(wrapped.closes()).rejects.toBeInstanceOf(ProviderHttpError);
    expect(calls).toBe(2);
  });
});

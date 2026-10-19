/**
 * Back off from a market-data provider that says "too many requests" (HTTP
 * 429): for BACKOFF_SECONDS no call is made to it, everywhere (the marker
 * lives in the shared cache table, so every request and Worker instance sees
 * it). Callers already fall back to cached quotes or stored closes when a
 * provider call fails, so they simply carry on with what's stored. Retrying
 * on every page refresh would only keep the limit exhausted (Tiingo's free
 * plan allows 50 requests an hour).
 */
import { ProviderHttpError } from '../adapters/marketData';
import type { Deps } from '../ports';
import { cacheGet, cacheSet } from './cache';

const BACKOFF_SECONDS = 15 * 60;

/** A call skipped because the provider recently said "too many requests". */
export class ProviderBackoffError extends Error {
  constructor(provider: string) {
    super(`${provider} is rate-limited; not calling it for a while.`);
    this.name = 'ProviderBackoffError';
  }
}

/**
 * Wrap every method of a provider so it backs off after a 429. Providers that
 * share an API key and its limit (Tiingo's prices and quotes) share `name`.
 */
export function withBackoff<T extends object>(provider: T, name: string, deps: () => Deps): T {
  const key = `backoff:${name}`;
  // Within one request, once we know we're backing off, don't ask the database again.
  let knownUntil = 0;
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const current = deps();
        const now = current.now().getTime();
        if (knownUntil > now || (await cacheGet<number>(current, key))) {
          knownUntil = Math.max(knownUntil, now + 60_000);
          throw new ProviderBackoffError(name);
        }
        try {
          return await value.apply(target, args);
        } catch (error) {
          if (error instanceof ProviderHttpError && error.status === 429) {
            console.warn(`${name} said too many requests; backing off for ${BACKOFF_SECONDS / 60} minutes.`);
            knownUntil = now + BACKOFF_SECONDS * 1000;
            await cacheSet(current, key, knownUntil, BACKOFF_SECONDS);
          }
          throw error;
        }
      };
    },
  });
}

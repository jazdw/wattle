import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { plaidLink } from './plaid';
import { requests, server } from './server';

// jsdom lacks the layout APIs Recharts and Radix use.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
// Browsers have Blob.text(); this jsdom version does not.
Blob.prototype.text ??= function text(this: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(this);
  });
};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

// Plaid Link loads a third-party script; tests drive this double instead.
vi.mock('react-plaid-link', async () => {
  const { plaidLink } = await import('./plaid');
  return {
    usePlaidLink: (config: { token: string | null; onSuccess: (publicToken: string | null) => void }) => {
      plaidLink.token = config.token;
      plaidLink.onSuccess = config.onSuccess;
      return { open: plaidLink.open, ready: plaidLink.ready || config.token !== null };
    },
  };
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  // The app fetches relative URLs ("/api/…"); Node's fetch needs them absolute.
  const fetchWithMsw = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    fetchWithMsw(typeof input === 'string' && input.startsWith('/') ? new URL(input, window.location.origin) : input, init);
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  requests.length = 0;
  localStorage.clear();
  plaidLink.open.mockReset();
  plaidLink.ready = false;
  plaidLink.token = null;
  plaidLink.onSuccess = null;
});

afterAll(() => server.close());

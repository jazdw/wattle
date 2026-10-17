import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetPlaid } from './plaid';
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

// Plaid Link's script isn't loaded in tests; a fake window.Plaid stands in.
resetPlaid();

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
  resetPlaid();
});

afterAll(() => server.close());

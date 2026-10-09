/** MSW server answering the app's /api calls from fixtures; tests override per case. */
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { ACCOUNTS, CONNECTIONS, history, ME, portfolio, QUOTES, TARGET } from './fixtures';

export interface RecordedRequest {
  method: string;
  path: string;
  url: URL;
  body: unknown;
}

/** Every request the app made during the current test. */
export const requests: RecordedRequest[] = [];

const json = (value: unknown) => () => HttpResponse.json(structuredClone(value) as JsonBodyType);

export const handlers = [
  http.get('*/api/auth/me', json(ME)),
  http.get('*/api/auth/dev-users', json({ users: [] })),
  http.post('*/api/auth/logout', json({ ok: true })),
  http.get('*/api/accounts', json({ accounts: ACCOUNTS })),
  http.get('*/api/connections', json(CONNECTIONS)),
  http.get('*/api/portfolio', () => HttpResponse.json(portfolio())),
  http.get('*/api/history', ({ request }) => HttpResponse.json(history(new URL(request.url).searchParams.get('group') ?? 'total'))),
  http.get('*/api/targets', json(TARGET)),
  http.get('*/api/quotes', json(QUOTES)),
  // Writes succeed by default; tests assert on what was sent.
  http.post('*/api/*', json({ ok: true })),
  http.put('*/api/*', json({ ok: true })),
  http.patch('*/api/*', json({ ok: true })),
  http.delete('*/api/*', json({ ok: true })),
];

export const server = setupServer(...handlers);

server.events.on('request:start', async ({ request }) => {
  const url = new URL(request.url);
  let body: unknown = undefined;
  const text = await request.clone().text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  requests.push({ method: request.method, path: url.pathname, url, body });
});

/** Requests matching "METHOD /path". */
export function sent(key: string): RecordedRequest[] {
  return requests.filter((request) => `${request.method} ${request.path}` === key);
}

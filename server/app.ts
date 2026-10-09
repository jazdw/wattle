/**
 * The Hono app, independent of the hosting platform. Entries pass `deps` as
 * the second argument to `app.fetch(request, { deps })`.
 */
import { Hono } from 'hono';
import { accountRoutes, connectionRoutes } from './routes/accounts';
import { authRoutes } from './auth/routes';
import type { AppEnv } from './env';
import { HttpError } from './lib/http';
import { safeEqual } from './lib/encoding';
import { plaidRoutes } from './routes/plaid';
import { portfolioRoutes } from './routes/portfolio';
import { runDaily } from './services/jobs';

/** Requests from the browser that change state must come from our own origin. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ORIGIN_EXEMPT = new Set(['/api/plaid/webhook', '/api/admin/run-daily']);

export function createApp(options: { assets?: (request: Request) => Promise<Response> } = {}) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && !ORIGIN_EXEMPT.has(c.req.path)) {
      const origin = c.req.header('origin');
      if (!origin || origin !== new URL(c.req.url).origin) {
        return c.json({ error: 'Cross-origin request refused.' }, 403);
      }
    }
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', (c) => c.json({ ok: true, name: 'wattle' }));

  app.route('/api/auth', authRoutes);
  app.route('/api/plaid', plaidRoutes);
  app.route('/api/connections', connectionRoutes);
  app.route('/api/accounts', accountRoutes);
  app.route('/api', portfolioRoutes);

  /** Run the daily job on demand (Bearer ADMIN_TOKEN). */
  app.post('/api/admin/run-daily', async (c) => {
    const token = c.env.deps.config.adminToken;
    const header = c.req.header('authorization') ?? '';
    if (!token || !safeEqual(header, `Bearer ${token}`)) return c.json({ error: 'forbidden' }, 403);
    return c.json(await runDaily(c.env.deps));
  });

  app.notFound((c) => {
    if (!c.req.path.startsWith('/api/') && options.assets) return options.assets(c.req.raw);
    return c.json({ error: 'Not found.' }, 404);
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    console.error('Unhandled error', error);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}

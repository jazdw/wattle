/**
 * The Hono app, independent of the hosting platform. Entries pass `deps` as
 * the second argument to `app.fetch(request, { deps })`.
 */
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { accountRoutes, connectionRoutes } from './routes/accounts';
import { authRoutes } from './auth/routes';
import type { AppEnv } from './env';
import { HttpError } from './lib/http';
import { plaidRoutes } from './routes/plaid';
import { verifyAccessToken } from './services/accessJwt';
import { portfolioRoutes } from './routes/portfolio';

/**
 * Paths that skip the Cloudflare Access check: Plaid's servers call the
 * webhook (it has a Bypass policy in Access and its own signature check).
 */
const ACCESS_EXEMPT = new Set(['/api/plaid/webhook']);

/** Plaid's servers post webhooks cross-site; they're authenticated by signature. */
const CSRF_EXEMPT = new Set(['/api/plaid/webhook']);

export function createApp(options: { assets?: (request: Request) => Promise<Response> } = {}) {
  const app = new Hono<AppEnv>();

  // Standard security headers (Hono's defaults, with framing denied and a
  // one-year HSTS). API responses are never cached.
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'DENY',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }),
  );
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // Cross-site request forgery: Hono refuses state-changing requests a form
  // on another site could send (form/plain-text bodies) unless they come from
  // this origin. JSON writes need a CORS preflight, which is never granted.
  const csrfCheck = csrf();
  app.use('*', (c, next) => (CSRF_EXEMPT.has(c.req.path) ? next() : csrfCheck(c, next)));

  // Optional second lock behind Cloudflare Access: every API request must
  // carry a valid Access token (see services/accessJwt.ts).
  app.use('/api/*', async (c, next) => {
    const access = c.env.deps.config.access;
    if (access && !ACCESS_EXEMPT.has(c.req.path)) {
      const valid = await verifyAccessToken(access, c.req.header('cf-access-jwt-assertion'), c.env.deps.now());
      if (!valid) return c.json({ error: 'Cloudflare Access token missing or invalid.' }, 403);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true, name: 'wattle' }));

  app.route('/api/auth', authRoutes);
  app.route('/api/plaid', plaidRoutes);
  app.route('/api/connections', connectionRoutes);
  app.route('/api/accounts', accountRoutes);
  // Mounted last: its auth middleware covers every remaining /api path.
  app.route('/api', portfolioRoutes);

  app.notFound((c) => {
    if (!c.req.path.startsWith('/api/') && options.assets) return options.assets(c.req.raw);
    return c.json({ error: 'Not found.' }, 404);
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof HTTPException) return error.getResponse();
    console.error('Unhandled error', error instanceof Error ? (error.stack ?? error.message) : error);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}

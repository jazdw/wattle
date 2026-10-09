/**
 * Plaid Link and webhooks. Linking requires a signed-in user; the webhook is
 * called by Plaid (no cookie) and is authenticated by its signed JWT instead.
 */
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { exchangeSchema, linkTokenSchema } from '../../shared/schemas';
import { requireAuth } from '../auth/routes';
import { connections } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { AppEnv } from '../env';
import { HttpError, notFound, readBody } from '../lib/http';
import type { Deps } from '../ports';
import { backfillConnection, collectBalanceHistory } from '../services/backfill';
import { verifyPlaidWebhook } from '../services/plaidWebhook';
import { snapshotHousehold } from '../services/snapshots';
import { accessTokenFor, getConnection, linkConnection, syncConnection } from '../services/sync';
import { marketDate } from '../../shared/dates';

export const plaidRoutes = new Hono<AppEnv>();

/** Plaid can only call back over public HTTPS. */
function webhookUrl(requestUrl: string): string | null {
  const url = new URL(requestUrl);
  return url.protocol === 'https:' ? `${url.origin}/api/plaid/webhook` : null;
}

function requirePlaid(deps: Deps) {
  if (!deps.plaid) throw new HttpError(503, 'Plaid is not configured on the server.');
  return deps.plaid;
}

plaidRoutes.post('/link-token', requireAuth, async (c) => {
  const plaid = requirePlaid(c.env.deps);
  const body = await readBody(c, linkTokenSchema);
  const tenant = c.get('tenant');
  let accessToken: string | undefined;
  if (body.connectionId) {
    const connection = await getConnection(tenant, body.connectionId);
    if (!connection) notFound('Connection not found.');
    accessToken = await accessTokenFor(c.env.deps, connection);
  }
  const linkToken = await plaid.createLinkToken({
    clientUserId: c.get('user').id,
    kind: body.kind,
    webhook: webhookUrl(c.req.url),
    accessToken,
  });
  return c.json({ linkToken });
});

plaidRoutes.post('/exchange', requireAuth, async (c) => {
  const deps = c.env.deps;
  requirePlaid(deps);
  const body = await readBody(c, exchangeSchema);
  const tenant = c.get('tenant');
  const connection = await linkConnection(deps, tenant, c.get('user').id, body.publicToken, body.kind);
  const result = await syncConnection(deps, tenant, connection.id);

  // History and today's snapshot can take a while; finish after responding.
  const hook = webhookUrl(c.req.url);
  deps.background(
    (async () => {
      await backfillConnection(deps, tenant, connection.id, hook);
      await snapshotHousehold(deps, tenant, marketDate(deps.now()));
    })().catch((error) => console.error('Post-link work failed', error)),
  );
  return c.json({ connectionId: connection.id, ...result });
});

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

interface PlaidWebhook {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  asset_report_id?: string;
  error?: { error_code?: string } | null;
}

plaidRoutes.post('/webhook', async (c) => {
  const deps = c.env.deps;
  if (!deps.plaid) return c.json({ ok: false }, 503);
  const raw = await c.req.text();
  const verified = await verifyPlaidWebhook(deps.plaid, c.req.header('plaid-verification'), raw, deps.now());
  if (!verified) return c.json({ error: 'invalid signature' }, 401);

  const event = JSON.parse(raw) as PlaidWebhook;
  // Webhooks carry no household: find the connection, then act as its household.
  const [connection] = await deps.db
    .select({ id: connections.id, householdId: connections.householdId })
    .from(connections)
    .where(
      event.webhook_type === 'ASSETS' && event.asset_report_id
        ? eq(connections.assetReportId, event.asset_report_id)
        : and(eq(connections.provider, 'plaid'), eq(connections.externalId, event.item_id ?? '')),
    )
    .limit(1);
  if (!connection) return c.json({ ok: true });
  const tenant = new Tenant(deps.db, connection.householdId);

  const setStatus = (status: 'ok' | 'login_required' | 'pending_expiration' | 'error', errorCode: string | null) =>
    tenant.db
      .update(connections)
      .set({ status, errorCode })
      .where(tenant.scope(connections, eq(connections.id, connection.id)));

  const sync = () =>
    deps.background(
      (async () => {
        await syncConnection(deps, tenant, connection.id);
        await snapshotHousehold(deps, tenant, marketDate(deps.now()));
      })().catch((error) => console.error('Webhook sync failed', error)),
    );

  switch (`${event.webhook_type}:${event.webhook_code}`) {
    case 'HOLDINGS:DEFAULT_UPDATE':
    case 'INVESTMENTS_TRANSACTIONS:DEFAULT_UPDATE':
    case 'ITEM:LOGIN_REPAIRED':
      sync();
      break;
    case 'ITEM:ERROR':
      await setStatus(
        event.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error',
        event.error?.error_code ?? null,
      );
      break;
    case 'ITEM:PENDING_EXPIRATION':
    case 'ITEM:PENDING_DISCONNECT':
      await setStatus('pending_expiration', event.webhook_code ?? null);
      break;
    case 'ITEM:USER_PERMISSION_REVOKED':
    case 'ITEM:USER_ACCOUNT_REVOKED':
      await setStatus('error', event.webhook_code ?? null);
      break;
    case 'ASSETS:PRODUCT_READY':
      deps.background(
        collectBalanceHistory(deps, tenant, connection.id).catch((error) =>
          console.error('Balance history failed', error),
        ),
      );
      break;
    case 'ASSETS:ERROR':
      await tenant.db
        .update(connections)
        .set({ assetReportTokenEnc: null, assetReportId: null, backfillStatus: 'failed' })
        .where(tenant.scope(connections, eq(connections.id, connection.id)));
      break;
    default:
      break;
  }
  return c.json({ ok: true });
});

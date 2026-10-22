/**
 * Plaid Link and webhooks. Linking requires a signed-in user; the webhook is
 * called by Plaid (no cookie) and is authenticated by its signed JWT instead.
 */
import { and, eq, notInArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Hono } from 'hono';
import { exchangeSchema, linkTokenSchema } from '../../shared/schemas';
import { requireAuth } from '../auth/routes';
import { connections } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { AppEnv } from '../env';
import { HttpError, notFound, readBody } from '../lib/http';
import type { Deps } from '../ports';
import { runAtomic } from '../db/batch';
import { SyncRun } from '../services/activity';
import { queueHistory } from '../services/backfill';
import { enqueue } from '../services/jobRunner';
import { verifyPlaidWebhook } from '../services/plaidWebhook';
import { accessTokenFor, getConnection, INACTIVE, linkConnection, statusStatement, syncConnection } from '../services/sync';
import { marketDate } from '../../shared/dates';

export const plaidRoutes = new Hono<AppEnv>();

/** Plaid can only call back over public HTTPS. */
function webhookUrl(requestUrl: string): string | null {
  const url = new URL(requestUrl);
  return url.protocol === 'https:' ? `${url.origin}/api/plaid/webhook` : null;
}

/**
 * Where a bank's own login (OAuth) returns to on a phone, registered with
 * Plaid as an allowed redirect URI. HTTPS only, like the webhook: on a
 * local http address Link uses its desktop popup instead.
 */
function oauthRedirectUrl(requestUrl: string): string | null {
  const url = new URL(requestUrl);
  return url.protocol === 'https:' ? `${url.origin}/plaid-oauth` : null;
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
    redirectUri: oauthRedirectUrl(c.req.url) ?? undefined,
    accessToken,
    chooseAccounts: body.chooseAccounts,
  });
  return c.json({ linkToken });
});

plaidRoutes.post('/exchange', requireAuth, async (c) => {
  const deps = c.env.deps;
  requirePlaid(deps);
  const body = await readBody(c, exchangeSchema);
  const tenant = c.get('tenant');
  const { connection, lease } = await linkConnection(deps, tenant, c.get('user').id, body.publicToken, body.kind);
  // The history load runs after responding (it can take a while).
  const result = await syncConnection(deps, tenant, connection.id, 'link', { lease, history: false });

  // The history load and today's snapshot run as background jobs.
  await queueHistory(deps, tenant, connection.id, 'load', 'link', webhookUrl(c.req.url));
  await enqueue(deps, tenant, [{ type: 'snapshot', payload: { date: marketDate(deps.now()), trigger: 'change' } }]);
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
  /** PENDING_EXPIRATION: when the login's consent ends. */
  consent_expiration_time?: string | null;
}

plaidRoutes.post('/webhook', async (c) => {
  const deps = c.env.deps;
  if (!deps.plaid) return c.json({ ok: false }, 503);
  const raw = await c.req.text();
  let event: PlaidWebhook;
  try {
    event = JSON.parse(raw) as PlaidWebhook;
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }
  // Webhooks carry no household: find the connection, then act as its
  // household. Looked up before the signature is checked: only Plaid and
  // Wattle know an item's or report's id, so a forged webhook naming none of
  // ours is dropped without asking Plaid for a verification key.
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
  const verified = await verifyPlaidWebhook(deps.plaid, c.req.header('plaid-verification'), raw, deps.now());
  if (!verified) return c.json({ error: 'invalid signature' }, 401);
  const tenant = new Tenant(deps.db, connection.householdId);

  const eventName = `${event.webhook_type}:${event.webhook_code}`;
  const observedAt = deps.now().getTime();
  /**
   * Record what Plaid reported, logged in the same batch. These don't take
   * the connection's lease: a status is only written if it's newer than the
   * last observation (statusStatement), so a sync running now can't overwrite
   * it with an older "OK", and consent warnings have their own column.
   */
  const record = async (change: BatchItem<'sqlite'>) => {
    const run = new SyncRun(deps, tenant, connection.id, 'sync', 'webhook');
    run.note = `Plaid reported ${eventName}${event.error?.error_code ? ` (${event.error.error_code})` : ''}.`;
    await runAtomic(tenant.db, [change, run.statement()]);
  };
  const setStatus = (status: 'login_required' | 'error', errorCode: string | null) =>
    record(statusStatement(tenant, connection.id, { status, errorCode }, observedAt));

  // A sync job (which also redoes today's snapshot). Plaid often sends several
  // webhooks at once (holdings and transactions): one job per minute serves them all.
  const sync = () =>
    enqueue(deps, tenant, [
      {
        id: `webhook-sync:${connection.id}:${Math.floor(observedAt / 60_000)}`,
        type: 'sync',
        payload: { connectionId: connection.id, trigger: 'webhook' },
        connectionId: connection.id,
      },
    ]);

  switch (eventName) {
    case 'HOLDINGS:DEFAULT_UPDATE':
    case 'INVESTMENTS_TRANSACTIONS:DEFAULT_UPDATE':
    case 'ITEM:LOGIN_REPAIRED':
    // The sync collects the report (or records Plaid's failure to build it)
    // under the connection's lease.
    case 'ASSETS:PRODUCT_READY':
    case 'ASSETS:ERROR':
      await sync();
      break;
    case 'ITEM:ERROR':
      await setStatus(
        event.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error',
        event.error?.error_code ?? null,
      );
      break;
    case 'ITEM:PENDING_EXPIRATION':
    case 'ITEM:PENDING_DISCONNECT': {
      // A warning that lasts until you re-link, not a status a sync clears.
      const consentExpiresAt = event.consent_expiration_time ? Date.parse(event.consent_expiration_time) : null;
      await record(
        tenant.db
          .update(connections)
          .set({ consentWarningAt: observedAt, ...(consentExpiresAt ? { consentExpiresAt } : {}) })
          .where(tenant.scope(connections, eq(connections.id, connection.id), notInArray(connections.status, INACTIVE))),
      );
      break;
    }
    case 'ITEM:NEW_ACCOUNTS_AVAILABLE':
      // Shown on the login's card until accounts are chosen (Choose accounts).
      await record(
        tenant.db
          .update(connections)
          .set({ newAccountsAt: observedAt })
          .where(tenant.scope(connections, eq(connections.id, connection.id), notInArray(connections.status, INACTIVE))),
      );
      break;
    case 'ITEM:USER_PERMISSION_REVOKED':
    case 'ITEM:USER_ACCOUNT_REVOKED':
      await setStatus('error', event.webhook_code ?? null);
      break;
    default:
      break;
  }
  return c.json({ ok: true });
});

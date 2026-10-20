/**
 * Fill in what hand-entered securities are (stock, ETF, mutual fund) where
 * that's still unknown: ones added before type lookups existed, or whose
 * lookup failed (e.g. the provider was rate-limited). Run nightly; lookups are
 * cached, so each ticker costs at most one request.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { runAtomic } from '../db/batch';
import { securities } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { describeTickers } from './pricing';

export async function typeHandEnteredSecurities(deps: Deps, tenant: Tenant): Promise<number> {
  const untyped = await tenant.db
    .select({ id: securities.id, ticker: securities.ticker, name: securities.name })
    .from(securities)
    .where(tenant.scope(securities, isNull(securities.externalId), isNull(securities.type)));
  const tickers = untyped.flatMap((row) => (row.ticker ? [row.ticker] : []));
  if (tickers.length === 0) return 0;
  const descriptions = await describeTickers(deps, tickers);
  // Only where still unset: a type (or name) set meanwhile is kept.
  const statements = untyped.flatMap((row) => {
    const description = row.ticker ? descriptions.get(row.ticker.toUpperCase()) : undefined;
    if (!description) return [];
    return [
      tenant.db
        .update(securities)
        .set({ type: description.type })
        .where(tenant.scope(securities, eq(securities.id, row.id), isNull(securities.type))),
      ...(description.name && row.name === row.ticker
        ? [tenant.db.update(securities).set({ name: description.name }).where(tenant.scope(securities, and(eq(securities.id, row.id), eq(securities.name, row.ticker!))))]
        : []),
    ];
  });
  await runAtomic(tenant.db, statements);
  return statements.length;
}

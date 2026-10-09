/**
 * The daily job (cron on Workers, node-cron on Node): for every household,
 * sync each connection, collect pending balance-history reports, then write
 * the day's snapshot. Failures are isolated per connection and per household.
 */
import { households } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { addDays, marketDate } from '../../shared/dates';
import { collectBalanceHistory, backfillConnection, pendingReports } from './backfill';
import { cachePrune } from './cache';
import { ensureFx } from './pricing';
import { snapshotHousehold } from './snapshots';
import { activeConnections, syncConnection } from './sync';

export interface DailyReport {
  date: string;
  households: number;
  errors: string[];
}

export async function runDaily(deps: Deps): Promise<DailyReport> {
  const date = marketDate(deps.now());
  const errors: string[] = [];
  await ensureFx(deps, addDays(date, -7), date);
  await cachePrune(deps);

  const rows = await deps.db.select({ id: households.id }).from(households);
  for (const { id } of rows) {
    const tenant = new Tenant(deps.db, id);
    for (const connection of await activeConnections(tenant)) {
      try {
        await syncConnection(deps, tenant, connection.id);
        // Investment history needs the transactions fetched by the first
        // successful sync; retry backfills that couldn't run at link time.
        if (connection.kind === 'investments' && connection.backfillStatus === 'pending') {
          await backfillConnection(deps, tenant, connection.id, null);
        }
      } catch (error) {
        errors.push(`sync ${connection.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const connectionId of await pendingReports(tenant)) {
      try {
        await collectBalanceHistory(deps, tenant, connectionId);
      } catch (error) {
        errors.push(`assets ${connectionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await snapshotHousehold(deps, tenant, date);
    } catch (error) {
      errors.push(`snapshot ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) console.error('Daily job errors', errors);
  return { date, households: rows.length, errors };
}

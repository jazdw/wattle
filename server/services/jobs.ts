/**
 * The daily job (cron on Workers, node-cron on Node): for every household,
 * sync each connection (which also collects ready balance-history reports), then write
 * the day's snapshot. Failures are isolated per connection and per household.
 * Each run is recorded in job_runs; old log entries are pruned here.
 */
import { lt } from 'drizzle-orm';
import { households, jobRuns, sessions } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { addDays, marketDate } from '../../shared/dates';
import { pruneLogs } from './activity';
import { cachePrune } from './cache';
import { ensureFx } from './pricing';
import { typeHandEnteredSecurities } from './securityTypes';
import { snapshotHousehold } from './snapshots';
import { activeConnections, syncConnection } from './sync';
import { describeError } from '../lib/errors';

export interface DailyReport {
  date: string;
  households: number;
  errors: string[];
}

export async function runDaily(deps: Deps): Promise<DailyReport> {
  const startedAt = deps.now().getTime();
  const date = marketDate(deps.now());
  const errors: string[] = [];
  await ensureFx(deps, addDays(date, -7), date);
  await cachePrune(deps);
  await pruneLogs(deps);
  await deps.db.delete(sessions).where(lt(sessions.expiresAt, startedAt));

  const rows = await deps.db.select({ id: households.id }).from(households);
  for (const { id } of rows) {
    const tenant = new Tenant(deps.db, id);
    for (const connection of await activeConnections(tenant)) {
      try {
        // Also collects ready bank reports and runs history loads that are due
        // (never run, abandoned, or invalidated by a late transaction).
        await syncConnection(deps, tenant, connection.id, 'nightly');
      } catch (error) {
        errors.push(`sync ${connection.id}: ${describeError(error)}`);
      }
    }
    try {
      await typeHandEnteredSecurities(deps, tenant);
    } catch (error) {
      errors.push(`types ${id}: ${describeError(error)}`);
    }
    try {
      await snapshotHousehold(deps, tenant, date);
    } catch (error) {
      errors.push(`snapshot ${id}: ${describeError(error)}`);
    }
  }
  if (errors.length > 0) console.error('Daily job errors', errors);
  await deps.db.insert(jobRuns).values({
    id: crypto.randomUUID(),
    job: 'daily',
    date,
    startedAt,
    finishedAt: deps.now().getTime(),
    households: rows.length,
    errors,
  });
  return { date, households: rows.length, errors };
}

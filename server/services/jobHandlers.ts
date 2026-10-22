/**
 * What each type of background job does (see ./jobRunner). Kept apart from
 * the runner so the runner has no dependency on the services it runs.
 */
import { marketDate, type IsoDate } from '../../shared/dates';
import type { Deps } from '../ports';
import type { SyncTrigger } from './activity';
import { finishNightly } from './jobs';
import { finishHistory, historyBlock, historyFailed, historyPrices, planHistory } from './backfill';
import { runJobWith, type FailureHandlers, type JobHandler, type JobHandlers, type JobOutcome } from './jobRunner';
import { typeHandEnteredSecurities } from './securityTypes';
import { snapshotHousehold } from './snapshots';
import { syncConnection } from './sync';

const notYet: JobHandler = async ({ job }) => {
  throw new Error(`No handler for ${job.type} jobs yet.`);
};

/**
 * Sync one connection. Nightly, the household's snapshot is its own job
 * (waiting for every sync); otherwise (a Plaid webhook) today's snapshot is
 * redone here.
 */
const sync: JobHandler = async ({ deps, tenant, job }) => {
  const { connectionId, trigger } = job.payload as { connectionId: string; trigger: SyncTrigger };
  const result = await syncConnection(deps, tenant, connectionId, trigger);
  if (trigger !== 'nightly') await snapshotHousehold(deps, tenant, marketDate(deps.now()));
  return { status: result.status, accounts: result.accounts, holdings: result.holdings, transactions: result.transactions, ...(result.skipped ? { skipped: true } : {}) };
};

/** Write the household's snapshot for a day (nightly: after typing hand-entered securities). */
const snapshot: JobHandler = async ({ deps, tenant, job }) => {
  const { date, trigger } = job.payload as { date: IsoDate; trigger: 'nightly' | 'change' };
  if (trigger === 'nightly') await typeHandEnteredSecurities(deps, tenant);
  const result = await snapshotHousehold(deps, tenant, date, trigger);
  return { accounts: result.accounts, holdings: result.holdings };
};

const nightlyFinish: JobHandler = async ({ deps, job }) => {
  await finishNightly(deps, (job.payload as { runId: string }).runId);
};

export const HANDLERS: JobHandlers = {
  sync,
  snapshot,
  nightly_finish: nightlyFinish,
  history_plan: planHistory,
  history_prices: historyPrices,
  history_block: historyBlock,
  history_finish: finishHistory,
  report_collect: notYet,
  report_account: notYet,
  report_finish: notYet,
};

/**
 * A history load whose plan or finish failed for good is marked failed (its
 * prices and blocks failing is handled by the finish, which counts them).
 */
const ON_FAILED: FailureHandlers = {
  history_plan: historyFailed,
  history_finish: historyFailed,
};

/** Run one job by id (the Worker's queue handler, Node's loop, tests). */
export function runJob(deps: Deps, id: string): Promise<JobOutcome> {
  return runJobWith(deps, id, HANDLERS, ON_FAILED);
}

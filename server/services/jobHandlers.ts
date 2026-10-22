/**
 * What each type of background job does (see ./jobRunner). Kept apart from
 * the runner so the runner has no dependency on the services it runs.
 */
import type { Deps } from '../ports';
import { runJobWith, type JobHandler, type JobHandlers, type JobOutcome } from './jobRunner';

const notYet: JobHandler = async ({ job }) => {
  throw new Error(`No handler for ${job.type} jobs yet.`);
};

export const HANDLERS: JobHandlers = {
  sync: notYet,
  snapshot: notYet,
  nightly_finish: notYet,
  history_plan: notYet,
  history_prices: notYet,
  history_block: notYet,
  history_finish: notYet,
  report_collect: notYet,
  report_account: notYet,
  report_finish: notYet,
};

/** Run one job by id (the Worker's queue handler, Node's loop, tests). */
export function runJob(deps: Deps, id: string): Promise<JobOutcome> {
  return runJobWith(deps, id, HANDLERS);
}

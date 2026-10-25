import type { JobType } from '../../shared/types';

/** What each kind of background job does, for messages ("loading history failed…"). */
export const JOB_TEXT: Record<JobType, string> = {
  sync: 'syncing',
  snapshot: "updating the day's snapshot",
  nightly_finish: 'finishing the nightly update',
  history_plan: 'loading history',
  history_prices: 'loading price history',
  history_block: 'loading history',
  history_finish: 'loading history',
  report_collect: 'collecting balance history',
  report_account: 'collecting balance history',
  report_finish: 'collecting balance history',
};

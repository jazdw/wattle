import { Link } from 'react-router-dom';
import type { StatusResponse } from '../../shared/types';
import { useStatus } from '../hooks/queries';
import { JOB_TEXT } from '../lib/jobs';
import { Alert } from './ui/misc';

const ACTION_TEXT: Record<StatusResponse['interrupted'][number]['action'], string> = {
  sync: 'a sync',
  history: 'loading history',
  balance_history: 'collecting balance history',
  relink: 're-linking',
  disconnect: 'disconnecting',
  account: 'an account change',
};

const day = (time: number) => new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Warns when background work didn't finish: the nightly update, a run stopped
 * part-way (a Worker limit can't be reported as it happens, so it's found
 * afterwards), or a background job that failed after its retries (see
 * /api/status).
 */
export function StatusBanner() {
  const { data } = useStatus();
  if (!data) return null;
  const messages: string[] = [];
  if (data.nightly?.state === 'interrupted') messages.push(`The nightly update of ${data.nightly.date} was stopped before it finished.`);
  if (data.nightly?.state === 'late') messages.push(`The nightly update hasn't run since ${data.nightly.date}.`);
  // One message per login and kind of work (a load's several parts fail together).
  const failed = new Map<string, string>();
  for (const job of data.failedJobs) {
    const what = JOB_TEXT[job.type];
    const key = `${job.connectionId ?? ''}:${what}`;
    if (failed.has(key)) continue;
    const how = job.errorCode === 'INTERRUPTED' ? 'was stopped part-way every time it ran' : `failed after ${job.attempts} attempts`;
    const fix = job.type.startsWith('history_') ? ' Use Reload history on its Accounts card to try again.' : '';
    failed.set(key, `${job.institutionName ? `${job.institutionName}: ` : ''}${what} ${how} (${day(job.finishedAt)}).${fix}`);
  }
  messages.push(...failed.values());
  const latest = new Map<string, StatusResponse['interrupted'][number]>();
  for (const run of data.interrupted) if (!latest.has(run.connectionId)) latest.set(run.connectionId, run);
  for (const run of latest.values()) {
    messages.push(`${run.institutionName}: ${ACTION_TEXT[run.action]} was stopped part-way on ${day(run.startedAt)}. It's retried automatically.`);
  }
  if (messages.length === 0) return null;
  return (
    <div className="mb-5">
      <Alert variant="warning">
        <ul className="grid gap-1">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
        <Link to="/activity" className="mt-1 inline-block underline">
          See Activity
        </Link>
      </Alert>
    </div>
  );
}

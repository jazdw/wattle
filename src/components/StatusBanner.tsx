import { Link } from 'react-router-dom';
import type { StatusResponse } from '../../shared/types';
import { useStatus } from '../hooks/queries';
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
 * Warns when background work didn't finish: a Worker stopped part-way (CPU or
 * time limit) can't report it, so it's found afterwards (see /api/status).
 */
export function StatusBanner() {
  const { data } = useStatus();
  if (!data) return null;
  const messages: string[] = [];
  if (data.nightly?.state === 'interrupted') messages.push(`The nightly update of ${data.nightly.date} was stopped before it finished.`);
  if (data.nightly?.state === 'late') messages.push(`The nightly update hasn't run since ${data.nightly.date}.`);
  for (const login of data.historyStopped) {
    messages.push(`${login.institutionName}: history was stopped part-way several times in a row, so it no longer retries on its own. Open its Activity to reload it.`);
  }
  const stopped = new Set(data.historyStopped.map((login) => login.connectionId));
  const latest = new Map<string, StatusResponse['interrupted'][number]>();
  for (const run of data.interrupted) if (!stopped.has(run.connectionId) && !latest.has(run.connectionId)) latest.set(run.connectionId, run);
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
        <Link to="/accounts" className="mt-1 inline-block underline">
          Accounts
        </Link>
      </Alert>
    </div>
  );
}

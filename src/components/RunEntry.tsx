import type { Currency } from '../../shared/money';
import type { SyncChange, SyncRunSummary } from '../../shared/types';
import { dateTime, money, quantity } from '../lib/format';
import { Badge } from './ui/badge';

const ACTION_TEXT: Record<SyncRunSummary['action'], string> = {
  sync: 'Sync',
  history: 'History load',
  balance_history: 'Bank history collected',
  relink: 'Signed in again',
  disconnect: 'Disconnected',
  account: 'Account changed',
};

const TRIGGER_TEXT: Record<SyncRunSummary['trigger'], string> = {
  link: 'when linked',
  webhook: 'Plaid update',
  nightly: 'nightly',
  manual: 'Sync button',
  refresh: 'Refresh all',
};

const COUNT_TEXT: Record<string, string> = {
  accounts: 'accounts',
  holdings: 'holdings',
  transactions: 'transactions',
  pricesFromPlaid: 'prices from Plaid',
  days: 'days of history',
  assetReportsRequested: 'bank history requested',
};

function describeChange(change: SyncChange): string {
  switch (change.kind) {
    case 'account_added':
      return `${change.account}: new account`;
    case 'account_missing':
      return `${change.account}: no longer reported by the institution`;
    case 'account_returned':
      return `${change.account}: reported again, with its history`;
    case 'balance': {
      const currency = change.currency as Currency;
      return `${change.account}: balance ${money(change.before, currency, { cents: true })} → ${money(change.after, currency, { cents: true })}`;
    }
    case 'holding': {
      const units = (value: number | null) => (value === null ? 'none' : `${quantity(value)} units`);
      return `${change.security} in ${change.account}: ${units(change.before)} → ${units(change.after)}`;
    }
  }
}

/** One run from a login's sync log, expandable to what it changed and the Plaid requests it made. */
export function RunEntry({ run, title }: { run: SyncRunSummary; title?: string }) {
  const counts = Object.entries(run.counts).map(([key, value]) => `${value} ${COUNT_TEXT[key] ?? key}`);
  return (
    <li>
      <details className="group rounded-md border px-3 py-2 text-sm">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">
            {title ? `${title} · ` : ''}
            {ACTION_TEXT[run.action]}
          </span>
          <span className="text-muted-foreground">({TRIGGER_TEXT[run.trigger]})</span>
          {run.outcome === 'error' && <Badge variant="danger">{run.errorCode === 'INTERRUPTED' ? 'Stopped part-way' : (run.errorCode ?? 'Failed')}</Badge>}
          {run.outcome === 'running' && <Badge variant="outline">Running</Badge>}
          {run.outcome === 'skipped' && <Badge variant="outline">Nothing to do</Badge>}
          {run.changes.length > 0 && <Badge variant="outline">{run.changes.length}{run.truncated ? '+' : ''} changes</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">{dateTime(run.startedAt)}</span>
        </summary>
        <div className="mt-2 grid gap-2 text-xs">
          {run.note && <p>{run.note}</p>}
          {run.errorMessage && <p className="text-negative">{run.errorMessage}</p>}
          {counts.length > 0 && <p className="text-muted-foreground">Stored: {counts.join(' · ')}</p>}
          {run.changes.length > 0 ? (
            <ul className="grid gap-0.5">
              {run.changes.map((change, index) => (
                <li key={index}>{describeChange(change)}</li>
              ))}
              {run.truncated && <li className="text-muted-foreground">…and more (only the first 500 are kept)</li>}
            </ul>
          ) : (
            run.outcome === 'ok' && run.action === 'sync' && <p className="text-muted-foreground">No balances or holdings changed.</p>
          )}
          {run.plaidCalls.length > 0 && (
            <div>
              <p className="text-muted-foreground">Plaid requests (quote the request id to Plaid support):</p>
              <ul className="font-mono text-[11px] text-muted-foreground">
                {run.plaidCalls.map((call, index) => (
                  <li key={index} className="break-all">
                    {call.endpoint} {call.requestId ?? '(no id)'}
                    {call.error && <span className="text-negative"> {call.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

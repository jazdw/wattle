import { useSearchParams } from 'react-router-dom';
import type { TransactionEntry } from '../../shared/types';
import { PageHeader } from '../components/Layout';
import { Card, CardContent } from '../components/ui/card';
import { NativeSelect } from '../components/ui/input';
import { EmptyState, Skeleton, Td, Th } from '../components/ui/misc';
import { useAccounts, useTransactions } from '../hooks/queries';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER, changeClass, longDate, money, quantity } from '../lib/format';

/** Plaid's subtype (dividend, reinvestment, …) reads better than its type (cash, buy, …) when there is one. */
function kindLabel(entry: TransactionEntry): string {
  const label = entry.subtype ?? entry.type ?? '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function Transactions() {
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const selectable = (accounts.data?.accounts ?? []).filter((candidate) => !candidate.isHidden && candidate.source === 'plaid');
  const accountId = params.get('account') ?? selectable.find((candidate) => candidate.type === 'investment')?.id ?? selectable[0]?.id ?? null;
  const account = selectable.find((candidate) => candidate.id === accountId);
  const transactions = useTransactions(account ? account.id : null);
  const byType = [...new Set([...ACCOUNT_TYPE_ORDER, ...selectable.map((candidate) => candidate.type)])]
    .map((type) => ({ type, accounts: selectable.filter((candidate) => candidate.type === type) }))
    .filter((entry) => entry.accounts.length > 0);
  const data = transactions.data;
  const investment = data?.kind === 'investment';

  return (
    <>
      <PageHeader
        title="Transactions"
        description="What Plaid has given Wattle for each linked account."
        actions={
          <div className="w-64">
            <NativeSelect value={account?.id ?? ''} onChange={(event) => setParams({ account: event.target.value })} aria-label="Account">
              {byType.map((entry) => (
                <optgroup key={entry.type} label={ACCOUNT_TYPE_LABELS[entry.type] ?? entry.type}>
                  {entry.accounts.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                      {candidate.mask ? ` ··${candidate.mask}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </NativeSelect>
          </div>
        }
      />
      {accounts.isPending || (account && transactions.isPending) ? (
        <Skeleton className="h-64 w-full" />
      ) : !account ? (
        <EmptyState title="No linked accounts">Transactions come from accounts linked through Plaid.</EmptyState>
      ) : !data || data.transactions.length === 0 ? (
        <EmptyState title="No transactions">
          {investment || account.type === 'investment'
            ? 'Plaid has no investment transactions for this account.'
            : 'Bank transactions come from bank history reports; none have been collected for this account.'}
        </EmptyState>
      ) : (
        <>
          <Card className="mb-4">
            <CardContent className="py-3 text-sm text-muted-foreground">
              {investment ? 'Plaid has transactions' : 'Bank history reports have transactions'} from <span className="font-medium text-foreground">{longDate(data.from!)}</span> to{' '}
              <span className="font-medium text-foreground">{longDate(data.to!)}</span>
              {investment ? '. Wattle asks for two years; anything earlier, the institution hasn’t given Plaid.' : ', as of the last report.'}
              {data.truncated && ` Showing the latest ${data.transactions.length}.`}
            </CardContent>
          </Card>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <Th>Date</Th>
                  {investment && <Th>Type</Th>}
                  <Th>{investment ? 'Security' : 'Description'}</Th>
                  {investment && <Th className="text-right">Shares</Th>}
                  {investment && <Th className="text-right">Price</Th>}
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.transactions.map((entry) => (
                  <tr key={entry.id}>
                    <Td className="whitespace-nowrap">{longDate(entry.date)}</Td>
                    {investment && <Td>{kindLabel(entry)}</Td>}
                    <Td>
                      {investment ? (
                        <>
                          <span className="font-medium">{entry.ticker ?? entry.security ?? '—'}</span>
                          {entry.description && <span className="ml-2 text-xs text-muted-foreground">{entry.description}</span>}
                        </>
                      ) : (
                        (entry.description ?? '—')
                      )}
                    </Td>
                    {investment && <Td className="text-right tabular-nums">{entry.quantity ? quantity(entry.quantity) : ''}</Td>}
                    {investment && <Td className="text-right tabular-nums">{entry.price && entry.quantity ? money(Math.round(entry.price * 100), data.currency) : ''}</Td>}
                    {/* Money in is positive here (Plaid's amounts are positive when money leaves). */}
                    <Td className={`text-right tabular-nums ${changeClass(-entry.amount)}`}>{entry.amount === 0 ? '' : money(-entry.amount, data.currency)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}

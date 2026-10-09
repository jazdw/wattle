import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccountSummary } from '../../shared/types';
import { api } from '../api';
import { TimeSeriesChart } from '../components/charts';
import { PageHeader } from '../components/Layout';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, EmptyState, Skeleton } from '../components/ui/misc';
import { Segmented } from '../components/ui/segmented';
import { useAccounts, useConnections, useHistory, usePortfolio, type Range } from '../hooks/queries';
import { useAuth, useOwnerName } from '../hooks/useAuth';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER, changeClass, formatPercent, money, relativeTime } from '../lib/format';

const RANGES: { value: Range; label: string }[] = [
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: 'YTD', label: 'YTD' },
  { value: '1Y', label: '1Y' },
  { value: 'ALL', label: 'All' },
];

export function NetWorth() {
  const { currency } = useAuth();
  const ownerName = useOwnerName();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<Range>('1Y');
  const portfolio = usePortfolio();
  const history = useHistory(range, 'total');
  const accounts = useAccounts();
  const connections = useConnections();

  const refresh = useMutation({
    mutationFn: () => api('/api/refresh', { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const change = useMemo(() => {
    const values = history.data?.series[0]?.values.filter((value): value is number => value !== null) ?? [];
    if (values.length < 2) return null;
    const first = values[0];
    const last = values.at(-1)!;
    return { amount: last - first, percent: first !== 0 ? (last - first) / Math.abs(first) : 0 };
  }, [history.data]);

  const groups = useMemo(() => {
    const visible = (accounts.data?.accounts ?? []).filter((account) => !account.isHidden);
    const byType = new Map<string, AccountSummary[]>();
    for (const account of visible) {
      const type = ACCOUNT_TYPE_ORDER.includes(account.type) ? account.type : 'other';
      byType.set(type, [...(byType.get(type) ?? []), account]);
    }
    return ACCOUNT_TYPE_ORDER.filter((type) => byType.has(type)).map((type) => {
      const list = byType.get(type)!.sort((a, b) => Math.abs(b.displayBalance ?? 0) - Math.abs(a.displayBalance ?? 0));
      return { type, accounts: list, total: list.reduce((sum, account) => sum + (account.displayBalance ?? 0), 0) };
    });
  }, [accounts.data]);

  const broken = connections.data?.connections.filter((connection) => connection.status !== 'ok') ?? [];
  const lastSync = Math.max(0, ...(connections.data?.connections.map((connection) => connection.lastSyncedAt ?? 0) ?? []));
  const empty = accounts.data && accounts.data.accounts.length === 0;

  return (
    <>
      <PageHeader
        title="Net worth"
        description={lastSync ? `Synced ${relativeTime(lastSync)}` : undefined}
        actions={
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw className={refresh.isPending ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        }
      />

      {broken.length > 0 && (
        <div className="mb-4">
          <Alert variant="warning">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4" />
              {broken.length === 1 ? `${broken[0].institutionName ?? 'A connection'} needs attention.` : `${broken.length} connections need attention.`}{' '}
              <Link to="/accounts" className="font-medium underline">
                Fix in Accounts
              </Link>
            </span>
          </Alert>
        </div>
      )}

      {empty ? (
        <EmptyState title="No accounts yet">
          <Link to="/accounts" className="font-medium text-foreground underline">
            Link an institution or add a manual account
          </Link>{' '}
          to get started.
        </EmptyState>
      ) : (
        <div className="grid gap-4">
          <Card>
            <CardContent className="pt-4 sm:pt-5">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-muted-foreground">Net worth</p>
                  {portfolio.data ? (
                    <p className="text-3xl font-semibold tracking-tight sm:text-4xl">{money(portfolio.data.netWorth, currency)}</p>
                  ) : (
                    <Skeleton className="h-10 w-48" />
                  )}
                  {change && (
                    <p className={`text-sm ${changeClass(change.amount)}`}>
                      {money(change.amount, currency, { signed: true })} ({formatPercent(change.percent, 1, true)}){' '}
                      <span className="text-muted-foreground">{range === 'ALL' ? 'all time' : range === 'YTD' ? 'this year' : `past ${range}`}</span>
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Segmented value={range} options={RANGES} onChange={setRange} />
                  {portfolio.data && (
                    <div className="flex gap-4 text-right text-sm">
                      <div>
                        <p className="text-muted-foreground">Assets</p>
                        <p className="font-medium">{money(portfolio.data.assets, currency)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Liabilities</p>
                        <p className="font-medium">{money(portfolio.data.liabilities, currency)}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {history.data && history.data.series.length > 0 ? (
                <TimeSeriesChart
                  history={history.data}
                  series={[{ key: 'total', label: 'Net worth', color: 'var(--series-1)', values: history.data.series[0].values }]}
                  currency={currency}
                  stacked={false}
                />
              ) : history.isPending ? (
                <Skeleton className="h-[280px] w-full" />
              ) : (
                <p className="py-16 text-center text-sm text-muted-foreground">History builds up from the first daily snapshot.</p>
              )}
              {history.data?.estimated.some(Boolean) && (
                <p className="mt-2 text-xs text-muted-foreground">Shaded periods are reconstructed from transactions and may be approximate.</p>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            {groups.map((group) => (
              <Card key={group.type}>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>{ACCOUNT_TYPE_LABELS[group.type] ?? group.type}</CardTitle>
                  <span className="font-semibold">{money(group.total, currency)}</span>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y">
                    {group.accounts.map((account) => (
                      <li key={account.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {account.name}
                            {account.mask && <span className="text-muted-foreground"> ··{account.mask}</span>}
                          </p>
                          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            {account.institutionName ?? (account.source === 'manual' ? 'Manual' : '')}
                            <Badge variant={account.ownerUserId ? 'outline' : 'gold'}>{ownerName(account.ownerUserId)}</Badge>
                            {account.currency !== currency && <Badge variant="outline">{account.currency}</Badge>}
                          </p>
                        </div>
                        <span className="shrink-0 font-medium">{money(account.displayBalance, currency)}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

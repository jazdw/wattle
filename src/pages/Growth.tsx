import { ChevronLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CATEGORIES, type Category } from '../../shared/taxonomy';
import type { HistoryGroup, HistoryResponse } from '../../shared/types';
import { Legend, TimeSeriesChart } from '../components/charts';
import { foldSeries, type ChartSeries } from '../lib/series';
import { PageHeader } from '../components/Layout';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { NativeSelect } from '../components/ui/input';
import { EmptyState, Skeleton, Td, Th } from '../components/ui/misc';
import { Segmented } from '../components/ui/segmented';
import { useAccounts, useHistory, type Range } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { CATEGORY_COLORS } from '../lib/colors';
import { changeClass, formatPercent, money } from '../lib/format';

const RANGES: { value: Range; label: string }[] = [
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: '6M', label: '6M' },
  { value: 'YTD', label: 'YTD' },
  { value: '1Y', label: '1Y' },
  { value: '2Y', label: '2Y' },
  { value: 'ALL', label: 'All' },
];

type View = 'total' | 'account' | 'category';

function categorySeries(history: HistoryResponse): ChartSeries[] {
  const order = [...CATEGORIES, 'liabilities'];
  return [...history.series]
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    .map((series) => ({
      key: series.key,
      label: series.label,
      color: CATEGORY_COLORS[series.key as Category | 'liabilities'] ?? 'var(--series-neutral)',
      values: series.values,
    }));
}

export function Growth() {
  const { currency } = useAuth();
  const [range, setRange] = useState<Range>('1Y');
  const [view, setView] = useState<View>('account');
  const [accountId, setAccountId] = useState<string | null>(null);
  const accounts = useAccounts();

  const group: HistoryGroup = accountId ? 'holding' : view;
  const history = useHistory(range, group, accountId ?? undefined);
  const account = accounts.data?.accounts.find((candidate) => candidate.id === accountId);

  const series = useMemo(() => {
    if (!history.data) return [];
    if (group === 'total') {
      return history.data.series.map((item) => ({ ...item, color: 'var(--series-1)' }));
    }
    if (group === 'category') return categorySeries(history.data);
    return foldSeries(history.data);
  }, [history.data, group]);

  const rows = series.map((item) => {
    const values = item.values.filter((value): value is number => value !== null);
    const first = values[0] ?? 0;
    const last = values.at(-1) ?? 0;
    return { ...item, first, last, change: last - first, percent: first ? (last - first) / Math.abs(first) : 0 };
  });

  const drillable = (accounts.data?.accounts ?? []).filter((candidate) => !candidate.isHidden && candidate.holdingCount > 0);

  return (
    <>
      <PageHeader
        title="Growth"
        description="Daily values over time. Changes include contributions and withdrawals."
        actions={<Segmented value={range} options={RANGES} onChange={setRange} />}
      />
      <Card>
        <CardContent className="pt-4 sm:pt-5">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {accountId ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setAccountId(null)}>
                  <ChevronLeft /> All accounts
                </Button>
                <span className="font-medium">{account?.name} — holdings</span>
              </>
            ) : (
              <Segmented
                value={view}
                options={[
                  { value: 'total', label: 'Total' },
                  { value: 'account', label: 'By account' },
                  { value: 'category', label: 'By category' },
                ]}
                onChange={setView}
              />
            )}
            <div className="ml-auto w-56">
              <NativeSelect
                value={accountId ?? ''}
                onChange={(event) => setAccountId(event.target.value || null)}
                aria-label="Drill into an account's holdings"
              >
                <option value="">Drill into holdings…</option>
                {drillable.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {history.isPending ? (
            <Skeleton className="h-[340px] w-full" />
          ) : series.length === 0 ? (
            <EmptyState title="No history yet">Snapshots are taken daily; linked investment accounts are backfilled automatically.</EmptyState>
          ) : (
            <>
              <TimeSeriesChart history={history.data!} series={series} currency={currency} stacked={group !== 'total'} height={340} />
              {series.length > 1 && (
                <div className="mt-3">
                  <Legend items={series.map((item) => ({ key: item.key, label: item.label, color: item.color }))} />
                </div>
              )}
              {history.data!.estimated.some(Boolean) && (
                <p className="mt-2 text-xs text-muted-foreground">Shaded periods are reconstructed from transactions and may be approximate.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <Card className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <Th>{group === 'holding' ? 'Holding' : group === 'category' ? 'Category' : group === 'total' ? 'Series' : 'Account'}</Th>
                <Th className="text-right">Start</Th>
                <Th className="text-right">Now</Th>
                <Th className="text-right">Change</Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className={group === 'account' && row.key !== '__other' ? 'cursor-pointer hover:bg-muted/50' : undefined}
                  onClick={() => {
                    if (group === 'account' && drillable.some((candidate) => candidate.id === row.key)) setAccountId(row.key);
                  }}
                >
                  <Td>
                    <span className="flex items-center gap-2">
                      <span className="size-2.5 rounded-sm" style={{ background: row.color }} />
                      {row.label}
                    </span>
                  </Td>
                  <Td className="text-right">{money(row.first, currency)}</Td>
                  <Td className="text-right font-medium">{money(row.last, currency)}</Td>
                  <Td className={`text-right ${changeClass(row.change)}`}>
                    {money(row.change, currency, { signed: true })}
                    <span className="ml-1 text-xs">({formatPercent(row.percent, 1, true)})</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

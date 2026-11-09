import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountLabel } from '../../shared/accounts';
import { CATEGORIES, type Category } from '../../shared/taxonomy';
import type { BreakdownRow, HistoryGroup, HistoryResponse } from '../../shared/types';
import { Legend, TimeSeriesChart, type ChartBand } from '../components/charts';
import { foldSeries, type ChartSeries } from '../lib/series';
import { PageHeader } from '../components/Layout';
import { Card, CardContent } from '../components/ui/card';
import { NativeSelect } from '../components/ui/input';
import { EmptyState, Skeleton, Td, Th } from '../components/ui/misc';
import { Segmented } from '../components/ui/segmented';
import { useAccounts, useHistory, type Range } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { CATEGORY_COLORS } from '../lib/colors';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER, changeClass, formatPercent, money } from '../lib/format';

const RANGES: { value: Range; label: string }[] = [
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: '6M', label: '6M' },
  { value: 'YTD', label: 'YTD' },
  { value: '1Y', label: '1Y' },
  { value: '2Y', label: '2Y' },
  { value: 'ALL', label: 'All' },
];

/** What the chart shows: the value split up, or where it came from (money in and out, returns, or both against the balance). */
type Mode = 'balance' | 'activity' | 'returns' | 'overview';
const MODES: { value: Mode; label: string }[] = [
  { value: 'balance', label: 'Balance' },
  { value: 'activity', label: 'Activity' },
  { value: 'returns', label: 'Returns' },
  { value: 'overview', label: 'Overview' },
];

type View = 'account' | 'category';

const COLORS = {
  in: 'var(--series-3)',
  out: 'var(--series-2)',
  market: 'var(--series-1)',
  income: 'var(--series-6)',
  fees: 'var(--series-8)',
  balance: 'var(--series-1)',
  money: 'var(--series-neutral-dark)',
  returns: 'var(--series-3)',
  losses: 'var(--series-8)',
};

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

/** The source parts a mode charts (cumulative from the range's start), and Overview's band between the balance and the money put in. */
function sourceSeries(history: HistoryResponse, mode: Exclude<Mode, 'balance'>): { series: ChartSeries[]; band?: ChartBand } {
  const part = (key: string) => history.series.find((series) => series.key === key)?.values ?? history.dates.map(() => null);
  const named = (key: keyof typeof COLORS, label: string, values = part(key)): ChartSeries => ({ key, label, color: COLORS[key], values });
  // A part that's nothing throughout would only draw a line along another's edge.
  const some = (series: ChartSeries[]) => series.filter((item) => item.values.some((value) => value !== null && value !== 0));
  if (mode === 'activity') return { series: some([named('in', 'Money in'), named('out', 'Money out')]) };
  if (mode === 'returns') return { series: some([named('market', 'Market gain/loss'), named('income', 'Dividends and interest'), named('fees', 'Fees')]) };
  // The balance less its returns: net deposits (money put in, less taken out), with changes not broken down.
  const [balance, income, fees, market] = [part('balance'), part('income'), part('fees'), part('market')];
  const money = balance.map((value, index) => (value === null ? null : value - (income[index] ?? 0) - (fees[index] ?? 0) - (market[index] ?? 0)));
  return {
    series: [named('money', 'Net deposits', money), named('balance', 'Balance', balance)],
    // Green where the balance is above what was put in, red where it's below (a loss).
    band: { label: 'Investment returns', color: COLORS.returns, negativeColor: COLORS.losses, from: 'money', to: 'balance' },
  };
}

export function Growth() {
  const { currency } = useAuth();
  const [range, setRange] = useState<Range>('1Y');
  const [mode, setMode] = useState<Mode>('balance');
  const [view, setView] = useState<View>('account');
  const [accountId, setAccountId] = useState<string | null>(null);
  const accounts = useAccounts();

  const account = accounts.data?.accounts.find((candidate) => candidate.id === accountId);
  // By account, a chosen account shows its holdings if it has any, otherwise
  // its balance; by category, its value split by category.
  const byHolding = Boolean(account && account.holdingCount > 0);
  const group: HistoryGroup = mode !== 'balance' ? 'source' : view === 'account' && byHolding ? 'holding' : view;
  const history = useHistory(range, group, account?.id);
  // The previous query's data shows while the next loads: only use it once it's the group asked for.
  const data = history.data?.group === group ? history.data : undefined;

  const { series, band } = useMemo((): { series: ChartSeries[]; band?: ChartBand } => {
    if (!data) return { series: [] };
    if (mode !== 'balance') return sourceSeries(data, mode);
    if (group === 'category') return { series: categorySeries(data) };
    return { series: foldSeries(data) };
  }, [data, group, mode]);

  const rows = series.map((item) => {
    const values = item.values.filter((value): value is number => value !== null);
    const first = values[0] ?? 0;
    const last = values.at(-1) ?? 0;
    return { ...item, first, last, change: last - first, percent: first ? (last - first) / Math.abs(first) : 0 };
  });

  const selectable = (accounts.data?.accounts ?? []).filter((candidate) => !candidate.isHidden);
  const byType = [...new Set([...ACCOUNT_TYPE_ORDER, ...selectable.map((candidate) => candidate.type)])]
    .map((type) => ({ type, accounts: selectable.filter((candidate) => candidate.type === type) }))
    .filter((entry) => entry.accounts.length > 0);
  const pick = (key: string) => {
    if (!account && selectable.some((candidate) => candidate.id === key)) setAccountId(key);
  };
  const breakdown = mode !== 'balance' ? (data?.breakdown ?? []) : [];

  return (
    <>
      <PageHeader
        title="Growth"
        description="Daily values over time, and where they came from: money in and out, dividends and interest, fees, and market gain or loss."
        actions={<Segmented value={range} options={RANGES} onChange={setRange} />}
      />
      <Card>
        <CardContent className="pt-4 sm:pt-5">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Segmented value={mode} options={MODES} onChange={setMode} />
            {mode === 'balance' && (
              <Segmented
                value={view}
                options={[
                  { value: 'account', label: byHolding ? 'By holding' : 'By account' },
                  { value: 'category', label: 'By category' },
                ]}
                onChange={setView}
              />
            )}
            <div className="ml-auto w-56">
              <NativeSelect value={accountId ?? ''} onChange={(event) => setAccountId(event.target.value || null)} aria-label="Account">
                <option value="">All accounts</option>
                {byType.map((entry) => (
                  <optgroup key={entry.type} label={ACCOUNT_TYPE_LABELS[entry.type] ?? entry.type}>
                    {entry.accounts.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {accountLabel(candidate)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </div>
          </div>

          {!data ? (
            <Skeleton className="h-[340px] w-full" />
          ) : (mode === 'balance' && series.length === 0) || (mode !== 'balance' && breakdown.length === 0) ? (
            <EmptyState title="No history yet">Snapshots are taken daily; linked investment accounts are backfilled automatically.</EmptyState>
          ) : series.length === 0 ? (
            // An account with no transactions in the range: nothing it did can be told apart.
            <div className="flex h-[340px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {mode === 'activity' ? 'No money in or out' : 'No dividends, fees or market gain or loss'} in this range that its transactions can show. Its change is under Not broken down below.
            </div>
          ) : (
            <>
              <TimeSeriesChart history={data} series={series} currency={currency} stacked={mode !== 'overview'} lines={mode === 'overview'} band={band} height={340} />
              {(series.length > 1 || band) && (
                <div className="mt-3">
                  <Legend items={[...series.map((item) => ({ key: item.key, label: item.label, color: item.color })), ...(band ? [{ key: 'band', label: band.label, color: band.color }] : [])]} />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {mode !== 'balance'
        ? breakdown.length > 0 && <BreakdownTable rows={breakdown} currency={currency} onPick={account ? undefined : pick} />
        : rows.length > 0 && (
            <Card className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <Th>{group === 'holding' ? 'Holding' : group === 'category' ? 'Category' : 'Account'}</Th>
                    <Th className="text-right">Start</Th>
                    <Th className="text-right">Now</Th>
                    <Th className="text-right">Change</Th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={row.key} className={!account && group === 'account' && !row.key.startsWith('__other') ? 'cursor-pointer hover:bg-muted/50' : undefined} onClick={() => group === 'account' && pick(row.key)}>
                      <Td>
                        <span className="flex items-center gap-2">
                          <span className="size-2.5 rounded-sm" style={{ background: row.color }} />
                          {row.label}
                        </span>
                      </Td>
                      <Td className="text-right">{money(row.first, currency)}</Td>
                      <Td className="text-right font-medium">{money(row.last, currency)}</Td>
                      <Td className={`text-right ${changeClass(row.change)}`}>
                        {money(row.change, currency)}
                        <span className="ml-1 text-xs">({formatPercent(row.percent, 1)})</span>
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

/** Where each account's value came from over the range, the household's first. */
function BreakdownTable({ rows, currency, onPick }: { rows: BreakdownRow[]; currency: HistoryResponse['currency']; onPick?: (key: string) => void }) {
  const showOther = rows.some((row) => row.other !== 0);
  const household = rows.some((row) => row.key === 'household');
  const needsType = rows.find((row) => row.key === 'household')?.needsType ?? rows.reduce((sum, row) => sum + row.needsType, 0);
  const signed = (value: number) => <span className={changeClass(value)}>{money(value, currency)}</span>;
  return (
    <Card className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <Th>Account</Th>
            <Th className="text-right">Start</Th>
            <Th className="text-right">Money in</Th>
            <Th className="text-right">Money out</Th>
            <Th className="text-right">Dividends and interest</Th>
            <Th className="text-right">Fees</Th>
            <Th className="text-right">Market gain/loss</Th>
            {showOther && <Th className="text-right">Not broken down</Th>}
            <Th className="text-right">Now</Th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.key} className={row.key === 'household' ? 'font-medium' : onPick ? 'cursor-pointer hover:bg-muted/50' : undefined} onClick={() => row.key !== 'household' && onPick?.(row.key)}>
              <Td>{row.label}</Td>
              <Td className="text-right">{money(row.start, currency)}</Td>
              <Td className="text-right">{money(row.moneyIn, currency)}</Td>
              <Td className="text-right">{row.moneyOut ? money(-row.moneyOut, currency) : money(0, currency)}</Td>
              <Td className="text-right">{signed(row.income)}</Td>
              <Td className="text-right">{row.fees ? money(-row.fees, currency) : money(0, currency)}</Td>
              <Td className="text-right">{signed(row.market)}</Td>
              {showOther && <Td className="text-right">{money(row.other, currency)}</Td>}
              <Td className="text-right font-medium">{money(row.end, currency)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-1 border-t px-4 py-3 text-xs text-muted-foreground">
        {household && <p>Transfers between your accounts are left out of the household’s money in and out.</p>}
        {showOther && <p>Not broken down: changes with no transactions to explain them, such as days before an account’s transactions are known, its first day, or a bank account’s balance moving without one.</p>}
        {needsType > 0 && (
          <p>
            {needsType === 1 ? '1 transaction needs a type' : `${needsType} transactions need a type`}: until then, what they did isn’t broken down.{' '}
            <Link to="/transactions" className="font-medium text-foreground underline">
              Set types
            </Link>
          </p>
        )}
      </div>
    </Card>
  );
}

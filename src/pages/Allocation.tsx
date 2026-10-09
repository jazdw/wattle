import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { driftTable, fullRebalance, investNewCash } from '../../shared/rebalance';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../shared/taxonomy';
import type { TargetResponse } from '../../shared/types';
import { api } from '../api';
import { Donut, Legend, type Slice } from '../components/charts';
import { PageHeader } from '../components/Layout';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent } from '../components/ui/dialog';
import { Field, Input } from '../components/ui/input';
import { Alert, EmptyState, Skeleton, Td, Th } from '../components/ui/misc';
import { Segmented } from '../components/ui/segmented';
import { Switch } from '../components/ui/switch';
import { useAccounts, usePortfolio, useTarget } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { CATEGORY_COLORS } from '../lib/colors';
import { changeClass, formatPercent, money } from '../lib/format';
import { cn } from '../lib/utils';

export function Allocation() {
  const { currency } = useAuth();
  const portfolio = usePortfolio();
  const target = useTarget();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<'cash' | 'full'>('cash');
  const [cash, setCash] = useState('10000');

  const weights = useMemo(() => target.data?.target?.weights ?? {}, [target.data]);
  const band = target.data?.target?.bandPct ?? 5;
  const categories = portfolio.data?.categories;

  const rows = useMemo(() => (categories ? driftTable(categories, weights, band) : []), [categories, weights, band]);
  const total = rows.reduce((sum, row) => sum + row.valueMinor, 0);

  const trades = useMemo(() => {
    if (!categories || !target.data?.target) return [];
    if (mode === 'full') return fullRebalance(categories, weights);
    const amount = Math.round(Number(cash) * 100);
    return Number.isFinite(amount) && amount > 0 ? investNewCash(categories, weights, amount) : [];
  }, [categories, weights, mode, cash, target.data]);

  const currentSlices: Slice[] = rows
    .filter((row) => row.valueMinor > 0)
    .map((row) => ({ key: row.category, label: CATEGORY_LABELS[row.category], value: row.valueMinor, color: CATEGORY_COLORS[row.category] }));
  const targetSlices: Slice[] = CATEGORIES.filter((category) => (weights[category] ?? 0) > 0).map((category) => ({
    key: category,
    label: CATEGORY_LABELS[category],
    value: weights[category]!,
    color: CATEGORY_COLORS[category],
  }));

  if (portfolio.isPending || target.isPending) return <Skeleton className="h-96 w-full" />;

  return (
    <>
      <PageHeader
        title="Allocation"
        description="Invested assets by category, looking through funds to what they hold."
        actions={
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> {target.data?.target ? 'Edit target' : 'Set a target'}
          </Button>
        }
      />
      {total === 0 ? (
        <EmptyState title="Nothing to allocate yet">Link or add accounts first.</EmptyState>
      ) : (
        <div className="grid gap-4">
          <Card>
            <CardContent className="grid gap-6 pt-5 md:grid-cols-2">
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm font-medium">Current</p>
                <Donut
                  slices={currentSlices}
                  center={money(total, currency, { compact: true })}
                  caption="invested"
                  formatValue={(slice, share) => `${money(slice.value, currency)} · ${formatPercent(share)}`}
                />
              </div>
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm font-medium">Target</p>
                {targetSlices.length > 0 ? (
                  <Donut
                    slices={targetSlices}
                    center={`±${band}%`}
                    caption="band"
                    formatValue={(slice) => formatPercent(slice.value, 0)}
                  />
                ) : (
                  <div className="grid size-[200px] place-items-center rounded-full border-2 border-dashed text-center text-sm text-muted-foreground">
                    No target set
                  </div>
                )}
              </div>
              <div className="md:col-span-2">
                <Legend
                  items={rows.map((row) => ({
                    key: row.category,
                    label: CATEGORY_LABELS[row.category],
                    color: CATEGORY_COLORS[row.category],
                    value: formatPercent(row.actual, 0),
                  }))}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <Th>Category</Th>
                  <Th className="text-right">Value</Th>
                  <Th className="text-right">Actual</Th>
                  <Th className="text-right">Target</Th>
                  <Th className="text-right">Drift</Th>
                  <Th className="text-right">To target</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.category}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <span className="size-2.5 rounded-sm" style={{ background: CATEGORY_COLORS[row.category] }} />
                        {CATEGORY_LABELS[row.category]}
                      </span>
                    </Td>
                    <Td className="text-right">{money(row.valueMinor, currency)}</Td>
                    <Td className="text-right">{formatPercent(row.actual)}</Td>
                    <Td className="text-right text-muted-foreground">{target.data?.target ? formatPercent(row.target) : '—'}</Td>
                    <Td className="text-right">
                      {target.data?.target ? (
                        <span className="inline-flex items-center gap-1.5">
                          {row.outOfBand && <Badge variant="warning">Outside band</Badge>}
                          {formatPercent(row.drift, 1, true)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className={cn('text-right', changeClass(row.deltaMinor))}>
                      {target.data?.target ? money(row.deltaMinor, currency, { signed: true }) : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {target.data?.target && (
            <Card>
              <CardHeader>
                <CardTitle>Rebalance</CardTitle>
                <CardDescription>
                  Category-level moves. Choose which funds to buy or sell within each category, and mind taxes in taxable
                  accounts.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex flex-wrap items-end gap-3">
                  <Segmented
                    value={mode}
                    options={[
                      { value: 'cash', label: 'Invest new cash' },
                      { value: 'full', label: 'Full rebalance' },
                    ]}
                    onChange={setMode}
                  />
                  {mode === 'cash' && (
                    <div className="w-40">
                      <Input inputMode="decimal" value={cash} onChange={(event) => setCash(event.target.value)} aria-label="Amount to invest" />
                    </div>
                  )}
                </div>
                {trades.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Already on target.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {trades.map((trade) => (
                      <li key={trade.category} className="flex items-center justify-between py-2">
                        <span className="flex items-center gap-2">
                          <span className="size-2.5 rounded-sm" style={{ background: CATEGORY_COLORS[trade.category] }} />
                          {trade.amountMinor > 0 ? 'Buy' : 'Sell'} {CATEGORY_LABELS[trade.category]}
                        </span>
                        <span className={cn('font-medium', changeClass(trade.amountMinor))}>
                          {money(Math.abs(trade.amountMinor), currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
      <TargetDialog open={editing} onOpenChange={setEditing} target={target.data?.target ?? null} />
    </>
  );
}

function TargetDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TargetResponse['target'];
}) {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [band, setBand] = useState('5');
  const [excludedAccounts, setExcludedAccounts] = useState<string[]>([]);
  const [excludedCategories, setExcludedCategories] = useState<Category[]>([]);
  const [initialised, setInitialised] = useState(false);

  if (open && !initialised) {
    setWeights(
      Object.fromEntries(CATEGORIES.map((category) => [category, target?.weights[category] ? String(Math.round(target.weights[category]! * 1000) / 10) : ''])),
    );
    setBand(String(target?.bandPct ?? 5));
    setExcludedAccounts(target?.excludedAccountIds ?? []);
    setExcludedCategories(target?.excludedCategories ?? ['real_estate']);
    setInitialised(true);
  }
  if (!open && initialised) setInitialised(false);

  const sum = Object.values(weights).reduce((total, value) => total + (Number(value) || 0), 0);
  const save = useMutation({
    mutationFn: () =>
      api('/api/targets', {
        method: 'PUT',
        body: JSON.stringify({
          name: 'Target',
          weights: Object.fromEntries(
            Object.entries(weights)
              .filter(([, value]) => Number(value) > 0)
              .map(([key, value]) => [key, Number(value) / 100]),
          ),
          bandPct: Number(band) || 0,
          excludedAccountIds: excludedAccounts,
          excludedCategories,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['target'] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Target allocation" description="Percentages of invested assets. They're normalised to 100%.">
        <div className="grid grid-cols-2 gap-3">
          {CATEGORIES.map((category) => (
            <Field key={category} label={CATEGORY_LABELS[category]}>
              <Input
                inputMode="decimal"
                placeholder="0"
                value={weights[category] ?? ''}
                onChange={(event) => setWeights({ ...weights, [category]: event.target.value })}
              />
            </Field>
          ))}
        </div>
        <p className={cn('text-sm', Math.abs(sum - 100) < 0.05 ? 'text-muted-foreground' : 'text-warning')}>Total {sum.toFixed(1)}%</p>
        <Field label="Rebalancing band (± percentage points)">
          <Input inputMode="decimal" value={band} onChange={(event) => setBand(event.target.value)} />
        </Field>
        <div className="grid gap-2">
          <p className="text-sm font-medium">Leave out of the allocation</p>
          {(['real_estate', 'cash', 'crypto', 'other'] as Category[]).map((category) => (
            <label key={category} className="flex items-center justify-between text-sm">
              {CATEGORY_LABELS[category]}
              <Switch
                checked={excludedCategories.includes(category)}
                onCheckedChange={(checked) =>
                  setExcludedCategories(checked ? [...excludedCategories, category] : excludedCategories.filter((item) => item !== category))
                }
              />
            </label>
          ))}
          <p className="mt-2 text-xs text-muted-foreground">Accounts (e.g. an emergency fund)</p>
          <div className="max-h-40 overflow-y-auto">
            {(accounts.data?.accounts ?? [])
              .filter((account) => !account.isHidden && account.type !== 'credit' && account.type !== 'loan')
              .map((account) => (
                <label key={account.id} className="flex items-center justify-between py-1 text-sm">
                  <span className="truncate">{account.name}</span>
                  <Switch
                    checked={excludedAccounts.includes(account.id)}
                    onCheckedChange={(checked) =>
                      setExcludedAccounts(checked ? [...excludedAccounts, account.id] : excludedAccounts.filter((id) => id !== account.id))
                    }
                  />
                </label>
              ))}
          </div>
        </div>
        {save.error && <Alert variant="error">{save.error.message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || sum <= 0}>
            Save target
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

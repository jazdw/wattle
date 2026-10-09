import { useMemo, useState } from 'react';
import { CATEGORY_LABELS, EQUITY_CATEGORIES, normalizeWeights, SIZES, STYLES, type Category } from '../../shared/taxonomy';
import type { HoldingRow } from '../../shared/types';
import { ClassificationDialog } from '../components/ClassificationDialog';
import { PageHeader } from '../components/Layout';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { EmptyState, Skeleton, Td, Th } from '../components/ui/misc';
import { usePortfolio } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { CATEGORY_COLORS } from '../lib/colors';
import { formatPercent, money } from '../lib/format';

/** Sequential single-hue ramp (light → dark) for the style grid. */
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab'];

function rampColor(share: number, max: number): string {
  if (max <= 0) return RAMP[0];
  return RAMP[Math.min(RAMP.length - 1, Math.floor((share / max) * (RAMP.length - 1)))];
}

const SIZE_LABELS = { large: 'Large', mid: 'Mid', small: 'Small' } as const;
const STYLE_LABELS = { value: 'Value', blend: 'Blend', growth: 'Growth' } as const;

function equityShare(holding: HoldingRow): number {
  const weights = normalizeWeights(holding.classification.categories);
  return EQUITY_CATEGORIES.reduce((sum, category) => sum + (weights[category] ?? 0), 0);
}

export function Style() {
  const { currency } = useAuth();
  const portfolio = usePortfolio();
  const [editing, setEditing] = useState<HoldingRow | null>(null);

  const style = portfolio.data?.style;
  const classified = style ? style.equityTotal - style.unclassified : 0;
  const maxCell = style ? Math.max(...SIZES.flatMap((size) => STYLES.map((s) => style.grid[size][s]))) : 0;

  const regions = useMemo(() => {
    const categories = portfolio.data?.categories;
    if (!categories) return [];
    const total = EQUITY_CATEGORIES.reduce((sum, category) => sum + categories[category], 0);
    return EQUITY_CATEGORIES.filter((category) => categories[category] > 0).map((category) => ({
      category,
      value: categories[category],
      share: total ? categories[category] / total : 0,
    }));
  }, [portfolio.data]);

  const funds = useMemo(
    () =>
      (portfolio.data?.holdings ?? [])
        .map((holding) => ({ holding, equity: Math.round(holding.value * equityShare(holding)) }))
        .filter((row) => row.equity > 0)
        .sort((a, b) => b.equity - a.equity),
    [portfolio.data],
  );

  if (portfolio.isPending) return <Skeleton className="h-96 w-full" />;
  if (!style || style.equityTotal === 0) {
    return (
      <>
        <PageHeader title="Style" />
        <EmptyState title="No stock holdings yet" />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Style" description="The stock portion of your portfolio, looking through funds." />
      <div className="grid gap-4 md:grid-cols-[auto_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Size × style</CardTitle>
            <CardDescription>Share of classified stock holdings</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-[auto_repeat(3,5.5rem)] gap-1 text-sm">
              <span />
              {STYLES.map((s) => (
                <span key={s} className="pb-1 text-center text-xs text-muted-foreground">
                  {STYLE_LABELS[s]}
                </span>
              ))}
              {SIZES.map((size) => (
                <div key={size} className="contents">
                  <span className="flex items-center pr-2 text-xs text-muted-foreground">{SIZE_LABELS[size]}</span>
                  {STYLES.map((s) => {
                    const value = style.grid[size][s];
                    const share = classified ? value / classified : 0;
                    const dark = share / (maxCell / (classified || 1)) > 0.55;
                    return (
                      <div
                        key={s}
                        title={`${SIZE_LABELS[size]} ${STYLE_LABELS[s]}: ${money(value, currency)}`}
                        className="grid aspect-square place-items-center rounded-md text-center"
                        style={{ background: rampColor(value, maxCell), color: dark ? '#fff' : '#0d366b' }}
                      >
                        <div>
                          <p className="font-semibold">{formatPercent(share, 0)}</p>
                          <p className="text-[10px] opacity-80">{money(value, currency, { compact: true })}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {style.unclassified > 0 && (
              <p className="mt-3 max-w-64 text-xs text-muted-foreground">
                {money(style.unclassified, currency)} ({formatPercent(style.unclassified / style.equityTotal, 0)}) of stocks have no
                size/style (individual stocks, or balances tracked without holdings such as super) and are left out.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Region</CardTitle>
            <CardDescription>Stocks by market</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex h-3 overflow-hidden rounded-full">
              {regions.map((region) => (
                <div
                  key={region.category}
                  style={{ width: `${region.share * 100}%`, background: CATEGORY_COLORS[region.category] }}
                  className="border-r-2 border-card last:border-r-0"
                />
              ))}
            </div>
            <ul className="grid gap-1.5 text-sm">
              {regions.map((region) => (
                <li key={region.category} className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-sm" style={{ background: CATEGORY_COLORS[region.category] }} />
                    {CATEGORY_LABELS[region.category as Category]}
                  </span>
                  <span>
                    <span className="font-medium">{formatPercent(region.share)}</span>
                    <span className="ml-2 text-muted-foreground">{money(region.value, currency)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b">
              <Th>Fund</Th>
              <Th className="text-right">Stock value</Th>
              <Th>Size</Th>
              <Th>Style</Th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {funds.map(({ holding, equity }) => {
              const sizes = normalizeWeights(holding.classification.sizes ?? {});
              const styles = normalizeWeights(holding.classification.styles ?? {});
              const describe = (weights: Partial<Record<string, number>>, labels: Record<string, string>) =>
                Object.entries(weights)
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .map(([key, value]) => `${labels[key]} ${formatPercent(value ?? 0, 0)}`)
                  .join(' · ');
              return (
                <tr key={holding.securityId} className="cursor-pointer hover:bg-muted/40" onClick={() => setEditing(holding)}>
                  <Td>
                    <span className="font-medium">{holding.ticker ?? holding.name}</span>
                    {holding.needsReview && (
                      <Badge variant="warning" className="ml-1.5">
                        Review
                      </Badge>
                    )}
                    <p className="max-w-72 truncate text-xs text-muted-foreground">{holding.name}</p>
                  </Td>
                  <Td className="text-right">{money(equity, currency)}</Td>
                  <Td className="text-muted-foreground">{describe(sizes, SIZE_LABELS) || 'Unknown'}</Td>
                  <Td className="text-muted-foreground">{describe(styles, STYLE_LABELS) || 'Unknown'}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <ClassificationDialog security={editing} onClose={() => setEditing(null)} />
    </>
  );
}

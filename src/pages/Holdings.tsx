import { ChevronDown, ChevronRight, Radio } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { CATEGORY_LABELS, normalizeWeights, type Category } from '../../shared/taxonomy';
import type { HoldingRow } from '../../shared/types';
import { ClassificationDialog } from '../components/ClassificationDialog';
import { PageHeader } from '../components/Layout';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { EmptyState, Skeleton, Td, Th } from '../components/ui/misc';
import { isMarketOpen, usePortfolio, useQuotes } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { changeClass, formatPercent, longDate, money, quantity } from '../lib/format';

function mainCategory(holding: HoldingRow): string {
  const weights = normalizeWeights(holding.classification.categories);
  const entries = Object.entries(weights).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (entries.length === 0) return 'Other';
  const [top, share] = entries[0];
  const label = CATEGORY_LABELS[top as Category];
  return entries.length > 1 && (share ?? 0) < 0.95 ? `Mixed (${label} ${formatPercent(share ?? 0, 0)})` : label;
}

export function Holdings() {
  const { currency } = useAuth();
  const portfolio = usePortfolio();
  const quotes = useQuotes();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<HoldingRow | null>(null);

  const quoteByTicker = useMemo(() => new Map(quotes.data?.quotes.map((quote) => [quote.ticker, quote]) ?? []), [quotes.data]);
  const closeByTicker = useMemo(() => new Map(quotes.data?.closes.map((close) => [close.ticker, close]) ?? []), [quotes.data]);

  const rows = useMemo(() => {
    const holdings = portfolio.data?.holdings ?? [];
    const total = holdings.reduce((sum, holding) => sum + holding.value, 0);
    const needle = filter.trim().toLowerCase();
    return holdings
      .filter((holding) => !needle || `${holding.ticker ?? ''} ${holding.name ?? ''}`.toLowerCase().includes(needle))
      .map((holding) => {
        const quote = holding.ticker ? quoteByTicker.get(holding.ticker) : undefined;
        // Day change in display currency, scaled from the native quote.
        const scale = holding.price ? holding.value / (holding.quantity * holding.price) : 1;
        const dayChange = quote ? Math.round(holding.quantity * quote.change * 100 * scale) : null;
        const liveValue = quote ? Math.round(holding.quantity * quote.price * 100 * scale) : holding.value;
        return { holding, quote, dayChange, liveValue, share: total ? holding.value / total : 0 };
      });
  }, [portfolio.data, filter, quoteByTicker]);

  const dayChange = rows.reduce((sum, row) => sum + (row.dayChange ?? 0), 0);
  const liveTotal = rows.reduce((sum, row) => sum + row.liveValue, 0);
  const open = isMarketOpen();

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <>
      <PageHeader title="Holdings" description="Every position across accounts, combined by security." />
      {portfolio.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : rows.length === 0 && !filter ? (
        <EmptyState title="No holdings yet">Link an investment account or add holdings to a manual account.</EmptyState>
      ) : (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-muted-foreground">Holdings value{quotes.data?.quotes.length ? ' (live)' : ''}</p>
                <p className="text-2xl font-semibold">{money(liveTotal, currency)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  Today's change
                  {open && <Radio className="size-3.5 text-positive" aria-label="Market open" />}
                </p>
                <p className={`text-2xl font-semibold ${changeClass(dayChange)}`}>
                  {quotes.data?.quotes.length ? money(dayChange, currency, { signed: true }) : '—'}
                </p>
                <p className="text-xs text-muted-foreground">Stocks & ETFs; mutual funds update after the close.</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-muted-foreground">Needs review</p>
                <p className="text-2xl font-semibold">{rows.filter((row) => row.holding.needsReview).length}</p>
                <p className="text-xs text-muted-foreground">Funds classified by a best guess. Click one to fix.</p>
              </CardContent>
            </Card>
          </div>

          <div className="mb-3 max-w-xs">
            <Input placeholder="Filter by ticker or name" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </div>

          <Card className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b">
                  <Th className="w-6" />
                  <Th>Security</Th>
                  <Th>Category</Th>
                  <Th className="text-right">Quantity</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">Day</Th>
                  <Th className="text-right">Value</Th>
                  <Th className="text-right">Weight</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map(({ holding, quote, dayChange: change, liveValue, share }) => {
                  const close = holding.ticker ? closeByTicker.get(holding.ticker) : undefined;
                  const isOpen = expanded.has(holding.securityId);
                  return (
                    <Fragment key={holding.securityId}>
                      <tr className="hover:bg-muted/40">
                        <Td>
                          <button type="button" onClick={() => toggle(holding.securityId)} aria-label="Show accounts" className="text-muted-foreground">
                            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        </Td>
                        <Td>
                          <p className="font-medium">{holding.ticker ?? '—'}</p>
                          <p className="max-w-64 truncate text-xs text-muted-foreground">{holding.name}</p>
                        </Td>
                        <Td>
                          <button type="button" className="text-left hover:underline" onClick={() => setEditing(holding)}>
                            {mainCategory(holding)}
                          </button>
                          {holding.needsReview && (
                            <Badge variant="warning" className="ml-1.5">
                              Review
                            </Badge>
                          )}
                        </Td>
                        <Td className="text-right">{quantity(holding.quantity)}</Td>
                        <Td className="text-right">
                          {quote ? quote.price.toFixed(2) : close ? close.close.toFixed(2) : holding.price?.toFixed(2) ?? '—'}
                          {!quote && close && <p className="text-xs text-muted-foreground">{longDate(close.date)}</p>}
                        </Td>
                        <Td className={`text-right ${quote ? changeClass(quote.change) : ''}`}>
                          {quote ? (
                            <>
                              {money(change, currency, { signed: true })}
                              <p className="text-xs">{formatPercent(quote.changePercent, 2, true)}</p>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Td>
                        <Td className="text-right font-medium">{money(liveValue, currency)}</Td>
                        <Td className="text-right text-muted-foreground">{formatPercent(share)}</Td>
                      </tr>
                      {isOpen &&
                        holding.accounts.map((position) => (
                          <tr key={position.accountId} className="bg-muted/30 text-xs">
                            <Td />
                            <Td colSpan={2} className="text-muted-foreground">
                              {position.name}
                            </Td>
                            <Td className="text-right">{quantity(position.quantity)}</Td>
                            <Td colSpan={2} />
                            <Td className="text-right">{money(position.value, currency)}</Td>
                            <Td />
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
      <ClassificationDialog security={editing} onClose={() => setEditing(null)} />
    </>
  );
}

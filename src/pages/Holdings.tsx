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
import { isLiveQuote, usePortfolio, useQuotes } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { changeClass, formatPercent, longDate, money, quantity, shortDate } from '../lib/format';

function mainCategory(holding: HoldingRow): string {
  const weights = normalizeWeights(holding.classification.categories);
  const entries = Object.entries(weights).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (entries.length === 0) return 'Other';
  const [top, share] = entries[0];
  const label = CATEGORY_LABELS[top as Category];
  return entries.length > 1 && (share ?? 0) < 0.95 ? `Mixed (${label} ${formatPercent(share ?? 0, 0)})` : label;
}

/** Plaid's security types (and those looked up for hand-entered tickers), as shown. */
const TYPE_LABELS: Record<string, string> = {
  equity: 'Stock',
  etf: 'ETF',
  'mutual fund': 'Mutual fund',
  'fixed income': 'Bond',
  cash: 'Cash',
  cryptocurrency: 'Crypto',
  derivative: 'Option',
};

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
        // Quotes are native-currency dollars; `value` is display-currency cents.
        // `scale` is the FX factor between them.
        const nativeMinor = holding.quantity * (holding.price ?? 0) * 100;
        const scale = nativeMinor ? holding.value / nativeMinor : 1;
        const dayChange = quote ? Math.round(holding.quantity * quote.change * 100 * scale) : null;
        const liveValue = quote ? Math.round(holding.quantity * quote.price * 100 * scale) : holding.value;
        return { holding, quote, scale, dayChange, liveValue, share: total ? holding.value / total : 0 };
      });
  }, [portfolio.data, filter, quoteByTicker]);

  const dayChange = rows.reduce((sum, row) => sum + (row.dayChange ?? 0), 0);
  const liveTotal = rows.reduce((sum, row) => sum + row.liveValue, 0);
  // Against the holdings' value at the previous close, as brokerages show it.
  const previousTotal = liveTotal - dayChange;
  const dayChangePercent = previousTotal ? dayChange / previousTotal : 0;
  // Live: at least one quote updated in the last 15 minutes (the same test as
  // the ((o)) on each row). After the close, today's prices and change still
  // show, just not as live.
  const live = quotes.data?.quotes.some((quote) => isLiveQuote(quote)) ?? false;

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
                <p className="text-sm text-muted-foreground">Holdings value{live ? ' (live)' : ''}</p>
                <p className="text-2xl font-semibold">{money(liveTotal, currency, { cents: true })}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  Today's change
                  {live && <Radio className="size-3.5 text-positive" aria-label="Live" />}
                </p>
                <p className={`text-2xl font-semibold ${changeClass(dayChange)}`}>
                  {quotes.data?.quotes.length ? (
                    <>
                      {money(dayChange, currency, { cents: true })}{' '}
                      <span className="text-base font-medium">({formatPercent(dayChangePercent, 2)})</span>
                    </>
                  ) : (
                    '—'
                  )}
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
                {rows.map(({ holding, quote, scale, dayChange: change, liveValue, share }) => {
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
                          <p className="flex items-center gap-1.5 font-medium">
                            {/* Bonds have no ticker: their CUSIP or ISIN identifies them. */}
                            {holding.ticker ? (
                              holding.ticker
                            ) : holding.cusip || holding.isin ? (
                              <span title={holding.cusip ? 'CUSIP' : 'ISIN'}>{holding.cusip ?? holding.isin}</span>
                            ) : (
                              '—'
                            )}
                            {TYPE_LABELS[holding.type ?? ''] && (
                              <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                                {TYPE_LABELS[holding.type ?? '']}
                              </Badge>
                            )}
                          </p>
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
                          {quote && (
                            // When this quote was last updated (quotes refresh separately, so times differ).
                            <p
                              className="flex items-center justify-end gap-1 whitespace-nowrap text-xs text-muted-foreground"
                              title={`${isLiveQuote(quote) ? 'Live price' : 'Price'}, last updated ${new Date(quote.time).toLocaleString()}`}
                            >
                              {isLiveQuote(quote) && <Radio className="size-3 text-positive" aria-label="Live" />}
                              {new Date(quote.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                            </p>
                          )}
                          {!quote && close && (
                            // A fund's price is its NAV, struck once a day after the close.
                            <p className="whitespace-nowrap text-xs text-muted-foreground" title={`${holding.type === 'mutual fund' ? 'Net asset value' : 'Close'} on ${longDate(close.date)}`}>
                              {holding.type === 'mutual fund' && 'NAV · '}
                              {shortDate(close.date)}
                            </p>
                          )}
                        </Td>
                        <Td className={`text-right ${quote ? changeClass(quote.change) : ''}`}>
                          {quote ? (
                            <>
                              {money(change, currency, { cents: true })}
                              <p className="text-xs">{formatPercent(quote.changePercent, 2)}</p>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Td>
                        <Td className="text-right font-medium">{money(liveValue, currency, { cents: true })}</Td>
                        <Td className="text-right text-muted-foreground">{formatPercent(share)}</Td>
                      </tr>
                      {isOpen &&
                        holding.accounts.map((position) => {
                          // Live, like the row above, so the accounts add up to it. The
                          // day's % is the security's, so only the dollar change is shown.
                          const positionChange = quote ? Math.round(position.quantity * quote.change * 100 * scale) : null;
                          const positionValue = quote ? Math.round(position.quantity * quote.price * 100 * scale) : position.value;
                          return (
                            <tr key={position.accountId} className="bg-muted/30 text-xs">
                              <Td />
                              <Td colSpan={2} className="text-muted-foreground">
                                {position.name}
                              </Td>
                              <Td className="text-right">{quantity(position.quantity)}</Td>
                              <Td />
                              <Td className={`text-right ${positionChange !== null ? changeClass(positionChange) : ''}`}>
                                {positionChange !== null ? money(positionChange, currency, { cents: true }) : ''}
                              </Td>
                              <Td className="text-right">{money(positionValue, currency, { cents: true })}</Td>
                              <Td />
                            </tr>
                          );
                        })}
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

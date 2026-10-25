import { ChevronDown, ChevronRight, Radio } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { CATEGORY_LABELS, normalizeWeights, type Category } from '../../shared/taxonomy';
import type { AccountSummary, HoldingRow } from '../../shared/types';
import { EditAccountDialog } from '../components/AccountDialogs';
import { ClassificationDialog } from '../components/ClassificationDialog';
import { PageHeader } from '../components/Layout';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { EmptyState, Skeleton, Td, Th } from '../components/ui/misc';
import { isLiveQuote, useAccounts, usePortfolio, useQuotes } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { accountKind, changeClass, formatPercent, longDate, money, quantity, shortDate } from '../lib/format';

function mainCategory(holding: HoldingRow): string {
  const weights = normalizeWeights(holding.classification.categories);
  const entries = Object.entries(weights).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (entries.length === 0) return 'Other';
  const [top, share] = entries[0];
  const label = CATEGORY_LABELS[top as Category];
  return entries.length > 1 && (share ?? 0) < 0.95 ? `Mixed (${label} ${formatPercent(share ?? 0, 0)})` : label;
}

/** A unit price (in units) as minor units for money(); null stays null. */
function unitPrice(price: number | null | undefined): number | null {
  return price === null || price === undefined ? null : Math.round(price * 100);
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
  const accounts = useAccounts();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<HoldingRow | null>(null);
  const [editingAccount, setEditingAccount] = useState<AccountSummary | null>(null);

  const quoteByTicker = useMemo(() => new Map(quotes.data?.quotes.map((quote) => [quote.ticker, quote]) ?? []), [quotes.data]);
  const closeByTicker = useMemo(() => new Map(quotes.data?.closes.map((close) => [close.ticker, close]) ?? []), [quotes.data]);

  const { rows, balances, total } = useMemo(() => {
    const holdings = portfolio.data?.holdings ?? [];
    const balances = portfolio.data?.balances ?? [];
    // Weights are of everything listed: holdings and balance-only accounts.
    const total = [...holdings, ...balances].reduce((sum, row) => sum + row.value, 0);
    const needle = filter.trim().toLowerCase();
    const rows = holdings
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
    return { rows, balances: balances.filter((balance) => !needle || balance.name.toLowerCase().includes(needle)), total };
  }, [portfolio.data, filter, quoteByTicker]);

  const dayChange = rows.reduce((sum, row) => sum + (row.dayChange ?? 0), 0);
  const liveTotal = rows.reduce((sum, row) => sum + row.liveValue, 0) + balances.reduce((sum, balance) => sum + balance.value, 0);
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
      <PageHeader title="Holdings" description="Every position across accounts, combined by security (cash by currency, bank accounts included), and the accounts valued by their balance." />
      {portfolio.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : rows.length === 0 && balances.length === 0 && !filter ? (
        <EmptyState title="No holdings yet">Link an investment account or add holdings to a manual account.</EmptyState>
      ) : (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-muted-foreground">Total value</p>
                <p className="text-2xl font-semibold">{money(liveTotal, currency)}</p>
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
                      {money(dayChange, currency)}{' '}
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
                <p className="text-xs text-muted-foreground">Classified by a best guess. Click its category to check or change it.</p>
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
                  const price = quote?.price ?? close?.close ?? holding.price;
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
                          {holding.classifiable ? (
                            <button
                              type="button"
                              className="text-left underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 hover:decoration-solid"
                              title="Change how this is classified"
                              onClick={() => setEditing(holding)}
                            >
                              {mainCategory(holding)}
                            </button>
                          ) : (
                            mainCategory(holding)
                          )}
                          {holding.needsReview && (
                            <button type="button" className="ml-1.5" aria-label="Review classification" onClick={() => setEditing(holding)}>
                              <Badge variant="warning">Review</Badge>
                            </button>
                          )}
                        </Td>
                        <Td className="text-right">{quantity(holding.quantity)}</Td>
                        <Td className="text-right">
                          {/* In the selected currency, so quantity × price = value. */}
                          {money(unitPrice(price === null ? null : price * scale), currency)}
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
                              {shortDate(close.date)}
                              {holding.type === 'mutual fund' && ' (NAV)'}
                            </p>
                          )}
                        </Td>
                        <Td className={`text-right ${quote ? changeClass(quote.change) : ''}`}>
                          {quote ? (
                            <>
                              {money(change, currency)}
                              <p className="text-xs">{formatPercent(quote.changePercent, 2)}</p>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Td>
                        <Td className="text-right font-medium">{money(liveValue, currency)}</Td>
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
                                {positionChange !== null ? money(positionChange, currency) : ''}
                              </Td>
                              <Td className="text-right">{money(positionValue, currency)}</Td>
                              <Td />
                            </tr>
                          );
                        })}
                    </Fragment>
                  );
                })}
                {balances.map((balance) => {
                  const account = accounts.data?.accounts.find((row) => row.id === balance.accountId);
                  return (
                    <tr key={balance.accountId} className="hover:bg-muted/40">
                      <Td />
                      <Td>
                        <p className="flex items-center gap-1.5 font-medium">
                          {balance.name}
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                            {accountKind(balance.type, balance.subtype)}
                          </Badge>
                        </p>
                        <p className="text-xs text-muted-foreground">Account balance</p>
                      </Td>
                      <Td>
                        {account ? (
                          <button
                            type="button"
                            className="text-left underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 hover:decoration-solid"
                            title="Change this account's category"
                            onClick={() => setEditingAccount(account)}
                          >
                            {CATEGORY_LABELS[balance.category]}
                          </button>
                        ) : (
                          CATEGORY_LABELS[balance.category]
                        )}
                      </Td>
                      <Td />
                      <Td />
                      <Td className="text-right text-muted-foreground">—</Td>
                      <Td className="text-right font-medium">{money(balance.value, currency)}</Td>
                      <Td className="text-right text-muted-foreground">{formatPercent(total ? balance.value / total : 0)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
      <ClassificationDialog security={editing} onClose={() => setEditing(null)} />
      <EditAccountDialog account={editingAccount} onClose={() => setEditingAccount(null)} />
    </>
  );
}

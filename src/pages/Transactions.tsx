import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KIND_WORDS, TRANSACTION_KINDS, TRANSFER_LINK_DAYS, type TransactionKind } from '../../shared/transactionKinds';
import { accountLabel } from '../../shared/accounts';
import { holdingLabel } from '../../shared/holdings';
import { fullDescription } from '../../shared/descriptions';
import { fixedRangeStart } from '../../shared/ranges';
import { addDays, marketDate } from '../../shared/dates';
import type { Currency } from '../../shared/money';
import type { TransactionEntry, TransferCandidatesResponse, TransferSide, TransfersResponse } from '../../shared/types';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent } from '../components/ui/dialog';
import { Tooltip } from '../components/ui/tooltip';
import { PageHeader } from '../components/Layout';
import { Card, CardContent } from '../components/ui/card';
import { Input, NativeSelect } from '../components/ui/input';
import { RangePicker } from '../components/RangePicker';
import { Alert, EmptyState, Skeleton, Td, Th } from '../components/ui/misc';
import { useAccounts, useTransactions, type Range } from '../hooks/queries';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER, changeClass, longDate, money, quantity } from '../lib/format';

/** A transaction's description and memo (a Quicken file's NAME and MEMO), joined to show. */
const textOf = (entry: TransactionEntry) => fullDescription(entry.description, entry.memo);

/** The institution's own name for the type, when it says more than the kind does. */
function ownType(entry: TransactionEntry): string | null {
  const label = entry.source === 'import' ? entry.type : (entry.subtype ?? entry.type);
  // A file's type codes (a Quicken file's BUYMF) mean nothing to read.
  if (!label || (entry.source === 'import' && (/^[A-Z]+$/.test(label) || label === 'CSV'))) return null;
  if (entry.kind && label.toLowerCase() === KIND_WORDS[entry.kind].toLowerCase()) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * What the transaction does: worked out from its type, or set by you. The
 * list shows just the type; whether it's automatic is said beneath (with the
 * institution's own word for it). The automatic one isn't listed twice.
 */
function KindSelect({ entry, onChange }: { entry: TransactionEntry; onChange: (kind: TransactionKind | null) => void }) {
  const automatic = entry.automatic ? KIND_WORDS[entry.automatic] : null;
  const own = ownType(entry);
  return (
    <>
      <NativeSelect
        value={entry.kindByYou ? (entry.kind ?? '') : ''}
        onChange={(event) => onChange((event.target.value || null) as TransactionKind | null)}
        aria-label={`Type of ${textOf(entry) ?? 'transaction'} on ${longDate(entry.date)}`}
        className={`h-8 w-full ${entry.kind === null ? 'border-amber-500' : ''}`}
      >
        <option value="">{entry.kindByYou ? `Back to automatic${automatic ? `: ${automatic}` : ''}` : (automatic ?? 'Needs a type')}</option>
        {TRANSACTION_KINDS.filter((kind) => entry.kindByYou || kind !== entry.automatic).map((kind) => (
          <option key={kind} value={kind}>
            {KIND_WORDS[kind]}
          </option>
        ))}
      </NativeSelect>
      <div className="mt-1 text-xs text-muted-foreground">
        {entry.kindByYou ? 'Set by you' : automatic ? 'Automatic' : 'Choose what it is'}
        {own && ` · ${own}`}
      </div>
    </>
  );
}

const sideName = (side: TransferSide) => accountLabel({ name: side.accountName, institutionName: side.institutionName, mask: side.mask });

/** One question in the check list: a pair to confirm, or a transaction several could pair with, to pick which. */
interface Question {
  key: string;
  /** The side the suggestions share, when there are several. */
  shared: 'in' | 'out' | null;
  options: TransfersResponse['transfers'];
}

/** Suggestions sharing a transaction become one question about it; the rest stand alone. */
function questions(transfers: TransfersResponse['transfers']): Question[] {
  const count = (pick: (transfer: TransfersResponse['transfers'][number]) => string) =>
    transfers.reduce((map, transfer) => map.set(pick(transfer), (map.get(pick(transfer)) ?? 0) + 1), new Map<string, number>());
  const ins = count((transfer) => transfer.in.transactionId);
  const outs = count((transfer) => transfer.out.transactionId);
  const found = new Map<string, Question>();
  for (const transfer of transfers) {
    const shared = ins.get(transfer.in.transactionId)! > 1 ? 'in' : outs.get(transfer.out.transactionId)! > 1 ? 'out' : null;
    const key = shared === 'in' ? `in:${transfer.in.transactionId}` : shared === 'out' ? `out:${transfer.out.transactionId}` : transfer.id;
    const question = found.get(key) ?? { key, shared, options: [] };
    question.options.push(transfer);
    found.set(key, question);
  }
  return [...found.values()];
}

/** One side of a transfer: its account and date, and its description to recognise it by. */
function SideCell({ side }: { side: TransferSide }) {
  return (
    <>
      <span>
        {sideName(side)}, <span className="whitespace-nowrap">{longDate(side.date)}</span>
      </span>
      {/* Long unbroken references ("XXXXXXXXXXXX1234") wrap rather than widen the table. */}
      {side.description && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{side.description}</span>}
    </>
  );
}

/** A cell as a table's on a wider screen, a line of the stacked row on a phone. */
const STACKED = 'block p-0 lg:table-cell lg:px-3 lg:py-2';

const optionText = (side: TransferSide) => `${sideName(side)}, ${longDate(side.date)}${side.description ? ` · ${side.description}` : ''}`;

/** Transfers between your accounts that could be paired more than one way: you say which. */
function TransfersToCheck({ transfers, onDecide }: { transfers: TransfersResponse['transfers']; onDecide: (id: string, status: 'confirmed' | 'rejected') => void }) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  return (
    <Card className="relative mb-4">
      <CardContent className="py-3">
        <p className="mb-1 text-sm font-medium">Transfers to check</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Money out of one of your accounts and the same money into another: is it one transfer? Where more than one could be, pick which. A transfer is neither money in nor out for the household; one that isn't stays as both.
        </p>
        {/* A table; on a phone, each row stacked, its sides labelled. */}
        {/* Fixed columns, so it fits the card: the sides share what the amount and the buttons leave. */}
        <table className="w-full text-sm lg:table-fixed">
          <colgroup className="hidden lg:table-column-group">
            <col className="w-28" />
            <col />
            <col />
            <col className="w-32" />
          </colgroup>
          <thead className="hidden lg:table-header-group">
            <tr className="border-b">
              <Th className="text-right">Amount</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>
                <span className="sr-only">Decide</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {questions(transfers).map((question) => {
              const [first] = question.options;
              const chosen = question.options.find((option) => option.id === picked[question.key]) ?? first;
              // The side in question: a list of its candidates.
              const choose = (side: 'in' | 'out') => (
                <NativeSelect
                  className="h-8 w-full"
                  value={chosen.id}
                  onChange={(event) => setPicked({ ...picked, [question.key]: event.target.value })}
                  aria-label={`Which transaction: ${money(first.out.amount, first.out.currency)} ${side === 'out' ? `into ${sideName(first.in)}` : `out of ${sideName(first.out)}`}`}
                >
                  {question.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {optionText(option[side])}
                    </option>
                  ))}
                </NativeSelect>
              );
              return (
                <tr key={question.key} className="grid gap-2 py-3 align-top lg:table-row lg:py-0">
                  <Td className={`${STACKED} whitespace-nowrap font-medium lg:text-right`}>{money(first.out.amount, first.out.currency)}</Td>
                  <Td className={STACKED}>
                    <span className="mb-0.5 block text-xs text-muted-foreground lg:hidden">From</span>
                    {question.shared === 'in' ? (
                      <>
                        {choose('out')}
                        <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{chosen.out.description ?? 'No description'}</span>
                      </>
                    ) : (
                      <SideCell side={first.out} />
                    )}
                  </Td>
                  <Td className={STACKED}>
                    <span className="mb-0.5 block text-xs text-muted-foreground lg:hidden">To</span>
                    {question.shared === 'out' ? (
                      <>
                        {choose('in')}
                        <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{chosen.in.description ?? 'No description'}</span>
                      </>
                    ) : (
                      <SideCell side={first.in} />
                    )}
                  </Td>
                  <Td className={STACKED}>
                    {/* The same two answers whether or not there was a choice; on a wide screen, icons with a tooltip. */}
                    <span className="flex flex-wrap gap-2 lg:flex-nowrap lg:justify-end">
                      <Tooltip content="It’s a transfer">
                        <Button size="sm" variant="outline" aria-label="It’s a transfer" onClick={() => onDecide(chosen.id, 'confirmed')}>
                          <Check className="text-positive" />
                          <span className="lg:hidden">It’s a transfer</span>
                        </Button>
                      </Tooltip>
                      <Tooltip content="Not a transfer">
                        <Button size="sm" variant="outline" aria-label="Not a transfer" onClick={() => question.options.forEach((option) => onDecide(option.id, 'rejected'))}>
                          <X className="text-negative" />
                          <span className="lg:hidden">Not a transfer</span>
                        </Button>
                      </Tooltip>
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/** Unlinking asks first: the pair then counts as money out and in, and isn't linked again automatically. */
function UnlinkDialog({ entry, account, onUnlink, onClose }: { entry: TransactionEntry; account: string; onUnlink: () => void; onClose: () => void }) {
  const transfer = entry.transfer!;
  const other = accountLabel({ name: transfer.accountName, institutionName: transfer.institutionName, mask: transfer.mask });
  const out = entry.amount > 0;
  // Both sides, where the money left and where it arrived, each on its own day with its own description.
  const here = { account, date: entry.date, description: textOf(entry) };
  const there = { account: other, date: transfer.date, description: transfer.description };
  const [from, to] = out ? [here, there] : [there, here];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Unlink this transfer?" description={`${money(Math.abs(entry.amount), entry.currency)} between two of your accounts.`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-muted/60 p-3 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd className="min-w-0">
            {from.account}, <span className="whitespace-nowrap">{longDate(from.date)}</span>
            {from.description && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{from.description}</span>}
          </dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="min-w-0">
            {to.account}, <span className="whitespace-nowrap">{longDate(to.date)}</span>
            {to.description && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{to.description}</span>}
          </dd>
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          Once unlinked, the withdrawal counts as money leaving your household and the deposit as money coming in.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onUnlink}>Unlink</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The transactions that could be this one's other side, to link it to yourself. */
function LinkDialog({ entry, currency, onLink, onClose }: { entry: TransactionEntry; currency: Currency; onLink: (other: string) => void; onClose: () => void }) {
  const candidates = useQuery({
    queryKey: ['transfer-candidates', entry.id],
    queryFn: () => api<TransferCandidatesResponse>(`/api/transactions/${entry.id}/candidates`),
  });
  const out = entry.amount > 0;
  const amount = money(Math.abs(entry.amount), currency);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={out ? 'Where did it go?' : 'Where did it come from?'}
        description={`${amount} ${out ? 'left this account' : 'came into this account'} on ${longDate(entry.date)}. If it ${out ? 'went to' : 'came from'} another of your accounts, pick the ${out ? 'deposit' : 'withdrawal'} there to link them as one transfer.`}
      >
        {candidates.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !candidates.data?.candidates.length ? (
          // What was looked for and found nothing: set apart from the question above.
          <div className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">No match found</p>
            None of your other accounts has {amount} {out ? 'coming in' : 'going out'} between {longDate(addDays(entry.date, -TRANSFER_LINK_DAYS))} and {longDate(addDays(entry.date, TRANSFER_LINK_DAYS))} that isn’t already linked.
          </div>
        ) : (
          <ul className="divide-y text-sm">
            {candidates.data.candidates.map((candidate) => (
              <li key={candidate.transactionId} className="flex items-center justify-between gap-4 py-2">
                <span>
                  {sideName(candidate)}, {longDate(candidate.date)}
                  {candidate.description && <span className="ml-2 text-xs text-muted-foreground">{candidate.description}</span>}
                </span>
                <Button size="sm" variant="outline" onClick={() => onLink(candidate.transactionId)}>
                  Link
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Transactions shown at a time: more are added beneath on request. */
const PAGE_SIZE = 100;

export function Transactions() {
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const selectable = (accounts.data?.accounts ?? []).filter((candidate) => !candidate.isHidden);
  // Every account's to begin with.
  const accountId = params.get('account') ?? 'all';
  const everything = accountId === 'all';
  const account = selectable.find((candidate) => candidate.id === accountId);
  const accountsById = new Map(selectable.map((candidate) => [candidate.id, candidate]));
  // Filters: a preset (as on the Growth page), or dates from and to; and a search.
  const [preset, setPreset] = useState<Range | null>('1M');
  const [from, setFrom] = useState(() => fixedRangeStart('1M', marketDate(new Date())) ?? '');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const choosePreset = (range: Range) => {
    setPreset(range);
    setFrom(fixedRangeStart(range, marketDate(new Date())) ?? '');
    setTo('');
  };
  const chooseDates = (start: string, end: string) => {
    // A start after the end: the end goes (the dates were the other way round).
    const until = start && end && start > end ? '' : end;
    setPreset(start || until ? null : 'ALL');
    setFrom(start);
    setTo(until);
  };
  const filtered = Boolean(from || to || query.trim());
  // Shown 100 at a time, from the first 100 again whenever the account, dates or search change.
  const listKey = [accountId, from, to, query].join('|');
  const [shownFor, setShownFor] = useState({ key: listKey, count: PAGE_SIZE });
  const shown = shownFor.key === listKey ? shownFor.count : PAGE_SIZE;
  const transactions = useTransactions(everything ? 'all' : account ? account.id : null, { from, to, q: query });
  const [linking, setLinking] = useState<TransactionEntry | null>(null);
  const [unlinking, setUnlinking] = useState<TransactionEntry | null>(null);
  const toCheck = useQuery({ queryKey: ['transfers', 'suggested'], queryFn: () => api<TransfersResponse>('/api/transfers?status=suggested') });
  // A transfer changes what the household's charts count as money in and out.
  const refresh = () => {
    setError(null);
    for (const queryKey of [['transactions'], ['transfers'], ['history']]) void queryClient.invalidateQueries({ queryKey });
  };
  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'confirmed' | 'rejected' }) => api(`/api/transfers/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: refresh,
    onError: (caught) => setError(caught.message),
  });
  const link = useMutation({
    mutationFn: ({ outId, inId }: { outId: string; inId: string }) => api('/api/transfers', { method: 'POST', body: JSON.stringify({ outId, inId }) }),
    onSuccess: () => {
      setLinking(null);
      refresh();
    },
    onError: (caught) => setError(caught.message),
  });
  const setKind = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: TransactionKind | null }) => api(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ kind }) }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
    onError: (caught) => setError(caught.message),
  });
  const byType = [...new Set([...ACCOUNT_TYPE_ORDER, ...selectable.map((candidate) => candidate.type)])]
    .map((type) => ({ type, accounts: selectable.filter((candidate) => candidate.type === type) }))
    .filter((entry) => entry.accounts.length > 0);
  const data = transactions.data;
  const investment = data?.kind === 'investment';
  // Every account's: which account each is in, and shares only where any have them.
  const mixed = data?.kind === 'all';
  const shares = investment || (mixed && Boolean(data?.transactions.some((entry) => entry.quantity)));

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Each account's transactions, from Plaid, bank history reports and your imports, and what each one does."
        actions={
          <div className="w-64">
            <NativeSelect value={everything ? 'all' : (account?.id ?? '')} onChange={(event) => setParams({ account: event.target.value })} aria-label="Account">
              <option value="all">All accounts</option>
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
        }
      />
      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      {toCheck.data && toCheck.data.transfers.length > 0 && <TransfersToCheck transfers={toCheck.data.transfers} onDecide={(id, status) => decide.mutate({ id, status })} />}
      {unlinking?.transfer && (
        <UnlinkDialog
          entry={unlinking}
          account={accountsById.has(unlinking.accountId) ? accountLabel(accountsById.get(unlinking.accountId)!) : 'This account'}
          onUnlink={() => {
            decide.mutate({ id: unlinking.transfer!.id, status: 'rejected' });
            setUnlinking(null);
          }}
          onClose={() => setUnlinking(null)}
        />
      )}
      {linking && data && (
        <LinkDialog
          entry={linking}
          currency={data.currency}
          onClose={() => setLinking(null)}
          onLink={(other) => link.mutate(linking.amount > 0 ? { outId: linking.id, inId: other } : { outId: other, inId: linking.id })}
        />
      )}
      {(account || everything) && (
        <Card className="mb-4">
          <CardContent className="flex flex-wrap items-end gap-3 py-3">
            <RangePicker value={preset} onChange={choosePreset} />
            <label className="grid gap-1 text-xs text-muted-foreground">
              From
              <Input type="date" className="h-8 w-44 sm:w-40" value={from} onChange={(event) => chooseDates(event.target.value, to)} />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              To
              <Input type="date" className="h-8 w-44 sm:w-40" value={to} onChange={(event) => chooseDates(from, event.target.value)} />
            </label>
            <label className="grid min-w-48 flex-1 gap-1 text-xs text-muted-foreground">
              Search
              <Input type="search" className="h-8" placeholder="Description or amount" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </CardContent>
        </Card>
      )}
      {accounts.isPending || ((account || everything) && transactions.isPending) ? (
        <Skeleton className="h-64 w-full" />
      ) : !account && !everything ? (
        <EmptyState title="No accounts">Transactions come from linked accounts and imported files.</EmptyState>
      ) : transactions.isError ? (
        <Alert variant="error">Couldn’t load its transactions: {transactions.error.message}</Alert>
      ) : data && data.transactions.length === 0 && filtered ? (
        <EmptyState title="No transactions match">Try other dates, or another search.</EmptyState>
      ) : !data || data.transactions.length === 0 ? (
        <EmptyState title="No transactions">
          {!account
            ? 'Transactions come from linked accounts and imported files.'
            : account.source === 'manual'
            ? 'Import a file of its transactions to see them here.'
            : investment || account.type === 'investment'
              ? 'Plaid has no investment transactions for this account.'
              : 'Bank transactions come from bank history reports; none have been collected for this account.'}
        </EmptyState>
      ) : (
        <>
          {(filtered || data.truncated) && (
            <p className="mb-2 text-sm text-muted-foreground">
              {filtered && (data.matched === 1 ? '1 transaction.' : `${data.matched.toLocaleString()} transactions.`)}
              {data.truncated && ` Showing the latest ${data.transactions.length}.`}
            </p>
          )}
          <Card className="overflow-x-auto">
            {/* A table on a wide screen; on a phone, each transaction stacked: its date and amount, account, description, type and transfer. */}
            <table className="w-full text-sm">
              <thead className="hidden lg:table-header-group">
                <tr className="border-b">
                  <Th>Date</Th>
                  {mixed && <Th>Account</Th>}
                  <Th>Type</Th>
                  <Th>{investment ? 'Security' : 'Description'}</Th>
                  {shares && <Th className="text-right">Shares</Th>}
                  {shares && <Th className="text-right">Price</Th>}
                  <Th className="text-right">Amount</Th>
                  <Th>Transfer</Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.transactions.slice(0, shown).map((entry) => {
                  return (
                    <tr key={entry.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-4 py-3 lg:table-row lg:p-0">
                      <Td className={`${STACKED} order-1 whitespace-nowrap text-xs text-muted-foreground lg:text-sm lg:text-foreground`}>{longDate(entry.date)}</Td>
                      {mixed && <Td className={`${STACKED} order-3 col-span-2 text-xs text-muted-foreground lg:min-w-32 lg:text-sm lg:text-foreground`}>{accountsById.has(entry.accountId) ? accountLabel(accountsById.get(entry.accountId)!) : '—'}</Td>}
                      {/* Wide enough for the longest type ("Automatic: Dividend or interest"), no wider: the description has the room. */}
                      <Td className={`${STACKED} order-5 col-span-2 lg:w-[17rem] lg:min-w-[17rem]`}>
                        <KindSelect entry={entry} onChange={(kind) => setKind.mutate({ id: entry.id, kind })} />
                      </Td>
                      <Td className={`${STACKED} order-4 col-span-2 [overflow-wrap:anywhere] lg:min-w-36`}>
                        {investment || (mixed && (entry.ticker || entry.security)) ? (
                          <>
                            <span className="font-medium">{entry.ticker || entry.security ? holdingLabel({ ticker: entry.ticker, name: entry.security }, 'short') : '—'}</span>
                            {textOf(entry) && <span className="ml-2 text-xs text-muted-foreground">{textOf(entry)}</span>}
                          </>
                        ) : (
                          (textOf(entry) ?? '—')
                        )}
                        {/* The shares and price columns, on a phone. */}
                        {shares && entry.quantity ? (
                          <span className="block text-xs text-muted-foreground lg:hidden">
                            {quantity(entry.quantity)} shares{entry.price ? ` at ${money(Math.round(entry.price * 100), entry.currency)}` : ''}
                          </span>
                        ) : null}
                      </Td>
                      {shares && <Td className="hidden text-right tabular-nums lg:table-cell">{entry.quantity ? quantity(entry.quantity) : ''}</Td>}
                      {shares && <Td className="hidden text-right tabular-nums lg:table-cell">{entry.price && entry.quantity ? money(Math.round(entry.price * 100), entry.currency) : ''}</Td>}
                      {/* Money in is positive here (amounts are stored positive when money leaves), in its account's currency. */}
                      <Td className={`${STACKED} order-2 text-right tabular-nums ${changeClass(-entry.amount)}`}>{entry.amount === 0 ? '' : money(-entry.amount, entry.currency)}</Td>
                      {/* A linked one names the other side (its account wrapping, its date beneath); clicking it asks to unlink. */}
                      <Td className={`${STACKED} order-6 col-span-2 text-xs lg:min-w-44 lg:max-w-72`}>
                        {entry.transfer ? (
                          <button
                            type="button"
                            className="grid gap-0.5 rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => setUnlinking(entry)}
                            title="Unlink transfer"
                          >
                            <span>
                              {entry.amount > 0 ? 'To' : 'From'} {accountLabel({ name: entry.transfer.accountName, institutionName: entry.transfer.institutionName, mask: entry.transfer.mask })}
                            </span>
                            <span className="whitespace-nowrap text-muted-foreground">{longDate(entry.transfer.date)}</span>
                          </button>
                        ) : entry.kind === 'deposit' || entry.kind === 'withdrawal' ? (
                          <Button size="sm" variant="ghost" className="-ml-2 h-6 px-2 lg:ml-0" onClick={() => setLinking(entry)} aria-label={`Link ${textOf(entry) ?? 'transaction'} on ${longDate(entry.date)} to a transfer`}>
                            Link transfer
                          </Button>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          {data.transactions.length > shown && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-sm text-muted-foreground">
              <span>
                Showing {shown.toLocaleString()} of {data.transactions.length.toLocaleString()}
              </span>
              <Button variant="outline" size="sm" onClick={() => setShownFor({ key: listKey, count: shown + PAGE_SIZE })}>
                Show {Math.min(PAGE_SIZE, data.transactions.length - shown)} more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

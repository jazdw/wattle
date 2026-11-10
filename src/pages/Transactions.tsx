import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KIND_WORDS, TRANSACTION_KINDS, type TransactionKind } from '../../shared/transactionKinds';
import { accountLabel } from '../../shared/accounts';
import { fullDescription } from '../../shared/descriptions';
import { fixedRangeStart } from '../../shared/ranges';
import { marketDate } from '../../shared/dates';
import type { Currency } from '../../shared/money';
import type { TransactionEntry, TransferCandidatesResponse, TransferSide, TransfersResponse } from '../../shared/types';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent } from '../components/ui/dialog';
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

/** What the transaction does: worked out from its type, or set by you. */
function KindSelect({ entry, onChange }: { entry: TransactionEntry; onChange: (kind: TransactionKind | null) => void }) {
  const automatic = entry.automatic ? KIND_WORDS[entry.automatic] : 'needs a type';
  return (
    <NativeSelect
      value={entry.kindByYou ? (entry.kind ?? '') : ''}
      onChange={(event) => onChange((event.target.value || null) as TransactionKind | null)}
      aria-label={`Type of ${textOf(entry) ?? 'transaction'} on ${longDate(entry.date)}`}
      className={`h-8 ${entry.kind === null ? 'border-amber-500' : ''}`}
    >
      <option value="">Automatic: {automatic}</option>
      {TRANSACTION_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {KIND_WORDS[kind]}
        </option>
      ))}
    </NativeSelect>
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
      <span className="whitespace-nowrap">
        {sideName(side)}, {longDate(side.date)}
      </span>
      {side.description && <span className="block text-xs text-muted-foreground">{side.description}</span>}
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
    <Card className="relative mb-4 overflow-x-auto">
      <CardContent className="py-3">
        <p className="mb-1 text-sm font-medium">Transfers to check</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Money out of one of your accounts and the same money into another: is it one transfer? Where more than one could be, pick which. A transfer is neither money in nor out for the household; one that isn't stays as both.
        </p>
        {/* A table; on a phone, each row stacked, its sides labelled. */}
        <table className="w-full text-sm">
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
                  className="h-8 lg:min-w-56"
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
                        <span className="mt-1 block text-xs text-muted-foreground">{chosen.out.description ?? 'No description'}</span>
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
                        <span className="mt-1 block text-xs text-muted-foreground">{chosen.in.description ?? 'No description'}</span>
                      </>
                    ) : (
                      <SideCell side={first.in} />
                    )}
                  </Td>
                  <Td className={STACKED}>
                    <span className="flex gap-2 lg:justify-end">
                      <Button size="sm" variant="outline" onClick={() => onDecide(chosen.id, 'confirmed')}>
                        {question.shared === null ? 'It’s a transfer' : 'Link'}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => question.options.forEach((option) => onDecide(option.id, 'rejected'))}>
                        Not a transfer
                      </Button>
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

/** The transactions that could be this one's other side, to link it to yourself. */
function LinkDialog({ entry, currency, onLink, onClose }: { entry: TransactionEntry; currency: Currency; onLink: (other: string) => void; onClose: () => void }) {
  const candidates = useQuery({
    queryKey: ['transfer-candidates', entry.id],
    queryFn: () => api<TransferCandidatesResponse>(`/api/transactions/${entry.id}/candidates`),
  });
  const out = entry.amount > 0;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Link a transfer" description={`${money(Math.abs(entry.amount), currency)} ${out ? 'out' : 'in'} on ${longDate(entry.date)}: the same money ${out ? 'into' : 'out of'} another of your accounts.`}>
        {candidates.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !candidates.data?.candidates.length ? (
          <p className="text-sm text-muted-foreground">Nothing in your other accounts matches: the same amount the other way, within 10 days, and not in a transfer already.</p>
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
  const transactions = useTransactions(everything ? 'all' : account ? account.id : null, { from, to, q: query });
  const [linking, setLinking] = useState<TransactionEntry | null>(null);
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
              <Input type="date" className="h-8 w-40" value={from} onChange={(event) => chooseDates(event.target.value, to)} />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              To
              <Input type="date" className="h-8 w-40" value={to} onChange={(event) => chooseDates(from, event.target.value)} />
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
            <table className="w-full text-sm">
              <thead>
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
                {data.transactions.map((entry) => {
                  const own = ownType(entry);
                  return (
                    <tr key={entry.id}>
                      <Td className="whitespace-nowrap">{longDate(entry.date)}</Td>
                      {mixed && <Td className="min-w-40">{accountsById.has(entry.accountId) ? accountLabel(accountsById.get(entry.accountId)!) : '—'}</Td>}
                      <Td className="min-w-72">
                        <KindSelect entry={entry} onChange={(kind) => setKind.mutate({ id: entry.id, kind })} />
                        {own && <div className="mt-1 text-xs text-muted-foreground">{own}</div>}
                      </Td>
                      <Td>
                        {investment || (mixed && (entry.ticker || entry.security)) ? (
                          <>
                            <span className="font-medium">{entry.ticker ?? entry.security ?? '—'}</span>
                            {textOf(entry) && <span className="ml-2 text-xs text-muted-foreground">{textOf(entry)}</span>}
                          </>
                        ) : (
                          (textOf(entry) ?? '—')
                        )}
                      </Td>
                      {shares && <Td className="text-right tabular-nums">{entry.quantity ? quantity(entry.quantity) : ''}</Td>}
                      {shares && <Td className="text-right tabular-nums">{entry.price && entry.quantity ? money(Math.round(entry.price * 100), entry.currency) : ''}</Td>}
                      {/* Money in is positive here (amounts are stored positive when money leaves), in its account's currency. */}
                      <Td className={`text-right tabular-nums ${changeClass(-entry.amount)}`}>{entry.amount === 0 ? '' : money(-entry.amount, entry.currency)}</Td>
                      <Td className="whitespace-nowrap text-xs">
                        {entry.transfer ? (
                          <span className="flex items-center gap-2">
                            <span>
                              {entry.amount > 0 ? 'To' : 'From'} {accountLabel({ name: entry.transfer.accountName, institutionName: entry.transfer.institutionName, mask: entry.transfer.mask })}, {longDate(entry.transfer.date)}
                            </span>
                            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => decide.mutate({ id: entry.transfer!.id, status: 'rejected' })}>
                              Unlink
                            </Button>
                          </span>
                        ) : entry.kind === 'deposit' || entry.kind === 'withdrawal' ? (
                          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setLinking(entry)} aria-label={`Link ${textOf(entry) ?? 'transaction'} on ${longDate(entry.date)} to a transfer`}>
                            Link…
                          </Button>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}

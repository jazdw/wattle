import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { dateRange, marketDate } from '../../shared/dates';
import { CURRENCIES, type Currency } from '../../shared/money';
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/taxonomy';
import type { AccountSummary, ImportResponse, TickerSuggestion } from '../../shared/types';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { extractBalances, type BalanceMapping, type DateFormat } from '../lib/csv';
import { fileValue, last4, readFiles, type FileAccount, type ReadFiles } from '../lib/imports';
import { accountKind, longDate, money } from '../lib/format';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Field, Input, NativeSelect } from './ui/input';
import { Alert } from './ui/misc';
import { Switch } from './ui/switch';

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries();
}

function OwnerSelect({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  const { me } = useAuth();
  return (
    <NativeSelect value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">Joint</option>
      {me?.household.members.map((member) => (
        <option key={member.id} value={member.id}>
          {member.name}
        </option>
      ))}
    </NativeSelect>
  );
}

const TYPE_OPTIONS = [
  { value: 'depository', label: 'Cash (bank account)' },
  { value: 'investment', label: 'Investments / super' },
  { value: 'property', label: 'Property' },
  { value: 'credit', label: 'Credit card' },
  { value: 'loan', label: 'Loan / mortgage' },
  { value: 'other', label: 'Other asset' },
];

/* ------------------------------------------------------------------ */
/* New manual account                                                  */
/* ------------------------------------------------------------------ */

export function NewAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { me, currency: shown } = useAuth();
  const invalidate = useInvalidate();
  // The currency follows the one shown (the sidebar switch) until you pick one here.
  const [currencyPicked, setCurrencyPicked] = useState(false);
  const [form, setForm] = useState(() => ({
    name: '',
    institutionName: '',
    type: 'depository',
    currency: shown,
    category: '',
    ownerUserId: me?.user.id ?? null,
    balance: '',
    date: marketDate(new Date()),
  }));

  const save = useMutation({
    mutationFn: () =>
      api('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          institutionName: form.institutionName || null,
          type: form.type,
          currency: form.currency,
          category: form.category || null,
          ownerUserId: form.ownerUserId,
          ...(form.balance !== '' ? { balance: Number(form.balance), date: form.date } : {}),
        }),
      }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
      setForm({ ...form, name: '', institutionName: '', balance: '' });
    },
  });

  if (open && !currencyPicked && form.currency !== shown) setForm({ ...form, currency: shown });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a manual account" description="For accounts Plaid can't reach: Australian banks, super, property, 401(k) plans…">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Example Super" />
          </Field>
          <Field label="Institution">
            <Input value={form.institutionName} onChange={(event) => setForm({ ...form, institutionName: event.target.value })} placeholder="REST" />
          </Field>
          <Field label="Type">
            <NativeSelect value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Currency">
            <NativeSelect
              value={form.currency}
              onChange={(event) => {
                setCurrencyPicked(true);
                setForm({ ...form, currency: event.target.value as Currency });
              }}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Owner">
            <OwnerSelect value={form.ownerUserId} onChange={(ownerUserId) => setForm({ ...form, ownerUserId })} />
          </Field>
          <Field label="Allocation category" hint="Used when the account has no holdings.">
            <NativeSelect value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              <option value="">Default for type</option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={form.type === 'credit' || form.type === 'loan' ? 'Amount owed' : 'Current balance'}>
            <Input inputMode="decimal" value={form.balance} onChange={(event) => setForm({ ...form, balance: event.target.value })} />
          </Field>
          <Field label="As of">
            <Input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
          </Field>
        </div>
        {save.error && <Alert variant="error">{save.error.message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!form.name || save.isPending}>
            Add account
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Edit account                                                        */
/* ------------------------------------------------------------------ */

export function EditAccountDialog({
  account,
  duplicateOf,
  onClose,
}: {
  account: AccountSummary | null;
  /** "Name at Institution" of the account this one looks like a copy of. */
  duplicateOf?: string | null;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const [form, setForm] = useState<{ id: string; name: string; ownerUserId: string | null; category: string; isHidden: boolean; purge: boolean } | null>(null);
  const [balance, setBalance] = useState(() => ({ amount: '', date: marketDate(new Date()) }));

  if (account && form?.id !== account.id) {
    setForm({
      id: account.id,
      name: account.name,
      ownerUserId: account.ownerUserId,
      category: account.category ?? '',
      isHidden: account.isHidden,
      purge: false,
    });
  }

  const history = useQuery({
    queryKey: ['balances', account?.id],
    queryFn: () => api<{ balances: { date: string; balance: number; source: string }[] }>(`/api/accounts/${account!.id}/balances`),
    enabled: account?.source === 'manual',
  });

  const save = useMutation({
    mutationFn: async () => {
      await api(`/api/accounts/${account!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form!.name,
          ownerUserId: form!.ownerUserId,
          category: form!.category || null,
          isHidden: form!.isHidden,
          purge: form!.isHidden && form!.purge,
        }),
      });
      if (account!.source === 'manual' && balance.amount !== '') {
        await api(`/api/accounts/${account!.id}/balances`, {
          method: 'POST',
          body: JSON.stringify({ date: balance.date, balance: Number(balance.amount) }),
        });
      }
    },
    onSuccess: () => {
      invalidate();
      setBalance({ ...balance, amount: '' });
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/accounts/${account!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!account || !form) return null;
  const liability = account.type === 'credit' || account.type === 'loan';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={account.name} description={[account.institutionName, account.mask && `··${account.mask}`, accountKind(account.type, account.subtype)].filter(Boolean).join(' · ')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Owner">
            <OwnerSelect value={form.ownerUserId} onChange={(ownerUserId) => setForm({ ...form, ownerUserId })} />
          </Field>
          <Field label="Allocation category" hint="Used when the account has no holdings.">
            <NativeSelect value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              <option value="">Default for type</option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>

        <div className="rounded-md border p-3">
          {duplicateOf && (
            <div className="mb-3">
              <Alert variant="warning">
                Possibly a duplicate of <span className="font-medium">{duplicateOf}</span>: same type, balance and last four digits, from
                another login. If it's the same account (e.g. a joint account you've both linked), hide this copy so it isn't counted twice.
              </Alert>
            </div>
          )}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="font-medium">Hide this account</span>
              <span className="block text-xs text-muted-foreground">
                Stops syncing it and leaves it out of every total — e.g. a joint account your partner already linked.
              </span>
            </span>
            <Switch checked={form.isHidden} onCheckedChange={(isHidden) => setForm({ ...form, isHidden })} />
          </label>
          {form.isHidden && !account.isHidden && (
            <label className="mt-3 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Also delete its stored history</span>
              <Switch checked={form.purge} onCheckedChange={(purge) => setForm({ ...form, purge })} />
            </label>
          )}
        </div>

        {account.source === 'manual' && (
          <div className="grid gap-2 rounded-md border p-3">
            <p className="text-sm font-medium">
              Record a balance <span className="font-normal text-muted-foreground">in {account.currency}</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Input
                inputMode="decimal"
                aria-label={`${liability ? 'Amount owed' : 'Balance'} (${account.currency})`}
                placeholder={`${liability ? 'Amount owed' : 'Balance'} (${account.currency})`}
                value={balance.amount}
                onChange={(event) => setBalance({ ...balance, amount: event.target.value })}
              />
              <Input type="date" value={balance.date} onChange={(event) => setBalance({ ...balance, date: event.target.value })} />
            </div>
            {(history.data?.balances.length ?? 0) > 0 && (
              <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground">
                {history.data!.balances.slice(0, 12).map((row) => (
                  <li key={row.date} className="flex justify-between py-0.5">
                    <span>{longDate(row.date)}</span>
                    <span>
                      {money(row.balance, account.currency)} <span className="opacity-70">{row.source}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {account.source !== 'manual' && account.missingSince && (
          <p className="text-xs text-muted-foreground">
            {account.institutionName ?? 'The institution'} no longer reports this account (closed, or deselected in Plaid). Delete removes it and its stored history; if you choose it
            again later it comes back as a new account.
          </p>
        )}
        {(save.error || remove.error) && <Alert variant="error">{(save.error ?? remove.error)!.message}</Alert>}
        <div className="flex flex-wrap justify-between gap-2">
          {account.source === 'manual' || account.missingSince ? (
            confirmDelete ? (
              <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Delete account and history
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete
              </Button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Manual holdings                                                     */
/* ------------------------------------------------------------------ */

interface HoldingDraft {
  ticker: string;
  name: string;
  quantity: string;
  price: string;
}

export function HoldingsDialog({ account, onClose }: { account: AccountSummary | null; onClose: () => void }) {
  const invalidate = useInvalidate();
  const [drafts, setDrafts] = useState<HoldingDraft[] | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  /** The version this editor loaded: saving is refused if someone saved since. */
  const [loadedVersion, setLoadedVersion] = useState<number | undefined>(undefined);

  const current = useQuery({
    queryKey: ['account-holdings', account?.id],
    queryFn: () =>
      api<{ holdings: { ticker: string | null; name: string | null; quantity: number; price: number | null; isPublic: boolean }[]; version: number }>(
        `/api/accounts/${account!.id}/holdings`,
      ),
    enabled: account !== null,
  });

  if (account && current.data && loadedFor !== account.id) {
    setLoadedFor(account.id);
    setLoadedVersion(current.data.version);
    setDrafts(
      current.data.holdings.map((holding) => ({
        ticker: holding.ticker ?? '',
        name: holding.name ?? '',
        quantity: String(holding.quantity),
        price: holding.isPublic ? '' : String(holding.price ?? ''),
      })),
    );
  }

  const save = useMutation({
    mutationFn: () =>
      api<{ unpriced: number }>(`/api/accounts/${account!.id}/holdings`, {
        method: 'PUT',
        body: JSON.stringify({
          holdings: (drafts ?? [])
            .filter((draft) => draft.ticker && draft.quantity)
            .map((draft) => ({
              ticker: draft.ticker,
              name: draft.name || undefined,
              quantity: Number(draft.quantity),
              ...(draft.price ? { price: Number(draft.price) } : {}),
            })),
          version: loadedVersion,
        }),
      }),
    onSuccess: () => {
      invalidate();
      setLoadedFor(null);
      onClose();
    },
  });

  if (!account) return null;
  const update = (index: number, patch: Partial<HoldingDraft>) =>
    setDrafts((list) => (list ?? []).map((draft, position) => (position === index ? { ...draft, ...patch } : draft)));

  return (
    <Dialog open onOpenChange={(open) => !open && (setLoadedFor(null), onClose())}>
      <DialogContent
        className="max-w-2xl"
        title={`Holdings — ${account.name}`}
        description="Public tickers are priced automatically each day. For funds without a ticker (e.g. a super option or 401(k) trust), give a code and unit price."
      >
        <div className="grid gap-2">
          <div className="grid grid-cols-[6rem_1fr_6rem_6rem_2rem] gap-2 text-xs text-muted-foreground">
            <span>Ticker / code</span>
            <span>Name</span>
            <span>Units</span>
            <span>Unit price</span>
            <span />
          </div>
          {(drafts ?? []).map((draft, index) => (
            <div key={index} className="grid grid-cols-[6rem_1fr_6rem_6rem_2rem] gap-2">
              <Input value={draft.ticker} onChange={(event) => update(index, { ticker: event.target.value.toUpperCase() })} />
              <Input value={draft.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="Optional" />
              <Input inputMode="decimal" value={draft.quantity} onChange={(event) => update(index, { quantity: event.target.value })} />
              <Input inputMode="decimal" value={draft.price} onChange={(event) => update(index, { price: event.target.value })} placeholder="Auto" />
              <Button variant="ghost" size="icon" onClick={() => setDrafts((list) => (list ?? []).filter((_, position) => position !== index))} aria-label="Remove">
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setDrafts([...(drafts ?? []), { ticker: '', name: '', quantity: '', price: '' }])}>
            <Plus /> Add holding
          </Button>
        </div>
        {save.error && <Alert variant="error">{save.error.message}</Alert>}
        {save.data && save.data.unpriced > 0 && <Alert variant="warning">{save.data.unpriced} holding(s) couldn't be priced; give a unit price.</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save holdings
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/** Where an account in the files goes: one of yours, a new manual account, or nowhere. */
type Choice = { to: 'account'; accountId: string } | { to: 'new'; name: string; type: string; currency: Currency; ownerUserId: string | null } | { to: 'skip' } | { to: 'choose' };

const DEFAULT_MAPPING: BalanceMapping = { dateColumn: 0, balanceColumn: 1, dateFormat: 'YYYY-MM-DD', hasHeader: true };
const isCurrency = (value: string | undefined): value is Currency => CURRENCIES.includes(value as Currency);
/** A market ticker as typed (VTI, BRK.B). */
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** How the import names an account in the files: its last digits, or the file for one without a number. */
const labelOf = (account: FileAccount) => (account.number ? `··${last4(account.number)}` : 'The file');
/** Holdings go only in investment accounts; balances in any. */
const fits = (target: AccountSummary, account: FileAccount) => account.file.kind === 'balances' || target.type === 'investment';

export function ImportDialog({ accounts, open, onOpenChange }: { accounts: AccountSummary[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const invalidate = useInvalidate();
  const { me, currency: shown } = useAuth();
  const [read, setRead] = useState<ReadFiles | null>(null);
  const [mapping, setMapping] = useState<BalanceMapping>(DEFAULT_MAPPING);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  // Tickers typed for securities the files name without one (by the file's id for it).
  const [tickers, setTickers] = useState<Record<string, string>>({});
  const visible = accounts.filter((candidate) => !candidate.isHidden);

  /** The account you have with the same last digits, when it can take the file. */
  const matchOf = (account: FileAccount) => (account.number ? visible.find((candidate) => candidate.mask && last4(candidate.mask) === last4(account.number) && fits(candidate, account)) : undefined);

  async function loadFiles(files: File[]) {
    setFileError(null);
    setRead(null);
    commit.reset();
    try {
      const result = readFiles(await Promise.all(files.map((file) => file.text())));
      setRead(result);
      if (result.kind === 'table') {
        setMapping(result.guess ?? { ...DEFAULT_MAPPING, balanceColumn: Math.max(0, (result.rows[0]?.length ?? 1) - 1) });
        setChoices([{ to: 'choose' }]);
      } else {
        setChoices(result.accounts.map((account) => {
          const match = matchOf(account);
          return match ? { to: 'account', accountId: match.id } : { to: 'choose' };
        }));
      }
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    }
  }

  // The accounts in the files; a CSV of balances is one, from its chosen columns.
  const preview = read?.kind === 'table' ? extractBalances(read.rows, mapping) : null;
  const fileAccounts: FileAccount[] =
    read?.kind === 'accounts' ? read.accounts : preview ? [{ number: null, institution: null, unknownTypes: [], file: { kind: 'balances', rows: preview.rows } }] : [];

  function defaultNew(account: FileAccount): Choice {
    const currency = isCurrency(account.file.currency) ? account.file.currency : shown;
    const name = account.number ? `${account.institution ?? 'Imported'} ··${last4(account.number)}` : 'Imported account';
    // Yours, as a manual account you add is (change it later with Edit account).
    return { to: 'new', name, type: account.file.kind === 'holdings' ? 'investment' : (account.type ?? 'depository'), currency, ownerUserId: me?.user.id ?? null };
  }
  function choose(index: number, choice: Choice) {
    setChoices(choices.map((current, at) => (at === index ? choice : current)));
  }

  // What stops each account going in (errors), and what's worth knowing (warnings).
  const chosenIds = choices.flatMap((choice) => (choice.to === 'account' ? [choice.accountId] : []));
  const checks = fileAccounts.map((account, index) => {
    const choice = choices[index] ?? { to: 'choose' };
    const errors: string[] = [];
    const warnings: string[] = [];
    if (choice.to === 'skip') return { errors, warnings };
    if (account.unknownTypes.length > 0) errors.push(`Wattle doesn't understand these transaction types yet: ${account.unknownTypes.join(', ')}. Skip this account.`);
    if (account.file.kind === 'balances' && account.file.rows.length === 0) errors.push('There are no balances to import.');
    const currency = account.file.currency;
    if (choice.to === 'account') {
      const target = visible.find((candidate) => candidate.id === choice.accountId);
      if (target && currency && currency !== target.currency) errors.push(`The file is in ${currency} but ${target.name} is in ${target.currency}.`);
      if (chosenIds.filter((id) => id === choice.accountId).length > 1) errors.push(`${target?.name ?? 'That account'} is chosen for another account too.`);
    }
    if (choice.to === 'new') {
      if (!choice.name.trim()) errors.push('Give the new account a name.');
      if (currency && currency !== choice.currency) errors.push(`The file is in ${currency}.`);
      const linked = account.number ? visible.find((candidate) => candidate.source === 'plaid' && candidate.mask && last4(candidate.mask) === last4(account.number)) : undefined;
      if (linked) warnings.push(`${linked.name} is linked with the same last digits: a new account would count this money twice.`);
    }
    return { errors, warnings };
  });
  // Securities the files name without a ticker: give one to price it at each day's close (a suggestion filled in when found).
  const untickered = [...new Map(fileAccounts.flatMap((account) => (account.file.kind === 'holdings' ? account.file.securities.filter((security) => !security.ticker) : [])).map((security) => [security.id, security])).values()];
  const suggestions = useQuery({
    queryKey: ['import-tickers', untickered.map((security) => security.id)],
    queryFn: () => api<{ suggestions: TickerSuggestion[] }>('/api/imports/tickers', { method: 'POST', body: JSON.stringify({ securities: untickered.map(({ id, name }) => ({ id, name })) }) }),
    enabled: untickered.length > 0,
    staleTime: Infinity,
  });
  const suggested = (id: string) => suggestions.data?.suggestions.find((suggestion) => suggestion.id === id);
  const tickerFor = (id: string) => (tickers[id] ?? suggested(id)?.ticker ?? '').trim().toUpperCase();
  const badTickers = untickered.filter((security) => tickerFor(security.id) && !TICKER.test(tickerFor(security.id)));
  const ready =
    fileAccounts.length > 0 && choices.every((choice) => choice.to !== 'choose') && checks.every((check) => check.errors.length === 0) && choices.some((choice) => choice.to !== 'skip') && badTickers.length === 0;

  const commit = useMutation({
    mutationFn: () =>
      api<ImportResponse>('/api/imports', {
        method: 'POST',
        body: JSON.stringify({
          accounts: fileAccounts.flatMap((account, index) => {
            const choice = choices[index];
            if (!choice || choice.to === 'skip' || choice.to === 'choose') return [];
            const target =
              choice.to === 'account'
                ? { accountId: choice.accountId }
                : { new: { name: choice.name.trim(), type: choice.type, currency: choice.currency, institutionName: account.institution, mask: last4(account.number), ownerUserId: choice.ownerUserId } };
            const file = account.file.kind === 'holdings' ? { ...account.file, securities: account.file.securities.map((security) => (security.ticker ? security : { ...security, ticker: tickerFor(security.id) || null })) } : account.file;
            return [{ label: labelOf(account), target, file }];
          }),
        }),
      }),
    // Accepted: the dialog closes; each account shows its progress on the Accounts page while it's written.
    onSuccess: () => {
      invalidate();
      close();
    },
  });

  // Closing starts the next import afresh.
  function close() {
    setRead(null);
    setChoices([]);
    setTickers({});
    setMapping(DEFAULT_MAPPING);
    setFileError(null);
    commit.reset();
    onOpenChange(false);
  }

  const header = read?.kind === 'table' ? (read.rows[0] ?? []) : [];
  const columnOptions = header.map((cell, index) => (
    <option key={index} value={index}>
      {mapping.hasHeader ? cell || `Column ${index + 1}` : `Column ${index + 1} (${cell})`}
    </option>
  ));

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className="max-w-2xl"
        title="Import history"
        description="Upload Quicken (QFX/OFX) files from investment, bank or card accounts, one or more at a time, or a CSV with a date and a balance on each row."
      >
        <Field label="Files">
          <Input type="file" multiple accept=".csv,text/csv,.qfx,.ofx" onChange={(event) => event.target.files?.length && void loadFiles([...event.target.files])} />
        </Field>
        {fileError && <Alert variant="error">{fileError}</Alert>}

        {read?.kind === 'table' && (
          <>
            {read.guess ? <Alert>Found its date and balance columns: check them below.</Alert> : <Alert>Choose the columns with the date and the balance.</Alert>}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Date column">
                <NativeSelect value={mapping.dateColumn} onChange={(event) => setMapping({ ...mapping, dateColumn: Number(event.target.value) })}>
                  {columnOptions}
                </NativeSelect>
              </Field>
              <Field label="Balance column">
                <NativeSelect value={mapping.balanceColumn} onChange={(event) => setMapping({ ...mapping, balanceColumn: Number(event.target.value) })}>
                  {columnOptions}
                </NativeSelect>
              </Field>
              <Field label="Date format">
                <NativeSelect value={mapping.dateFormat} onChange={(event) => setMapping({ ...mapping, dateFormat: event.target.value as DateFormat })}>
                  <option>YYYY-MM-DD</option>
                  <option>DD/MM/YYYY</option>
                  <option>MM/DD/YYYY</option>
                </NativeSelect>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={mapping.hasHeader} onCheckedChange={(hasHeader) => setMapping({ ...mapping, hasHeader })} /> First row is a header
            </label>
          </>
        )}

        {fileAccounts.map((account, index) => (
          <ImportRow
            key={account.number ?? `file:${index}`}
            account={account}
            choice={choices[index] ?? { to: 'choose' }}
            accounts={visible.filter((candidate) => fits(candidate, account))}
            onChoose={(choice) => choose(index, choice.to === 'new' && choices[index]?.to !== 'new' ? defaultNew(account) : choice)}
            check={checks[index]}
            skipped={preview?.skipped ?? 0}
            shown={shown}
          />
        ))}

        {untickered.length > 0 && (
          <div className="grid gap-2 rounded-md border p-3 text-sm">
            <p className="font-medium">Securities without a ticker</p>
            <p className="text-muted-foreground">
              Give a security its market ticker to value it at each day's close. Leave it blank for a fund with no market price (a plan's own funds): it's valued from the file's prices, on a straight line between them.
            </p>
            {untickered.map((security) => {
              const suggestion = suggested(security.id);
              const value = tickers[security.id] ?? suggestion?.ticker ?? '';
              return (
                <div key={security.id} className="grid items-center gap-2 sm:grid-cols-[1fr_8rem]">
                  <div className="min-w-0">
                    <p className="truncate">{security.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {security.id}
                      {suggestion && value.trim().toUpperCase() === suggestion.ticker && (suggestion.from === 'yours' ? ' · the same name as one of your securities' : ' · found by its name: check it')}
                    </p>
                  </div>
                  <Input aria-label={`Ticker for ${security.name}`} value={value} placeholder={suggestions.isLoading ? 'Looking…' : 'None'} onChange={(event) => setTickers({ ...tickers, [security.id]: event.target.value })} />
                </div>
              );
            })}
            {badTickers.length > 0 && <Alert variant="error">That isn't a ticker: {badTickers.map((security) => tickerFor(security.id)).join(', ')}.</Alert>}
          </div>
        )}
        {commit.error && <Alert variant="error">{commit.error.message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          <Button onClick={() => commit.mutate()} disabled={!ready || commit.isPending}>
            {commit.isPending ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One account in the files: what it holds, and where it goes. */
function ImportRow({
  account,
  choice,
  accounts,
  onChoose,
  check,
  skipped,
  shown,
}: {
  account: FileAccount;
  choice: Choice;
  accounts: AccountSummary[];
  onChoose: (choice: Choice) => void;
  check: { errors: string[]; warnings: string[] };
  skipped: number;
  shown: Currency;
}) {
  const file = account.file;
  const value = choice.to === 'account' ? choice.accountId : choice.to;
  const target = choice.to === 'account' ? accounts.find((candidate) => candidate.id === choice.accountId) : undefined;
  const currency = target?.currency ?? (choice.to === 'new' ? choice.currency : isCurrency(file.currency) ? file.currency : shown);
  const label = labelOf(account);
  return (
    <div className="grid gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="font-medium">
          {account.number ? `Account ${label}` : 'Balances'}
          {account.institution && <span className="text-muted-foreground"> · {account.institution}</span>}
        </p>
        <p className="text-muted-foreground">{summary(file, currency, skipped)}</p>
      </div>
      {file.kind === 'balances' && file.rows.length > 0 && (
        <ul className="max-h-36 overflow-y-auto text-xs text-muted-foreground">
          {file.rows.slice(-8).map((row) => (
            <li key={row.date} className="flex justify-between">
              <span>{longDate(row.date)}</span>
              <span>{money(Math.round(row.balance * 100), currency)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={`Import ${label} into`}>
          <NativeSelect
            value={value}
            onChange={(event) => {
              const next = event.target.value;
              onChoose(next === 'skip' || next === 'choose' ? { to: next } : next === 'new' ? { to: 'new', name: '', type: 'investment', currency, ownerUserId: null } : { to: 'account', accountId: next });
            }}
          >
            <option value="choose">Choose…</option>
            {accounts.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
            <option value="new">New account</option>
            <option value="skip">Skip</option>
          </NativeSelect>
        </Field>
        {choice.to === 'new' && (
          <Field label="New account's name">
            <Input value={choice.name} onChange={(event) => onChoose({ ...choice, name: event.target.value })} />
          </Field>
        )}
      </div>
      {choice.to === 'new' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {file.kind === 'balances' && (
            <Field label="Type">
              <NativeSelect value={choice.type} onChange={(event) => onChoose({ ...choice, type: event.target.value })}>
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Currency">
            <NativeSelect value={choice.currency} onChange={(event) => onChoose({ ...choice, currency: event.target.value as Currency })}>
              {CURRENCIES.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      )}
      {check.errors.map((error) => (
        <Alert key={error} variant="error">
          {error}
        </Alert>
      ))}
      {check.warnings.map((warning) => (
        <Alert key={warning} variant="warning">
          {warning}
        </Alert>
      ))}
    </div>
  );
}

/** What an account in the files holds, in a line. */
function summary(file: FileAccount['file'], currency: Currency, skipped: number): string {
  if (file.kind === 'balances') {
    const { rows } = file;
    if (rows.length === 0) return `No balances${skipped > 0 ? ` (${skipped} rows skipped)` : ''}`;
    // The import carries each balance forward to the next, so it writes every day in between.
    const days = rows.length > 1 ? `, filling ${dateRange(rows[0].date, rows.at(-1)!.date).length} days` : '';
    return `${rows.length} ${rows.length === 1 ? 'balance' : 'balances'}${days} · ${longDate(rows[0].date)} – ${longDate(rows.at(-1)!.date)}${skipped > 0 ? ` · ${skipped} rows skipped` : ''}`;
  }
  const from = file.transactions[0]?.date;
  const to = file.transactions.at(-1)?.date;
  const positions = `${file.positions.length} ${file.positions.length === 1 ? 'holding' : 'holdings'}`;
  const transactions = `${file.transactions.length} ${file.transactions.length === 1 ? 'transaction' : 'transactions'}`;
  return `${positions}, ${transactions}${from && to ? ` · ${longDate(from)} – ${longDate(to)}` : ''} · ${money(fileValue(file), currency)} on ${longDate(file.asOf)}`;
}

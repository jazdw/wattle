import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { marketDate } from '../../shared/dates';
import { CURRENCIES, fromMinor, type Currency } from '../../shared/money';
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/taxonomy';
import type { AccountSummary } from '../../shared/types';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { extractBalances, parseCsv, PRESETS, type BalanceMapping, type DateFormat } from '../lib/csv';
import { longDate, money } from '../lib/format';
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
  const { me } = useAuth();
  const invalidate = useInvalidate();
  const [form, setForm] = useState(() => ({
    name: '',
    institutionName: '',
    type: 'depository',
    currency: 'AUD' as Currency,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a manual account" description="For accounts Plaid can't reach: Australian banks, super, property, 401(k) plans…">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="REST Super" />
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
            <NativeSelect value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value as Currency })}>
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

export function EditAccountDialog({ account, onClose }: { account: AccountSummary | null; onClose: () => void }) {
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
      <DialogContent title={account.name} description={[account.institutionName, account.mask && `··${account.mask}`, account.subtype].filter(Boolean).join(' · ')}>
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
            <p className="text-sm font-medium">Record a balance</p>
            <div className="grid grid-cols-2 gap-2">
              <Input
                inputMode="decimal"
                placeholder={liability ? 'Amount owed' : 'Balance'}
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

        {(save.error || remove.error) && <Alert variant="error">{(save.error ?? remove.error)!.message}</Alert>}
        <div className="flex flex-wrap justify-between gap-2">
          {account.source === 'manual' ? (
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

  const current = useQuery({
    queryKey: ['account-holdings', account?.id],
    queryFn: () =>
      api<{ holdings: { ticker: string | null; name: string | null; quantity: number; price: number | null; isPublic: boolean }[] }>(
        `/api/accounts/${account!.id}/holdings`,
      ),
    enabled: account !== null,
  });

  if (account && current.data && loadedFor !== account.id) {
    setLoadedFor(account.id);
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
/* CSV import                                                          */
/* ------------------------------------------------------------------ */

export function ImportDialog({ accounts, open, onOpenChange }: { accounts: AccountSummary[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const invalidate = useInvalidate();
  const [accountId, setAccountId] = useState('');
  const [table, setTable] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<BalanceMapping | null>(null);
  const [presetLabel, setPresetLabel] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);

  async function loadFile(file: File) {
    const rows = parseCsv(await file.text());
    setTable(rows);
    const preset = rows.length > 0 ? PRESETS.find((candidate) => candidate.detect(rows[0])) : undefined;
    setPresetLabel(preset?.label ?? null);
    setMapping(
      preset?.mapping(rows[0]) ?? {
        dateColumn: 0,
        balanceColumn: Math.max(0, (rows[0]?.length ?? 1) - 1),
        dateFormat: 'YYYY-MM-DD',
        hasHeader: true,
      },
    );
  }

  const preview = table && mapping ? extractBalances(table, mapping) : null;
  const account = accounts.find((candidate) => candidate.id === accountId);

  const commit = useMutation({
    mutationFn: () =>
      api<{ imported: number }>('/api/imports/balances', {
        method: 'POST',
        body: JSON.stringify({ accountId, rows: preview!.rows, overwrite }),
      }),
    onSuccess: () => invalidate(),
  });

  const header = table?.[0] ?? [];
  const columnOptions = header.map((cell, index) => (
    <option key={index} value={index}>
      {mapping?.hasHeader ? cell || `Column ${index + 1}` : `Column ${index + 1} (${cell})`}
    </option>
  ));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTable(null);
          commit.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-2xl"
        title="Import balance history"
        description="Upload a CSV with a date and a balance per row — e.g. a Westpac transaction export (its running balance becomes daily history)."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Account">
            <NativeSelect value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">Choose…</option>
              {accounts
                .filter((candidate) => !candidate.isHidden)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="CSV file">
            <Input type="file" accept=".csv,text/csv" onChange={(event) => event.target.files?.[0] && void loadFile(event.target.files[0])} />
          </Field>
        </div>

        {table && mapping && (
          <>
            {presetLabel && <Alert>Recognised a {presetLabel} export.</Alert>}
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
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={overwrite} onCheckedChange={setOverwrite} /> Replace values already synced for the same days
            </label>
            {preview && (
              <div className="rounded-md border p-3 text-sm">
                <p className="mb-1 font-medium">
                  {preview.rows.length} days
                  {preview.rows.length > 0 && ` · ${longDate(preview.rows[0].date)} – ${longDate(preview.rows.at(-1)!.date)}`}
                  {preview.skipped > 0 && <span className="text-muted-foreground"> · {preview.skipped} rows skipped</span>}
                </p>
                <ul className="max-h-36 overflow-y-auto text-xs text-muted-foreground">
                  {preview.rows.slice(-8).map((row) => (
                    <li key={row.date} className="flex justify-between">
                      <span>{longDate(row.date)}</span>
                      <span>{account ? money(Math.round(row.balance * 100), account.currency) : fromMinor(Math.round(row.balance * 100))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {commit.error && <Alert variant="error">{commit.error.message}</Alert>}
        {commit.data && <Alert>Imported {commit.data.imported} days.</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => commit.mutate()} disabled={!accountId || !preview?.rows.length || commit.isPending}>
            Import
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

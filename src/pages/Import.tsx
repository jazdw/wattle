/**
 * Importing history: files in, a section per account found in them (where it
 * goes, the balance it's worked out from when the file has none) with a
 * preview of every row it writes, checked by the server before anything is
 * written (POST /api/imports/check), then imported in one request.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountLabel } from '../../shared/accounts';
import { holdingLabel } from '../../shared/holdings';
import { dateRange } from '../../shared/dates';
import { CURRENCIES, type Currency } from '../../shared/money';
import type { ImportRequest } from '../../shared/schemas';
import type { AccountSummary, AccountType, ImportCheck, ImportProblem, ImportResponse, TickerSuggestion } from '../../shared/types';
import { api } from '../api';
import { SubtypeSelect } from '../components/AccountDialogs';
import { PageHeader } from '../components/Layout';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Field, Input, NativeSelect } from '../components/ui/input';
import { Alert, Td, Th } from '../components/ui/misc';
import { Switch } from '../components/ui/switch';
import { useAccounts } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';
import { extractBalances, parseAmount, type BalanceMapping, type DateFormat } from '../lib/csv';
import { ACCOUNT_TYPE_OPTIONS, accountKind, longDate, money, quantity } from '../lib/format';
import { previewRows } from '../lib/importPreview';
import { combineAccounts, fileValue, last4, readFiles, type FileAccount, type ReadFiles } from '../lib/imports';
import { withKnown, type Known } from '../lib/known';
import { cn } from '../lib/utils';

/** Where an account in the files goes: one of yours, a new manual account, with another file's, or nowhere. */
type Choice =
  | { to: 'account'; accountId: string }
  | { to: 'new'; name: string; institutionName: string; type: AccountType; subtype: string; currency: Currency; ownerUserId: string | null }
  /** The same account as another file's (files with no account number, such as a CSV a year): imported together, where that one goes. */
  | { to: 'with'; index: number }
  | { to: 'skip' }
  | { to: 'choose' };
/** A known balance as typed: before the file's first transaction or after its last, amounts as text. */
type KnownInput = { at: 'start' | 'end'; cash: string; shares: Record<string, string> };

const DEFAULT_MAPPING: BalanceMapping = { dateColumn: 0, balanceColumn: 1, dateFormat: 'YYYY-MM-DD', hasHeader: true };
const NO_KNOWN: KnownInput = { at: 'end', cash: '', shares: {} };
/** How long typing settles before the import is checked again. */
const CHECK_DELAY_MS = 600;
const isCurrency = (value: string | undefined): value is Currency => CURRENCIES.includes(value as Currency);
/** A market ticker as typed (VTI, BRK.B). */
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** How the import names an account in the files: its last digits, or the file for one without a number. */
const labelOf = (account: FileAccount) => (account.number ? `··${last4(account.number)}` : (account.fileName ?? 'The file'));
/** Holdings go in investment accounts, or a bank account as its daily balance (a brokerage's cash management account); balances in any. */
const fits = (target: AccountSummary, account: FileAccount) => account.file.kind === 'balances' || target.type === 'investment' || target.type === 'depository';
const typed = (value: string | undefined) => (value?.trim() ? parseAmount(value) : null);
const toKnown = (input: KnownInput): Known => ({ at: input.at, cash: typed(input.cash), shares: Object.fromEntries(Object.entries(input.shares).map(([id, value]) => [id, typed(value)])) });

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** `checkDelay`: how long changes settle before they're checked (tests check straight away). */
export function Import({ checkDelay = CHECK_DELAY_MS }: { checkDelay?: number }) {
  const queryClient = useQueryClient();
  const { me, currency: shown } = useAuth();
  const accounts = useAccounts();
  const [read, setRead] = useState<ReadFiles | null>(null);
  const [mapping, setMapping] = useState<BalanceMapping>(DEFAULT_MAPPING);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  // Tickers typed for securities the files name without one (by the file's id for it).
  const [tickers, setTickers] = useState<Record<string, string>>({});
  // Known balances typed for files of transactions with none (by the account's place in the files).
  const [knowns, setKnowns] = useState<Record<number, KnownInput>>({});
  const [fileKey, setFileKey] = useState(0);
  const visible = (accounts.data?.accounts ?? []).filter((candidate) => !candidate.isHidden);

  /** The account you have with the same last digits, when it can take the file. */
  const matchOf = (account: FileAccount) => (account.number ? visible.find((candidate) => candidate.mask && last4(candidate.mask) === last4(account.number) && fits(candidate, account)) : undefined);

  async function loadFiles(files: File[]) {
    setFileError(null);
    setRead(null);
    setKnowns({});
    commit.reset();
    try {
      const result = readFiles(await Promise.all(files.map((file) => file.text())), files.map((file) => file.name));
      setRead(result);
      if (result.kind === 'table') {
        setMapping(result.guess ?? { ...DEFAULT_MAPPING, balanceColumn: Math.max(0, (result.rows[0]?.length ?? 1) - 1) });
        setChoices([{ to: 'choose' }]);
      } else {
        setChoices(
          result.accounts.map((account) => {
            const match = matchOf(account);
            return match ? { to: 'account', accountId: match.id } : { to: 'choose' };
          }),
        );
      }
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    }
  }

  // The accounts in the files; a CSV of balances is one, from its chosen columns.
  const preview = read?.kind === 'table' ? extractBalances(read.rows, mapping) : null;
  const fileAccounts: FileAccount[] =
    read?.kind === 'accounts' ? read.accounts : preview ? [{ number: null, institution: null, unknownTypes: [], file: { kind: 'balances', rows: preview.rows } }] : [];
  // Files you've said are the same account join the one they name (null for those joining another).
  const combined = fileAccounts.map((account, index): { account: FileAccount; error: string | null } | null => {
    if (choices[index]?.to === 'with') return null;
    const members = fileAccounts.filter((_, at) => at === index || (choices[at]?.to === 'with' && (choices[at] as { index: number }).index === index));
    try {
      return { account: combineAccounts(members), error: null };
    } catch (error) {
      return { account, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Files of transactions are worked out once their known balance is given (null until then).
  const resolved = combined.map((entry, index) => (entry ? withKnown(entry.account, knowns[index] && toKnown(knowns[index])) : null));
  /** The other files an account with no number may be combined with: ones of the same kind not already joining another. */
  const partnersOf = (index: number) =>
    fileAccounts.flatMap((other, at) => (at !== index && !fileAccounts[index].number && !other.number && other.file.kind === fileAccounts[index].file.kind && choices[at]?.to !== 'with' ? [{ index: at, label: labelOf(other) }] : []));

  function defaultNew(account: FileAccount): Choice {
    const currency = isCurrency(account.file.currency) ? account.file.currency : shown;
    const type: AccountType = account.file.kind === 'holdings' ? 'investment' : (account.type ?? 'depository');
    // Shown with its institution and last digits, so its name says what it is ("Checking"), or else what the file's called.
    const name = account.subtype ? accountKind(type, account.subtype) : account.institution ? accountKind(type, null) : (account.fileName?.replace(/\.[^.]+$/, '') ?? 'Imported account');
    // Yours, as a manual account you add is (change it later with Edit account).
    return { to: 'new', name, institutionName: account.institution ?? '', type, subtype: account.subtype ?? '', currency, ownerUserId: me?.user.id ?? null };
  }
  function choose(index: number, choice: Choice) {
    setChoices(choices.map((current, at) => (at === index ? choice : current)));
  }

  // What stops each account going in (errors), and what's worth knowing (warnings), before the server checks.
  const chosenIds = choices.flatMap((choice) => (choice.to === 'account' ? [choice.accountId] : []));
  const checks = fileAccounts.map((read, index) => {
    let account = read;
    const choice = choices[index] ?? { to: 'choose' };
    const errors: string[] = [];
    const warnings: string[] = [];
    if (choice.to === 'skip') return { errors, warnings };
    if (choice.to === 'with') {
      const root = choices[choice.index];
      if (!root || root.to === 'choose' || root.to === 'skip' || root.to === 'with') errors.push(`Choose where ${labelOf(fileAccounts[choice.index])} goes.`);
      return { errors, warnings };
    }
    const entry = combined[index]!;
    account = entry.account;
    if (entry.error) errors.push(entry.error);
    const worked = resolved[index];
    if (!worked && !entry.error) errors.push(`Give the ${account.unanchored?.kind === 'holdings' ? 'holdings' : 'balance'} known at the start or end of the file.`);
    if (!account.unanchored && account.file.kind === 'holdings' && account.file.transactions.length === 0)
      errors.push('This file has holdings but no transactions to work back through: choose "Same account as" its file of transactions, or skip it.');
    if (account.unknownTypes.length > 0) errors.push(`Wattle doesn't understand these transaction types yet: ${account.unknownTypes.join(', ')}. Skip this account.`);
    if (worked?.file.kind === 'balances' && worked.file.rows.length === 0) errors.push('There are no balances to import.');
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
  const nameOf = (id: string | null) => {
    if (!id) return null;
    const security = fileAccounts.flatMap((account) => (account.file.kind === 'holdings' ? account.file.securities : [])).find((candidate) => candidate.id === id);
    return holdingLabel({ ticker: security?.ticker ?? (tickerFor(id) || null), name: security?.name, cusip: id }, 'short');
  };
  const locallyReady =
    fileAccounts.length > 0 && choices.every((choice) => choice.to !== 'choose') && checks.every((check) => check.errors.length === 0) && choices.some((choice) => choice.to !== 'skip') && badTickers.length === 0;

  // The accounts placed so far (somewhere to go, nothing missing): checked as they settle, before the rest are; imported once every account is.
  const placed = fileAccounts.flatMap((read, index) => {
    const choice = choices[index];
    const account = resolved[index];
    if (!account || !choice || choice.to === 'choose' || choice.to === 'skip' || choice.to === 'with' || checks[index]?.errors.length) return [];
    const target =
      choice.to === 'account'
        ? { accountId: choice.accountId }
        : { new: { name: choice.name.trim(), type: choice.type, subtype: choice.subtype || null, currency: choice.currency, institutionName: choice.institutionName.trim() || null, mask: last4(read.number), ownerUserId: choice.ownerUserId } };
    const file = account.file.kind === 'holdings' ? { ...account.file, securities: account.file.securities.map((security) => (security.ticker ? security : { ...security, ticker: tickerFor(security.id) || null })) } : account.file;
    return [{ label: labelOf(read), target, file }];
  });
  const request: ImportRequest | null = placed.length > 0 && badTickers.length === 0 ? { accounts: placed } : null;
  const body = request ? JSON.stringify(request) : null;
  const settled = useDebounced(body, checkDelay);
  const check = useQuery({
    queryKey: ['import-check', settled],
    queryFn: () => api<ImportCheck>('/api/imports/check', { method: 'POST', body: settled! }),
    enabled: settled !== null && settled === body,
    staleTime: Infinity,
    gcTime: 0,
  });
  const checked = settled === body && check.data !== undefined && !check.isFetching;
  const problems = checked ? check.data!.problems : [];

  const commit = useMutation({
    mutationFn: () => api<ImportResponse>('/api/imports', { method: 'POST', body: body! }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  // Starting again: the next files afresh.
  function reset() {
    setRead(null);
    setChoices([]);
    setTickers({});
    setKnowns({});
    setMapping(DEFAULT_MAPPING);
    setFileError(null);
    setFileKey((key) => key + 1);
    commit.reset();
  }

  if (commit.data) return <Imported result={commit.data} accounts={visible} onMore={reset} />;

  const header = read?.kind === 'table' ? (read.rows[0] ?? []) : [];
  const columnOptions = header.map((cell, index) => (
    <option key={index} value={index}>
      {mapping.hasHeader ? cell || `Column ${index + 1}` : `Column ${index + 1} (${cell})`}
    </option>
  ));
  const status = !request
    ? fileAccounts.length === 0
      ? null
      : 'Choose where each account goes and fill in what’s missing.'
    : !locallyReady && checked && problems.length === 0
      ? 'Checked so far. Choose where each account goes and fill in what’s missing.'
      : !checked
      ? check.error && settled === body
        ? null
        : 'Checking…'
      : problems.length > 0
        ? `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} to fix before importing.`
        : `Checked: ${check.data!.accounts.length} ${check.data!.accounts.length === 1 ? 'account' : 'accounts'} ready to import.`;

  return (
    <>
      <PageHeader
        title="Import history"
        description="Quicken (QFX/OFX) files from investment, bank or card accounts, or CSVs of balances or transactions. Nothing is written until you import."
        actions={
          <Button variant="outline" asChild>
            <Link to="/accounts">
              <ArrowLeft /> Accounts
            </Link>
          </Button>
        }
      />
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>
              Choose one or more at a time. Each account in them gets its own section below, matched to one of yours by its last digits. A CSV of transactions has no balance in it: you give one, at its start or end, and every day is worked out from there.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field label="Files">
              <Input key={fileKey} type="file" multiple accept=".csv,text/csv,.qfx,.ofx" onChange={(event) => event.target.files?.length && void loadFiles([...event.target.files])} />
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
          </CardContent>
        </Card>

        {untickered.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Securities without a ticker</CardTitle>
              <CardDescription>
                Each is valued at its ticker's close every day. Tickers found by name are filled in for you; change any, or leave one blank for a fund with no market price (a plan's own funds), valued from the file's prices on a straight line between them.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {untickered.map((security) => {
                const suggestion = suggested(security.id);
                const value = tickers[security.id] ?? suggestion?.ticker ?? '';
                return (
                  <div key={security.id} className="grid items-center gap-2 sm:grid-cols-[1fr_8rem]">
                    <div className="min-w-0">
                      <p className="truncate">{security.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {security.id}
                        {suggestion &&
                          value.trim().toUpperCase() === suggestion.ticker &&
                          (suggestion.from === 'yours' ? ' · the same name as one of your securities' : suggestion.exact ? ' · found by its name' : ' · a similar name: check it')}
                      </p>
                    </div>
                    <Input aria-label={`Ticker for ${security.name}`} value={value} placeholder={suggestions.isLoading ? 'Looking…' : 'None'} onChange={(event) => setTickers({ ...tickers, [security.id]: event.target.value })} />
                  </div>
                );
              })}
              {badTickers.length > 0 && <Alert variant="error">That isn't a ticker: {badTickers.map((security) => tickerFor(security.id)).join(', ')}.</Alert>}
            </CardContent>
          </Card>
        )}

        {fileAccounts.map((account, index) => (
          <AccountSection
            key={account.number ?? account.fileName ?? `file:${index}`}
            read={combined[index]?.account ?? account}
            account={resolved[index] ?? combined[index]?.account ?? account}
            partners={partnersOf(index)}
            choice={choices[index] ?? { to: 'choose' }}
            accounts={visible.filter((candidate) => fits(candidate, account))}
            onChoose={(choice) => choose(index, choice.to === 'new' && choices[index]?.to !== 'new' ? defaultNew(account) : choice)}
            known={knowns[index] ?? NO_KNOWN}
            onKnown={(known) => setKnowns({ ...knowns, [index]: known })}
            check={checks[index]}
            problems={problems.filter((found) => found.label === labelOf(account))}
            closes={checked ? (check.data!.accounts.find((found) => found.label === labelOf(account))?.closes ?? []) : []}
            nameOf={nameOf}
            skipped={preview?.skipped ?? 0}
            shown={shown}
          />
        ))}

        {fileAccounts.length > 0 && (
          <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
            <p className={cn('text-sm', problems.length > 0 ? 'text-negative' : 'text-muted-foreground')} role="status">
              {status}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={reset}>
                Start again
              </Button>
              <Button onClick={() => commit.mutate()} disabled={!locallyReady || !checked || problems.length > 0 || commit.isPending}>
                {commit.isPending ? 'Importing…' : 'Import'}
              </Button>
            </div>
            {check.error && settled === body && (
              <div className="w-full">
                <Alert variant="error">{check.error.message}</Alert>
              </div>
            )}
            {commit.error && (
              <div className="w-full">
                <Alert variant="error">{commit.error.message}</Alert>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** One account in the files: where it goes, what it's worked out from, and every row it writes. */
function AccountSection({
  read,
  account,
  partners,
  choice,
  accounts,
  onChoose,
  known,
  onKnown,
  check,
  problems,
  closes,
  nameOf,
  skipped,
  shown,
}: {
  read: FileAccount;
  account: FileAccount;
  partners: { index: number; label: string }[];
  choice: Choice;
  accounts: AccountSummary[];
  onChoose: (choice: Choice) => void;
  known: KnownInput;
  onKnown: (known: KnownInput) => void;
  check: { errors: string[]; warnings: string[] };
  problems: ImportProblem[];
  closes: ImportCheck['accounts'][number]['closes'];
  nameOf: (id: string | null) => string | null;
  skipped: number;
  shown: Currency;
}) {
  const file = account.file;
  const worked = read.unanchored ? account !== read : true;
  const value = choice.to === 'account' ? choice.accountId : choice.to === 'with' ? `with:${choice.index}` : choice.to;
  const joined = choice.to === 'with';
  const target = choice.to === 'account' ? accounts.find((candidate) => candidate.id === choice.accountId) : undefined;
  const currency = target?.currency ?? (choice.to === 'new' ? choice.currency : isCurrency(file.currency) ? file.currency : shown);
  const label = labelOf(read);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <CardTitle>
            {read.number ? `Account ${label}` : (read.fileName ?? 'Balances')}
            {read.institution && <span className="font-normal text-muted-foreground"> · {read.institution}</span>}
          </CardTitle>
          {choice.to === 'skip' ? <Badge variant="outline">Skipped</Badge> : problems.length > 0 && <Badge variant="danger">{problems.length === 1 ? '1 problem' : `${problems.length} problems`}</Badge>}
        </div>
        <CardDescription>{summary(file, currency, skipped, worked ? undefined : read.unanchored?.transactions)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Import into">
            <NativeSelect
              aria-label={`Import ${label} into`}
              value={value}
              onChange={(event) => {
                const next = event.target.value;
                onChoose(
                  next === 'skip' || next === 'choose'
                    ? { to: next }
                    : next === 'new'
                      ? { to: 'new', name: '', institutionName: '', type: 'investment', subtype: '', currency, ownerUserId: null }
                      : next.startsWith('with:')
                        ? { to: 'with', index: Number(next.slice(5)) }
                        : { to: 'account', accountId: next },
                );
              }}
            >
              <option value="choose">Choose…</option>
              {accounts.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {accountLabel(candidate)}
                </option>
              ))}
              <option value="new">New account</option>
              {partners.map((partner) => (
                <option key={partner.index} value={`with:${partner.index}`}>
                  Same account as {partner.label}
                </option>
              ))}
              <option value="skip">Skip</option>
            </NativeSelect>
          </Field>
          {choice.to === 'new' && (
            <>
              <Field label="New account's name">
                <Input value={choice.name} onChange={(event) => onChoose({ ...choice, name: event.target.value })} />
              </Field>
              {/* As the file names it, to correct (some files give a code rather than a name). */}
              <Field label="Institution">
                <Input value={choice.institutionName} placeholder="None" onChange={(event) => onChoose({ ...choice, institutionName: event.target.value })} />
              </Field>
              {file.kind === 'balances' && (
                <Field label="Type">
                  <NativeSelect value={choice.type} onChange={(event) => onChoose({ ...choice, type: event.target.value as AccountType, subtype: '' })}>
                    {ACCOUNT_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              <SubtypeSelect type={choice.type} value={choice.subtype} onChange={(subtype) => onChoose({ ...choice, subtype })} />
              <Field label="Currency">
                <NativeSelect value={choice.currency} onChange={(event) => onChoose({ ...choice, currency: event.target.value as Currency })}>
                  {CURRENCIES.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </NativeSelect>
              </Field>
            </>
          )}
        </div>
        {joined && <p className="text-muted-foreground">Imported together with that file, where it goes; its preview shows them both.</p>}
        {read.unanchored && choice.to !== 'skip' && !joined && <KnownFields pending={read.unanchored} known={known} onKnown={onKnown} />}
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
        {problems.map((found) => (
          <Alert key={`${found.date}:${found.text}`} variant="error">
            {found.text.charAt(0).toUpperCase() + found.text.slice(1)}.
          </Alert>
        ))}
        {choice.to !== 'skip' && !joined && worked && <PreviewTable file={file} currency={currency} problemDates={new Set(problems.flatMap((found) => (found.date ? [found.date] : [])))} closes={closes} nameOf={nameOf} />}
      </CardContent>
    </Card>
  );
}

/** Every row the import writes, newest first: transactions with the cash and shares after each, or balances. */
function PreviewTable({
  file,
  currency,
  problemDates,
  closes,
  nameOf,
}: {
  file: FileAccount['file'];
  currency: Currency;
  problemDates: Set<string>;
  closes: ImportCheck['accounts'][number]['closes'];
  nameOf: (id: string | null) => string | null;
}) {
  const rows = previewRows(file);
  if (rows.length === 0) return null;
  const holdings = file.kind === 'holdings';
  // An account holding and moving no cash (a 401(k)): no cash columns.
  const cash = !holdings || rows.some((row) => row.amount !== 0 || row.balance !== 0);
  const closeOf = (date: string, security: string | null) => closes.find((found) => found.date === date && found.security === security)?.close;
  return (
    <div className="max-h-[28rem] overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b">
            <Th>Date</Th>
            {holdings && <Th>Transaction</Th>}
            {holdings && <Th>Security</Th>}
            {holdings && <Th className="text-right">Shares</Th>}
            {holdings && <Th className="text-right">Price</Th>}
            {holdings && <Th className="text-right">Close</Th>}
            {cash && <Th className="text-right">{holdings ? 'Cash in / out' : 'Change'}</Th>}
            {cash && <Th className="text-right">{holdings ? 'Cash after' : 'Balance'}</Th>}
            {holdings && <Th className="text-right">Shares after</Th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, index) => {
            const close = holdings ? closeOf(row.date, row.security) : undefined;
            return (
              <tr key={index} className={cn(problemDates.has(row.date) && 'bg-negative/10')}>
                <Td className="whitespace-nowrap">{longDate(row.date)}</Td>
                {holdings && (
                  <Td>
                    {row.label}
                    {row.description && <span className="block text-xs text-muted-foreground">{row.description}</span>}
                  </Td>
                )}
                {holdings && <Td>{nameOf(row.security) ?? '—'}</Td>}
                {holdings && <Td className="text-right tabular-nums">{row.shares ? quantity(row.shares) : ''}</Td>}
                {holdings && <Td className="text-right tabular-nums">{row.price ? row.price.toFixed(2) : ''}</Td>}
                {holdings && <Td className="text-right tabular-nums text-muted-foreground">{close ? close.toFixed(2) : ''}</Td>}
                {cash && <Td className="text-right tabular-nums">{row.amount ? money(row.amount, currency) : ''}</Td>}
                {/* Cash below zero is owed for a moment (bought before the money arrived), not a problem. */}
                {cash && <Td className={cn('text-right tabular-nums', row.balance < 0 && holdings && 'text-muted-foreground')}>{money(row.balance, currency)}</Td>}
                {holdings && <Td className={cn('text-right tabular-nums', row.held !== null && row.held < -1e-6 && 'text-negative')}>{row.held === null ? '' : quantity(row.held)}</Td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A file of transactions has no balance in it: one known at its start or end
 * (cash, and each security's shares) works out every day.
 */
function KnownFields({ pending, known, onKnown }: { pending: NonNullable<FileAccount['unanchored']>; known: KnownInput; onKnown: (known: KnownInput) => void }) {
  const first = pending.transactions[0]?.date;
  const last = pending.transactions.at(-1)?.date;
  if (!first || !last) return null;
  const holdings = pending.kind === 'holdings';
  return (
    <div className="grid gap-2 rounded-md bg-muted/40 p-3">
      <p className="text-muted-foreground">
        The file has transactions but no {holdings ? 'holdings' : 'balance'}: give {holdings ? 'what the account held' : 'its balance'} before the first or after the last, and every day is worked out from the transactions.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Known">
          <NativeSelect value={known.at} onChange={(event) => onKnown({ ...known, at: event.target.value as KnownInput['at'] })}>
            <option value="end">After the last transaction ({longDate(last)})</option>
            <option value="start">Before the first transaction ({longDate(first)})</option>
          </NativeSelect>
        </Field>
        {(!holdings || pending.moneyMoves) && (
          <Field label={holdings ? 'Cash' : 'Balance'}>
            <Input inputMode="decimal" value={known.cash} onChange={(event) => onKnown({ ...known, cash: event.target.value })} />
          </Field>
        )}
        {holdings &&
          pending.securities.map((security) => (
            <Field key={security.id} label={`Shares of ${security.name}`}>
              <Input inputMode="decimal" value={known.shares[security.id] ?? ''} onChange={(event) => onKnown({ ...known, shares: { ...known.shares, [security.id]: event.target.value } })} />
            </Field>
          ))}
      </div>
    </div>
  );
}

/** After importing: each account, its history appearing as it's written. */
function Imported({ result, accounts, onMore }: { result: ImportResponse; accounts: AccountSummary[]; onMore: () => void }) {
  return (
    <>
      <PageHeader title="Import history" />
      <Card>
        <CardHeader>
          <CardTitle>Imported</CardTitle>
          <CardDescription>Holdings history is written in the background, a minute or so for a few years; it's safe to leave this page.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <ul className="divide-y rounded-md border">
            {result.accounts.map((entry) => {
              const account = accounts.find((candidate) => candidate.id === entry.accountId);
              const progress = account?.importProgress;
              return (
                <li key={entry.accountId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>
                    <span className="font-medium">{account?.name ?? entry.label}</span>
                    {entry.created && <span className="text-muted-foreground"> · new</span>}
                    <span className="text-muted-foreground">
                      {' '}
                      · {entry.days} days, {longDate(entry.from)} – {longDate(entry.to)}
                    </span>
                  </span>
                  {progress ? <Badge variant="outline">Writing… {progress.done} of {progress.total}</Badge> : <Badge>Done</Badge>}
                  {entry.estimated.length > 0 && <span className="w-full text-xs text-muted-foreground">Priced from the file for now (closes couldn't be fetched): {entry.estimated.join(', ')}. They're priced at each day's close overnight.</span>}
                </li>
              );
            })}
          </ul>
          <div className="flex gap-2">
            <Button onClick={onMore}>Import more files</Button>
            <Button variant="outline" asChild>
              <Link to="/accounts">Accounts</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/** What an account in the files holds, in a line. */
function summary(file: FileAccount['file'], currency: Currency, skipped: number, pending?: { date: string }[]): string {
  if (pending) {
    if (pending.length === 0) return 'No transactions';
    return `${pending.length} ${pending.length === 1 ? 'transaction' : 'transactions'} · ${longDate(pending[0].date)} – ${longDate(pending.at(-1)!.date)}`;
  }
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

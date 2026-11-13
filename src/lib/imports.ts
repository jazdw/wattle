/**
 * Every import starts here: each file is recognised from its content and
 * read into the accounts it holds, in one shape whatever the format
 * (shared/schemas.ts importSchema), then accounts with the same number
 * across files are merged. Quicken downloads (QFX/OFX) hold investment,
 * bank and card accounts; a CSV is dates and balances, or transactions
 * worked out from a balance you give (./csv, ./known).
 */
import { addDays, type IsoDate } from '../../shared/dates';
import { longDate } from './format';
import type { ImportedBalances, ImportedFile, ImportedHoldings } from '../../shared/schemas';
import type { AccountType } from '../../shared/types';
import type { Unanchored } from './known';
import { csvAccounts, guessMapping, parseCsv, transactionsKind, type BalanceMapping } from './csv';
import { isOfx, ofxAccounts } from './ofx';

/** A transaction as read, with the institution's id for it and its description when the file has them (for the page; the server doesn't need them). */
export type ReadTransaction = ImportedHoldings['transactions'][number];
/** A bank or card account's transaction, as a balances file carries it. */
export type CashTransaction = NonNullable<ImportedBalances['transactions']>[number];

/** A bank or card statement's own figures (./ofx), kept to work it out with others of its account. */
export interface Statement {
  /** Its balance (cents, as the file signs it: a card's owed is below zero) and when that's from. */
  closing: number;
  asOf: IsoDate;
  /** The moment the balance is from (an ISO instant), for saying when, in your time zone. */
  at: string | null;
  /** The days its transactions cover, as it says (DTSTART, DTEND). */
  start: IsoDate | null;
  end: IsoDate | null;
  owed: boolean;
  transactions: ReadTransaction[];
  /** Each file it came from, for the import page to show (one, until several of an account are combined). */
  files: StatementFile[];
}

/** One file's statement of an account, as the import page shows it. */
export interface StatementFile {
  name: string | null;
  from: IsoDate;
  to: IsoDate;
  count: number;
  /** Cents, as the file signs it. */
  balance: number;
  asOf: IsoDate;
  at: string | null;
}

/**
 * Whether a statement's balance is its balance where its transactions end: dated
 * their last day or the next (banks end the list on the day of the download or
 * the day before). Any later, days in between could hold transactions it doesn't
 * have, so it isn't used.
 */
export const balanceAtEnd = (asOf: IsoDate, end: IsoDate) => asOf <= addDays(end, 1);

/** One account in the files. */
export interface FileAccount {
  /** The account number as the file has it; null for a file with one account and no number. */
  number: string | null;
  institution: string | null;
  /** The file's name, for an account it doesn't number. */
  fileName?: string;
  /** What kind of account the file says it is (a bank or card statement), for a new one. */
  type?: AccountType;
  /** Its kind within that, when the file says (shared/accounts.ts: checking, savings…). */
  subtype?: string;
  file: ImportedFile;
  /**
   * A bank or card statement's own figures, so several of one account are
   * worked out together (combineAccounts): its closing balance (cents, as the
   * file signs it) and the day it's as of, the days its transactions cover,
   * and those transactions as read.
   */
  statement?: Statement;
  /** Transactions with no balance in the file: the file is worked out once one is known (./known). */
  unanchored?: Unanchored;
  /** Transaction types the reader doesn't understand: the account can't be imported until they are. */
  unknownTypes: string[];
}

export type ReadFiles =
  | { kind: 'accounts'; accounts: FileAccount[] }
  /** A CSV of dates and balances: its columns found from its header when it names them (else chosen by hand). */
  | { kind: 'table'; rows: string[][]; guess: BalanceMapping | null };

/** Read the chosen files (named for accounts a file doesn't number). Throws, saying why, when one can't be read. */
export function readFiles(contents: string[], names: string[] = []): ReadFiles {
  const perFile: FileAccount[][] = [];
  for (const [index, content] of contents.entries()) {
    if (isOfx(content)) {
      const accounts = ofxAccounts(content);
      if (accounts.length === 0) throw new Error('A Quicken file has no accounts in it.');
      // Each statement's file, by name, for the import page.
      perFile.push(accounts.map((account) => (account.statement ? { ...account, statement: { ...account.statement, files: account.statement.files.map((file) => ({ ...file, name: names[index] ?? null })) } } : account)));
      continue;
    }
    // Investment transactions; else a balance per row (its columns checked by hand); else cash transactions.
    const rows = parseCsv(content);
    const kind = transactionsKind(content);
    const guess = guessMapping(rows);
    if (kind === 'holdings' || (kind === 'cash' && !guess)) {
      perFile.push(csvAccounts(content)!.map((account) => ({ ...account, fileName: names[index] })));
      continue;
    }
    if (contents.length > 1) throw new Error('A CSV of dates and balances is imported on its own.');
    return { kind: 'table', rows, guess };
  }
  return { kind: 'accounts', accounts: mergeAccounts(perFile) };
}

/** The last four characters of an account number, as Wattle keeps them (an account's mask). */
export const last4 = (number: string | null) => number?.slice(-4) ?? null;

/**
 * Accounts with the same number in several files as one: overlapping
 * downloads count each transaction once (by the institution's id, else by
 * its details, keeping as many as the file with the most has, so two
 * identical buys on one day both stay); positions and cash from the most
 * recent file; balances by date, the later file's winning.
 */
export function mergeAccounts(perFile: FileAccount[][]): FileAccount[] {
  const merged = new Map<string, FileAccount[]>();
  const order: string[] = [];
  perFile.forEach((accounts, fileIndex) =>
    accounts.forEach((account, index) => {
      const key = account.number ?? `file:${fileIndex}:${index}`;
      if (!merged.has(key)) order.push(key);
      merged.set(key, [...(merged.get(key) ?? []), account]);
    }),
  );
  return order.map((key) => combineAccounts(merged.get(key)!));
}

/** Transactions in several files as one: by the institution's id, else by their details, as many as the file with the most has. */
function mergeTransactions<T extends { id?: string; date: string; label: string; amount: number; security?: string | null; shares?: number }>(lists: T[][]): T[] {
  const keep = new Map<string, T[]>();
  for (const list of lists) {
    const here = new Map<string, T[]>();
    for (const txn of list) {
      const key = txn.id ? `id:${txn.id}` : [txn.date, txn.label, txn.security, txn.shares, txn.amount].join('|');
      here.set(key, [...(here.get(key) ?? []), txn]);
    }
    for (const [key, found] of here) if (found.length > (keep.get(key)?.length ?? 0)) keep.set(key, found);
  }
  return [...keep.values()].flat().sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * One account's bank or card statements (one or several) as one: their
 * transactions together, each once, the days they cover, and their newest
 * balance, for the import page's starting and ending balance (./known), each
 * filled in from the best there is and either one changeable. A statement's
 * balance is the account's when it was downloaded, whatever days it covers,
 * so it's only the ending balance when it's dated where the transactions end
 * (balanceAtEnd). Statements that leave out days between them are refused:
 * the transactions then are missing.
 */
function settleStatements(copies: FileAccount[], name: string): FileAccount {
  const statements = copies.map((copy) => copy.statement!);
  const newest = statements.reduce((best, statement) => (statement.asOf > best.asOf ? statement : best));
  const covered = statements
    .map((statement) => ({ from: statement.start ?? statement.transactions[0]?.date ?? statement.asOf, to: statement.end ?? statement.transactions.at(-1)?.date ?? statement.asOf }))
    .sort((a, b) => a.from.localeCompare(b.from));
  let reach = covered[0].to;
  for (const span of covered.slice(1)) {
    if (span.from > addDays(reach, 1)) throw new Error(`${name}: the files leave out ${longDate(addDays(reach, 1))} to ${longDate(addDays(span.from, -1))}, so its balance before then can't be worked out. Add the file for those days, or leave out the older files.`);
    if (span.to > reach) reach = span.to;
  }
  const transactions = mergeTransactions(statements.map((statement) => statement.transactions));
  const last = transactions.at(-1)?.date;
  const end = last && last > reach ? last : reach;
  const [shared] = copies;
  // By the days their transactions cover, whatever order they were chosen in.
  const files = statements.flatMap((statement) => statement.files).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  // Kept as one statement, so files joined to it later are worked out with it again.
  const statement: Statement = { closing: newest.closing, asOf: newest.asOf, at: newest.at, start: covered[0].from, end, owed: newest.owed, transactions, files };
  const atEnd = balanceAtEnd(newest.asOf, end);
  return {
    ...shared,
    institution: copies.find((copy) => copy.institution)?.institution ?? null,
    unknownTypes: [...new Set(copies.flatMap((copy) => copy.unknownTypes))],
    statement,
    file: { kind: 'balances', currency: shared.file.currency, rows: [] },
    unanchored: {
      kind: 'cash',
      transactions,
      owed: newest.owed,
      from: covered[0].from,
      // A balance dated the day after the transactions end is that day's.
      to: atEnd && newest.asOf > end ? newest.asOf : end,
      fileBalance: { amount: (newest.owed ? -newest.closing : newest.closing) / 100 || 0, asOf: newest.asOf, at: newest.at, atEnd },
    },
  };
}

/**
 * One account read from several files (the same number, or files you said
 * are the same account) as one. Holdings come from the latest file that has
 * them; with none, it still needs a balance known (./known). A Quicken file
 * and a CSV of the same account can't be combined: their transactions can't
 * be matched to count each once.
 */
export function combineAccounts(copies: FileAccount[]): FileAccount {
  const [first] = copies;
  const name = first.number ? `··${last4(first.number)}` : (first.fileName ?? 'the account');
  if (copies.every((copy) => copy.statement)) return settleStatements(copies, name);
  if (copies.length === 1) return first;
  const unknownTypes = [...new Set(copies.flatMap((copy) => copy.unknownTypes))];
  if (copies.some((copy) => copy.file.kind !== first.file.kind)) throw new Error(`The files read ${name} in different ways.`);
  const shared = { number: first.number, fileName: first.fileName, institution: copies.find((copy) => copy.institution)?.institution ?? null, type: copies.find((copy) => copy.type)?.type, subtype: copies.find((copy) => copy.subtype)?.subtype, unknownTypes };
  const withIds = copies.filter((copy) => (copy.unanchored?.transactions ?? (copy.file.kind === 'holdings' ? copy.file.transactions : [])).some((txn: ReadTransaction) => txn.id));
  if (withIds.length > 0 && withIds.length < copies.length && copies.some((copy) => copy.fileName)) throw new Error(`${name} is in a Quicken file and a CSV: import it from one of them, or its transactions would count twice.`);
  if (first.file.kind === 'balances') {
    const pending = copies.flatMap((copy) => (copy.unanchored?.kind === 'cash' ? [copy.unanchored.transactions] : []));
    if (pending.length === copies.length) return { ...shared, file: { kind: 'balances', rows: [] }, unanchored: { kind: 'cash', transactions: mergeTransactions(pending) } };
    if (pending.length > 0) throw new Error(`${name}: a file of balances and a file of transactions can't be combined.`);
    const balances = copies.map((copy) => copy.file as ImportedBalances);
    const byDate = new Map(balances.flatMap((file) => file.rows).map((row) => [row.date, row.balance]));
    const transactions = balances.some((file) => file.transactions) ? mergeTransactions(balances.map((file) => file.transactions ?? [])) : undefined;
    return {
      ...shared,
      file: { kind: 'balances', currency: first.file.currency, rows: [...byDate].map(([date, balance]) => ({ date, balance })).sort((a, b) => a.date.localeCompare(b.date)), ...(transactions ? { transactions } : {}) },
    };
  }
  const files = copies.map((copy) => copy.file as ImportedHoldings);
  if (new Set(files.map((file) => file.currency ?? '')).size > 1) throw new Error(`The files for ${name} are in different currencies.`);
  const transactions = mergeTransactions(files.map((file) => file.transactions as ReadTransaction[]));
  const securities = [...new Map(files.flatMap((file) => file.securities).map((security) => [security.id, security])).values()];
  const asOf = files.map((file) => file.asOf).sort().at(-1)!;
  // Holdings: from the latest file that has them (not one of transactions only).
  const known = copies.filter((copy) => !copy.unanchored).map((copy) => copy.file as ImportedHoldings);
  if (known.length === 0) {
    const moneyMoves = copies.some((copy) => copy.unanchored?.kind === 'holdings' && copy.unanchored.moneyMoves);
    return { ...shared, file: { kind: 'holdings', currency: first.file.currency, asOf, securities, positions: [], cash: 0, transactions }, unanchored: { kind: 'holdings', securities, transactions, moneyMoves } };
  }
  const latest = known.reduce((best, file) => (file.asOf > best.asOf ? file : best));
  return { ...shared, file: { ...latest, asOf, securities, transactions } };
}

/** What an account in the files holds now, in cents (positions at the file's prices, and cash). */
export function fileValue(file: ImportedHoldings): number {
  return file.cash + file.positions.reduce((sum, row) => sum + Math.round(row.shares * (row.price ?? 0) * 100), 0);
}

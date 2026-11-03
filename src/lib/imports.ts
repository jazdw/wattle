/**
 * Every import starts here: each file is recognised from its content and
 * read into the accounts it holds, in one shape whatever the format
 * (shared/schemas.ts importSchema), then accounts with the same number
 * across files are merged. Quicken downloads (QFX/OFX) hold investment,
 * bank and card accounts; a CSV is dates and balances (./csv).
 */
import type { ImportedFile, ImportedHoldings } from '../../shared/schemas';
import type { AccountType } from '../../shared/types';
import { guessMapping, parseCsv, type BalanceMapping } from './csv';
import { isOfx, ofxAccounts } from './ofx';

/** A transaction as read, with the institution's id for it when the file has one (the server doesn't need it). */
export type ReadTransaction = ImportedHoldings['transactions'][number] & { id?: string };

/** One account in the files. */
export interface FileAccount {
  /** The account number as the file has it; null for a file with one account and no number. */
  number: string | null;
  institution: string | null;
  /** What kind of account the file says it is (a bank or card statement), for a new one. */
  type?: AccountType;
  file: ImportedFile;
  /** Transaction types the reader doesn't understand: the account can't be imported until they are. */
  unknownTypes: string[];
}

export type ReadFiles =
  | { kind: 'accounts'; accounts: FileAccount[] }
  /** A CSV of dates and balances: its columns found from its header when it names them (else chosen by hand). */
  | { kind: 'table'; rows: string[][]; guess: BalanceMapping | null };

/** Read the chosen files. Throws, saying why, when one can't be read. */
export function readFiles(contents: string[]): ReadFiles {
  const perFile: FileAccount[][] = [];
  for (const content of contents) {
    if (isOfx(content)) {
      const accounts = ofxAccounts(content);
      if (accounts.length === 0) throw new Error('A Quicken file has no accounts in it.');
      perFile.push(accounts);
      continue;
    }
    if (contents.length > 1) throw new Error('A CSV of dates and balances is imported on its own.');
    const rows = parseCsv(content);
    return { kind: 'table', rows, guess: guessMapping(rows) };
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
  return order.map((key) => {
    const copies = merged.get(key)!;
    if (copies.length === 1) return copies[0];
    const [first] = copies;
    const unknownTypes = [...new Set(copies.flatMap((copy) => copy.unknownTypes))];
    if (copies.some((copy) => copy.file.kind !== first.file.kind)) throw new Error(`The files read account ··${last4(first.number)} in different ways.`);
    if (first.file.kind === 'balances') {
      const byDate = new Map(copies.flatMap((copy) => (copy.file.kind === 'balances' ? copy.file.rows : [])).map((row) => [row.date, row.balance]));
      return { ...first, unknownTypes, file: { kind: 'balances', currency: first.file.currency, rows: [...byDate].map(([date, balance]) => ({ date, balance })).sort((a, b) => a.date.localeCompare(b.date)) } };
    }
    const files = copies.map((copy) => copy.file as ImportedHoldings);
    if (new Set(files.map((file) => file.currency ?? '')).size > 1) throw new Error(`The files for account ··${last4(first.number)} are in different currencies.`);
    const latest = files.reduce((best, file) => (file.asOf > best.asOf ? file : best));
    const keep = new Map<string, ReadTransaction[]>();
    for (const file of files) {
      const here = new Map<string, ReadTransaction[]>();
      for (const txn of file.transactions as ReadTransaction[]) {
        const key = txn.id ? `id:${txn.id}` : [txn.date, txn.label, txn.security, txn.shares, txn.amount].join('|');
        here.set(key, [...(here.get(key) ?? []), txn]);
      }
      for (const [key, found] of here) if (found.length > (keep.get(key)?.length ?? 0)) keep.set(key, found);
    }
    const securities = new Map(files.flatMap((file) => file.securities).map((security) => [security.id, security]));
    return {
      number: first.number,
      institution: copies.find((copy) => copy.institution)?.institution ?? null,
      unknownTypes,
      file: {
        ...latest,
        securities: [...securities.values()],
        transactions: [...keep.values()].flat().sort((a, b) => a.date.localeCompare(b.date)),
      },
    };
  });
}

/** What an account in the files holds now, in cents (positions at the file's prices, and cash). */
export function fileValue(file: ImportedHoldings): number {
  return file.cash + file.positions.reduce((sum, row) => sum + Math.round(row.shares * (row.price ?? 0) * 100), 0);
}

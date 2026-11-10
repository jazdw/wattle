/**
 * Which transactions count where a file's and the institution's meet
 * (server/services/importedRecord.ts), and that everything reading them as
 * the account's record goes by it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { betterText, pairUp, sameTransaction } from '../server/services/importedRecord';

const row = (date: string, amount: number, securityId: string | null = null, quantity = 0) => ({ date, amount, securityId, quantity });

describe('the imported record', () => {
  it('matches the same amount, security and shares within five days', () => {
    expect(sameTransaction(row('2026-07-15', -5000, 'vti'), row('2026-07-17', -5000, 'vti'))).toBe(true);
    expect(sameTransaction(row('2026-07-15', 10000, 'vti', 1.5), row('2026-07-16', 10000, 'vti', 1.5004))).toBe(true);
    expect(sameTransaction(row('2026-07-15', 10000, 'vti', -1.5), row('2026-07-16', 10000, 'vti', 1.5))).toBe(true);
    expect(sameTransaction(row('2026-07-15', -5000, 'vti'), row('2026-07-21', -5000, 'vti'))).toBe(false);
    expect(sameTransaction(row('2026-07-15', -5000, 'vti'), row('2026-07-16', -5001, 'vti'))).toBe(false);
    expect(sameTransaction(row('2026-07-15', 10000, 'vti', 1), row('2026-07-16', 10000, 'vti', 2))).toBe(false);
    // Cash with no shares may name a holding on one side only; shares can't.
    expect(sameTransaction(row('2026-07-15', 25, null), row('2026-07-15', 25, 'adr'))).toBe(true);
    expect(sameTransaction(row('2026-07-15', -5000, 'vti'), row('2026-07-15', -5000, 'vxus'))).toBe(false);
    expect(sameTransaction(row('2026-07-15', 10000, null, 1), row('2026-07-15', 10000, 'vti', 1))).toBe(false);
  });

  it('pairs each of the institution\'s with one of the file\'s at most, the nearest', () => {
    const early = row('2026-07-13', 50000);
    const late = row('2026-07-15', 50000);
    const theirs = row('2026-07-16', 50000);
    expect([...pairUp([early, late], [theirs])]).toEqual([[theirs, late]]);
    expect(pairUp([early, late], [theirs, row('2026-07-17', 50000)]).size).toBe(2);
    expect(pairUp([early], [theirs, row('2026-07-17', 50000)]).size).toBe(1);
    // Two alike on a day: each to the one whose description agrees.
    const toSavings = { ...row('2026-07-15', 50000), description: 'Online transfer to savings ref' };
    const toBrokerage = { ...row('2026-07-15', 50000), description: 'Online transfer to brokerage' };
    const theirBrokerage = { ...row('2026-07-15', 50000), description: 'Online transfer to brokerage 1234567890' };
    const theirSavings = { ...row('2026-07-15', 50000), description: 'Online transfer to savings ref 9876543210' };
    expect([...pairUp([toSavings, toBrokerage], [theirBrokerage, theirSavings])]).toEqual([
      [theirBrokerage, toBrokerage],
      [theirSavings, toSavings],
    ]);
  });

  it("takes the institution's description when it has all of the file's text", () => {
    const theirs = (description: string | null) => ({ description });
    // A NAME cut at 32 characters, MEMO going on mid-word; the bank's text in one.
    expect(betterText({ description: 'Online Transfer 12345678901 to E', memo: 'xample savings ref 1234' }, theirs('Online Transfer 12345678901 to Example savings ref 1234'))).toEqual({ description: 'Online Transfer 12345678901 to Example savings ref 1234', memo: null });
    // NAME padded with spaces, split at a word.
    expect(betterText({ description: 'EXAMPLE CARD     AUTOPAY', memo: 'PPD ID: 1234' }, theirs('EXAMPLE CARD AUTOPAY PPD ID: 1234'))).toEqual({ description: 'EXAMPLE CARD AUTOPAY PPD ID: 1234', memo: null });
    // The file's cut short: the bank's goes on.
    expect(betterText({ description: 'Online transfer to example' }, theirs('Online transfer to example savings 1234567890'))?.description).toBe('Online transfer to example savings 1234567890');
    expect(betterText({ description: null }, theirs('Dividend'))?.description).toBe('Dividend');
    // Different text, or different case: the file's stays.
    expect(betterText({ description: 'Payroll' }, theirs('Direct deposit payroll'))).toBeNull();
    expect(betterText({ description: 'CHECK 110' }, theirs('CHECK # 110'))).toBeNull();
    expect(betterText({ description: 'PAYROLL' }, theirs('Payroll'))).toBeNull();
    expect(betterText({ description: 'Dividend' }, theirs(null))).toBeNull();
  });

  it("is what every reader of an account's transactions goes by", () => {
    // These read them for something else: the sync and the import (their own rows), the history rebuild (Plaid's), a kind you set (by id), and the pairing itself.
    const elsewhere = new Set(['server/routes/transactions.ts', 'server/services/backfill.ts', 'server/services/holdingsImport.ts', 'server/services/importedRecord.ts', 'server/services/sync.ts']);
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []));
    const readers = files('server').filter((file) => /\.from\((transactions|transactionsTable|schema\.transactions)\)/.test(readFileSync(file, 'utf8')) && !elsewhere.has(file));
    expect(readers.sort()).toEqual(['server/services/breakdown.ts', 'server/services/transactionList.ts', 'server/services/transfers.ts']);
    for (const file of readers) expect(readFileSync(file, 'utf8'), file).toContain('counted()');
  });
});

/**
 * Where each account's value came from, day by day: money in and out,
 * dividends and interest, fees, and what's left, which for an investment
 * account is market gain or loss. Read from its transactions' kinds
 * (shared/transactionKinds.ts), each day converted at that day's rate (so
 * exchange-rate moves land in market gain or loss).
 *
 * What can't be told goes in "not broken down" rather than market gain or
 * loss: days before an account's first known transaction, an account's
 * first and last days (its starting value isn't a gain), the change of an
 * account that isn't an investment (a bank's should come to nothing), and
 * transactions whose kind isn't known.
 *
 * An account holding no cash nets each day's purchases and sales: a switch
 * between its funds is neither money in nor out.
 *
 * For the household, transfers between its own accounts (`internal`) are
 * left out of money in and out: each account still counts its side, so
 * neither side's market gain or loss is touched.
 *
 * Start + money in − money out + dividends − fees + market + not broken
 * down = the end, exactly, in cents.
 */
import { and, desc, eq, gte, inArray, lte, min, ne } from 'drizzle-orm';
import { addDays, type IsoDate } from '../../shared/dates';
import { accountLabel } from '../../shared/accounts';
import { kindOf, type TransactionKind } from '../../shared/transactionKinds';
import type { BreakdownRow, HistorySeries } from '../../shared/types';
import { inChunks } from '../db/batch';
import { holdingDaily, pricesDaily, securities, transactions } from '../db/schema';
import type { Tenant } from '../db/tenant';
import { counted } from './importedRecord';
import { isCashSecurity } from './valuation';

/** Days either side of a split that a transfer of its shares is taken to be the split. */
const SPLIT_DAYS = 3;

export interface BreakdownAccount {
  id: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  type: string;
  currency: string;
}

export interface BreakdownInput {
  dates: IsoDate[];
  accounts: BreakdownAccount[];
  /** Each account's value per date, in the display currency, in cents (null: none that day). */
  values: Map<string, (number | null)[]>;
  convert: (minor: number, from: string, date: IsoDate) => number;
  /** Ids of transactions that are transfers between the household's accounts: out of its money in and out. */
  internal?: Set<string>;
  /**
   * Per date, the household's correction for transfers in transit (counted
   * in both accounts, or in neither): added to its balance, start and end,
   * so they agree with money in and out, which leave the transfers out.
   */
  transit?: number[];
  /** With every account in scope: a Household row, internal transfers left out of its money in and out. */
  household: boolean;
}

/** One day's parts, in the display currency's cents. */
interface Parts {
  moneyIn: number;
  moneyOut: number;
  income: number;
  fees: number;
  market: number;
  other: number;
}

const zero = (): Parts => ({ moneyIn: 0, moneyOut: 0, income: 0, fees: 0, market: 0, other: 0 });
const PART_KEYS: (keyof Parts)[] = ['moneyIn', 'moneyOut', 'income', 'fees', 'market', 'other'];

interface StoredTransaction {
  id: string;
  accountId: string;
  date: string;
  source: 'plaid' | 'report' | 'import';
  kind: TransactionKind | null;
  type: string | null;
  subtype: string | null;
  amount: number;
  quantity: number;
  price: number | null;
  description: string | null;
  currency: string;
  securityId: string | null;
}

export async function breakdown(tenant: Tenant, input: BreakdownInput): Promise<{ series: HistorySeries[]; rows: BreakdownRow[] }> {
  const { dates, accounts } = input;
  const first = dates[0];
  const last = dates.at(-1)!;
  const ids = accounts.map((account) => account.id);
  const index = new Map(dates.map((date, position) => [date, position]));

  // Each account's transactions in the range (the first date is where it starts from: its own aren't counted), and its first ever.
  const stored: StoredTransaction[] = [];
  const firstTransaction = new Map<string, string>();
  for (const chunk of inChunks(ids)) {
    stored.push(
      ...(await tenant.db
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          date: transactions.date,
          source: transactions.source,
          kind: transactions.kind,
          type: transactions.type,
          subtype: transactions.subtype,
          amount: transactions.amount,
          quantity: transactions.quantity,
          price: transactions.price,
          description: transactions.description,
          currency: transactions.currency,
          securityId: transactions.securityId,
        })
        .from(transactions)
        .where(tenant.scope(transactions, inArray(transactions.accountId, chunk), gte(transactions.date, addDays(first, 1)), lte(transactions.date, last), counted()))),
    );
    const firsts = await tenant.db
      .select({ accountId: transactions.accountId, first: min(transactions.date) })
      .from(transactions)
      .where(tenant.scope(transactions, inArray(transactions.accountId, chunk), counted()))
      .groupBy(transactions.accountId);
    for (const row of firsts) if (row.first) firstTransaction.set(row.accountId, row.first);
  }

  const securityIds = [...new Set(stored.flatMap((txn) => (txn.securityId ? [txn.securityId] : [])))];
  const securityRows: { id: string; ticker: string | null; type: string | null }[] = [];
  for (const chunk of inChunks(securityIds)) {
    securityRows.push(...(await tenant.db.select({ id: securities.id, ticker: securities.ticker, type: securities.type }).from(securities).where(tenant.scope(securities, inArray(securities.id, chunk)))));
  }
  const securityById = new Map(securityRows.map((row) => [row.id, row]));
  const isCash = (txn: StoredTransaction) => {
    const security = txn.securityId ? securityById.get(txn.securityId) : undefined;
    return security ? isCashSecurity(security) : false;
  };

  // Shares moved in or out: valued at that day's price, unless it's a split.
  const moved = stored.filter((txn) => txn.quantity !== 0 && txn.securityId && kindOf(txn, isCash(txn)) === 'transfer');
  const splitDays = await splits(tenant, moved.flatMap((txn) => (securityById.get(txn.securityId!)?.ticker ? [{ ticker: securityById.get(txn.securityId!)!.ticker!, date: txn.date }] : [])));
  const heldPrice = await transferPrices(tenant, moved);

  // Accounts holding no cash and moving none (a plan bought into directly): its buys are money in, its sales money out.
  const cashless = new Set(
    ids.filter((id) => {
      const own = stored.filter((txn) => txn.accountId === id);
      return own.length > 0 && own.every((txn) => txn.source === 'import' && !['income', 'deposit', 'withdrawal', 'fee', 'sweep'].includes(kindOf(txn, isCash(txn)) ?? 'unknown') && !isCash(txn));
    }),
  );

  const daily = new Map<string, Parts[]>(ids.map((id) => [id, dates.map(zero)]));
  const internalDaily = dates.map(zero);
  const needsType = new Map<string, number>();
  for (const txn of stored) {
    const position = index.get(txn.date as IsoDate);
    if (position === undefined) continue;
    const kind = kindOf(txn, isCash(txn));
    const flows = flowOf(txn, kind, cashless.has(txn.accountId), (value) => input.convert(value, txn.currency, txn.date as IsoDate), {
      split: () => {
        const ticker = txn.securityId ? securityById.get(txn.securityId)?.ticker : null;
        return Boolean(ticker && splitDays.get(ticker)?.some((day) => Math.abs(Date.parse(day) - Date.parse(txn.date)) <= SPLIT_DAYS * 86_400_000));
      },
      price: () => heldPrice.get(txn.id) ?? txn.price ?? 0,
    });
    if (kind === null) needsType.set(txn.accountId, (needsType.get(txn.accountId) ?? 0) + 1);
    const day = daily.get(txn.accountId)![position];
    for (const key of PART_KEYS) day[key] += flows[key];
    if (input.internal?.has(txn.id)) {
      internalDaily[position].moneyIn += flows.moneyIn;
      internalDaily[position].moneyOut += flows.moneyOut;
    }
  }
  // An account holding no cash buys with money in and sells for money out; a switch between its funds
  // (a sale and a purchase on one day) is neither, so each day's sales and purchases offset first.
  for (const id of cashless) {
    for (const day of daily.get(id)!) {
      const both = Math.min(day.moneyIn, day.moneyOut);
      day.moneyIn -= both;
      day.moneyOut -= both;
    }
  }

  // What's left of each day's change: market gain or loss, or not broken down.
  const accountTotals = new Map<string, Parts>();
  for (const account of accounts) {
    const values = input.values.get(account.id) ?? dates.map(() => null);
    const days = daily.get(account.id)!;
    const since = firstTransaction.get(account.id);
    for (let position = 1; position < dates.length; position++) {
      const before = values[position - 1];
      const now = values[position];
      const change = (now ?? 0) - (before ?? 0);
      const day = days[position];
      if (!since || dates[position] < since) {
        // No transactions known yet: none of the change can be told apart.
        Object.assign(day, { ...zero(), other: change });
        continue;
      }
      const remainder = change - (day.moneyIn - day.moneyOut + day.income - day.fees + day.other);
      const edge = (before === null) !== (now === null);
      if (edge || account.type !== 'investment') day.other += remainder;
      else day.market += remainder;
    }
    days[0] = zero();
    accountTotals.set(account.id, sum(days));
  }

  const startOf = (id: string) => input.values.get(id)?.[0] ?? 0;
  const endOf = (id: string) => input.values.get(id)?.at(-1) ?? 0;
  const transit = input.household && input.transit ? input.transit : dates.map(() => 0);
  const rows: BreakdownRow[] = accounts.map((account) => ({ key: account.id, label: accountLabel(account), start: startOf(account.id), end: endOf(account.id), ...accountTotals.get(account.id)!, needsType: needsType.get(account.id) ?? 0 }));

  // The scope's days: every account's parts, less transfers between them from money in and out.
  const together = dates.map((_, position) => {
    const day = zero();
    for (const id of ids) for (const key of PART_KEYS) day[key] += daily.get(id)![position][key];
    if (input.household) {
      day.moneyIn -= internalDaily[position].moneyIn;
      day.moneyOut -= internalDaily[position].moneyOut;
    }
    return day;
  });
  if (input.household) {
    const total = sum(together);
    rows.unshift({
      key: 'household',
      label: 'Household',
      start: ids.reduce((sum, id) => sum + startOf(id), transit[0]),
      end: ids.reduce((sum, id) => sum + endOf(id), transit.at(-1)!),
      ...total,
      needsType: [...needsType.values()].reduce((sum, count) => sum + count, 0),
    });
  }

  const cumulative = (pick: (day: Parts) => number) => {
    let running = 0;
    return together.map((day) => (running += pick(day)));
  };
  const balance = dates.map((_, position) => {
    let total: number | null = null;
    for (const id of ids) {
      const value = input.values.get(id)?.[position];
      if (value !== null && value !== undefined) total = (total ?? 0) + value;
    }
    return total === null ? null : total + transit[position];
  });
  const none = dates.map(() => null);
  const series: HistorySeries[] = [
    { key: 'balance', label: 'Balance', values: balance, quality: none },
    { key: 'in', label: 'Money in', values: cumulative((day) => day.moneyIn), quality: none },
    { key: 'out', label: 'Money out', values: cumulative((day) => -day.moneyOut), quality: none },
    { key: 'income', label: 'Dividends and interest', values: cumulative((day) => day.income), quality: none },
    { key: 'fees', label: 'Fees', values: cumulative((day) => -day.fees), quality: none },
    { key: 'market', label: 'Market gain/loss', values: cumulative((day) => day.market), quality: none },
    { key: 'other', label: 'Not broken down', values: cumulative((day) => day.other), quality: none },
  ];
  return { series, rows };
}

function sum(days: Parts[]): Parts {
  const total = zero();
  for (const day of days) for (const key of PART_KEYS) total[key] += day[key];
  return total;
}

/**
 * What one transaction brings into or takes out of the account's value, by
 * its kind: `convert` takes the account's cents to the display currency's.
 */
export function flowOf(
  txn: { amount: number; quantity: number; price: number | null; source: string; subtype: string | null },
  kind: TransactionKind | null,
  cashless: boolean,
  convert: (cents: number) => number,
  shares: { split: () => boolean; price: () => number },
): Parts {
  const parts = zero();
  // Stored positive when money leaves the account.
  const cashIn = convert(-txn.amount);
  const worth = () => convert(Math.abs(Math.round(txn.quantity * (txn.price ?? 0) * 100)) || Math.abs(txn.amount));
  const subtype = (txn.subtype ?? '').toLowerCase();
  switch (kind) {
    case 'deposit':
    case 'withdrawal':
      if (cashIn >= 0) parts.moneyIn = cashIn;
      else parts.moneyOut = -cashIn;
      break;
    case 'income':
      parts.income = cashIn;
      break;
    case 'fee':
      parts.fees = Math.abs(cashIn);
      break;
    case 'reinvest':
      // Paid from cash, its dividend is listed apart; moving none, it's the dividend.
      if (txn.amount === 0) parts.income = worth();
      break;
    case 'buy':
      if (cashless || (txn.source === 'plaid' && subtype === 'contribution')) parts.moneyIn = worth();
      break;
    case 'sell':
      if (cashless || (txn.source === 'plaid' && subtype === 'distribution')) parts.moneyOut = worth();
      break;
    case 'transfer':
      if (txn.quantity !== 0 && !shares.split()) {
        const value = convert(Math.abs(Math.round(txn.quantity * shares.price() * 100)));
        if (txn.quantity > 0) parts.moneyIn = value;
        else parts.moneyOut = value;
      }
      break;
    case 'sweep':
      break;
    case null:
      // Not known: what it did to the account's cash can't be told apart.
      parts.other = cashIn;
      break;
  }
  return parts;
}

/** Each ticker's split days near the given dates. */
async function splits(tenant: Tenant, near: { ticker: string; date: string }[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const { ticker, date } of near) {
    const rows = await tenant.db
      .select({ date: pricesDaily.date })
      .from(pricesDaily)
      .where(and(eq(pricesDaily.ticker, ticker), gte(pricesDaily.date, addDays(date as IsoDate, -SPLIT_DAYS)), lte(pricesDaily.date, addDays(date as IsoDate, SPLIT_DAYS)), ne(pricesDaily.splitFactor, 1)));
    found.set(ticker, [...(found.get(ticker) ?? []), ...rows.map((row) => row.date)]);
  }
  return found;
}

/** The price each moved holding had that day in its account (its own price when the transaction has none). */
async function transferPrices(tenant: Tenant, moved: StoredTransaction[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  for (const txn of moved) {
    if (txn.price) continue;
    const [row] = await tenant.db
      .select({ price: holdingDaily.price })
      .from(holdingDaily)
      .where(tenant.scope(holdingDaily, eq(holdingDaily.accountId, txn.accountId), eq(holdingDaily.securityId, txn.securityId!), lte(holdingDaily.date, txn.date)))
      .orderBy(desc(holdingDaily.date))
      .limit(1);
    if (row?.price) prices.set(txn.id, row.price);
  }
  return prices;
}

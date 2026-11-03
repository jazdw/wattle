/**
 * Minimal CSV parsing and column mapping for history imports: dates and
 * balances, or transactions (cash, or investments) whose columns are found
 * from the header. Parsing happens in the browser; the server validates the
 * normalised rows.
 */
import type { IsoDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { ImportedFile, ImportedHoldings, ImportKind } from '../../shared/schemas';
import type { FileAccount, ReadTransaction } from './imports';
import { closestIncome, ticker } from './ofx';

/** RFC 4180-ish parser: quoted fields, escaped quotes, CRLF. Blank rows are dropped, or kept as [] (they separate a file's tables). */
export function parseCsv(text: string, keepBlank = false): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      else if (keepBlank) rows.push([]);
      row = [];
      field = '';
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows.map((cells) => cells.map((cell) => cell.trim()));
}

export type DateFormat = 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';

export function parseDate(value: string, format: DateFormat): string | null {
  const parts = value.match(/\d+/g);
  if (!parts || parts.length < 3) return null;
  let [year, month, day] = [0, 0, 0];
  if (format === 'YYYY-MM-DD') [year, month, day] = parts.map(Number);
  if (format === 'DD/MM/YYYY') [day, month, year] = parts.map(Number);
  if (format === 'MM/DD/YYYY') [month, day, year] = parts.map(Number);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "$1,234.56", "(12.00)", "-12" → number. */
export function parseAmount(value: string): number | null {
  const negative = /^\(.*\)$/.test(value.trim()) || value.trim().startsWith('-');
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? (negative ? -number : number) : null;
}

export interface BalanceMapping {
  dateColumn: number;
  balanceColumn: number;
  dateFormat: DateFormat;
  hasHeader: boolean;
}


/**
 * Where a CSV's dates and balances are, and how its dates are written: a
 * header naming a date column and a balance column ("Date", "Balance",
 * "Running balance"…), and the date format the values allow (a day over 12
 * says which comes first; month first when nothing does). Null when the
 * header doesn't name both: the columns are chosen by hand.
 */
export function guessMapping(rows: string[][]): BalanceMapping | null {
  const header = (rows[0] ?? []).map((cell) => cell.toLowerCase());
  const dateColumn = header.findIndex((cell) => /\bdate\b/.test(cell));
  const balanceColumn = header.findIndex((cell) => /\bbalance\b/.test(cell));
  if (dateColumn < 0 || balanceColumn < 0) return null;
  return { dateColumn, balanceColumn, dateFormat: guessDateFormat(rows.slice(1).map((row) => row[dateColumn] ?? '')), hasHeader: true };
}

function guessDateFormat(values: string[]): DateFormat {
  const parts = values.map((value) => value.match(/\d+/g)?.map(Number) ?? []).filter((found) => found.length >= 3);
  if (parts.length > 0 && parts.every((found) => found[0] > 31)) return 'YYYY-MM-DD';
  if (parts.some((found) => found[0] > 12)) return 'DD/MM/YYYY';
  return 'MM/DD/YYYY';
}

/**
 * One end-of-day balance per date. Transaction exports list several rows per
 * day; the day's last transaction carries its closing balance, so file order
 * (newest-first or oldest-first) decides which row wins.
 */
export function extractBalances(rows: string[][], mapping: BalanceMapping): { rows: { date: string; balance: number }[]; skipped: number } {
  const data = mapping.hasHeader ? rows.slice(1) : rows;
  const parsed: { date: string; balance: number }[] = [];
  let skipped = 0;
  for (const row of data) {
    const date = parseDate(row[mapping.dateColumn] ?? '', mapping.dateFormat);
    const balance = parseAmount(row[mapping.balanceColumn] ?? '');
    if (!date || balance === null) {
      skipped += 1;
      continue;
    }
    parsed.push({ date, balance });
  }
  const newestFirst = parsed.length > 1 && parsed[0].date > parsed.at(-1)!.date;
  const byDate = new Map<string, number>();
  for (const row of newestFirst ? parsed : [...parsed].reverse()) {
    if (!byDate.has(row.date)) byDate.set(row.date, row.balance);
  }
  return {
    rows: [...byDate].map(([date, balance]) => ({ date, balance })).sort((a, b) => a.date.localeCompare(b.date)),
    skipped,
  };
}

/** A header cell for each column a table of transactions or holdings may have, tried in order. */
const COLUMNS = {
  account: /^account( (number|no\.?|#|id))?$/,
  date: /\bdate\b/,
  shares: /\b(shares?|units?|quantity|qty)\b/,
  price: /\bprice\b/,
  amount: /\b(net amount|amount|total)\b/,
  value: /\bvalue\b/,
  debit: /\b(debit|withdrawals?|money out|paid out|outflow)\b/,
  credit: /\b(credit|deposits?|money in|paid in|inflow)\b/,
  symbol: /\b(symbol|ticker)\b/,
  security: /\b(fund|security|investment|holding|name)\b/,
  type: /\b(type|action|activity)\b|^transaction$/,
  description: /\b(description|details|memo|payee|narrative)\b/,
  status: /\bstatus\b/,
} as const;

type Columns = { -readonly [key in keyof typeof COLUMNS]: number };

/** Each column found in the header (-1 when missing), no column used twice. */
function findColumns(header: string[]): Columns {
  const cells = header.map((cell) => cell.toLowerCase().trim());
  const used = new Set<number>();
  const found = {} as Columns;
  for (const [key, pattern] of Object.entries(COLUMNS) as [keyof Columns, RegExp][]) {
    // A transaction's own date, not a holding's last trade or price date.
    const index = cells.findIndex((cell, at) => !used.has(at) && pattern.test(cell) && !(key === 'date' && /\b(last|as of|price)\b/.test(cell)));
    if (index >= 0) used.add(index);
    found[key] = index;
  }
  return found;
}

/** What a table is, from its header: holdings now (shares in securities, no dates), investment or cash transactions, or neither. */
type TableKind = 'holdings' | 'investments' | 'cash' | null;
function tableKind(header: string[]): TableKind {
  const columns = findColumns(header);
  const securities = columns.shares >= 0 && (columns.security >= 0 || columns.symbol >= 0);
  if (securities && columns.date < 0 && columns.type < 0) return 'holdings';
  if (columns.date < 0) return null;
  if (securities) return 'investments';
  if (columns.amount >= 0 || columns.debit >= 0 || columns.credit >= 0) return 'cash';
  return null;
}

/**
 * A CSV's tables: rows between blank lines, each with its own header. A
 * block whose first row isn't a header, as wide as the table above, is more
 * of that table (some files leave a blank line between accounts).
 */
function tables(text: string): string[][][] {
  const blocks: string[][][] = [];
  let current: string[][] = [];
  for (const row of parseCsv(text, true)) {
    if (row.length === 0) {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else current.push(row);
  }
  if (current.length > 0) blocks.push(current);
  const found: string[][][] = [];
  for (const block of blocks) {
    const previous = found.at(-1);
    if (previous && !tableKind(block[0]) && block[0].length === previous[0].length) previous.push(...block);
    else found.push(block);
  }
  return found;
}

/**
 * What a CSV holds: investments (a table of transactions in securities,
 * and maybe one of holdings now), cash transactions, or neither (a CSV of
 * balances, read as one, or something else).
 */
export function transactionsKind(text: string): 'holdings' | 'cash' | null {
  const kinds = tables(text).map((rows) => tableKind(rows[0]));
  if (kinds.includes('investments') || kinds.includes('holdings')) return 'holdings';
  if (kinds.includes('cash')) return 'cash';
  return null;
}

/**
 * The kind of an investment transaction from the file's type for it and the
 * shares it moves; null for a type it doesn't know (listed, never guessed).
 * With no type column, the shares say which way a trade went.
 */
export function investmentKind(type: string, shares: number, amount: number): ImportKind | null {
  const text = type.toLowerCase();
  const moves = Math.abs(shares) > 0;
  const inOrOut: ImportKind = amount >= 0 ? 'deposit' : 'withdrawal';
  if (!text) return moves ? (shares > 0 ? 'buy' : 'sell') : amount !== 0 ? inOrOut : null;
  if (/sweep/.test(text)) return 'sweep';
  if (/reinvest/.test(text)) return 'reinvest';
  if (/split/.test(text)) return 'transfer';
  if (/\b(fees?|expense|charge)\b/.test(text)) return moves ? 'sell' : 'fee';
  if (/dividend|interest|capital gain|distribution|income|earning/.test(text)) return moves ? 'reinvest' : 'income';
  if (/\b(buy|bought|purchase)/.test(text)) return 'buy';
  if (/\b(sell|sold|sale|redemption|redeem)/.test(text)) return 'sell';
  // Out of one fund and into another: a sale and a purchase, by the shares.
  if (/exchange/.test(text)) return moves ? (shares > 0 ? 'buy' : 'sell') : inOrOut;
  if (/transfer/.test(text)) return moves ? 'transfer' : inOrOut;
  if (/contribution|deposit|\b(received|incoming)\b/.test(text)) return moves ? 'buy' : 'deposit';
  if (/withdraw|\b(outgoing|disbursement)\b/.test(text)) return moves ? 'sell' : 'withdrawal';
  return null;
}

/**
 * A CSV's accounts: one per account number when it has an account column,
 * else one for the file. Investments come with their holdings when the file
 * has a table of them (else, like cash transactions, with no balance yet:
 * it's known once given, ./known). Cash rules as Quicken files have them
 * (./ofx): a $1 fund with no symbol, or one cash is swept into, is the
 * account's cash; a reinvestment is the income and the purchase it pays for
 * when the file lists that income (else it only adds shares). Pending rows
 * are left out; a row whose date or amount can't be read stops the import,
 * saying which. Null when the CSV holds no transactions.
 */
export function csvAccounts(text: string): FileAccount[] | null {
  const kind = transactionsKind(text);
  if (!kind) return null;
  type Found = { transactions: ReadTransaction[]; holdings: { id: string; ticker: string | null; name: string; shares: number; price: number }[] | null; securities: Map<string, ImportedHoldings['securities'][number]>; unknownTypes: Set<string> };
  const accounts = new Map<string, Found>();
  const account = (number: string) => accounts.get(number) ?? accounts.set(number, { transactions: [], holdings: null, securities: new Map(), unknownTypes: new Set() }).get(number)!;

  for (const rows of tables(text)) {
    const table = tableKind(rows[0]);
    if (!table || (kind === 'holdings' && table === 'cash')) continue;
    const columns = findColumns(rows[0]);
    const cell = (row: string[], column: number) => (column >= 0 ? (row[column] ?? '').trim() : '');
    const dateFormat = guessDateFormat(rows.slice(1).map((row) => cell(row, columns.date)));
    rows.slice(1).forEach((row, index) => {
      const found = account(cell(row, columns.account));
      const symbol = ticker(cell(row, columns.symbol));
      const name = cell(row, columns.security);
      const id = symbol ?? name;
      if (table === 'holdings') {
        const shares = parseAmount(cell(row, columns.shares)) ?? 0;
        found.holdings ??= [];
        found.holdings.push({ id, ticker: symbol, name: name || id, shares, price: Math.abs(parseAmount(cell(row, columns.price)) ?? 0) });
        return;
      }
      if (/pending/i.test(cell(row, columns.status))) return;
      const line = `Row ${index + 2} of the CSV`;
      const date = parseDate(cell(row, columns.date), dateFormat) as IsoDate | null;
      if (!date) throw new Error(`${line} has no date Wattle can read.`);
      const label = cell(row, columns.type);
      const amountCell = cell(row, columns.amount) || cell(row, columns.value);
      let amount = amountCell ? parseAmount(amountCell) : null;
      if (amount === null && (cell(row, columns.debit) || cell(row, columns.credit))) amount = Math.abs(parseAmount(cell(row, columns.credit)) ?? 0) - Math.abs(parseAmount(cell(row, columns.debit)) ?? 0);
      if (table === 'cash') {
        if (amount === null) throw new Error(`${line} has no amount Wattle can read.`);
        if (amount === 0) return;
        const cents = toMinor(amount);
        // Named by its type, else its description: interest and dividends are income, a charge a fee.
        const named = label || cell(row, columns.description);
        const cashKind: ImportKind = /interest|dividend/i.test(named) ? 'income' : /\bfees?\b|charge/i.test(named) && cents < 0 ? 'fee' : cents < 0 ? 'withdrawal' : 'deposit';
        const description = cell(row, columns.description);
        found.transactions.push({ date, kind: cashKind, label: named || 'CSV', ...(description ? { description } : {}), security: null, shares: 0, price: 0, amount: cents, value: 0, charges: 0 });
        return;
      }
      const shares = parseAmount(cell(row, columns.shares)) ?? 0;
      const price = Math.abs(parseAmount(cell(row, columns.price)) ?? 0);
      const value = amount !== null ? Math.abs(toMinor(amount)) : Math.round(Math.abs(shares) * price * 100);
      const txnKind = investmentKind(label, shares, amount ?? 0);
      if (!txnKind) {
        found.unknownTypes.add(label);
        return;
      }
      const holds = ['buy', 'sell', 'reinvest', 'transfer'].includes(txnKind);
      // A trade naming no security and moving no shares keeps the money in the account's cash.
      if (holds && !id && shares === 0) {
        found.transactions.push({ date, kind: 'sweep', label: label || 'CSV', security: null, shares: 0, price: 0, amount: 0, value, charges: 0 });
        return;
      }
      if (holds && !id) throw new Error(`${line} doesn't say which security it's in.`);
      if (id && !found.securities.has(id)) found.securities.set(id, { id, ticker: symbol, name: name || id });
      // Cash: a buy pays its total, a sale and income bring it in; a transfer only moves shares (a reinvestment's below).
      const signed = txnKind === 'buy' ? -value : txnKind === 'sell' || txnKind === 'income' || txnKind === 'deposit' ? value : txnKind === 'withdrawal' || txnKind === 'fee' ? -value : 0;
      const direction = txnKind === 'sell' ? -1 : txnKind === 'transfer' ? Math.sign(shares) : 1;
      const description = cell(row, columns.description);
      found.transactions.push({ date, kind: txnKind, label: label || 'CSV', ...(description ? { description } : {}), security: id || null, shares: holds ? direction * Math.abs(shares) : 0, price, amount: signed, value: txnKind === 'transfer' ? 0 : value, charges: 0 });
    });
  }

  const result: FileAccount[] = [];
  for (const [number, found] of accounts) {
    const { transactions, holdings } = found;
    transactions.sort((a, b) => a.date.localeCompare(b.date));
    // A reinvestment paid for by income from the same security the file lists pays out of cash; otherwise it only adds shares.
    const incomes = transactions.filter((txn) => txn.kind === 'income' && txn.security);
    for (const txn of transactions.filter((candidate) => candidate.kind === 'reinvest' && candidate.security).sort((a, b) => b.value - a.value)) {
      const at = closestIncome(incomes, txn);
      if (at < 0) continue;
      incomes.splice(at, 1);
      txn.amount = -txn.value;
    }
    // The account's cash: $1 funds with no symbol, or that cash is swept into.
    const swept = new Set(transactions.filter((txn) => txn.kind === 'sweep' && txn.security).map((txn) => txn.security!));
    const cashFunds = new Set((holdings ?? []).filter((row) => row.price === 1 && (!row.ticker || swept.has(row.id))).map((row) => row.id));
    for (const txn of transactions) {
      if (txn.security && cashFunds.has(txn.security)) {
        // Money into or out of the cash itself stays; a trade of it is a move within it.
        if (!['income', 'deposit', 'withdrawal', 'fee'].includes(txn.kind)) Object.assign(txn, { kind: 'sweep', shares: 0, amount: 0 });
        txn.security = null;
      } else if (txn.kind === 'sweep') Object.assign(txn, { security: null, shares: 0, amount: 0 });
      else if (!['buy', 'sell', 'reinvest', 'transfer'].includes(txn.kind)) txn.security = null;
    }
    const securities = [...found.securities.values()].filter((security) => !cashFunds.has(security.id));
    for (const row of holdings ?? []) if (!cashFunds.has(row.id) && !securities.some((security) => security.id === row.id)) securities.push({ id: row.id, ticker: row.ticker, name: row.name });
    const asOf = transactions.at(-1)?.date ?? ('1970-01-01' as IsoDate);
    const moneyMoves = transactions.some((txn) => ['income', 'deposit', 'withdrawal', 'fee', 'sweep'].includes(txn.kind));
    const base = { number: number || null, institution: null, unknownTypes: [...found.unknownTypes] };
    if (kind === 'cash') {
      result.push({ ...base, file: { kind: 'balances', rows: [] }, unanchored: { kind: 'cash', transactions } });
      continue;
    }
    if (holdings) {
      // Holdings now: the account's file is known as it stands.
      const positions = holdings.filter((row) => !cashFunds.has(row.id) && row.shares !== 0).map((row) => ({ security: row.id, shares: row.shares, ...(row.price > 0 ? { price: row.price } : {}) }));
      const cash = toMinor(holdings.filter((row) => cashFunds.has(row.id)).reduce((sum, row) => sum + row.shares, 0));
      result.push({ ...base, type: 'investment', file: { kind: 'holdings', asOf, securities, positions, cash, transactions } });
      continue;
    }
    const file: ImportedFile = { kind: 'holdings', asOf, securities, positions: [], cash: 0, transactions };
    result.push({ ...base, type: 'investment', file, unanchored: { kind: 'holdings', securities, transactions, moneyMoves } });
  }
  return result;
}

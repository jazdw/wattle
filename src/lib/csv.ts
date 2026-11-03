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
import { ticker } from './ofx';

/** RFC 4180-ish parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
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

/** A header cell for each column a transactions CSV may have, tried in order. */
const COLUMNS = {
  date: /\bdate\b/,
  shares: /\b(shares?|units?|quantity|qty)\b/,
  price: /\bprice\b/,
  amount: /\b(amount|total)\b/,
  value: /\bvalue\b/,
  debit: /\b(debit|withdrawals?|money out|paid out|outflow)\b/,
  credit: /\b(credit|deposits?|money in|paid in|inflow)\b/,
  symbol: /\b(symbol|ticker)\b/,
  security: /\b(fund|security|investment|holding|name)\b/,
  type: /\b(type|action|activity|transaction)\b/,
  description: /\b(description|details|memo|payee|narrative)\b/,
  status: /\bstatus\b/,
} as const;

type Columns = { -readonly [key in keyof typeof COLUMNS]: number };

/** Each column found in the header (-1 when missing), no column used twice. */
function findColumns(header: string[]): Columns {
  const cells = header.map((cell) => cell.toLowerCase());
  const used = new Set<number>();
  const found = {} as Columns;
  for (const [key, pattern] of Object.entries(COLUMNS) as [keyof Columns, RegExp][]) {
    const index = cells.findIndex((cell, at) => !used.has(at) && pattern.test(cell));
    if (index >= 0) used.add(index);
    found[key] = index;
  }
  return found;
}

/**
 * What a transactions CSV holds: investments when it has shares and the
 * security they're in, cash when it has amounts (one column, or debits and
 * credits). Null for anything else (a CSV of balances is read as one).
 */
export function transactionsKind(rows: string[][]): 'holdings' | 'cash' | null {
  const columns = findColumns(rows[0] ?? []);
  if (columns.date < 0) return null;
  if (columns.shares >= 0 && (columns.security >= 0 || columns.symbol >= 0)) return 'holdings';
  if (columns.amount >= 0 || columns.debit >= 0 || columns.credit >= 0) return 'cash';
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
  if (!text) return moves ? (shares > 0 ? 'buy' : 'sell') : amount > 0 ? 'deposit' : amount < 0 ? 'withdrawal' : null;
  if (/reinvest/.test(text)) return 'reinvest';
  if (/split/.test(text)) return 'transfer';
  if (/\b(fees?|expense|charge)\b/.test(text)) return moves ? 'sell' : 'fee';
  if (/dividend|interest|capital gain|distribution|income|earning/.test(text)) return moves ? 'reinvest' : 'income';
  if (/\b(buy|bought|purchase)/.test(text)) return 'buy';
  if (/\b(sell|sold|sale|redemption|redeem)/.test(text)) return 'sell';
  if (/transfer|exchange/.test(text)) return moves ? 'transfer' : amount >= 0 ? 'deposit' : 'withdrawal';
  if (/contribution|deposit/.test(text)) return moves ? 'buy' : 'deposit';
  if (/withdraw/.test(text)) return moves ? 'sell' : 'withdrawal';
  return null;
}

/**
 * A CSV of transactions as one account with no balance yet (it's known once
 * given: ./known). Cash: each row's amount, signed as the file has it.
 * Investments: each row's kind, shares and price, the cash amount signed by
 * its kind (a buy pays, a sale brings in). Pending rows are left out; a row
 * whose date or amount can't be read stops the import, saying which.
 */
export function transactionsAccount(rows: string[][]): FileAccount | null {
  const kind = transactionsKind(rows);
  if (!kind) return null;
  const columns = findColumns(rows[0]);
  const cell = (row: string[], column: number) => (column >= 0 ? (row[column] ?? '').trim() : '');
  const dateFormat = guessDateFormat(rows.slice(1).map((row) => cell(row, columns.date)));
  const transactions: ReadTransaction[] = [];
  const securities = new Map<string, ImportedHoldings['securities'][number]>();
  const unknownTypes = new Set<string>();
  rows.slice(1).forEach((row, index) => {
    if (/pending/i.test(cell(row, columns.status))) return;
    const line = index + 2;
    const date = parseDate(cell(row, columns.date), dateFormat) as IsoDate | null;
    if (!date) throw new Error(`Row ${line} of the CSV has no date Wattle can read.`);
    const label = cell(row, columns.type);
    const amountCell = cell(row, columns.amount) || cell(row, columns.value);
    let amount = amountCell ? parseAmount(amountCell) : null;
    if (amount === null && (cell(row, columns.debit) || cell(row, columns.credit))) amount = Math.abs(parseAmount(cell(row, columns.credit)) ?? 0) - Math.abs(parseAmount(cell(row, columns.debit)) ?? 0);
    if (kind === 'cash') {
      if (amount === null) throw new Error(`Row ${line} of the CSV has no amount Wattle can read.`);
      if (amount === 0) return;
      const cents = toMinor(amount);
      // Named by its type, else its description: interest and dividends are income, a charge a fee.
      const named = label || cell(row, columns.description);
      const cashKind: ImportKind = /interest|dividend/i.test(named) ? 'income' : /\bfees?\b|charge/i.test(named) && cents < 0 ? 'fee' : cents < 0 ? 'withdrawal' : 'deposit';
      transactions.push({ date, kind: cashKind, label: named || 'CSV', security: null, shares: 0, price: 0, amount: cents, value: 0, charges: 0 });
      return;
    }
    const shares = parseAmount(cell(row, columns.shares)) ?? 0;
    const price = Math.abs(parseAmount(cell(row, columns.price)) ?? 0);
    const value = amount !== null ? Math.abs(toMinor(amount)) : Math.round(Math.abs(shares) * price * 100);
    const txnKind = investmentKind(label, shares, amount ?? 0);
    if (!txnKind) {
      unknownTypes.add(label);
      return;
    }
    const symbol = ticker(cell(row, columns.symbol));
    const name = cell(row, columns.security);
    const id = symbol ?? name;
    const holds = ['buy', 'sell', 'reinvest', 'transfer'].includes(txnKind);
    if (holds && !id) throw new Error(`Row ${line} of the CSV doesn't say which security it's in.`);
    if (holds && !securities.has(id)) securities.set(id, { id, ticker: symbol, name: name || id });
    // Cash: a buy pays its total, a sale and income bring it in; a reinvestment or transfer only moves shares.
    const signed = txnKind === 'buy' ? -value : txnKind === 'sell' || txnKind === 'income' || txnKind === 'deposit' ? value : txnKind === 'withdrawal' || txnKind === 'fee' ? -value : 0;
    const direction = txnKind === 'sell' ? -1 : txnKind === 'transfer' ? Math.sign(shares) : 1;
    transactions.push({ date, kind: txnKind, label: label || 'CSV', security: holds ? id : null, shares: holds ? direction * Math.abs(shares) : 0, price, amount: signed, value: txnKind === 'transfer' ? 0 : value, charges: 0 });
  });
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  const placeholder: ImportedFile =
    kind === 'cash'
      ? { kind: 'balances', rows: [] }
      : { kind: 'holdings', asOf: transactions.at(-1)?.date ?? ('1970-01-01' as IsoDate), securities: [...securities.values()], positions: [], cash: 0, transactions };
  return {
    number: null,
    institution: null,
    type: kind === 'holdings' ? 'investment' : undefined,
    unknownTypes: [...unknownTypes],
    file: placeholder,
    unanchored:
      kind === 'cash'
        ? { kind: 'cash', transactions }
        : { kind: 'holdings', securities: [...securities.values()], transactions, moneyMoves: transactions.some((txn) => ['income', 'deposit', 'withdrawal', 'fee'].includes(txn.kind)) },
  };
}

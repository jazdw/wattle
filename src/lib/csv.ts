/**
 * Minimal CSV parsing and column mapping for history imports. Parsing happens
 * in the browser; the server validates the normalised rows.
 */
import { addDays } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';

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

export interface Preset {
  id: string;
  label: string;
  /** Recognise a file from its header row. */
  detect: (header: string[]) => boolean;
  /** Turn the whole file into a table of dates and balances, for files without a balance column. */
  transform?: (rows: string[][]) => string[][];
  mapping: (header: string[]) => BalanceMapping;
}

const find = (header: string[], name: string) => header.findIndex((cell) => cell.toLowerCase() === name.toLowerCase());

const VANGUARD_POSITIONS = ['Account Number', 'Investment Name', 'Symbol', 'Shares', 'Share Price', 'Total Value'];
/**
 * Transactions that move money within the account (between its cash and its
 * holdings); every other kind (deposits, dividends, interest, contributions,
 * conversions, fees…) moves money in or out.
 */
const VANGUARD_INTERNAL = new Set(['sweep in', 'sweep out', 'buy', 'sell', 'reinvestment', 'exchange', 'stock split']);

/**
 * A Vanguard download lists each account's positions now, then its
 * transactions (no balances). For an account holding only $1 holdings (cash
 * and money market funds) its total moves only with money in or out, so
 * walking back from today's total through those gives each day's balance.
 * Accounts holding anything priced otherwise are left out: their value moves
 * with prices every day. One balance column per account; the first row is
 * the day before the first transaction. Sums are in integer cents, so exact.
 */
export function vanguardBalances(rows: string[][]): string[][] {
  const transactionsAt = rows.findIndex((row) => row[0] === 'Account Number' && row[1] === 'Trade Date');
  if (transactionsAt < 0) return [];
  const positions = rows.slice(1, transactionsAt);
  const header = rows[transactionsAt];
  const column = (name: string) => find(header, name);
  const [dateAt, typeAt, amountAt] = [column('Trade Date'), column('Transaction Type'), column('Net Amount')];

  const totals = new Map<string, number>();
  const priced = new Set<string>();
  for (const row of positions) {
    if (parseAmount(row[4] ?? '') !== 1) priced.add(row[0]);
    totals.set(row[0], (totals.get(row[0]) ?? 0) + toMinor(parseAmount(row[5] ?? '') ?? 0));
  }
  const accounts = [...totals.keys()].filter((account) => !priced.has(account));

  // Money in or out per account and day, in cents.
  const flows = new Map<string, Map<string, number>>(accounts.map((account) => [account, new Map()]));
  for (const row of rows.slice(transactionsAt + 1)) {
    const byDate = flows.get(row[0]);
    const date = parseDate(row[dateAt] ?? '', 'YYYY-MM-DD');
    if (!byDate || !date || VANGUARD_INTERNAL.has((row[typeAt] ?? '').toLowerCase())) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + toMinor(parseAmount(row[amountAt] ?? '') ?? 0));
  }
  const dates = [...new Set([...flows.values()].flatMap((byDate) => [...byDate.keys()]))].sort();
  if (accounts.length === 0 || dates.length === 0) return [];

  // Newest first: each day's closing balance, then undo that day's flows.
  const running = new Map(accounts.map((account) => [account, totals.get(account)!]));
  const table: string[][] = [];
  for (const date of [...dates].reverse()) {
    table.push([date, ...accounts.map((account) => fromMinor(running.get(account)!).toFixed(2))]);
    for (const account of accounts) running.set(account, running.get(account)! - (flows.get(account)!.get(date) ?? 0));
  }
  table.push([addDays(dates[0], -1), ...accounts.map((account) => fromMinor(running.get(account)!).toFixed(2))]);
  return [['Date', ...accounts.map((account) => `Account ending ${account.slice(-4)}`)], ...table.reverse()];
}

/** The balance column for an account by its last digits (a column named "Account ending 1234"), else -1. */
export function accountColumn(header: string[], mask: string | null | undefined): number {
  return mask ? header.findIndex((cell) => cell === `Account ending ${mask.slice(-4)}`) : -1;
}

export const PRESETS: Preset[] = [
  {
    id: 'vanguard',
    label: 'Vanguard download (balances rebuilt from transactions; cash and money market accounts only)',
    detect: (header) => VANGUARD_POSITIONS.every((name, index) => header[index] === name),
    transform: vanguardBalances,
    mapping: () => ({ dateColumn: 0, balanceColumn: 1, dateFormat: 'YYYY-MM-DD', hasHeader: true }),
  },
  {
    // Example Bank "Export transactions" CSV:
    // Bank Account,Date,Description,Debit Amount,Credit Amount,Balance,Category,Reference
    id: 'examplebank',
    label: 'bank transactions',
    detect: (header) => find(header, 'Description') >= 0 && find(header, 'Balance') >= 0 && find(header, 'Bank Account') >= 0,
    mapping: (header) => ({
      dateColumn: find(header, 'Date'),
      balanceColumn: find(header, 'Balance'),
      dateFormat: 'DD/MM/YYYY',
      hasHeader: true,
    }),
  },
];

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

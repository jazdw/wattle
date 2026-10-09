/**
 * Minimal CSV parsing and column mapping for history imports. Parsing happens
 * in the browser; the server validates the normalised rows.
 */

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
  mapping: (header: string[]) => BalanceMapping;
}

const find = (header: string[], name: string) => header.findIndex((cell) => cell.toLowerCase() === name.toLowerCase());

export const PRESETS: Preset[] = [
  {
    // Westpac "Export transactions" CSV:
    // Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial
    id: 'westpac',
    label: 'Westpac transactions',
    detect: (header) => find(header, 'Narrative') >= 0 && find(header, 'Balance') >= 0 && find(header, 'Bank Account') >= 0,
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

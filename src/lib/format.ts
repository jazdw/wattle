import { formatMoney, formatPercent, type Currency } from '../../shared/money';

export { formatMoney, formatPercent };

export function money(minor: number | null | undefined, currency: Currency, options?: Parameters<typeof formatMoney>[2]): string {
  return minor === null || minor === undefined ? '—' : formatMoney(minor, currency, options);
}

export function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function longDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Date and time, e.g. "Oct 8, 2026, 10:00 PM". */
export function dateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A time later today or soon after: "at 6:02 PM" today, else "Fri 6:02 PM". */
export function upcomingTime(epochMs: number): string {
  const when = new Date(epochMs);
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return when.toDateString() === new Date().toDateString() ? `at ${time}` : `${when.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

export function relativeTime(epochMs: number | null): string {
  if (!epochMs) return 'never';
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Units held, in full: fractional shares (and crypto) to 6 places, 8 below one unit; no trailing zeros. */
export function quantity(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(value) < 1 ? 8 : 6 }).format(value);
}

/** Positive/negative colour class for changes. */
export function changeClass(value: number): string {
  if (value > 0) return 'text-positive';
  if (value < 0) return 'text-negative';
  return 'text-muted-foreground';
}

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  depository: 'Cash',
  investment: 'Investments',
  property: 'Property',
  credit: 'Credit cards',
  loan: 'Loans',
  other: 'Other',
};

export const ACCOUNT_TYPE_ORDER = ['depository', 'investment', 'property', 'other', 'credit', 'loan'];

/** Plaid subtypes whose plain capitalisation reads wrong. */
const SUBTYPE_LABELS: Record<string, string> = {
  '401a': '401(a)',
  '401k': '401(k)',
  '403b': '403(b)',
  '457b': '457(b)',
  '529': '529 plan',
  roth: 'Roth IRA',
  'roth 401k': 'Roth 401(k)',
  student: 'Student loan',
  auto: 'Auto loan',
  'non-taxable brokerage account': 'Non-taxable brokerage',
};
/** Abbreviations kept in capitals (CD, IRA, HSA, SEP IRA, RRSP, …). */
const ACRONYMS = new Set(['cd', 'ira', 'hsa', 'hra', 'sep', 'sarsep', 'simple', 'ugma', 'utma', 'esa', 'tsp', 'nqdc', 'ebt', 'gic', 'isa', 'sipp', 'rrsp', 'rrif', 'tfsa', 'resp', 'rdsp', 'lira', 'lif', 'lrif', 'lrsp', 'prif', 'rlif']);
const TYPE_KIND: Record<string, string> = {
  depository: 'Bank account',
  investment: 'Investments',
  property: 'Property',
  credit: 'Credit',
  loan: 'Loan',
  other: 'Other',
};

/** An account's kind for display: "Checking", "401(k)", "Roth IRA", or its type when there's no subtype. */
export function accountKind(type: string, subtype: string | null): string {
  if (!subtype) return TYPE_KIND[type] ?? sentence(type);
  const known = SUBTYPE_LABELS[subtype.toLowerCase()];
  if (known) return known;
  const words = subtype.toLowerCase().split(' ').map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
  return sentence(words.join(' '));
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

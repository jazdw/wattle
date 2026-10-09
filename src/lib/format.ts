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

export function relativeTime(epochMs: number | null): string {
  if (!epochMs) return 'never';
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function quantity(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: value < 10 ? 4 : 2 }).format(value);
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

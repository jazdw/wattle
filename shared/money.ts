/**
 * Money helpers. Amounts are stored and passed around as integer minor units
 * (cents) together with an ISO currency code, so sums are exact.
 */

export const CURRENCIES = ['USD', 'AUD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/** A currency's English name from its ISO 4217 code ("USD" → "US Dollar"); the code if unknown. */
export function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'currency' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

export function fromMinor(minor: number): number {
  return minor / 100;
}

/**
 * Rates keyed `${from}->${to}`; a rate converts one unit of `from` into `to`.
 * Same-currency conversion is always 1.
 */
export type FxRates = Partial<Record<`${Currency}->${Currency}`, number>>;

export function fxRate(rates: FxRates, from: Currency, to: Currency): number | null {
  if (from === to) return 1;
  const direct = rates[`${from}->${to}`];
  if (direct) return direct;
  const inverse = rates[`${to}->${from}`];
  return inverse ? 1 / inverse : null;
}

/** Convert minor units between currencies. Unknown rates fall back to 1:1 and are reported. */
export function convertMinor(
  minor: number,
  from: Currency,
  to: Currency,
  rates: FxRates,
): number {
  const rate = fxRate(rates, from, to);
  return Math.round(minor * (rate ?? 1));
}

/** How each currency is written: its locale picks the symbol and separators ("$" for AUD in en-AU, "A$" elsewhere). */
const CURRENCY_LOCALES: Record<Currency, string> = {
  USD: 'en-US',
  AUD: 'en-AU',
};

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * Format minor units for display: in full with the currency's own decimal places
 * (cents for USD and AUD), or compact ("$1.2M") where space is tight.
 */
export function formatMoney(
  minor: number,
  currency: Currency,
  options: { compact?: boolean; signed?: boolean } = {},
): string {
  const key = `${currency}:${options.compact}:${options.signed}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(CURRENCY_LOCALES[currency], {
      style: 'currency',
      currency,
      ...(options.compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}),
      signDisplay: options.signed ? 'exceptZero' : 'auto',
    });
    formatters.set(key, formatter);
  }
  return formatter.format(minor / 100);
}

export function formatPercent(fraction: number, digits = 1, signed = false): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(fraction);
}

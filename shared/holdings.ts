/**
 * How a holding is named wherever it's shown. Short where space is tight (a
 * chart's legend, a table cell with its name under it): its ticker, or its
 * name when it has no market ticker, as a CUSIP tells you nothing. Long on
 * its own line (a tooltip, a title, a log): the ticker and the name.
 */

export interface NamedSecurity {
  ticker?: string | null;
  name?: string | null;
  cusip?: string | null;
  isin?: string | null;
}

/** A CUSIP (nine letters and digits): what a fund with no market ticker (a plan's own fund) is stored under in place of one. */
const CUSIP = /^(?=.*\d)[0-9A-Z]{9}$/;

/** Whether an identifier is a CUSIP (a file's id for a security): one stored on a security matches it in later files. */
export function isCusip(id: string): boolean {
  return CUSIP.test(id);
}

/** Its market ticker; null for one stored under its CUSIP. */
export function marketTicker(security: NamedSecurity): string | null {
  const ticker = security.ticker?.trim();
  return ticker && !CUSIP.test(ticker) ? ticker : null;
}

/** What identifies it in short: its market ticker, else its CUSIP or ISIN (a bond, a plan's own fund); null with none. */
export function holdingSymbol(security: NamedSecurity): string | null {
  return marketTicker(security) ?? (security.ticker?.trim() || security.cusip || security.isin || null);
}

/**
 * Its name for showing. `long` (the default): "VTI · Vanguard Total Stock
 * Market ETF". `short`: "VTI". Either way one with no market ticker is its
 * name alone, and one with no name its symbol.
 */
export function holdingLabel(security: NamedSecurity, size: 'short' | 'long' = 'long'): string {
  const { short, detail } = holdingParts(security);
  return size === 'long' && detail ? `${short} · ${detail}` : short;
}

/** The short label, and what the long one adds to it (its name, for one with a ticker; null when it adds nothing): for two lines, the name under the ticker. */
export function holdingParts(security: NamedSecurity): { short: string; detail: string | null } {
  const name = security.name?.trim() || null;
  const ticker = marketTicker(security);
  if (ticker) return { short: ticker, detail: name && name.toUpperCase() !== ticker.toUpperCase() ? name : null };
  return { short: name ?? holdingSymbol(security) ?? 'Unknown security', detail: null };
}

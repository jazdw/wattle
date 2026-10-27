/**
 * Rebuild daily positions for an investment account by walking its
 * transactions backwards from today's holdings. Pure: no I/O.
 *
 * End-of-day state for day D is today's state with every transaction dated
 * after D undone. Undoing a transaction subtracts its quantity from its
 * security; when the account holds cash as a security (Plaid's CUR:USD or a
 * cash-type sweep), cash is rebuilt from transaction amounts too (Plaid
 * amounts are positive when cash leaves the account), in integer cents so the
 * sums are exact.
 *
 * A share split (`splitFactor`, on the first day at the new price) is undone
 * the same way: walking back past it divides that security's shares by the
 * factor, so the days before it have the shares actually held then.
 *
 * Gaps in the institution's history show up as impossible states (negative
 * quantities). They are clamped to zero and that day and every earlier day
 * is marked `unmatched`.
 *
 * With a window (`emitFrom`/`emitTo`), only the days inside it are priced and
 * returned: the walk from today still covers every day (undoing transactions
 * is cheap; pricing and building rows is what costs), so a window's days are
 * exactly those of the full rebuild. That's what lets a history load run as
 * independent jobs, one window each.
 */
import { addDays, type IsoDate } from '../../shared/dates';
import { fromMinor, toMinor } from '../../shared/money';
import type { PriceSource } from '../../shared/quality';

export interface BackfillHolding {
  securityId: string;
  quantity: number;
}

export interface BackfillTransaction {
  date: IsoDate;
  securityId: string | null;
  quantity: number;
  /** Minor units, positive when cash leaves the account. */
  amount: number;
}

export interface PriceResult {
  price: number;
  source: PriceSource;
}

export interface BackfillInput {
  start: IsoDate;
  end: IsoDate;
  holdings: BackfillHolding[];
  transactions: BackfillTransaction[];
  cashSecurityId: string | null;
  price: (securityId: string, date: IsoDate) => PriceResult | null;
  /** Shares after per share before for a split taking effect on `date` (1 when none). */
  splitFactor?: (securityId: string, date: IsoDate) => number;
  /** Return only days from here (default: start). */
  emitFrom?: IsoDate;
  /** Return only days up to here (default: end). */
  emitTo?: IsoDate;
  /**
   * Cash may go below zero (a fee charged before money arrives) without
   * counting as a gap: for an institution's own complete records, not
   * Plaid's, where it usually means transactions are missing.
   */
  allowNegativeCash?: boolean;
}

export interface BackfillPosition {
  securityId: string;
  quantity: number;
  price: number | null;
  value: number;
  /** Null when there was no price at all (valued at zero). */
  priceSource: PriceSource | null;
}

export interface BackfillDay {
  date: IsoDate;
  positions: BackfillPosition[];
  total: number;
  /** On or before a day the walk found impossible (a gap in the transactions). */
  unmatched: boolean;
}

const EPSILON = 1e-6;

export function reconstructHistory(input: BackfillInput): BackfillDay[] {
  // Shares per security; the cash security's entry is in cents instead.
  const cashId = input.cashSecurityId;
  const quantities = new Map<string, number>();
  for (const holding of input.holdings) {
    quantities.set(holding.securityId, (quantities.get(holding.securityId) ?? 0) + holding.quantity);
  }
  if (cashId) quantities.set(cashId, toMinor(quantities.get(cashId) ?? 0));
  const isEmpty = (securityId: string, quantity: number) => (securityId === cashId ? quantity === 0 : Math.abs(quantity) < EPSILON);

  const byDate = new Map<IsoDate, BackfillTransaction[]>();
  for (const txn of input.transactions) {
    if (txn.date > input.end || txn.date < input.start) continue;
    const list = byDate.get(txn.date) ?? [];
    list.push(txn);
    byDate.set(txn.date, list);
  }

  const emitFrom = input.emitFrom ?? input.start;
  const emitTo = input.emitTo ?? input.end;
  const days: BackfillDay[] = [];
  let broken = false;
  // The earliest day the account held anything: days before it are dropped.
  let firstHeld: IsoDate | null = null;

  for (let date = input.end; date >= input.start; date = addDays(date, -1)) {
    let held = false;
    for (const [securityId, quantity] of quantities) held ||= !isEmpty(securityId, quantity);
    if (held) firstHeld = date;
    if (date >= emitFrom && date <= emitTo) {
      const positions: BackfillPosition[] = [];
      let total = 0;
      for (const [securityId, quantity] of quantities) {
        if (isEmpty(securityId, quantity)) continue;
        if (securityId === cashId) {
          // Below zero only when allowed (allowNegativeCash): an amount owed.
          total += quantity;
          positions.push({ securityId, quantity: fromMinor(quantity), price: 1, value: quantity, priceSource: 'close' });
          continue;
        }
        const priced = input.price(securityId, date);
        const value = priced ? Math.round(quantity * priced.price * 100) : 0;
        total += value;
        positions.push({ securityId, quantity, price: priced?.price ?? null, value, priceSource: priced?.source ?? null });
      }
      days.push({ date, positions, total, unmatched: broken });
    }

    // Undo this day's transactions to get the previous day's closing state.
    for (const txn of byDate.get(date) ?? []) {
      if (txn.securityId === cashId && cashId) {
        quantities.set(cashId, quantities.get(cashId)! - toMinor(txn.quantity));
      } else if (txn.securityId) {
        quantities.set(txn.securityId, (quantities.get(txn.securityId) ?? 0) - txn.quantity);
      }
      if (cashId && txn.securityId !== cashId) {
        quantities.set(cashId, quantities.get(cashId)! + txn.amount);
      }
    }
    // And a split that took effect today: the day before had fewer shares.
    if (input.splitFactor) {
      for (const [securityId, quantity] of quantities) {
        if (securityId === cashId) continue;
        const factor = input.splitFactor(securityId, date);
        if (factor !== 1 && factor > 0) quantities.set(securityId, quantity / factor);
      }
    }
    for (const [securityId, quantity] of quantities) {
      if (securityId === cashId ? quantity < 0 && !input.allowNegativeCash : quantity < -EPSILON) {
        quantities.set(securityId, 0);
        broken = true;
      }
    }
  }

  // Drop days before the account held anything.
  return days.filter((day) => firstHeld !== null && day.date >= firstHeld).reverse();
}

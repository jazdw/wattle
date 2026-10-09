/**
 * Rebuild daily positions for an investment account by walking its
 * transactions backwards from today's holdings. Pure: no I/O.
 *
 * End-of-day state for day D is today's state with every transaction dated
 * after D undone. Undoing a transaction subtracts its quantity from its
 * security; when the account holds cash as a security (Plaid's CUR:USD or a
 * cash-type sweep), cash is rebuilt from transaction amounts too (Plaid
 * amounts are positive when cash leaves the account).
 *
 * Gaps in the institution's history show up as impossible states (negative
 * quantities). They are clamped to zero and that day and every earlier day
 * is marked `estimated`.
 */
import { addDays, type IsoDate } from '../../shared/dates';

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
  /** The price is a stand-in (no market history for this day). */
  estimated: boolean;
}

export interface BackfillInput {
  start: IsoDate;
  end: IsoDate;
  holdings: BackfillHolding[];
  transactions: BackfillTransaction[];
  cashSecurityId: string | null;
  price: (securityId: string, date: IsoDate) => PriceResult | null;
}

export interface BackfillPosition {
  securityId: string;
  quantity: number;
  price: number | null;
  value: number;
  estimated: boolean;
}

export interface BackfillDay {
  date: IsoDate;
  positions: BackfillPosition[];
  total: number;
  estimated: boolean;
}

const EPSILON = 1e-6;

export function reconstructHistory(input: BackfillInput): BackfillDay[] {
  const quantities = new Map<string, number>();
  for (const holding of input.holdings) {
    quantities.set(holding.securityId, (quantities.get(holding.securityId) ?? 0) + holding.quantity);
  }
  if (input.cashSecurityId && !quantities.has(input.cashSecurityId)) quantities.set(input.cashSecurityId, 0);

  const byDate = new Map<IsoDate, BackfillTransaction[]>();
  for (const txn of input.transactions) {
    if (txn.date > input.end || txn.date < input.start) continue;
    const list = byDate.get(txn.date) ?? [];
    list.push(txn);
    byDate.set(txn.date, list);
  }

  const days: BackfillDay[] = [];
  let broken = false;

  for (let date = input.end; date >= input.start; date = addDays(date, -1)) {
    const positions: BackfillPosition[] = [];
    let total = 0;
    let dayEstimated = broken;
    for (const [securityId, quantity] of quantities) {
      if (Math.abs(quantity) < EPSILON) continue;
      const priced = securityId === input.cashSecurityId ? { price: 1, estimated: false } : input.price(securityId, date);
      const value = priced ? Math.round(quantity * priced.price * 100) : 0;
      const estimated = broken || !priced || priced.estimated;
      dayEstimated ||= estimated;
      total += value;
      positions.push({ securityId, quantity, price: priced?.price ?? null, value, estimated });
    }
    days.push({ date, positions, total, estimated: dayEstimated });

    // Undo this day's transactions to get the previous day's closing state.
    for (const txn of byDate.get(date) ?? []) {
      if (txn.securityId) {
        quantities.set(txn.securityId, (quantities.get(txn.securityId) ?? 0) - txn.quantity);
      }
      if (input.cashSecurityId && txn.securityId !== input.cashSecurityId) {
        quantities.set(input.cashSecurityId, (quantities.get(input.cashSecurityId) ?? 0) + txn.amount / 100);
      }
    }
    for (const [securityId, quantity] of quantities) {
      if (quantity < -EPSILON) {
        quantities.set(securityId, 0);
        broken = true;
      }
    }
  }

  // Drop days before the account held anything.
  let first = days.length - 1;
  while (first >= 0 && days[first].positions.length === 0) first -= 1;
  return days.slice(0, first + 1).reverse();
}

/**
 * Transfers between the household's own accounts: money out of one account
 * matched to the same money into another, so the household counts it as
 * neither new money nor spending, and on one date in its totals.
 *
 * A pair is a candidate when both are money in or out (by their kind,
 * shared/transactionKinds.ts), in different accounts, in the same currency,
 * equal and opposite to the cent, and within MATCH_DAYS of each other either
 * way (money can arrive before the other bank shows it leaving). When a
 * transaction has exactly one candidate and that one has only it, they're
 * linked automatically; so are two whose descriptions quote the same
 * reference number (a bank's transfer between its own accounts), or where
 * one names the other's institution, whatever else is near; and identical ones that can't be told apart (two of the
 * same amount out of one account and into another on the same days) are
 * paired in order, as is one whose candidates are all alike (any would be
 * the same). Otherwise each pair is suggested for you to check.
 * Pairs you confirmed or rejected are never changed.
 */
import { eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { IsoDate } from '../../shared/dates';
import { kindOf } from '../../shared/transactionKinds';
import { inChunks, runAtomic } from '../db/batch';
import { accounts, jobs, securities, transactions, transfers } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { enqueue, type JobContext } from './jobRunner';
import { isCashSecurity } from './valuation';

/** Days apart that a transfer's two sides may be dated. */
export const MATCH_DAYS = 5;
/** Days apart that a transfer you link by hand may be. */
export const CANDIDATE_DAYS = 10;

const DAY_MS = 86_400_000;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

export interface MoneyMove {
  id: string;
  accountId: string;
  date: string;
  /** Cents, positive when money leaves the account. */
  amount: number;
  currency: string;
  description?: string | null;
  /** The account's institution, which the other side's description may name. */
  institution?: string | null;
}

/** The household's money in and out (by kind) in visible accounts. */
export async function moneyMoves(tenant: Tenant): Promise<MoneyMove[]> {
  const rows = await tenant.db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      date: transactions.date,
      amount: transactions.amount,
      currency: transactions.currency,
      source: transactions.source,
      kind: transactions.kind,
      type: transactions.type,
      subtype: transactions.subtype,
      quantity: transactions.quantity,
      description: transactions.description,
      institution: accounts.institutionName,
      securityType: securities.type,
      ticker: securities.ticker,
      hasSecurity: securities.id,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(securities, eq(securities.id, transactions.securityId))
    .where(tenant.scope(transactions, eq(accounts.isHidden, false)));
  return rows
    .filter((row) => row.amount !== 0)
    .filter((row) => {
      const kind = kindOf(row, row.hasSecurity !== null && isCashSecurity({ ticker: row.ticker, type: row.securityType }));
      return kind === 'deposit' || kind === 'withdrawal';
    })
    .map(({ id, accountId, date, amount, currency, description, institution }) => ({ id, accountId, date, amount, currency, description, institution }));
}

/** Each pair that could be one transfer: `out` leaves one account, `in` arrives in another. */
export function candidatePairs(moves: MoneyMove[], days = MATCH_DAYS): { outId: string; inId: string }[] {
  const arrivals = new Map<string, MoneyMove[]>();
  for (const move of moves) {
    if (move.amount >= 0) continue;
    const key = `${move.currency}:${-move.amount}`;
    arrivals.set(key, [...(arrivals.get(key) ?? []), move]);
  }
  return moves.flatMap((out) =>
    out.amount > 0 ? (arrivals.get(`${out.currency}:${out.amount}`) ?? []).filter((arrival) => arrival.accountId !== out.accountId && daysApart(arrival.date, out.date) <= days).map((arrival) => ({ outId: out.id, inId: arrival.id })) : [],
  );
}

/** Long numbers in a description (nine digits or more, so not a date): a bank's reference for the transfer, quoted on both sides. */
export function references(description: string | null | undefined): string[] {
  return description?.match(/\d{9,}/g) ?? [];
}

/** Words too common in institution names to recognise one by. */
const GENERIC = new Set(['bank', 'banks', 'banking', 'credit', 'union', 'federal', 'national', 'savings', 'trust', 'financial', 'investments', 'investment', 'securities', 'group', 'first', 'community', 'america', 'american', 'united', 'state', 'company', 'services', 'retirement']);

/**
 * Whether a description names an institution: the first distinctive word of
 * its name (four letters or more, not one common to many: "Example" from
 * "Example Bank", "Contoso" from "Bank of Contoso"), as a word.
 */
export function names(description: string | null | undefined, institution: string | null | undefined): boolean {
  const word = institution?.match(/[A-Za-z]{4,}/g)?.find((candidate) => !GENERIC.has(candidate.toLowerCase()));
  return Boolean(word && description && new RegExp(`\\b${word}\\b`, 'i').test(description));
}

/** Pair each transfer it can (see the top): linked when there's only one way to, suggested when there's more. */
export async function matchTransfers(deps: Deps, tenant: Tenant): Promise<{ auto: number; suggested: number }> {
  const existing = await tenant.db.select().from(transfers).where(tenant.scope(transfers));
  const linked = new Set(existing.filter((row) => row.status === 'auto' || row.status === 'confirmed').flatMap((row) => [row.outId, row.inId]));
  const rejected = new Set(existing.filter((row) => row.status === 'rejected').map((row) => `${row.outId}|${row.inId}`));
  const moves = (await moneyMoves(tenant)).filter((move) => !linked.has(move.id));
  const pairs = candidatePairs(moves).filter((pair) => !rejected.has(`${pair.outId}|${pair.inId}`));

  const count = (list: { outId: string; inId: string }[], side: 'outId' | 'inId') => list.reduce((map, pair) => map.set(pair[side], (map.get(pair[side]) ?? 0) + 1), new Map<string, number>());
  const only = (list: { outId: string; inId: string }[]) => {
    const outs = count(list, 'outId');
    const ins = count(list, 'inId');
    return list.filter((pair) => outs.get(pair.outId) === 1 && ins.get(pair.inId) === 1);
  };
  // Both sides quoting the same reference number (a bank's own transfer between its accounts) settle a pair even beside others.
  const byId = new Map(moves.map((move) => [move.id, move]));
  const sharedReference = (pair: { outId: string; inId: string }) => {
    const [out, arrival] = [byId.get(pair.outId), byId.get(pair.inId)];
    const theirs = new Set(references(arrival?.description));
    // Or one side's description names the other's institution ("Example Brokerage payments"), when they're different banks.
    return references(out?.description).some((reference) => theirs.has(reference)) || (out?.institution !== arrival?.institution && (names(out?.description, arrival?.institution) || names(arrival?.description, out?.institution)));
  };
  const referenced = only(pairs.filter(sharedReference));
  const settled = new Set(referenced.flatMap((pair) => [pair.outId, pair.inId]));
  const rest = pairs.filter((pair) => !settled.has(pair.outId) && !settled.has(pair.inId));
  const unique = only(rest);
  const twins = interchangeable(rest.filter((pair) => !unique.includes(pair)), byId);
  const alike = indistinguishable(rest.filter((pair) => !unique.includes(pair) && !twins.some((twin) => twin.outId === pair.outId || twin.inId === pair.inId)), byId);
  const auto = [...referenced, ...unique, ...twins, ...alike];
  const paired = new Set(auto.flatMap((pair) => [pair.outId, pair.inId]));
  const suggested = rest.filter((pair) => !paired.has(pair.outId) && !paired.has(pair.inId));
  const wanted = new Set(suggested.map((pair) => `${pair.outId}|${pair.inId}`));
  const now = deps.now().getTime();

  const statements: BatchItem<'sqlite'>[] = [
    // Suggestions no longer wanted (a side linked elsewhere, or gone).
    ...inChunks(existing.filter((row) => row.status === 'suggested' && !wanted.has(`${row.outId}|${row.inId}`)).map((row) => row.id)).map((ids) => tenant.db.delete(transfers).where(tenant.scope(transfers, inArray(transfers.id, ids)))),
    ...auto.map((pair) =>
      tenant.db
        .insert(transfers)
        .values({ id: crypto.randomUUID(), householdId: tenant.householdId, ...pair, status: 'auto', createdAt: now })
        .onConflictDoUpdate({ target: [transfers.outId, transfers.inId], set: { status: 'auto' }, setWhere: eq(transfers.status, 'suggested') }),
    ),
    ...suggested.map((pair) => tenant.db.insert(transfers).values({ id: crypto.randomUUID(), householdId: tenant.householdId, ...pair, status: 'suggested', createdAt: now }).onConflictDoNothing()),
  ];
  if (statements.length > 0) await runAtomic(tenant.db, statements);
  return { auto: auto.length, suggested: suggested.length };
}

/**
 * Pairs among transfers that can't be told apart: as many identical ones out
 * of one account on one day as into another on one day, each a candidate for
 * each and for nothing else. Any pairing is the same, so they're paired in order.
 */
function interchangeable(pairs: { outId: string; inId: string }[], byId: Map<string, MoneyMove>): { outId: string; inId: string }[] {
  const key = (pair: { outId: string; inId: string }) => {
    const out = byId.get(pair.outId)!;
    const arrival = byId.get(pair.inId)!;
    return [out.accountId, out.date, arrival.accountId, arrival.date, out.amount].join('|');
  };
  const groups = new Map<string, { outId: string; inId: string }[]>();
  for (const pair of pairs) groups.set(key(pair), [...(groups.get(key(pair)) ?? []), pair]);
  return [...groups.values()].flatMap((group) => {
    const outs = [...new Set(group.map((pair) => pair.outId))].sort();
    const ins = [...new Set(group.map((pair) => pair.inId))].sort();
    const elsewhere = pairs.some((pair) => !group.includes(pair) && (outs.includes(pair.outId) || ins.includes(pair.inId)));
    return outs.length === ins.length && group.length === outs.length * ins.length && !elsewhere ? outs.map((outId, index) => ({ outId, inId: ins[index] })) : [];
  });
}

/**
 * One transaction whose candidates on the other side are all alike (the
 * same account, day, amount and description) and are candidates for it
 * alone: whichever is linked, the rest are the same money, so the first is.
 */
function indistinguishable(pairs: { outId: string; inId: string }[], byId: Map<string, MoneyMove>): { outId: string; inId: string }[] {
  const looks = (move: MoneyMove) => [move.accountId, move.date, move.amount, move.description ?? ''].join('|');
  const linked: { outId: string; inId: string }[] = [];
  const taken = new Set<string>();
  for (const [side, other] of [['outId', 'inId'], ['inId', 'outId']] as const) {
    const bySide = new Map<string, { outId: string; inId: string }[]>();
    for (const pair of pairs) bySide.set(pair[side], [...(bySide.get(pair[side]) ?? []), pair]);
    for (const [id, group] of bySide) {
      if (group.length < 2 || taken.has(id)) continue;
      const candidates = group.map((pair) => pair[other]);
      const alike = new Set(candidates.map((candidate) => looks(byId.get(candidate)!))).size === 1;
      const theirsAlone = candidates.every((candidate) => pairs.every((pair) => pair[other] !== candidate || pair[side] === id));
      if (!alike || !theirsAlone || candidates.some((candidate) => taken.has(candidate))) continue;
      const pick = [...candidates].sort()[0];
      linked.push(side === 'outId' ? { outId: id, inId: pick } : { outId: pick, inId: id });
      taken.add(id);
      taken.add(pick);
    }
  }
  return linked;
}

/** match_transfers: pair the household's transfers. */
export async function matchTransfersJob({ deps, tenant }: JobContext): Promise<Record<string, unknown>> {
  return matchTransfers(deps, tenant);
}

/**
 * Queue matching after new transactions: `key` names what brought them (a
 * sync, a report, an import), and `waitsFor` a group of jobs writing them.
 * Nothing's added while a match not yet started is queued for the household.
 */
export async function queueMatching(deps: Deps, tenant: Tenant, key: string, waitsFor?: string): Promise<void> {
  if (!waitsFor) {
    const [pending] = await tenant.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(tenant.scope(jobs, eq(jobs.type, 'match_transfers'), eq(jobs.status, 'queued')))
      .limit(1);
    if (pending) return;
  }
  await enqueue(deps, tenant, [{ id: `match:${key}`, type: 'match_transfers', payload: {}, ...(waitsFor ? { waitsFor } : {}) }]);
}

/** Linked transfers between visible accounts, each side's account, date and amount. */
export async function linkedTransfers(tenant: Tenant): Promise<{ id: string; status: 'auto' | 'confirmed'; out: MoneyMove; in: MoneyMove }[]> {
  const rows = await tenant.db
    .select({ id: transfers.id, status: transfers.status, outId: transfers.outId, inId: transfers.inId })
    .from(transfers)
    .where(tenant.scope(transfers, inArray(transfers.status, ['auto', 'confirmed'])));
  return pairsWithMoves(tenant, rows) as Promise<{ id: string; status: 'auto' | 'confirmed'; out: MoneyMove; in: MoneyMove }[]>;
}

/** Transfers with both sides' details (only those whose accounts are both visible). */
export async function pairsWithMoves<T extends { outId: string; inId: string }>(tenant: Tenant, rows: T[]): Promise<(Omit<T, 'outId' | 'inId'> & { out: MoneyMove; in: MoneyMove })[]> {
  const ids = [...new Set(rows.flatMap((row) => [row.outId, row.inId]))];
  const found = new Map<string, MoneyMove>();
  for (const chunk of inChunks(ids)) {
    const moves = await tenant.db
      .select({ id: transactions.id, accountId: transactions.accountId, date: transactions.date, amount: transactions.amount, currency: transactions.currency })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(tenant.scope(transactions, inArray(transactions.id, chunk), eq(accounts.isHidden, false)));
    for (const move of moves) found.set(move.id, move);
  }
  return rows.flatMap(({ outId, inId, ...rest }) => (found.has(outId) && found.has(inId) ? [{ ...rest, out: found.get(outId)!, in: found.get(inId)! }] : []));
}

/**
 * Per date, the household's correction for linked transfers in transit: a
 * transfer that arrives before it leaves is counted in both accounts until
 * it leaves (taken off once); one that leaves first is in neither until it
 * arrives (added). `convert` takes its cents to the display currency's.
 */
export function inTransit(dates: IsoDate[], linked: { out: MoneyMove; in: MoneyMove }[], convert: (minor: number, from: string, date: IsoDate) => number): number[] {
  const transit = dates.map(() => 0);
  for (const pair of linked) {
    if (pair.in.date === pair.out.date) continue;
    const arrivesFirst = pair.in.date < pair.out.date;
    const from = arrivesFirst ? pair.in.date : pair.out.date;
    const until = arrivesFirst ? pair.out.date : pair.in.date;
    dates.forEach((date, index) => {
      if (date >= from && date < until) transit[index] += (arrivesFirst ? -1 : 1) * convert(pair.out.amount, pair.out.currency, date);
    });
  }
  return transit;
}

/** Whether a pair could be linked by hand: money out and the same money in, in two accounts, near enough. */
export function linkable(out: MoneyMove, arrival: MoneyMove): string | null {
  if (out.accountId === arrival.accountId) return 'A transfer is between two accounts.';
  if (out.currency !== arrival.currency) return 'A transfer is in one currency.';
  if (!(out.amount > 0 && arrival.amount === -out.amount)) return 'A transfer is money out of one account and the same money into the other.';
  if (daysApart(out.date, arrival.date) > CANDIDATE_DAYS) return `A transfer's two sides are within ${CANDIDATE_DAYS} days of each other.`;
  return null;
}


/**
 * Transactions (the kind you set on one) and transfers between your
 * accounts (those to check, and linking or unlinking two yourself).
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { transactionPatchSchema, transferCreateSchema, transferPatchSchema } from '../../shared/schemas';
import type { Currency } from '../../shared/money';
import type { TransferCandidatesResponse, TransferSide, TransfersResponse } from '../../shared/types';
import { requireAuth } from '../auth/routes';
import { inChunks, runAtomic } from '../db/batch';
import { accounts, transactions, transfers } from '../db/schema';
import type { Tenant } from '../db/tenant';
import type { AppEnv } from '../env';
import { HttpError, notFound, readBody } from '../lib/http';
import { listTransactions } from '../services/transactionList';
import { linkable, moneyMoves, pairsWithMoves, type MoneyMove } from '../services/transfers';

export const transactionRoutes = new Hono<AppEnv>();
transactionRoutes.use('*', requireAuth);

/** Every visible account's transactions, newest first, filtered as an account's are. */
transactionRoutes.get('/', async (c) => {
  const tenant = c.get('tenant');
  return c.json(await listTransactions(tenant, null, { from: c.req.query('from'), to: c.req.query('to'), q: c.req.query('q') }));
});

transactionRoutes.patch('/:id', async (c) => {
  const tenant = c.get('tenant');
  const body = await readBody(c, transactionPatchSchema);
  const [updated] = await tenant.db
    .update(transactions)
    .set({ kind: body.kind })
    .where(tenant.scope(transactions, eq(transactions.id, c.req.param('id'))))
    .returning({ id: transactions.id });
  if (!updated) notFound('Transaction not found.');
  return c.json({ ok: true });
});

/** Money moving the other way, the same amount, in another account, near enough in date, and not in a transfer already. */
transactionRoutes.get('/:id/candidates', async (c) => {
  const tenant = c.get('tenant');
  const moves = await moneyMoves(tenant);
  const self = moves.find((move) => move.id === c.req.param('id'));
  if (!self) notFound('Transaction not found, or not money in or out.');
  const linked = await linkedIds(tenant);
  const others = moves.filter((move) => !linked.has(move.id) && (self.amount > 0 ? linkable(self, move) : linkable(move, self)) === null);
  const response: TransferCandidatesResponse = { candidates: await sides(tenant, others) };
  return c.json(response);
});

export const transferRoutes = new Hono<AppEnv>();
transferRoutes.use('*', requireAuth);

transferRoutes.get('/', async (c) => {
  const tenant = c.get('tenant');
  const status = c.req.query('status') === 'linked' ? (['auto', 'confirmed'] as const) : (['suggested'] as const);
  const rows = await tenant.db
    .select({ id: transfers.id, status: transfers.status, outId: transfers.outId, inId: transfers.inId })
    .from(transfers)
    .where(tenant.scope(transfers, inArray(transfers.status, [...status])));
  const pairs = await pairsWithMoves(tenant, rows);
  const described = new Map((await sides(tenant, pairs.flatMap((pair) => [pair.out, pair.in]))).map((side) => [side.transactionId, side]));
  const response: TransfersResponse = {
    transfers: pairs.map((pair) => ({ id: pair.id, status: pair.status, out: described.get(pair.out.id)!, in: described.get(pair.in.id)! })).sort((a, b) => b.out.date.localeCompare(a.out.date)),
  };
  return c.json(response);
});

/** Link two transactions as one transfer yourself. */
transferRoutes.post('/', async (c) => {
  const tenant = c.get('tenant');
  const body = await readBody(c, transferCreateSchema);
  const moves = new Map((await moneyMoves(tenant)).map((move) => [move.id, move]));
  const out = moves.get(body.outId);
  const arrival = moves.get(body.inId);
  if (!out || !arrival) throw new HttpError(400, 'A transfer is between two transactions of money in or out.');
  const problem = linkable(out, arrival);
  if (problem) throw new HttpError(400, problem);
  const linked = await linkedIds(tenant);
  if (linked.has(out.id) || linked.has(arrival.id)) throw new HttpError(409, 'One of these is already in a transfer: unlink it first.');
  const now = c.env.deps.now().getTime();
  const id = crypto.randomUUID();
  await runAtomic(tenant.db, [
    // Other suggestions for either side go: this is the one.
    tenant.db.delete(transfers).where(tenant.scope(transfers, eq(transfers.status, 'suggested'), or(inArray(transfers.outId, [out.id, arrival.id]), inArray(transfers.inId, [out.id, arrival.id])))),
    tenant.db
      .insert(transfers)
      .values({ id, householdId: tenant.householdId, outId: out.id, inId: arrival.id, status: 'confirmed', createdAt: now, decidedAt: now })
      .onConflictDoUpdate({ target: [transfers.outId, transfers.inId], set: { status: 'confirmed', decidedAt: now } }),
  ]);
  return c.json({ ok: true });
});

/** It's a transfer (a suggestion confirmed), or it isn't (a suggestion or a link rejected). */
transferRoutes.patch('/:id', async (c) => {
  const tenant = c.get('tenant');
  const body = await readBody(c, transferPatchSchema);
  const [pair] = await tenant.db.select().from(transfers).where(tenant.scope(transfers, eq(transfers.id, c.req.param('id'))));
  if (!pair) notFound('Transfer not found.');
  const now = c.env.deps.now().getTime();
  if (body.status === 'rejected') {
    await tenant.db.update(transfers).set({ status: 'rejected', decidedAt: now }).where(tenant.scope(transfers, eq(transfers.id, pair.id)));
    return c.json({ ok: true });
  }
  const linked = await linkedIds(tenant);
  if (pair.status !== 'auto' && pair.status !== 'confirmed' && (linked.has(pair.outId) || linked.has(pair.inId))) throw new HttpError(409, 'One of these is already in a transfer: unlink it first.');
  await runAtomic(tenant.db, [
    tenant.db.update(transfers).set({ status: 'confirmed', decidedAt: now }).where(tenant.scope(transfers, eq(transfers.id, pair.id))),
    tenant.db.delete(transfers).where(tenant.scope(transfers, eq(transfers.status, 'suggested'), or(inArray(transfers.outId, [pair.outId, pair.inId]), inArray(transfers.inId, [pair.outId, pair.inId])))),
  ]);
  return c.json({ ok: true });
});

/** Transactions in a linked transfer. */
async function linkedIds(tenant: Tenant): Promise<Set<string>> {
  const rows = await tenant.db
    .select({ outId: transfers.outId, inId: transfers.inId })
    .from(transfers)
    .where(tenant.scope(transfers, inArray(transfers.status, ['auto', 'confirmed'])));
  return new Set(rows.flatMap((row) => [row.outId, row.inId]));
}

/** Transactions as transfer sides: with their account and description. */
async function sides(tenant: Tenant, moves: MoneyMove[]): Promise<TransferSide[]> {
  const found: TransferSide[] = [];
  for (const chunk of inChunks([...new Set(moves.map((move) => move.id))])) {
    const rows = await tenant.db
      .select({
        transactionId: transactions.id,
        accountId: transactions.accountId,
        accountName: accounts.name,
        institutionName: accounts.institutionName,
        mask: accounts.mask,
        date: transactions.date,
        amount: transactions.amount,
        currency: transactions.currency,
        description: transactions.description,
      })
      .from(transactions)
      .innerJoin(accounts, and(eq(accounts.id, transactions.accountId), eq(accounts.householdId, transactions.householdId)))
      .where(tenant.scope(transactions, inArray(transactions.id, chunk)));
    found.push(...rows.map((row) => ({ ...row, currency: row.currency as Currency })));
  }
  return found.sort((a, b) => a.date.localeCompare(b.date));
}


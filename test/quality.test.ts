import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../server/db/schema';
import { QUALITY_SET, replaceWhere } from '../server/services/quality';
import { DAILY_SOURCES, mayReplace } from '../shared/quality';
import { client, createHousehold, createTestDeps } from './helpers';

describe('replacing daily rows in SQL', () => {
  it('follows the same trust order as the code, for every pair of sources', async () => {
    const deps = await createTestDeps();
    const home = await createHousehold(deps, 'Home', 'me@example.com');
    const api = client(deps, home.cookie);
    const accountId = (await api('/api/accounts', { method: 'POST', json: { name: 'Savings', type: 'depository', currency: 'USD' } })).body.id as string;
    const row = (source: (typeof DAILY_SOURCES)[number], balance: number) => ({
      householdId: home.householdId,
      accountId,
      date: '2026-09-01',
      balance,
      currency: 'USD',
      source,
      priceSource: null,
      unmatched: false,
    });

    for (const current of DAILY_SOURCES) {
      for (const next of DAILY_SOURCES) {
        await deps.db.delete(schema.accountDaily).where(eq(schema.accountDaily.accountId, accountId));
        await deps.db.insert(schema.accountDaily).values(row(current, 1));
        await deps.db
          .insert(schema.accountDaily)
          .values(row(next, 2))
          .onConflictDoUpdate({
            target: [schema.accountDaily.accountId, schema.accountDaily.date],
            set: { balance: sql`excluded.balance`, ...QUALITY_SET },
            setWhere: replaceWhere(schema.accountDaily.source),
          });
        const [stored] = await deps.db.select().from(schema.accountDaily).where(eq(schema.accountDaily.accountId, accountId));
        expect({ current, next, replaced: stored.balance === 2 }).toEqual({ current, next, replaced: mayReplace(next, current) });
        expect(stored.source).toBe(mayReplace(next, current) ? next : current);
      }
    }
  });
});

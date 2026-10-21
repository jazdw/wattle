import { describe, expect, it } from 'vitest';
import { users } from '../db/schema';
import { createTestDeps } from '../../test/helpers';
import { describeError, describeErrorWithStack } from './errors';

async function failedQuery(): Promise<unknown> {
  const deps = await createTestDeps();
  const row = { id: 'u1', googleSub: 'sub-1', email: 'secret-person@example.com', name: 'Secret Person', createdAt: 1, lastLoginAt: 1 };
  await deps.db.insert(users).values(row);
  try {
    await deps.db.insert(users).values(row);
  } catch (error) {
    return error;
  }
  throw new Error('expected the duplicate insert to fail');
}

describe('describeError', () => {
  it("keeps a failed query's SQL and reason but not its values", async () => {
    const error = await failedQuery();
    expect(String((error as Error).message)).toContain('secret-person@example.com'); // what Drizzle puts in the message
    for (const described of [describeError(error), describeErrorWithStack(error)]) {
      expect(described).toContain('insert into "users"');
      expect(described).toMatch(/UNIQUE constraint failed/);
      expect(described).not.toContain('secret-person');
      expect(described).not.toContain('Secret Person');
    }
    expect(describeErrorWithStack(error)).toContain('    at ');
  });

  it('describes other errors by message, with their causes', () => {
    expect(describeError(new Error('outer', { cause: new Error('inner') }))).toBe('outer (cause: inner)');
    expect(describeError('plain')).toBe('plain');
  });
});

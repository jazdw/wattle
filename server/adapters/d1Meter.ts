/**
 * Counts the rows D1 says each query wrote (its result's meta.rows_written:
 * index entries included, as D1 bills and limits them), for the daily write
 * budget (services/writeBudget.ts). Wraps the D1 binding for one invocation.
 *
 * Results from raw() carry no meta, so those queries (Drizzle uses raw() for
 * selects and for writes with returning: small, single-row ones here) aren't
 * counted; the bulk writes go through batch() and run(), which are.
 * Typed structurally, so nothing here imports Cloudflare's types.
 */
import type { WriteMeter } from '../ports';

interface Meta {
  meta?: { rows_written?: number };
}

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<unknown>;
  all(): Promise<unknown>;
}

export interface D1Like {
  prepare(query: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

export function meteredD1<D extends D1Like>(db: D): { db: D; meter: WriteMeter } {
  let rows = 0;
  const count = <R>(result: R): R => {
    rows += (result as Meta)?.meta?.rows_written ?? 0;
    return result;
  };
  // Wrapped statements go to batch() unwrapped: D1 only accepts its own.
  const original = new WeakMap<object, Statement>();
  const wrap = (statement: Statement): Statement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === 'run' || property === 'all') return async () => count(await target[property]());
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    original.set(wrapped, statement);
    return wrapped;
  };
  const metered = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => wrap(target.prepare(query));
      if (property === 'batch') {
        return async (statements: Statement[]) => (await target.batch(statements.map((statement) => original.get(statement) ?? statement))).map(count);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: metered, meter: { rowsWritten: () => rows } };
}

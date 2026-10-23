/**
 * Every place that writes each table, reviewed for concurrency. A new write
 * path fails this test until it's added here, with the reason it's safe:
 * which lease it holds, or why it doesn't need one, and that its writes are
 * one atomic batch.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REVIEWED: Record<string, Record<string, string>> = {
  'server/services/sync.ts': {
    connections: 'connection lease; status via statusStatement (newest wins)',
    accounts: 'connection lease, in the sync pass batch',
    holdings: 'connection lease, in the sync pass batch',
    investmentTransactions: 'connection lease, in the sync pass batch',
    securities: 'connection lease; new ones get derived ids (shared across connections)',
  },
  'server/services/backfill.ts': {
    connections: 'connection lease (or marking a load due + note when busy)',
    accountDaily: 'connection lease; insert-or-ignore backfill rows, rebuild deletes only backfill rows',
    holdingDaily: 'connection lease; as accountDaily',
  },
  'server/services/assetReports.ts': {
    connections: 'connection lease, atomic with the balances and log row',
    accountDaily: 'connection lease, atomic with the status and log row (each account job: its balances only, replacing carried-forward rows; safe to repeat)',
    jobs: "moving a waiting report check's run_after to now: one conditional update; the job runner's claim still decides who runs it",
  },
  'server/routes/plaid.ts': {
    connections: 'webhooks: status via statusStatement (newest wins), consent warning and new-accounts columns; no lease needed',
  },
  'server/routes/accounts.ts': {
    connections: 'accounts chosen: clears only the new-accounts notice, and only one from before the request (single conditional update; nothing else writes it but the webhook)',
    accounts: 'create: atomic; rename/owner/category: single update; hide: connection + snapshot leases; delete: account lease (manual) or connection + snapshot leases, re-checked as no longer reported (linked); a different account than a suggested return: single update of its own column; confirmed return: connection + snapshot leases, re-checked',
    accountDaily: 'hide/purge: connection + snapshot leases; a confirmed return moves the new account\'s rows to the old one: connection + snapshot leases, re-checked, one atomic batch',
    holdingDaily: 'hide/purge: connection + snapshot leases; confirmed return: as accountDaily',
    holdings: 'manual holdings: account lease + version, atomic; confirmed return: as accountDaily',
    investmentTransactions: 'confirmed return: as accountDaily (the new account\'s transactions win an id both have)',
    securities: 'manual holdings: account lease; never modifies Plaid-owned rows; derived ids',
  },
  'server/routes/portfolio.ts': {
    holdingDaily: 'CSV import: one atomic batch',
    securities: 'classification edit: single update (syncs never touch classification); import: derived ids',
    targets: 'targets lease + version',
    households: 'settings: single update',
  },
  'server/services/balances.ts': {
    accountDaily: 'recorded balances and CSV imports: one atomic batch; imports never overwrite unless asked; manual accounts under the account lease',
    accounts: "manual account's current balance from its newest entry: account lease, atomic with dropping stale copies",
  },
  'server/services/snapshots.ts': {
    accountDaily: 'snapshot lease, atomic',
    holdingDaily: 'snapshot lease, atomic',
    accounts: 'manual balances from holdings: snapshot lease, atomic with the rows',
    snapshotRuns: 'log rows: written running under the snapshot lease (closing any left running, atomically), completed by id',
  },
  'server/services/lease.ts': { leases: 'the lease itself: conditional upserts and holder-checked updates' },
  'server/services/writeBudget.ts': { dbUsage: "the day's rows written: one upsert adding to the total, safe from any number of invocations at once" },
  'server/services/securityTypes.ts': {
    securities: 'nightly: fills type (and a ticker-only name) of hand-entered securities only where still unset; one batch',
  },
  'server/services/activity.ts': {
    syncRuns: 'log rows, written in the batch of the change they record (or alone for skipped/failed runs); running rows closed under the connection lease',
    priceRuns: 'pruning old entries',
    jobRuns: 'pruning old entries',
    snapshotRuns: 'pruning old entries',
  },
  'server/services/pricing.ts': {
    pricesDaily: 'public data; atomic with its price_runs row; last write wins with provider data',
    priceRuns: 'log rows, atomic with the prices they record',
    fxDaily: 'public data; insert-or-ignore, atomic with its log row',
  },
  'server/services/cache.ts': { kvCache: 'TTL cache; last write wins is fine' },
  'server/services/jobRunner.ts': {
    jobs: 'insert-or-ignore (fixed ids dedupe); claimed by one conditional update (queued and due, or lock expired); later writes only by the lock token holder; waiting jobs released by one conditional update per group',
  },
  'server/services/jobs.ts': {
    jobRuns: 'one row per nightly run, written running and completed by id; earlier rows left running marked interrupted',
    sessions: 'pruning expired sessions',
  },
  'server/auth/routes.ts': {
    users: 'single upsert on google_sub',
    households: 'first household has a fixed id (insert-or-ignore)',
    householdMembers: 'insert-or-ignore (one per user), then read back',
    sessions: 'one row per sign-in',
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('write paths', () => {
  it('every table write is in a reviewed place', () => {
    const found: string[] = [];
    for (const file of sourceFiles('server')) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\.(?:insert|update|delete)\((\w+)\)/g)) {
        const table = match[1];
        if (!REVIEWED[file]?.[table]) found.push(`${file} writes ${table}`);
      }
    }
    expect(found, 'Review these writes for concurrency, then list them in test/writes.test.ts').toEqual([]);
  });

  it('chunked (non-atomic) batches are used only for idempotent bulk writes', () => {
    const users = sourceFiles('server').filter((file) => file !== 'server/db/batch.ts' && /\brunBatch\(/.test(readFileSync(file, 'utf8')));
    // Pruning old log rows, history backfill rows (insert-or-ignore) and cache upserts.
    expect(users.sort()).toEqual(['server/services/activity.ts', 'server/services/backfill.ts', 'server/services/cache.ts']);
  });
});

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { cloudflareJobQueue, consumeJobs, localJobQueue } from '../server/adapters/jobQueues';
import * as schema from '../server/db/schema';
import { Tenant } from '../server/db/tenant';
import type { Deps } from '../server/ports';
import { LEASE_MS } from '../server/services/lease';
import {
  dueJobs,
  enqueue,
  pruneJobsStatement,
  RetryLater,
  runJobWith,
  sweep,
  type JobHandler,
  type JobHandlers,
} from '../server/services/jobRunner';
import { createHousehold, createTestDeps, wakes } from './helpers';

/** Handlers where every type runs `handler`. */
function handlersFor(handler: JobHandler): JobHandlers {
  return new Proxy({} as JobHandlers, { get: () => handler });
}

async function setup() {
  const deps = await createTestDeps();
  const home = await createHousehold(deps, 'Home', 'me@example.com');
  const tenant = new Tenant(deps.db, home.householdId);
  const job = async (id: string) => (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0];
  const later = (ms: number) => {
    const at = deps.now().getTime() + ms;
    deps.now = () => new Date(at);
  };
  return { deps, tenant, job, later };
}

const woken = (deps: Deps) => wakes(deps).flatMap((wake) => wake.ids.map((id) => ({ id, delaySeconds: wake.delaySeconds })));

describe('job runner', () => {
  it('adds jobs once, wakes the ones that can run, and records the result', async () => {
    const { deps, tenant, job } = await setup();
    await enqueue(deps, tenant, [
      { id: 'a', type: 'snapshot', payload: { n: 1 }, groupId: 'g' },
      { id: 'b', type: 'snapshot', payload: {}, waitsFor: 'g' },
    ]);
    await enqueue(deps, tenant, [{ id: 'a', type: 'snapshot', payload: { n: 2 } }]); // ignored
    expect(await job('a')).toMatchObject({ status: 'queued', payload: { n: 1 }, householdId: tenant.householdId });
    expect(await job('b')).toMatchObject({ status: 'waiting' });
    expect(woken(deps).map((wake) => wake.id)).toEqual(['a', 'a']);

    const seen: unknown[] = [];
    await runJobWith(deps, 'a', handlersFor(async ({ job: row, tenant: jobTenant }) => {
      seen.push(row.payload, jobTenant.householdId);
      return { days: 3 };
    }));
    expect(seen).toEqual([{ n: 1 }, tenant.householdId]);
    expect(await job('a')).toMatchObject({ status: 'done', attempts: 1, result: { days: 3 }, lockToken: null });
    // The group is finished, so what waited for it is queued and woken.
    expect(await job('b')).toMatchObject({ status: 'queued' });
    expect(woken(deps).at(-1)?.id).toBe('b');
  });

  it('retries a failed attempt after a backoff, then fails it, with the error scrubbed', async () => {
    const { deps, tenant, job, later } = await setup();
    await enqueue(deps, tenant, [{ id: 'j', type: 'sync', payload: {} }]);
    const failing = handlersFor(async () => {
      throw new Error('Plaid said no');
    });
    await runJobWith(deps, 'j', failing);
    expect(await job('j')).toMatchObject({ status: 'queued', attempts: 1, errorMessage: 'Plaid said no' });
    expect(woken(deps).at(-1)).toEqual({ id: 'j', delaySeconds: 60 });
    expect(await dueJobs(deps)).toEqual([]); // not before the backoff
    expect(await runJobWith(deps, 'j', failing)).toEqual({ retryInSeconds: 60 });

    later(61_000);
    await runJobWith(deps, 'j', failing);
    expect(woken(deps).at(-1)).toEqual({ id: 'j', delaySeconds: 300 });
    later(301_000);
    await runJobWith(deps, 'j', failing);
    expect(await job('j')).toMatchObject({ status: 'failed', attempts: 3, errorMessage: 'Plaid said no' });
  });

  it("doesn't count waiting (RetryLater) as an attempt", async () => {
    const { deps, tenant, job, later } = await setup();
    await enqueue(deps, tenant, [{ id: 'j', type: 'report_collect', payload: {}, maxAttempts: 1 }]);
    const notReady = handlersFor(async () => {
      throw new RetryLater(600, 'Plaid is still preparing the report.');
    });
    for (let round = 0; round < 3; round += 1) {
      await runJobWith(deps, 'j', notReady);
      expect(await job('j')).toMatchObject({ status: 'queued', attempts: 0 });
      later(601_000);
    }
    await runJobWith(deps, 'j', handlersFor(async () => ({ ok: true })));
    expect(await job('j')).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('runs again an attempt that was stopped part-way, and gives up after max_attempts as INTERRUPTED', async () => {
    const { deps, tenant, job, later } = await setup();
    await enqueue(deps, tenant, [{ id: 'j', type: 'history_block', payload: {}, groupId: 'g' }, { id: 'next', type: 'history_finish', payload: {}, waitsFor: 'g' }]);
    const stopped = handlersFor(() => new Promise(() => {})); // never returns, like a Worker stopped mid-way
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      void runJobWith(deps, 'j', stopped);
      await expect.poll(async () => (await job('j')).attempts).toBe(attempt);
      expect(await runJobWith(deps, 'j', stopped)).toMatchObject({ retryInSeconds: expect.any(Number) }); // locked by that attempt
      later(LEASE_MS + 1);
      expect(await dueJobs(deps)).toContain('j');
    }
    await runJobWith(deps, 'j', stopped);
    expect(await job('j')).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED' });
    expect(await job('next')).toMatchObject({ status: 'queued' }); // the group finished, if not well
  });

  it('an attempt that lost its lock stops at its next write, leaving the newer attempt alone', async () => {
    const { deps, tenant, job, later } = await setup();
    await enqueue(deps, tenant, [{ id: 'j', type: 'history_block', payload: {} }]);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const writes: string[] = [];
    const first = runJobWith(deps, 'j', handlersFor(async ({ renew }) => {
      await paused;
      await renew(); // throws: the lock was taken over
      writes.push('first');
    }));
    await expect.poll(async () => (await job('j')).status).toBe('running');
    later(LEASE_MS + 1);
    await runJobWith(deps, 'j', handlersFor(async ({ renew }) => {
      await renew();
      writes.push('second');
      return { by: 'second' };
    }));
    resume();
    await first;
    expect(writes).toEqual(['second']);
    expect(await job('j')).toMatchObject({ status: 'done', result: { by: 'second' } });
  });

  it('releases what waits for a group once, when its last two jobs finish at the same time', async () => {
    const { deps, tenant, job } = await setup();
    await enqueue(deps, tenant, [
      { id: 'a', type: 'history_block', payload: {}, groupId: 'g' },
      { id: 'b', type: 'history_block', payload: {}, groupId: 'g' },
      { id: 'next', type: 'history_finish', payload: {}, waitsFor: 'g' },
    ]);
    let arrived = 0;
    let go!: () => void;
    const together = new Promise<void>((resolve) => (go = resolve));
    const handlers = handlersFor(async () => {
      arrived += 1;
      if (arrived === 2) go();
      await together;
    });
    await Promise.all([runJobWith(deps, 'a', handlers), runJobWith(deps, 'b', handlers)]);
    expect(await job('next')).toMatchObject({ status: 'queued' });
    expect(woken(deps).filter((wake) => wake.id === 'next')).toHaveLength(1);
  });

  it('releases a job added waiting for a group that finished meanwhile, without the sweep', async () => {
    const { deps, tenant, job } = await setup();
    await enqueue(deps, tenant, [{ id: 'a', type: 'history_block', payload: {}, groupId: 'g' }]);
    await runJobWith(deps, 'a', handlersFor(async () => undefined)); // its release finds nothing waiting yet
    await enqueue(deps, tenant, [{ id: 'late', type: 'history_finish', payload: {}, waitsFor: 'g' }]);
    expect(await job('late')).toMatchObject({ status: 'queued' });
    expect(woken(deps).at(-1)?.id).toBe('late');
    // Waiting for a group with jobs still to run stays waiting.
    await enqueue(deps, tenant, [{ id: 'b', type: 'history_block', payload: {}, groupId: 'h' }, { id: 'held', type: 'history_finish', payload: {}, waitsFor: 'h' }]);
    expect(await job('held')).toMatchObject({ status: 'waiting' });
  });

  it('the sweep wakes overdue and stopped jobs, and releases waiting jobs whose group finished', async () => {
    const { deps, tenant, job, later } = await setup();
    await enqueue(deps, tenant, [
      { id: 'lost', type: 'sync', payload: {} },
      { id: 'stopped', type: 'sync', payload: {} },
      { id: 'blocked', type: 'snapshot', payload: {}, waitsFor: 'busy-group' },
      { id: 'busy', type: 'sync', payload: {}, groupId: 'busy-group', runAfter: deps.now().getTime() + 3_600_000 },
    ]);
    // A waiting job whose release was lost (added straight to the table, so nothing released it).
    const now = deps.now().getTime();
    await deps.db.insert(schema.jobs).values({ id: 'orphan', householdId: tenant.householdId, type: 'snapshot', payload: {}, waitsFor: 'finished-group', status: 'waiting', runAfter: now, createdAt: now });
    void runJobWith(deps, 'stopped', handlersFor(() => new Promise(() => {})));
    await expect.poll(async () => (await job('stopped')).status).toBe('running');
    later(LEASE_MS + 60_000);
    const before = woken(deps).length;
    expect(await sweep(deps)).toBe(2);
    expect(woken(deps).slice(before).map((wake) => wake.id).sort()).toEqual(['lost', 'orphan', 'stopped']);
    expect(await job('orphan')).toMatchObject({ status: 'queued' });
    expect(await job('blocked')).toMatchObject({ status: 'waiting' });
  });

  it('prunes finished jobs after 30 days', async () => {
    const { deps, tenant, job, later } = await setup();
    await enqueue(deps, tenant, [{ id: 'old', type: 'sync', payload: {} }, { id: 'open', type: 'sync', payload: {}, runAfter: deps.now().getTime() + 1e12 }]);
    await runJobWith(deps, 'old', handlersFor(async () => undefined));
    later(31 * 24 * 3600_000);
    await pruneJobsStatement(deps);
    expect(await job('old')).toBeUndefined();
    expect(await job('open')).toBeDefined();
  });
});

describe('job queues', () => {
  it('Cloudflare: one message per job, in batches of 100, delays clamped to 24 hours', async () => {
    const sent: { body: { id: string }; delaySeconds?: number }[][] = [];
    const queue = cloudflareJobQueue({ sendBatch: async (messages) => void sent.push(messages) });
    await queue.wake(Array.from({ length: 150 }, (_, index) => `j${index}`));
    await queue.wake(['late'], 100_000);
    expect(sent.map((batch) => batch.length)).toEqual([100, 50, 1]);
    expect(sent[0][0]).toEqual({ body: { id: 'j0' } });
    expect(sent[2][0]).toEqual({ body: { id: 'late' }, delaySeconds: 86_400 });
  });

  it("Cloudflare: acks a run, retries a job that can't run yet, and retries after a runner failure", async () => {
    const calls: string[] = [];
    const message = (id: string) => ({
      body: { id },
      ack: () => calls.push(`ack ${id}`),
      retry: (options?: { delaySeconds?: number }) => calls.push(`retry ${id} ${options?.delaySeconds}`),
    });
    await consumeJobs({ messages: [message('ok'), message('busy'), message('broken')] }, async (id) => {
      if (id === 'broken') throw new Error('D1 unavailable');
      return id === 'busy' ? { retryInSeconds: 42 } : {};
    });
    expect(calls).toEqual(['ack ok', 'retry busy 42', 'retry broken 60']);
  });

  it('local: a wake-up drains every due job, including ones added meanwhile', async () => {
    const due = ['a', 'b'];
    const ran: string[] = [];
    const queue = localJobQueue(
      async () => [...due],
      async (id) => {
        ran.push(id);
        due.splice(due.indexOf(id), 1);
        if (id === 'a') due.push('c');
      },
    );
    await queue.wake(['a']);
    await expect.poll(() => ran).toEqual(['a', 'b', 'c']);
    await queue.drain();
  });
});

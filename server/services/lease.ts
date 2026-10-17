/**
 * Leases: at most one holder at a time per key, across Worker instances.
 *
 *  - `connection:<id>`: everything that changes a Plaid connection's data
 *    (sync, history load, bank history, disconnect, re-link, hiding its accounts).
 *  - `snapshot:<household>`: recomputing the household's daily snapshot.
 *  - `account:<id>`: saving a manual account's holdings.
 *  - `targets:<household>`: saving the target allocation.
 *
 * Taking a lease is one conditional upsert, which the database applies
 * atomically, so exactly one caller wins. Each holder has a random token:
 * only it can renew or release, and it renews (checking it still holds the
 * lease) immediately before every write batch, so a holder whose lease ran
 * out can't write over a newer holder's work. Leases expire on their own, so
 * a holder that dies mid-way (CPU limit, crash) blocks the key for at most
 * LEASE_MS.
 *
 * Someone who finds the lease taken can leave a note: "run again, there's
 * news". A run clears notes left before it started (clearNotesBefore, in its
 * write batch) and, on release, a remaining note keeps the lease and tells
 * the holder to run again. Failed runs clear nothing, so a note waits for the
 * next successful run.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { leases } from '../db/schema';
import { HttpError } from '../lib/http';
import type { Tenant } from '../db/tenant';
import type { Deps } from '../ports';

/** Far longer than any write takes; long work renews as it goes. */
export const LEASE_MS = 2 * 60 * 1000;
/** How long a person's action (hide, disconnect, save) waits for a running sync. */
export const USER_WAIT_MS = 10_000;
const POLL_MS = 250;

/** The lease was lost (it expired and someone else took it): stop without writing. */
export class LeaseLostError extends Error {
  constructor(key: string) {
    super(`Lost the lease on ${key}; another run took over.`);
    this.name = 'LeaseLostError';
  }
}

/** A person's action found the lease taken for longer than they should wait. */
export class BusyError extends HttpError {
  constructor(message = 'A sync is running for this connection. Try again in a moment.') {
    super(409, message);
    this.name = 'BusyError';
  }
}

export const connectionLease = (id: string) => `connection:${id}`;
export const snapshotLease = (householdId: string) => `snapshot:${householdId}`;
export const accountLease = (id: string) => `account:${id}`;
export const targetsLease = (householdId: string) => `targets:${householdId}`;

export class Lease {
  /** The previous holder's lease ran out without being released: that run never finished. */
  abandoned = false;
  private readonly deps: Deps;
  private readonly tenant: Tenant;
  readonly key: string;
  private readonly holder: string;

  private constructor(deps: Deps, tenant: Tenant, key: string, holder: string) {
    this.deps = deps;
    this.tenant = tenant;
    this.key = key;
    this.holder = holder;
  }

  /** Take the lease if it's free or expired; null if someone holds it. */
  static async acquire(deps: Deps, tenant: Tenant, key: string): Promise<Lease | null> {
    const now = deps.now().getTime();
    const holder = crypto.randomUUID();
    const [before] = await tenant.db
      .select({ holder: leases.holder, until: leases.until })
      .from(leases)
      .where(tenant.scope(leases, eq(leases.key, key)));
    const taken = await tenant.db
      .insert(leases)
      .values({ key, householdId: tenant.householdId, holder, until: now + LEASE_MS })
      .onConflictDoUpdate({
        target: leases.key,
        set: { holder, until: now + LEASE_MS },
        setWhere: and(eq(leases.householdId, tenant.householdId), or(isNull(leases.until), lt(leases.until, now))),
      })
      .returning({ holder: leases.holder });
    if (taken[0]?.holder !== holder) return null;
    const lease = new Lease(deps, tenant, key, holder);
    lease.abandoned = Boolean(before?.holder && before.until !== null && before.until < now);
    return lease;
  }

  /**
   * For a key nobody can know about yet (a connection being created): the
   * statement creating the lease already held, to batch with the creation.
   */
  static held(deps: Deps, tenant: Tenant, key: string): { lease: Lease; statement: BatchItem<'sqlite'> } {
    const holder = crypto.randomUUID();
    return {
      lease: new Lease(deps, tenant, key, holder),
      statement: tenant.db.insert(leases).values({ key, householdId: tenant.householdId, holder, until: deps.now().getTime() + LEASE_MS }),
    };
  }

  /** Take the lease, waiting up to `waitMs` for the holder to finish; throws BusyError if it doesn't. */
  static async acquireOrBusy(deps: Deps, tenant: Tenant, key: string, message?: string): Promise<Lease> {
    const lease = await Lease.acquireWaiting(deps, tenant, key);
    if (!lease) throw new BusyError(message);
    return lease;
  }

  /** Take the lease, waiting up to `waitMs` for the holder to finish; null if it doesn't. */
  static async acquireWaiting(deps: Deps, tenant: Tenant, key: string, waitMs = USER_WAIT_MS): Promise<Lease | null> {
    for (let waited = 0; ; waited += POLL_MS) {
      const lease = await Lease.acquire(deps, tenant, key);
      if (lease || waited >= waitMs) return lease;
      await deps.sleep(POLL_MS);
    }
  }

  /** Ask the holder to run again before releasing (it has news). */
  static async leaveNote(deps: Deps, tenant: Tenant, key: string): Promise<void> {
    const now = deps.now().getTime();
    await tenant.db
      .insert(leases)
      .values({ key, householdId: tenant.householdId, noteAt: now })
      .onConflictDoUpdate({ target: leases.key, set: { noteAt: now }, setWhere: eq(leases.householdId, tenant.householdId) });
  }

  /** Confirm this run still holds the lease and extend it. Call right before writing. */
  async renew(): Promise<void> {
    const renewed = await this.tenant.db
      .update(leases)
      .set({ until: this.deps.now().getTime() + LEASE_MS })
      .where(this.mine())
      .returning({ key: leases.key });
    if (renewed.length === 0) throw new LeaseLostError(this.key);
  }

  /** For the run's write batch: clear notes left before it started (its work covers them). */
  clearNotesBefore(startedAt: number): BatchItem<'sqlite'> {
    return this.tenant.db
      .update(leases)
      .set({ noteAt: null })
      .where(and(this.mine(), lt(leases.noteAt, startedAt)));
  }

  /**
   * Release, unless a note is waiting: then keep (and extend) the lease and
   * return false, so the caller runs again.
   */
  async release(): Promise<boolean> {
    const released = await this.tenant.db
      .update(leases)
      .set({ holder: null, until: null })
      .where(and(this.mine(), isNull(leases.noteAt)))
      .returning({ key: leases.key });
    if (released.length > 0) return true;
    const kept = await this.tenant.db
      .update(leases)
      .set({ until: this.deps.now().getTime() + LEASE_MS })
      .where(this.mine())
      .returning({ key: leases.key });
    // Not ours any more (it expired and was taken): the new holder sees the note.
    return kept.length === 0;
  }

  /** Release regardless of notes (after a failure, or the last allowed run); notes stay. */
  async forceRelease(): Promise<void> {
    await this.tenant.db.update(leases).set({ holder: null, until: null }).where(this.mine());
  }

  private mine() {
    return this.tenant.scope(leases, eq(leases.key, this.key), eq(leases.holder, this.holder));
  }
}

/**
 * Run `work` holding the lease, re-running it while notes arrive (at most
 * `maxRuns` times), then release. On failure the lease is released (notes
 * stay) and the error rethrown.
 */
export async function holdWhile<T>(lease: Lease, work: (run: number) => Promise<T>, maxRuns = 3): Promise<T> {
  try {
    let result = await work(1);
    for (let run = 2; !(await lease.release()); run++) {
      if (run > maxRuns) {
        await lease.forceRelease();
        break;
      }
      result = await work(run);
    }
    return result;
  } catch (error) {
    await lease.forceRelease().catch((releaseError: unknown) =>
      console.error('Could not release the lease', releaseError instanceof Error ? releaseError.message : releaseError),
    );
    throw error;
  }
}

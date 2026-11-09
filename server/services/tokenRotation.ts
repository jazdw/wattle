/**
 * Moving stored Plaid tokens to a new encryption key (rotation: ./crypto).
 * While TOKEN_ENC_KEY_NEXT is set, the first request a Worker instance
 * serves queues one rotate_tokens job per household (its id names the new
 * key's version, so it's queued once however many instances start); the
 * nightly job does the same pass as a safety net. Each token is decrypted
 * with whichever key it's under and written back only if it hasn't changed
 * since it was read, so a sync or a new report writing the same row at once
 * wins and nothing is lost (that write used the new key anyway). Each login
 * moved gets a run in its Activity: "Moved its tokens to the new encryption key".
 */
import { and, eq } from 'drizzle-orm';
import { runAtomic } from '../db/batch';
import { connections, households } from '../db/schema';
import { Tenant } from '../db/tenant';
import type { Deps } from '../ports';
import { SyncRun, type SyncTrigger } from './activity';
import { decryptToken, encryptToken, loadTokenKeys, needsRotation, tokenAad } from './crypto';
import { enqueueForHouseholds, type JobContext } from './jobRunner';

export interface RotationResult {
  /** Tokens re-encrypted. */
  rotated: number;
  /** Tokens still under an older key (a write in between, or one that couldn't be decrypted). */
  remaining: number;
}

const FIELDS = ['accessTokenEnc', 'assetReportTokenEnc'] as const;

/** The household's tokens under the key that encrypts now, each login moved noted in its Activity. */
export async function rotateTokens(deps: Deps, tenant: Tenant, trigger: SyncTrigger): Promise<RotationResult> {
  const keys = await loadTokenKeys(deps.config.tokenEncKey);
  const rows = await tenant.db
    .select({ id: connections.id, accessTokenEnc: connections.accessTokenEnc, assetReportTokenEnc: connections.assetReportTokenEnc })
    .from(connections)
    .where(tenant.scope(connections));
  let rotated = 0;
  let remaining = 0;
  for (const row of rows) {
    let moved = 0;
    for (const field of FIELDS) {
      const value = row[field];
      if (!value || !needsRotation(keys, value)) continue;
      try {
        const aad = tokenAad(tenant.householdId, row.id);
        const fresh = await encryptToken(keys, await decryptToken(keys, value, aad), aad);
        const [written] = await tenant.db
          .update(connections)
          .set({ [field]: fresh })
          .where(tenant.scope(connections, and(eq(connections.id, row.id), eq(connections[field], value))))
          .returning({ id: connections.id });
        if (written) moved += 1;
        else remaining += 1;
      } catch (error) {
        // Under a key no longer listed: left as it is (the login would need relinking anyway).
        console.error('Token rotation: a token could not be re-encrypted', error instanceof Error ? error.message : 'unknown error');
        remaining += 1;
      }
    }
    if (moved > 0) {
      const run = new SyncRun(deps, tenant, row.id, 'tokens', trigger);
      run.note = 'Moved its tokens to the new encryption key.';
      await runAtomic(tenant.db, [run.statement()]);
      rotated += moved;
    }
  }
  return { rotated, remaining };
}

/** rotate_tokens: the household's tokens to the new key. */
export async function rotateTokensJob({ deps, tenant }: JobContext): Promise<Record<string, unknown>> {
  return { ...(await rotateTokens(deps, tenant, 'key')) };
}

/** Whether this instance has queued the rotation (once is enough: the jobs' ids keep them to one per key). */
let queued = false;

/** While a new key is set: queue each household's rotation, once per instance (the first request it serves). */
export async function queueRotation(deps: Deps): Promise<void> {
  if (!deps.config.tokenRotating || queued) return;
  queued = true;
  try {
    const keys = await loadTokenKeys(deps.config.tokenEncKey);
    const rows = await deps.db.select({ id: households.id }).from(households);
    await enqueueForHouseholds(
      deps,
      rows.map(({ id }) => [new Tenant(deps.db, id), { id: `rotate:${keys.current}:${id}`, type: 'rotate_tokens' as const, payload: {} }]),
    );
  } catch (error) {
    // Tried again by the next instance, or the nightly job's pass.
    queued = false;
    console.error('Token rotation could not be queued', error instanceof Error ? error.message : 'unknown error');
  }
}

/** The nightly job's pass: every household's tokens still under an older key. */
export async function rotateAllTokens(deps: Deps): Promise<RotationResult> {
  const total: RotationResult = { rotated: 0, remaining: 0 };
  for (const { id } of await deps.db.select({ id: households.id }).from(households)) {
    const result = await rotateTokens(deps, new Tenant(deps.db, id), 'nightly');
    total.rotated += result.rotated;
    total.remaining += result.remaining;
  }
  return total;
}

/** Tests: a fresh instance. */
export function resetRotationQueue(): void {
  queued = false;
}

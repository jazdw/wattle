/**
 * Cloudflare Workers entry: binds D1 + secrets into the platform-neutral app
 * (server/app.ts) and runs the daily job on the cron trigger.
 */
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../server/db/schema';
import { createApp } from '../server/app';
import { depsFromEnv, type RawEnv } from '../server/config';
import { describeError } from '../server/lib/errors';
import { meteredD1 } from '../server/adapters/d1Meter';
import { cloudflareJobQueue, consumeJobs, type JobMessage } from '../server/adapters/jobQueues';
import type { Db } from '../server/ports';
import { runNextJob } from '../server/services/jobHandlers';
import { runDaily } from '../server/services/jobs';
import { recordWrites } from '../server/services/writeBudget';

interface Env extends RawEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Background jobs: one message per job to run (see server/services/jobRunner.ts). */
  JOBS: Queue<JobMessage>;
}

/** Per invocation: its rows written are counted towards the day's write budget (services/writeBudget.ts). */
function deps(env: Env) {
  const metered = meteredD1(env.DB);
  const db = drizzle(metered.db, { schema }) as unknown as Db;
  return { ...depsFromEnv(env, db, cloudflareJobQueue(env.JOBS)), writes: metered.meter };
}

/** Add a request's or the cron's rows written to the day's total (jobs add their own). */
const recorded = (invocationDeps: ReturnType<typeof deps>) => recordWrites(invocationDeps, 0).catch(() => {});

let app: ReturnType<typeof createApp> | null = null;

export default {
  async fetch(request, env, ctx) {
    app ??= createApp({ assets: env.ASSETS ? (req) => env.ASSETS!.fetch(req) : undefined });
    const requestDeps = deps(env);
    const response = await app.fetch(request, { deps: requestDeps }, ctx);
    ctx.waitUntil(recorded(requestDeps));
    return response;
  },
  /** One job per message (max_batch_size 1), so each has an invocation's limits to itself: the fairest due. */
  async queue(batch, env) {
    const jobDeps = deps(env);
    await consumeJobs(batch, () => runNextJob(jobDeps));
  },
  async scheduled(_controller, env) {
    const cronDeps = deps(env);
    try {
      await runDaily(cronDeps);
      await recorded(cronDeps);
    } catch (error) {
      // Rethrown without the original, whose message can carry query values,
      // so the run still shows as failed.
      throw new Error(`Daily job failed: ${describeError(error)}`);
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

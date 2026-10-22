/**
 * Cloudflare Workers entry: binds D1 + secrets into the platform-neutral app
 * (server/app.ts) and runs the daily job on the cron trigger.
 */
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../server/db/schema';
import { createApp } from '../server/app';
import { depsFromEnv, type RawEnv } from '../server/config';
import { describeError } from '../server/lib/errors';
import { cloudflareJobQueue, consumeJobs, type JobMessage } from '../server/adapters/jobQueues';
import type { Db } from '../server/ports';
import { runNextJob } from '../server/services/jobHandlers';
import { runDaily } from '../server/services/jobs';

interface Env extends RawEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** Background jobs: one message per job to run (see server/services/jobRunner.ts). */
  JOBS: Queue<JobMessage>;
}

function deps(env: Env) {
  const db = drizzle(env.DB, { schema }) as unknown as Db;
  return depsFromEnv(env, db, cloudflareJobQueue(env.JOBS));
}

let app: ReturnType<typeof createApp> | null = null;

export default {
  fetch(request, env, ctx) {
    app ??= createApp({ assets: env.ASSETS ? (req) => env.ASSETS!.fetch(req) : undefined });
    return app.fetch(request, { deps: deps(env) }, ctx);
  },
  /** One job per message (max_batch_size 1), so each has an invocation's limits to itself: the fairest due. */
  async queue(batch, env) {
    const jobDeps = deps(env);
    await consumeJobs(batch, () => runNextJob(jobDeps));
  },
  async scheduled(_controller, env) {
    try {
      await runDaily(deps(env));
    } catch (error) {
      // Rethrown without the original, whose message can carry query values,
      // so the run still shows as failed.
      throw new Error(`Daily job failed: ${describeError(error)}`);
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

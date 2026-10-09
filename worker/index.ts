/**
 * Cloudflare Workers entry: binds D1 + secrets into the platform-neutral app
 * (server/app.ts) and runs the daily job on the cron trigger.
 */
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../server/db/schema';
import { createApp } from '../server/app';
import { depsFromEnv, type RawEnv } from '../server/config';
import type { Db } from '../server/ports';
import { runDaily } from '../server/services/jobs';

interface Env extends RawEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
}

function deps(env: Env, ctx: ExecutionContext) {
  const db = drizzle(env.DB, { schema }) as unknown as Db;
  return depsFromEnv(env, db, (work) => ctx.waitUntil(work));
}

let app: ReturnType<typeof createApp> | null = null;

export default {
  fetch(request, env, ctx) {
    app ??= createApp({ assets: env.ASSETS ? (req) => env.ASSETS!.fetch(req) : undefined });
    return app.fetch(request, { deps: deps(env, ctx) }, ctx);
  },
  async scheduled(_controller, env, ctx) {
    await runDaily(deps(env, ctx));
  },
} satisfies ExportedHandler<Env>;

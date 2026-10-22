/**
 * Start the nightly run against the Node app's database (node/server.ts runs
 * it only every 24h). This queues the night's jobs; the running Node app
 * picks them up within a minute.
 *
 *   DATABASE_URL=file:wattle.db npx tsx --env-file=.dev.vars scripts/node-daily.ts
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../server/db/schema';
import { depsFromEnv } from '../server/config';
import type { Db } from '../server/ports';
import { runDaily } from '../server/services/jobs';

const db = drizzle(createClient({ url: process.env.DATABASE_URL ?? 'file:wattle.db' }), { schema });
// The app's own loop runs the jobs, so nothing here wakes a runner.
const deps = depsFromEnv({ ...process.env }, db as unknown as Db, { wake: async () => {} });
const { id, households } = await runDaily(deps);
console.log(`Nightly run ${id} queued for ${households} household(s); the Node app runs its jobs within a minute.`);

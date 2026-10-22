/**
 * Node entry: the same app on @hono/node-server with a local SQLite file via
 * libsql — proof that Wattle isn't tied to Workers.
 *
 *   DATABASE_URL=file:wattle.db npm run node:start
 *
 * Static files are served from dist/client after `npm run build`. The daily
 * job runs every 24h from start-up (use a real scheduler in production).
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from '../server/db/schema';
import { createApp } from '../server/app';
import { depsFromEnv } from '../server/config';
import { describeError } from '../server/lib/errors';
import { localJobQueue } from '../server/adapters/jobQueues';
import type { Db, Deps } from '../server/ports';
import { runJob } from '../server/services/jobHandlers';
import { dueJobs, sweep } from '../server/services/jobRunner';
import { runDaily } from '../server/services/jobs';

const client = createClient({ url: process.env.DATABASE_URL ?? 'file:wattle.db' });
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: 'migrations' });

// On Node the request host comes from the client's Host header, so the
// "private host" check behind dev sign-in can be spoofed. Require an explicit
// opt-in, and never set it on a reachable server.
const env = { ...process.env };
if (env.ALLOW_DEV_LOGIN !== '1') delete env.DEV_LOGIN_EMAILS;

// Background jobs run in this process: due ones one at a time, swept every minute.
const jobQueue = localJobQueue(
  () => dueJobs(deps),
  (id) => runJob(deps, id),
);
const deps: Deps = depsFromEnv(env, db as unknown as Db, jobQueue);
setInterval(() => void sweep(deps).then(() => jobQueue.drain()), 60_000);

// Static files first (the built SPA), then the API, then index.html for client routes.
const app = createApp();
const root = new Hono();
root.use('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : serveStatic({ root: './dist/client' })(c, next)));
root.all('/api/*', (c) => app.fetch(c.req.raw, { deps }));
root.get('*', serveStatic({ root: './dist/client', path: 'index.html' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port });
console.log(`Wattle on http://localhost:${port}`);

setInterval(() => void runDaily(deps).catch((error) => console.error('Daily job failed', describeError(error))), 24 * 3600 * 1000);

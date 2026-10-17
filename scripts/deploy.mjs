#!/usr/bin/env node
// Deploy: find (or create) the production D1 database, build with its id,
// apply migrations, then deploy the Worker to CUSTOM_DOMAIN. Used locally
// (after `npx wrangler login`) and by CI (with CLOUDFLARE_API_TOKEN).
//
//   CUSTOM_DOMAIN=wattle.example.com npm run deploy

import { spawnSync } from 'node:child_process';
import { applyMigrations, databaseId } from './remote-d1.mjs';

const domain = process.env.CUSTOM_DOMAIN;
if (!domain) {
  console.error('Set CUSTOM_DOMAIN to the domain to deploy to, e.g. CUSTOM_DOMAIN=wattle.example.com npm run deploy');
  process.exit(1);
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const id = databaseId();
// The Vite build writes the id into the generated deploy config (vite.config.ts).
run('npm', ['run', 'build'], { D1_DATABASE_ID: id });
// Schema first, so the new code never runs against an old schema.
applyMigrations(id);
run('npx', ['wrangler', 'deploy', '--domain', domain]);

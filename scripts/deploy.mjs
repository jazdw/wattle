#!/usr/bin/env node
// Deploy: find (or create) the production D1 database, build with its id,
// apply migrations, then deploy the Worker to CUSTOM_DOMAIN with the plain
// settings below. Used locally (after `npx wrangler login`) and by CI (with
// CLOUDFLARE_API_TOKEN; settings from GitHub repository variables).
//
//   CUSTOM_DOMAIN=wattle.example.com PLAID_ENV=sandbox npm run deploy

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

/**
 * Plain (non-secret) settings, passed to the Worker as variables on every
 * deploy from the environment (GitHub repository variables in CI). Each deploy
 * replaces all variables, so the Worker always has exactly these; secrets
 * (API keys) are set separately with `wrangler secret put` and never touched.
 */
const SETTINGS = ['PLAID_ENV', 'QUOTE_PROVIDER', 'QUOTE_CACHE_SECONDS', 'FX_PROVIDER', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'];
const vars = SETTINGS.filter((name) => process.env[name]).flatMap((name) => ['--var', `${name}:${process.env[name]}`]);

const id = databaseId();
// The Vite build writes the id into the generated deploy config (vite.config.ts).
run('npm', ['run', 'build'], { D1_DATABASE_ID: id });
// Schema first, so the new code never runs against an old schema.
applyMigrations(id);
console.log(`Settings: ${SETTINGS.filter((name) => process.env[name]).map((name) => `${name}=${process.env[name]}`).join(', ') || '(none; defaults apply)'}`);
run('npx', ['wrangler', 'deploy', '--domain', domain, ...vars]);

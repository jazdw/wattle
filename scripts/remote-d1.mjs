#!/usr/bin/env node
// The production D1 database, found by name (and created if it doesn't exist
// yet), so its id never has to be copied anywhere or committed.
//
//   node scripts/remote-d1.mjs id        print the database id (creating it if needed)
//   node scripts/remote-d1.mjs migrate   apply migrations to it
//
// Wrangler's D1 commands read wrangler.jsonc, whose database_id is a
// placeholder, and ignore the build's generated config. So remoteConfig()
// writes a minimal config with just the D1 binding and the real id to
// .wrangler/remote-d1.json (git-ignored), for those commands' --config.
// Needs Wrangler auth: `npx wrangler login` locally, CLOUDFLARE_API_TOKEN in CI.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must match the D1 binding in wrangler.jsonc.
const DATABASE = 'wattle';
const BINDING = 'DB';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REMOTE_CONFIG = resolve(ROOT, '.wrangler/remote-d1.json');

function wrangler(args, { capture = true } = {}) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // No terminal input: Wrangler mustn't stop to ask questions.
    stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  if (result.status !== 0) {
    if (capture) console.error(result.stderr || result.stdout);
    throw new Error(`wrangler ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function findDatabase() {
  const databases = JSON.parse(wrangler(['d1', 'list', '--json']));
  return databases.find((database) => database.name === DATABASE)?.uuid ?? null;
}

/** The database id, creating the database on first use. */
export function databaseId() {
  const existing = findDatabase();
  if (existing) return existing;
  console.error(`Creating the D1 database "${DATABASE}"…`);
  wrangler(['d1', 'create', DATABASE, '--update-config=false']);
  const created = findDatabase();
  if (!created) throw new Error(`Created the D1 database "${DATABASE}" but can't find it.`);
  return created;
}

/** Write the config D1 commands need for the real database; returns its path. */
export function remoteConfig(id = databaseId()) {
  mkdirSync(dirname(REMOTE_CONFIG), { recursive: true });
  writeFileSync(
    REMOTE_CONFIG,
    JSON.stringify(
      {
        name: DATABASE,
        d1_databases: [{ binding: BINDING, database_name: DATABASE, database_id: id, migrations_dir: resolve(ROOT, 'migrations') }],
      },
      null,
      2,
    ),
  );
  return REMOTE_CONFIG;
}

export function applyMigrations(id) {
  wrangler(['d1', 'migrations', 'apply', DATABASE, '--remote', '--config', remoteConfig(id)], { capture: false });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'id') console.log(databaseId());
  else if (command === 'migrate') applyMigrations(databaseId());
  else {
    console.error('Usage: node scripts/remote-d1.mjs id|migrate');
    process.exit(1);
  }
}

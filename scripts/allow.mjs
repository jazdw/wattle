#!/usr/bin/env node
// Manage who can sign in (the `allowed_emails` D1 table).
//
//   npm run allow -- list
//   npm run allow -- add you@gmail.com partner@gmail.com [--note "us"] [--household <id>]
//   npm run allow -- remove someone@gmail.com [--keep-sessions]
//
// Without --household, a new user joins the first (oldest) household — the
// single-tenant setup. Pass --household to put someone in another household.
//
// Targets the production database by default; add --local for the local dev
// database. Removing someone also signs them out everywhere unless
// --keep-sessions is given.

import { spawnSync } from 'node:child_process';

const DATABASE = 'wattle';

const USAGE = `Usage:
  npm run allow -- list [--local]
  npm run allow -- add <email> [<email> …] [--note "text"] [--household <id>] [--local]
  npm run allow -- remove <email> [<email> …] [--keep-sessions] [--local]`;

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { local: false, keepSessions: false, note: null, household: null };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--local') options.local = true;
    else if (arg === '--remote') options.local = false;
    else if (arg === '--keep-sessions') options.keepSessions = true;
    else if (arg === '--note') {
      options.note = argv[++index];
      if (options.note === undefined) fail('--note needs a value.');
    } else if (arg.startsWith('--note=')) options.note = arg.slice('--note='.length);
    else if (arg === '--household') {
      options.household = argv[++index];
      if (options.household === undefined) fail('--household needs a value.');
    }
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [command, ...emails] = positional;
  return { command, emails, options };
}

/** Quote a value as an SQL string literal. */
function sql(value) {
  return value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeEmails(emails) {
  if (emails.length === 0) fail('Give at least one email address.');
  return emails.map((raw) => {
    const email = raw.trim().toLowerCase();
    // Deliberately simple: one @, no spaces, a dot in the domain.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Not an email address: ${raw}`);
    return email;
  });
}

/** Run SQL with Wrangler and return the rows of each statement. */
function execute(command, local) {
  const result = spawnSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      DATABASE,
      local ? '--local' : '--remote',
      '--json',
      '--command',
      command,
    ],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  try {
    return JSON.parse(result.stdout).map((statement) => statement.results ?? []);
  } catch {
    console.error(result.stdout);
    fail('Could not read the Wrangler output.');
  }
}

const { command, emails, options } = parseArgs(process.argv.slice(2));
const target = options.local ? 'local' : 'production';

switch (command) {
  case 'list': {
    const [rows] = execute(
      `SELECT a.email, a.note, a.household_id,
              datetime(a.added_at / 1000, 'unixepoch') AS added,
              CASE WHEN u.id IS NULL THEN 'no' ELSE 'yes' END AS has_signed_in
         FROM allowed_emails a
         LEFT JOIN users u ON lower(u.email) = lower(a.email)
        ORDER BY a.email`,
      options.local,
    );
    if (rows.length === 0) {
      console.log(`No allowed emails in the ${target} database.`);
    } else {
      console.log(`Allowed emails (${target}):`);
      console.table(rows);
    }
    break;
  }

  case 'add': {
    const list = normalizeEmails(emails);
    const values = list
      .map((email) => `(${sql(email)}, unixepoch() * 1000, ${sql(options.note)}, ${sql(options.household)})`)
      .join(', ');
    // Re-adding an email updates its note/household instead of failing.
    execute(
      `INSERT INTO allowed_emails (email, added_at, note, household_id) VALUES ${values}
       ON CONFLICT(email) DO UPDATE SET note = COALESCE(excluded.note, allowed_emails.note),
         household_id = COALESCE(excluded.household_id, allowed_emails.household_id)`,
      options.local,
    );
    console.log(`Allowed (${target}): ${list.join(', ')}`);
    break;
  }

  case 'remove': {
    const list = normalizeEmails(emails);
    const inList = list.map(sql).join(', ');
    const statements = [`DELETE FROM allowed_emails WHERE lower(email) IN (${inList})`];
    if (!options.keepSessions) {
      statements.push(
        `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email) IN (${inList}))`,
      );
    }
    execute(statements.join('; '), options.local);
    console.log(
      `Removed (${target}): ${list.join(', ')}` +
        (options.keepSessions ? ' — existing sessions kept.' : ' — and signed out everywhere.'),
    );
    console.log(
      'Their household data is kept. Emails in the ALLOWED_EMAILS variable (if any) still work.',
    );
    break;
  }

  case undefined:
    fail('Give a command.');
    break;

  default:
    fail(`Unknown command: ${command}`);
}

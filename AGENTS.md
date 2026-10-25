# AGENTS.md

Guidance for AI coding agents working in this repository. `README.md` covers the architecture, setup and how everything works; read it for anything not covered here.

## This repository is public. Real financial data never goes in it.

Wattle Wealth runs against the owner's real accounts in production. Everything committed here, including commit messages, can be read by anyone and can't be fully taken back: rewriting history still leaves old commits on GitHub until GitHub Support purges them.

**Never put any of the following in a commit, commit message, test, fixture, code comment, README, migration, script or log message:**

- Names of real people (account holders, household members), email addresses, phone numbers or addresses.
- Account names as an institution reports them, account numbers, masks or last-four digits, Plaid item or account ids, request ids or access tokens.
- Balances, net worth, transaction amounts or dates, share counts or cost bases from real accounts.
- Which institutions, funds or tickers the owner actually uses or holds, or facts about them (how many holdings there are, how much history an account has).
- Hostnames, the custom domain, Cloudflare account or database ids, and anything from `.dev.vars`, the production database or `plaid_responses` / `plaid_webhooks`.

**When production data informs a change** (a bug found in real data, a format an institution sends), reproduce it with made-up values:

- Fictional names and masks: `Pat Example - Brokerage Account - ****1234`.
- Round, invented amounts and share counts: a `$10,000.00` deposit, `100` shares at `$60.25`.
- Generic tickers or well-known index funds not tied to the owner (`XYZ`, `VTI`), and invented dates.
- Neutral wording in comments and docs: "some institutions label prices a day early", not the institution's name.

The test fixtures in `test/fakes.ts`, `test/brokerage.ts` and `src/test/fixtures.ts` are invented; keep it that way.

**Before every push**, check what's going out:

```sh
git log --format='%h %B' origin/main..HEAD
git diff origin/main..HEAD
```

Look for names, masks, amounts, institution names and anything copied from production. If something slipped into a local commit, fix it before pushing. If it was already pushed, stop and tell the owner straight away.

## Secrets

Never read secret values into the conversation: `.dev.vars`, Worker secrets (`wrangler secret`), GitHub secrets, tokens or keys. Tell the owner where to put a value and verify only that it's set or that the feature works. Never print, log or commit them.

## Working agreements

- Commit and push only when the owner asks. A push to `main` deploys to production through GitHub Actions.
- Ask before changing production: the database (`wrangler d1 execute --remote`), Worker settings or secrets, GitHub variables or repository settings.
- Migrations are append-only once pushed: never edit, fold or delete a migration that's on `origin/main` (`git ls-tree origin/main migrations/`). Create new ones with `npm run db:generate`.
- Match the surrounding code: its comment density, naming and idioms. There's no formatter; don't run one over files.
- Don't add third-party services or outbound APIs without asking.

## Commands

```sh
npm run dev          # local app (applies local D1 migrations first)
npm run typecheck
npm run lint
npm test             # vitest: server tests in test/, component tests in src/
npm run db:generate  # new migration from server/db/schema.ts
```

Run `npm run typecheck && npm run lint && npm test` before saying a change is done.

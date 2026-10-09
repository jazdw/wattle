# Wattle

A private net-worth and investment tracker for a household. It pulls balances and holdings from Plaid, and you can add manual accounts for anything Plaid can't reach (Australian banks, super, property). It shows:

- net worth over time
- allocation against a target, with rebalancing suggestions
- the size and value/growth split of the stock portion
- daily growth by account, category or holding
- live quotes

It runs on Cloudflare Workers + D1. The server code itself has no Cloudflare dependency and also runs on Node with SQLite.

## Stack

| | |
|---|---|
| UI | React 19, React Router, TanStack Query, Tailwind v4, shadcn-style components (Radix), Recharts |
| API | Hono (`server/`), zod validation |
| Data | Drizzle ORM on SQLite: D1 in production, libsql in tests and on Node |
| Hosting | Cloudflare Workers (static assets + API + daily cron) |
| Data sources | Plaid (balances, holdings, investment transactions, asset reports), Tiingo (daily closes incl. mutual funds), Finnhub (live quotes), Frankfurter/ECB (USD↔AUD) |

## Layout

```
shared/    Domain logic used by browser and server: taxonomy, fund profiles, classification,
           allocation look-through, rebalancing, money/dates, zod schemas, API types
server/    Platform-neutral API: app.ts (createApp), ports.ts (Deps), db/ (schema, tenant scoping),
           auth/, routes/, services/ (sync, backfill, snapshots, pricing, history, portfolio, jobs),
           adapters/ (plaid, tiingo, finnhub, frankfurter)
worker/    Cloudflare entry: D1 + secrets → Deps; cron → daily job
node/      Node entry: @hono/node-server + libsql (portability; `npm run node:start`)
src/       React app
test/      Integration tests (real app on in-memory SQLite)
migrations/  drizzle-kit SQL, applied by Wrangler (D1) or Drizzle's migrator (libsql)
```

## How it works

- **Households.** Every row of financial data belongs to a household (the tenant). Routes only reach data through `Tenant.scope()`, which always adds `household_id = ?`. `test/tenancy.test.ts` checks that two households can't see or change each other's data through any route.
- **Unlinking.** Disconnecting a login keeps its accounts and history as manual accounts, unless you choose to delete them. Accounts an institution stops reporting (closed, or deselected in Plaid) are flagged "no longer reported" and drop out of totals, keeping their history.
- **Sold positions.** Sold holdings disappear on the next sync. Their history stays, and charts show them falling to zero.
- **Linking.** Each person links their own logins with Plaid Link: "Link investments" for brokerages, 401(k)s and HSAs, "Link bank / card" for checking, savings and cards. Accounts are tagged by owner (either of you, or joint). If you've both linked a joint account, **hide** one copy. Hidden accounts aren't synced or stored and don't count in any total.
- **No account numbers.** Only Plaid's `mask` (last ≤4 characters) is stored. The `auth` product is never requested. `test/schema.test.ts` fails if a column for account or routing numbers appears.
- **Secrets at rest.** Plaid access tokens and asset-report tokens are AES-256-GCM encrypted with `TOKEN_ENC_KEY`. The ciphertext is bound to its household and connection, and keys can be rotated (`v2:<new>,v1:<old>`).
- **Daily job** (cron `0 2 * * *` UTC, after US close). It syncs every connection, fetches closes and FX, and writes one `account_daily` and one `holding_daily` row per account and holding. Manual and imported values are never overwritten.
- **History backfill.** When an account is linked:
  - Investment accounts are rebuilt from up to 24 months of transactions and daily closes. Days where the institution's history has gaps are marked *estimated* and shaded in charts.
  - Bank and card accounts use Plaid Asset Report daily balances (up to 2 years).
  - Anything else can be imported from CSV. Westpac transaction exports are recognised automatically.
- **Classification.** Funds are split across categories (US/international/emerging/Australian stocks, US/international bonds, cash, real estate, …) and, for the stock portion, size and value/growth.
  - `shared/fundProfiles.ts` seeds common Vanguard, Fidelity, Schwab, iShares and ASX funds, including target-date mixes.
  - Unknown funds get a name-based guess flagged **Review**. Every classification can be edited.
- **Allocation scope.** The target can leave out categories (e.g. real estate) and accounts (e.g. an emergency fund).

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars        # fill in keys; TOKEN_ENC_KEY: openssl rand -base64 32
npm run db:migrate                    # local D1
npm run dev                           # http://localhost:5173
node scripts/seed-demo.mjs            # optional: demo accounts + a year of history (dev sign-in)
```

On localhost the login page offers **dev sign-in** for the emails in `DEV_LOGIN_EMAILS`. It's disabled on any public hostname. Plaid sandbox logins: `user_good` / `pass_good`.

Checks (CI runs the same):

```sh
npm run typecheck && npm run lint && npm run test:coverage
```

Tests run the real app on in-memory SQLite with fake Plaid, Tiingo, Finnhub and FX providers (`test/fakes.ts`), and enforce D1's 100-parameter limit. Coverage thresholds cover server, shared and client logic. React components are checked by rendering the app.

The logo is generated: `node scripts/logo.mjs && npm run icons`. This writes `public/logo.svg` (detailed, for app icons) and `public/favicon.svg` (simplified, to stay legible in a browser tab).

The schema lives in `server/db/schema.ts`. After changing it, run `npm run db:generate` to write a new migration.

## Setup

### Google OAuth
Create an OAuth client (Web) at <https://console.cloud.google.com/apis/credentials> with these redirect URIs:
- `http://localhost:5173/api/auth/google/callback`
- `https://<your-domain>/api/auth/google/callback`

The redirect URI is built from the request's origin, so no hostname is configured anywhere.

### Plaid
1. Get `PLAID_CLIENT_ID` and the sandbox/production secrets from <https://dashboard.plaid.com/developers/keys>.
2. Develop against **sandbox**. On the Trial plan, production allows 10 Items (logins), and removing an Item does not free its slot. Link each real institution once.
3. Webhooks are sent to `https://<your-domain>/api/plaid/webhook`, derived automatically from the request origin. They are verified with Plaid's signed JWT.

### Market data
- Tiingo: <https://www.tiingo.com>. The free tier is personal use, 1,000 requests/day and 500 symbols/month.
- Finnhub: <https://finnhub.io>. The free tier is personal use, 60 requests/minute.
- Both are optional. Without them, holdings are valued at the institution's prices and no live quotes are shown.

### Deploy
1. `npm run db:create`, then put the database id into `wrangler.jsonc`.
2. Set secrets: `npx wrangler secret put <NAME>` for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENC_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `TIINGO_API_KEY`, `FINNHUB_API_KEY`, `ADMIN_TOKEN`. Set `PLAID_ENV` (var) to `production` when ready.
3. Allow your Google accounts: `npm run allow -- add you@gmail.com partner@gmail.com`.
4. Deploy with either:
   - **GitHub Actions** (`.github/workflows/deploy.yml`): set the `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `CUSTOM_DOMAIN` repository secrets and push to `main`. It typechecks, lints, tests, applies D1 migrations, then runs `wrangler deploy --domain $CUSTOM_DOMAIN`.
   - **By hand:** `npm run db:migrate:remote && npm run deploy -- --domain wattle.example.com`.

**Workers plan:** use Workers Paid ($5/month). The free plan allows 10 ms of CPU and 50 outbound requests per invocation, and Wattle goes past that. Measured on Node, including SQLite's share:
- a routine sync takes about 20 ms
- a 2-year history chart by category takes about 80 ms
- a 2-year backfill takes about 250 ms per account

Re-run the daily job by hand: `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<domain>/api/admin/run-daily`.

### Running on Node instead

```sh
npm run build
DATABASE_URL=file:wattle.db PORT=8787 GOOGLE_CLIENT_ID=… TOKEN_ENC_KEY=… npm run node:start
```

## Future improvements

### Investments
- **Returns excluding contributions.** Today the Growth page includes money added and withdrawn. Wattle already stores investment transactions, so it can compute time-weighted return (performance alone) and money-weighted return (your actual experience), plus dividends as total return.
- **Benchmarks.** Compare the portfolio's return with VT, the S&P 500 or a 60/40 mix over the same period.
- **Risk checks ("X-ray").** Simple rules with pass/warn results. For example:
  - too much in one account or one stock
  - USD/AUD currency exposure
  - region concentration
  - emergency-fund coverage in months of spending
  - total fund fees (expense ratios) as a share of the portfolio
- **Fund overlap.** The individual stocks shared across your funds (VTI, the S&P 500 and target-date funds overlap heavily). Needs fund-holdings data; check sources first.
- **Dividends and fees.** A dividend timeline and fees paid per year, from investment transactions.
- **Projections.** A FIRE / retirement projection from current balances, contribution rate and an assumed return range.
- **Privacy mode.** One click blurs every amount, for looking at Wattle with others around.

### Transactions phase (checking and credit cards)
- **Sync** with Plaid `/transactions/sync`, fetching on demand and daily rather than continuously, which keeps Plaid usage down.
- **Categories, merchants and tags**, with rules that categorise automatically and remember manual corrections. Only uncategorised transactions go to a classifier, and any single transaction can override the merchant's usual category (e.g. tyres bought at Costco are Auto, not Shopping).
- **Classification model.** A small decision/classification model instead of a chat LLM, e.g. TypeSafe's [Jev](https://openrouter.ai/typesafe/jev-1.13): it returns typed choices with probabilities, so anything below a confidence threshold goes to a review queue. Could also suggest fund classifications (category, size, style) for funds without a seeded profile. It needs only merchant or fund names and amounts, never account details. Vendor-reported accuracy and cost are unverified.
- **Transfers between our own accounts** (checking → brokerage, card payments) detected and linked so they aren't counted as income or spending.
- **Edits ripple through.** Editing or recategorising an old transaction updates every derived view (cash flow, budgets, balances).
- **Cash flow and budgets.** Monthly income vs spending (a Sankey diagram is popular), category budgets with remaining amounts, and trends.
- **Recurring transactions and a planner.** Upcoming bills and income, projected cash flow, and the ability to drop in a planned transaction and see its effect.
- **Per-property pages.** Rent, mortgage and expenses for each property, with only net cash flow feeding the household budget.
- **Search** across transactions, merchants and categories.
- **Imports** that fill gaps without creating duplicates, for banks Plaid can't reach (Westpac CSV is already supported for balances).

### Data sources and platform
- Australian bank sync through a Consumer Data Right (CDR) aggregator (Basiq/Fiskil), behind the existing aggregator port.
- SimpleFIN as a cheap fallback for balances and transactions where Plaid fails. It provides no holdings, and users report reliability problems.
- Automatic property valuations.
- Invites and multiple households in the UI.
- Passkey (WebAuthn) sign-in as an alternative to Google.

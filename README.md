<p align="center">
  <img src="public/logo.svg" alt="Wattle Wealth logo: a sprig of golden wattle" width="128" height="128">
</p>

<h1 align="center">Wattle Wealth</h1>

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
- **Unlinking.** Disconnecting a login stops syncing and keeps its accounts and history as manual accounts, unless you choose to delete them. The Plaid login itself is kept (unless `PLAID_ALLOW_REMOVE` is on), so **Reconnect** resumes it on the same Item: Plaid's Trial plan counts removed Items, so a new link would use another of the 10. Balances recorded or imported while disconnected keep those days; syncing never overwrites them. Accounts an institution stops reporting (closed, or deselected in Plaid) are flagged "no longer reported" and drop out of totals, keeping their history.
- **Sold positions.** Sold holdings disappear on the next sync. Their history stays, and charts show them falling to zero.
- **Linking.** Each person links their own logins with Plaid Link. **Link account** asks Plaid for Assets (daily balance history; it's what Link lists institutions by), Investments wherever the login has investment accounts, and consent for Transactions and Liabilities, which aren't fetched or billed until used and can be switched on later on the same login (no new Item). So one login, one Item, brings a brokerage's holdings and its cash account's history. **Link investments only** is the fallback for institutions without Assets (some 401(k) providers). Each completed link is a new Plaid Item; on the Trial plan removed Items still count against the 10. Accounts are tagged by owner (either of you, or joint). If you've both linked a joint account, **hide** one copy. Hidden accounts aren't synced or stored and don't count in any total.
- **No account numbers.** Only Plaid's `mask` (last ≤4 characters) is stored. The `auth` product is never requested. `test/schema.test.ts` fails if a column for account or routing numbers appears.
- **Secrets at rest.** Plaid access tokens and asset-report tokens are AES-256-GCM encrypted with `TOKEN_ENC_KEY`. The ciphertext is bound to its household and connection, and keys can be rotated (`v2:<new>,v1:<old>`).
- **Nothing personal in logs.** Errors are logged through `describeError` (`server/lib/errors.ts`), which keeps a failed query's SQL but drops its values (Drizzle puts them in the message).
- **Sessions** last 30 days and end as soon as the email leaves the allow-list. Signing out also tells the browser to drop cached pages, and a page restored by the back button reloads.
- **Shared prices.** Daily closes and FX rates from Tiingo and Frankfurter are public data, shared by all households. Prices an institution reports through Plaid stay with that household (its securities' last price) and never go in the shared table.
- **Session cookies.** Over HTTPS they're `__Host-` cookies, which only this exact host can set, so another subdomain can't plant a session.
- **Webhook checks.** The webhook is public. A webhook naming an item or report Wattle Wealth doesn't have is dropped before its signature is checked, so forged ones can't make it ask Plaid for verification keys. For the rest: key ids must be well-formed, an id Plaid had no key for isn't asked about again for five minutes, and each instance makes at most 10 lookups a minute (Plaid's real key is normally cached).
- **Daily job** (cron `0 2 * * *` UTC, after US close). It syncs every connection, fetches closes and FX, and writes one `account_daily` and one `holding_daily` row per account and holding. Manual and imported values are never overwritten. History loads and missed-day fills that are due run last, after every sync and snapshot, so heavy history work cut short can't stop the rest.
- **Runs stopped part-way.** A Worker stopped by a limit (CPU, run time, requests) runs no more code and can't log it, so it's found afterwards:
  - Syncs, history loads and report collections write a `running` row in `sync_runs` when they start. The next run to take the connection's lease marks any still-running row `INTERRUPTED` (nothing else can be running then). Activity shows it as "Stopped part-way".
  - The daily job writes its `job_runs` row as `running` when it starts. The next job marks one left running as `interrupted` and lists it in its errors.
  - History work stopped three times in a row stops retrying on its own (otherwise each retry would be stopped again, every night). **Reload history** still runs it.
  - Every page shows a warning while any of this is recent (`/api/status`): the nightly job stopped or late, runs stopped in the last three days, history that stopped retrying.
- **Work budgets.** `test/budgets.test.ts` counts the database calls, statements, rows written and outside requests of a first link, the nightly job and each page load, with realistically sized data (30 positions, 500 transactions, two years), and fails when a change goes over budget. Counts, not timings, so they're exact.
- **Concurrency.** Two people, a webhook and the nightly job can all act at once; the rules (`services/lease.ts`, enforced by `test/writes.test.ts`):
  - **Leases**, at most one holder per key, taken with one atomic conditional write and renewed (checking the holder) right before every write batch. They expire after 2 minutes, so a run killed mid-way can't block anything for long.
    - `connection:<id>`: everything that changes a Plaid connection's data, including syncs, history loads, bank history, disconnecting, re-linking, and hiding its accounts.
    - `snapshot:<household>`: the daily snapshot.
    - `account:<id>`: a manual account's holdings, balance entries and deletion.
    - `targets:<household>`: the target allocation.
  - **Notes.** Something that finds a lease taken (a Plaid webhook, a history load, a snapshot request) leaves a note, and the holder runs again before releasing. Only a successful run clears a note, so a failure doesn't lose it.
  - **Atomic writes.** Each sync pass fetches from Plaid first, then writes everything, with its log entry, in one D1 batch (a transaction). Every other multi-step change is one batch too.
  - **No lost edits.** Manual holdings and targets carry a version. A save from an editor opened before someone else's save is refused ("changed by someone else, reload").
  - **Newest information wins** for a connection's status: a "login required" webhook isn't overwritten by a sync that fetched before it. Consent warnings are their own field, cleared by re-linking.
  - **Late transactions.** A transaction dated before the investment history was built makes that history be rebuilt.
- **Activity logs** (kept two years, pruned by the daily job).
  - `sync_runs` (per household): every sync, history load and bank-history collection, including checks that found nothing to do (with the reason), with what triggered it, Plaid's `request_id` for each call (what Plaid support asks for), counts, and what changed: balances before → after, holdings' units before → after, accounts added or no longer reported. Status changes Plaid reports by webhook are logged too. Shown per login under **Accounts → Activity** (the button on its card).
  - `price_runs` (global): every price and FX check, with the tickers, what came back, and any stored close that was replaced with a different value; written atomically with the prices it stores. Not shown in the app, since the tickers would reveal what households hold. Query it with `npx wrangler d1 execute wattle --remote --command "SELECT * FROM price_runs ORDER BY started_at DESC LIMIT 20"`.
  - `snapshot_runs` (per household): each snapshot of a day, nightly or redone after a change, with how many account and holding rows it wrote.
  - `job_runs` (global): each nightly run, with the households processed and any errors.
  - The **Activity** page (Accounts → Activity) shows the household's `sync_runs` and `snapshot_runs` together with the nightly runs, by day, filterable to problems. Of `job_runs` it shows only the date and whether the run finished, since its errors can name other households' logins.
  - Known gap: if two households' snapshots fetch the same ticker at the same moment, a `price_runs` entry can name a "before" value the other fetch had already replaced. The stored price is right; only that log detail is off, and it can't happen with one household. Closing it would mean serialising all price writes, which isn't worth it.
  - Raw Plaid responses are not stored.
- **History backfill.** When an account is linked:
  - With Investments, investment accounts are rebuilt from up to 24 months of transactions and daily closes. Days where the institution's history has gaps are marked *estimated* and shaded in charts.
  - With Assets, the login's other accounts (bank, card, a brokerage's cash account) use Plaid Asset Report daily balances (up to 2 years).
  - Anything else can be imported from CSV. Westpac transaction exports are recognised automatically.
- **Missed days.** Each night's snapshot records the day's balance. Which figure wins for a day:
  - A linked account's balance reported that day is the bank's figure, and replaces anything entered or imported for it.
  - If a sync fails (or the login is disconnected), the last balance is carried forward and marked *estimated*.
  - After each sync, each account's last day covered by the institution's figure (a reported balance or bank history) is checked. Days after it, up to yesterday, were missed. Recorded and imported days don't count, since the fill never replaces them.
  - Bank accounts on an Assets login: a small asset report is requested for just those days. Its balances replace the estimates, but never reported, entered or imported days.
  - Investment accounts: they're rebuilt for just those days from the transactions that arrived since, so a trade made during the gap shows up.
  - Each gap is asked for once. Days the bank has no figure for keep the carried-forward balance, still estimated, relabelled as bank history (`backfill`), so they count as covered and aren't asked for again.
- **Classification.** Funds are split across categories (US/international/emerging/Australian stocks, US/international bonds, cash, real estate, …) and, for the stock portion, size and value/growth.
  - `shared/fundProfiles.ts` seeds common Vanguard, Fidelity, Schwab, iShares and ASX funds, including target-date mixes.
  - Unknown funds get a name-based guess flagged **Review**. Every classification can be edited.
- **Allocation scope.** The target can leave out categories (e.g. real estate) and accounts (e.g. an emergency fund).

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars        # fill in keys; TOKEN_ENC_KEY: openssl rand -base64 32
npm run db:migrate                    # local D1
npm run allow -- add you@gmail.com --local   # Google accounts that can sign in
npm run dev                           # http://localhost:5173
node scripts/seed-demo.mjs            # optional: demo accounts + a year of history (dev sign-in)
```

On localhost the login page offers **dev sign-in** for the emails in `DEV_LOGIN_EMAILS`. It's disabled on any public hostname. Plaid sandbox logins: `user_good` / `pass_good`.

Checks (CI runs the same, except end-to-end tests):

```sh
npm run typecheck && npm run lint && npm run test:coverage
```

Tests:

| Command | What | Where |
|---|---|---|
| `npm test` | **Vitest**, two projects. `node`: the real API on in-memory SQLite with fake Plaid, Tiingo, Finnhub and FX providers (`test/fakes.ts`), enforcing D1's 100-parameter limit. `dom`: React pages and components in jsdom (React Testing Library) with the API served by MSW (`src/test/`). | local + CI (with coverage thresholds) |
| `npm run test:e2e` | **Playwright** in the installed Google Chrome. Builds the app, serves it with the Node entry on a throwaway SQLite database, seeds demo data, and clicks through the main flows (`e2e/`). | local only |

The logo is generated: `node scripts/logo.mjs && npm run icons`. This writes `public/logo.svg` (detailed, for app icons) and `public/favicon.svg` (simplified, to stay legible in a browser tab).

The schema lives in `server/db/schema.ts`. After changing it, run `npm run db:generate` to write a new migration.

## Setup

### Google OAuth
Create an OAuth client (Web) at <https://console.cloud.google.com/apis/credentials> with these redirect URIs:
- `http://localhost:5173/api/auth/google/callback`
- `https://<your-domain>/api/auth/google/callback`

The redirect URI is built from the request's origin, so no hostname is configured anywhere. Sign-in uses `openid-client` with PKCE, `state` and `nonce`. Google's endpoints are fixed in `server/auth/google.ts`, so no discovery request is made.

### Plaid
1. Get `PLAID_CLIENT_ID` and the sandbox/production secrets from <https://dashboard.plaid.com/developers/keys>.
2. Develop against **sandbox**. On the Trial plan, production allows 10 Items (logins), and removing an Item does not free its slot. Link each real institution once.
3. Webhooks are sent to `https://<your-domain>/api/plaid/webhook`, derived automatically from the request origin. They are verified with Plaid's signed JWT.
4. Add `https://<your-domain>/plaid-oauth` under **Allowed redirect URIs** in the dashboard (Developers → API). Banks with their own login page (OAuth: Chase, Capital One, …) send phones back there to finish linking. It's sent over HTTPS only; on a local http address Link uses its desktop popup and needs no redirect URI.

### Market data
- Tiingo: <https://www.tiingo.com>. The free tier is personal use, 1,000 requests/day and 500 symbols/month.
- Finnhub: <https://finnhub.io>. The free tier is personal use, 60 requests/minute.
- Both are optional. Without them, holdings are valued at the institution's prices and no live quotes are shown.

### Deploy
Nothing in the repo is specific to one deployment. Everything that is lives in your Cloudflare account or your GitHub repository settings.

Configuration comes in two kinds:
- **Secrets** (API keys and the like): set once on the Worker with `npx wrangler secret put <NAME>`. Deploys never touch them.
- **Plain settings** (`PLAID_ENV`, `QUOTE_PROVIDER`, …): GitHub repository variables, passed to the Worker as variables on every deploy by `scripts/deploy.mjs`. Each deploy replaces them all, so the Worker always has exactly what's set; to change one, `gh variable set NAME --body VALUE` and redeploy.

1. **Log in:** `npx wrangler login`.
2. **Deploy:** `CUSTOM_DOMAIN=wattle.example.com PLAID_ENV=sandbox npm run deploy`. It finds the D1 database named `wattle` (creating it the first time), builds with its id, applies migrations and deploys to the domain with the plain settings in the environment. The id is never written to the repo: `wrangler.jsonc` keeps a placeholder.
3. **Worker secrets:** these persist across deploys. For each `<NAME>`, run `npx wrangler secret put <NAME>`:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `TOKEN_ENC_KEY` (generate with `openssl rand -base64 32`)
   - `PLAID_CLIENT_ID`, `PLAID_SECRET`
   - `TIINGO_API_KEY`, `FINNHUB_API_KEY`
4. **Who can sign in:** `npm run allow -- add you@gmail.com partner@gmail.com`.
5. **GitHub Actions** (`.github/workflows/deploy.yml`): every push to `main` typechecks, lints and tests. Once these are set, it also runs `npm run deploy`. Until then the deploy step is skipped.
   - Secret: `CLOUDFLARE_API_TOKEN` (`gh secret set CLOUDFLARE_API_TOKEN`). The "Edit Cloudflare Workers" template, plus Account → D1 → Edit.
   - Variables: `CLOUDFLARE_ACCOUNT_ID` and `CUSTOM_DOMAIN` (`gh variable set NAME --body VALUE`). Not secret, just kept out of the repo.
   - Plain settings, as variables too: `PLAID_ENV` and any others from the table below.

The nightly job runs from the Cron Trigger. Locally, `npm run daily` triggers it on the dev server.

**Workers plan:** use Workers Paid ($5/month). The free plan allows 10 ms of CPU and 50 outbound requests per invocation, and Wattle Wealth goes past that. Measured on Node, including SQLite's share:
- a routine sync takes about 20 ms
- a 2-year history chart by category takes about 80 ms
- a 2-year backfill takes about 250 ms per account

### Cloudflare Access (Zero Trust), recommended
A second lock in front of the app. Cloudflare's edge only lets your Google accounts reach the domain at all. Wattle Wealth's own Google sign-in still runs behind it (it decides which household member you are). It's free for up to 50 users. Requests from the daily cron never pass through Access, so it's unaffected.

1. **Team name:** in Cloudflare → **Zero Trust → Settings → Team name and domain**, note `<team>.cloudflareaccess.com`.
2. **Google OAuth client for Access** (separate from Wattle Wealth's): Google Cloud Console → **APIs & Services → Credentials → Create OAuth client → Web application**.
   - Authorized JavaScript origin: `https://<team>.cloudflareaccess.com`
   - Authorized redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
3. **Login method:** Zero Trust → **Integrations → Identity providers → Add new → Google**. Paste the client ID (as **App ID**) and the secret, save, then **Test**.
4. **Applications:** Zero Trust → **Access controls → Applications → Create new application → Self-hosted**.
   - **App:** hostname = your domain, no path. Policy **Allow**, Include → **Emails** → your addresses. Login method Google with **Instant authentication** on. Session duration around 7–30 days.
   - **Plaid webhook:** hostname = your domain, path = `api/plaid/webhook`. Policy **Bypass**, Include → **Everyone**. Plaid can't sign in, and Wattle Wealth already verifies Plaid's signature on every webhook.
5. **Check:**
   - A private window should go through Google via `cloudflareaccess.com` before reaching Wattle Wealth's login.
   - A Google account that isn't listed should be blocked by Cloudflare.
   - `curl -i -X POST https://<domain>/api/plaid/webhook` should return Wattle Wealth's `401 {"error":"invalid signature"}`. A redirect to `cloudflareaccess.com` means the bypass isn't applying.

6. **Make the app require Access too** (recommended). Access adds a signed token (`Cf-Access-Jwt-Assertion`) to every request it lets through. With these two settings (GitHub variables, applied on the next deploy), every API request without a valid token is refused, so a misconfigured or removed policy can't expose the app:
   - `ACCESS_TEAM_DOMAIN`: e.g. `<team>.cloudflareaccess.com`
   - `ACCESS_AUD`: the application's **Application Audience (AUD) Tag**, under Access → Applications → your app → Configure → Additional settings

   The signing keys are fetched from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and cached for an hour, or refreshed early when Access rotates them. The Plaid webhook is exempt. Leave both settings unset locally.

### Configuration reference
| Setting | Where | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub secret | Lets the deploy job use your Cloudflare account |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub variable | Which Cloudflare account to deploy to |
| `CUSTOM_DOMAIN` | GitHub variable | Domain to deploy to (`wrangler deploy --domain`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Worker secrets | Google sign-in |
| `TOKEN_ENC_KEY` | Worker secret | Encrypts Plaid tokens at rest |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | Worker secrets | Plaid |
| `PLAID_ENV` | GitHub variable | `sandbox` (default) or `production` |
| `PLAID_ALLOW_REMOVE` | GitHub variable (optional) | `true` makes Disconnect also remove the login at Plaid (`/item/remove`, can't be undone). Default off: the login is kept so it can be reconnected without using another Item |
| `TIINGO_API_KEY` | Worker secret | Daily closes (mutual funds too), history, ticker lookups; live quotes without Finnhub (50 requests an hour free) |
| `FINNHUB_API_KEY` | Worker secret (optional) | Live quotes (60 calls a minute free; no mutual funds or history, which come from Tiingo) |
| `QUOTE_PROVIDER` | GitHub variable (optional) | `finnhub` (default with a Finnhub key), `tiingo` (default otherwise) or `none` |
| `QUOTE_CACHE_SECONDS` | GitHub variable (optional) | How long a live quote is reused, app-wide (default `300`) |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | GitHub variables (optional) | Require a Cloudflare Access token on API requests |
| `DEV_LOGIN_EMAILS` | `.dev.vars` only | Local dev sign-in without Google |
| `FX_PROVIDER=none` | tests only | No live exchange-rate calls |

Locally, every Worker setting goes in `.dev.vars` (see `.dev.vars.example`).

### Running on Node instead

```sh
npm run build
DATABASE_URL=file:wattle.db PORT=8787 GOOGLE_CLIENT_ID=… TOKEN_ENC_KEY=… npm run node:start
```

## Future improvements

### Investments
- **Returns excluding contributions.** Today the Growth page includes money added and withdrawn. Wattle Wealth already stores investment transactions, so it can compute time-weighted return (performance alone) and money-weighted return (your actual experience), plus dividends as total return.
- **Currency effect.** Split growth into what came from the assets themselves and what came from USD/AUD exchange-rate moves. In a mixed USD/AUD household, net worth in one currency can rise or fall just because the other currency moved. For each account in a different currency from the one displayed, compare its value at a fixed starting rate with its value at each day's rate.
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
- **Privacy mode.** One click blurs every amount, for looking at Wattle Wealth with others around.

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
- **Bulk inserts without Drizzle.** Building statements row by row in Drizzle is most of the CPU time of a history load (about 6.6 µs a row: per-column encoding and checks on every SQL piece; a 30-position load writes ~47,000 rows in ~3,600 statements). A small hand-written bulk insert for `holding_daily`, `account_daily` and `prices_daily` would cut it substantially. Reads and ordinary writes are fine as they are. `test/budgets.test.ts` measures the statements built.
- **History loads as real background jobs.** On Workers, `waitUntil` work after a response belongs to the same invocation: it shares its CPU limit and is cut off 30 seconds after the response. Options: Cloudflare Queues (one message per load, each its own invocation), Workflows (durable steps, each retried and with its own CPU limit), or a second, frequent cron that runs due history work. Today a load that's cut off is recorded and retried by the nightly job (see "Runs stopped part-way").

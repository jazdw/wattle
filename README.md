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
- **Unlinking.** Disconnecting a login stops syncing and keeps its accounts and history as manual accounts, unless you choose to delete them. The Plaid login itself is kept (unless `PLAID_ALLOW_REMOVE` is on), so **Reconnect** resumes it on the same Item: Plaid's Trial plan counts removed Items, so a new link would use another of the 10. Balances recorded or imported while disconnected keep those days; syncing never overwrites them. Accounts an institution stops reporting (closed, or deselected in Plaid) are flagged "no longer reported" and drop out of totals (charts too, from that day), keeping their history; they can then be deleted with it.
- **Sold positions.** Sold holdings disappear on the next sync. Their history stays, and charts show them falling to zero.
- **Linking.** Each person links their own logins with Plaid Link. **Link account** asks Plaid for Assets (daily balance history; it's what Link lists institutions by), Investments wherever the login has investment accounts, and consent for Transactions, which isn't fetched or billed until used and can be switched on later on the same login (no new Item). So one login, one Item, brings a brokerage's holdings and its cash account's history. **Link investments only** is the fallback for institutions without Assets (some 401(k) providers). Each completed link is a new Plaid Item; on the Trial plan removed Items still count against the 10. Accounts are tagged by owner (either of you, or joint). If you've both linked a joint account, **hide** one copy. Hidden accounts aren't synced or stored and don't count in any total.
- **Choosing accounts.** **Choose accounts** on a login's card reopens Plaid Link for that login with its account selection, to add or remove accounts at any time (no new Item). It syncs straight away: added accounts appear and get their history loaded (only theirs). An added investment account's history loads straight away; an added bank account's needs a new bank report for the whole login, which Plaid bills per report, so Wattle asks first (**Load history** or **Not now**; Reload history loads everything later). Removed ones are flagged "no longer reported" and keep their history; choosing one again brings it back with its history: Plaid gives it a new account id, so a new account matching exactly one no-longer-reported account of the login (type, subtype, last four and name) takes that account over, noted in Activity, and the days between are filled as missed days. Look-alikes (more than one match) stay separate accounts. When Plaid reports that the institution has accounts you haven't shared (`NEW_ACCOUNTS_AVAILABLE`), the card says so until you choose.
- **No full account numbers.** Wattle never asks for Auth (account and routing numbers), Liabilities or Identity, its Plaid client only calls a fixed list of endpoints, and every Plaid response has account and routing numbers (and asset reports' account owners) removed before anything else sees it. Only masks (the last few digits) are kept.
- **No account numbers.** Only Plaid's `mask` (last ≤4 characters) is stored. The `auth` product is never requested. `test/schema.test.ts` fails if a column for account or routing numbers appears.
- **Secrets at rest.** Plaid access tokens and asset-report tokens are AES-256-GCM encrypted with `TOKEN_ENC_KEY`. The ciphertext is bound to its household and connection, and keys can be rotated (`v2:<new>,v1:<old>`).
- **Nothing personal in logs.** Errors are logged through `describeError` (`server/lib/errors.ts`), which keeps a failed query's SQL but drops its values (Drizzle puts them in the message).
- **Sessions** last 30 days and end as soon as the email leaves the allow-list. Signing out also tells the browser to drop cached pages, and a page restored by the back button reloads.
- **Shared prices.** Daily closes and FX rates from Tiingo and Frankfurter are public data, shared by all households. Prices an institution reports through Plaid stay with that household (its securities' last price) and never go in the shared table.
- **Session cookies.** Over HTTPS they're `__Host-` cookies, which only this exact host can set, so another subdomain can't plant a session.
- **Webhook checks.** The webhook is public. A webhook naming an item or report Wattle Wealth doesn't have is dropped before its signature is checked, so forged ones can't make it ask Plaid for verification keys. For the rest: key ids must be well-formed, an id Plaid had no key for isn't asked about again for five minutes, and each instance makes at most 10 lookups a minute (Plaid's real key is normally cached).
- **Background jobs** (`services/jobRunner.ts`). Work that doesn't happen while someone waits runs as small jobs, each in an invocation of its own, so each has the platform's limits to itself (Workers Free: 10 ms of CPU, 50 outside requests):
  - The `jobs` table is the record. The platform only wakes a runner: a Cloudflare Queue (`wattle-jobs`, one message per job, one job run per message) on Workers, the process's own loop on Node.
  - Each wake-up runs the fairest due job, not the one its message named: from the household with the fewest jobs running, then the one whose last job started longest ago. So one household's history load takes turns with everyone else's nightly syncs, and nobody waits while a runner is free. A lost wake-up is recovered by the sweep, which runs nightly and whenever the app checks `/api/status`, so nothing depends on the queue keeping its messages.
  - A job is claimed by one conditional update and holds a lock it renews before each write, like a lease, and on a heartbeat while it runs, so only an attempt that was stopped loses it. A failed attempt is retried after 1, 5, then 30 minutes; one stopped part-way (its lock ran out) runs again. After three attempts it fails for good: shown in the warning banner and on the Activity page, and a failed history load offers **Reload history**.
  - Jobs that belong together share a group; a job can wait for a group and is queued when that group has no unfinished jobs (checked when each of its jobs finishes and when the waiting job is added, so neither order loses it). A group's jobs fail "for good" without holding up what waits for them; that job decides what the failures mean (a history load with failed parts fails, and writes nothing if its prices failed).
  - `JOB_CHUNK_ROWS` (default 1,000) sets about how many rows one job builds. Building a row costs about 6.6 µs of CPU, so the default stays inside Workers Free; on Workers Paid, 5,000 gives a quarter of the jobs. Keep it under about 8,000: a job writes roughly one statement per 9 rows, and D1 allows 1,000 queries per invocation.
  - **Daily write budget.** D1 Free allows 100,000 rows written a day (UTC), every index entry counting, and past that every write fails until midnight UTC, sign-in included. A first history load for a large investment login can write more than that (about 117,000 measured for two accounts with 30 positions). So each request and job adds the rows D1 says it wrote (`meta.rows_written`, counted by `adapters/d1Meter.ts`) to the day's total in `db_usage`, and history and bank-report jobs that could take the day past `D1_DAILY_WRITE_BUDGET` (default 80,000) wait until just after midnight UTC instead: a load spreads over days, with the same result, and its card says when it continues. Waiting doesn't use an attempt. If D1 refuses a write for its daily limit anyway, the job waits for the reset the same way. `0` turns the budget off (Workers Paid). Node counts nothing, so nothing waits.
- **Investments calls.** Plaid bills holdings and investment transactions per call (the Trial plan counts them against its free credits), so a sync fetches only what's needed: a `HOLDINGS` webhook fetches holdings, an `INVESTMENTS_TRANSACTIONS` webhook transactions, a bank-report webhook neither; Sync, linking, Choose accounts and a repaired login fetch both. The nightly sync skips what was already fetched since the market's last close (4pm New York), recorded in `holdings_fetched_at` / `transactions_fetched_at`: a webhook that came after the close already has the day, while one earlier in the day doesn't count, so a trade made during the day is still caught that night when its webhook was missed. The nightly snapshot still values every holding with that day's closing prices.
- **Daily job** (cron `0 2 * * *` UTC, after US close). The cron adds the night's jobs first (so a cron stopped part-way still syncs), then does the light upkeep (FX rates, pruning, the sweep), adding any failure to the night's errors. A second trigger within a few hours joins the night already running. The jobs: a `sync` per active login, then per household a `snapshot` waiting for its syncs (one `account_daily` and one `holding_daily` row per account and holding), then `nightly_finish`, which completes the `job_runs` row with any job that failed. One household's failures never hold up another's. Manual and imported values are never overwritten.
- **Runs stopped part-way.** A Worker stopped by a limit (CPU, run time, requests) runs no more code and can't log it, so it's found afterwards:
  - Syncs write a `running` row in `sync_runs` when they start. The next run to take the connection's lease marks any still-running row `INTERRUPTED` (nothing else can be running then). Activity shows it as "Stopped part-way". History loads and report collections are jobs, which record a stopped attempt themselves.
  - Snapshots do the same in `snapshot_runs`, and the daily job in `job_runs`: one still running when the next night starts is marked `interrupted`.
  - Every page shows a warning while any of this is recent (`/api/status`): the nightly job stopped or late, runs stopped in the last three days, background jobs that failed.
- **Work budgets.** `test/budgets.test.ts` counts the database calls, statements, rows written and outside requests of each request and each background job (a first link and its history load, the nightly job, page loads), with realistically sized data (30 positions, 500 transactions, two years), and fails when a change goes over budget. Counts, not timings, so they're exact.
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
  - `jobs` (per household): each background job, its attempts, result or error. Finished jobs are kept 30 days (what they changed is in the logs above).
  - `job_runs` (global): each nightly run, with the households processed and any errors.
  - The **Activity** page (Accounts → Activity) shows the household's `sync_runs` and `snapshot_runs` together with the nightly runs and any background job that failed for good, by day, filterable to problems. Of `job_runs` it shows only the date and whether the run finished, since its errors can name other households' logins.
  - Known gap: if two households' snapshots fetch the same ticker at the same moment, a `price_runs` entry can name a "before" value the other fetch had already replaced. The stored price is right; only that log detail is off, and it can't happen with one household. Closing it would mean serialising all price writes, which isn't worth it.
  - Raw Plaid responses are not stored.
- **History backfill.** When an account is linked (as background jobs; the login's card shows "Loading history… n of m"):
  - With Investments, investment accounts are rebuilt from up to 24 months of transactions and daily closes. Days where the institution's history has gaps are marked *estimated* and shaded in charts. The jobs: `history_plan` decides the work, `history_prices` fetches closes for a few tickers each, `history_block` rebuilds one account's window of days each (independent: each walks back from today's holdings, so windows can run in any order), and `history_finish` records the outcome. `test/historyChunks.test.ts` checks that many small jobs write exactly the rows one large job would.
  - With Assets, the login's other accounts (bank, card, a brokerage's cash account) use Plaid Asset Report daily balances (up to 2 years), collected by `report_collect` once Plaid has built the report (a large report becomes one `report_account` job per account, then `report_finish`). It's first looked for a minute after it's asked for, then every 10 minutes. A report that isn't ready after a day, or can't be collected after retries, is given up and deleted at Plaid: a first load is marked failed (Reload history asks for a new one), and missed days wait for a later fill.
  - Anything else can be imported from CSV. Westpac transaction exports are recognised automatically.
- **Missed days.** Each night's snapshot records the day's balance. Which figure wins for a day:
  - A linked account's balance reported that day is the bank's figure, and replaces anything entered or imported for it.
  - If a sync fails (or the login is disconnected), the last balance is carried forward and marked *estimated*.
  - After each sync, each account's last day covered by the institution's figure (a reported balance or bank history) is checked. Days after it, up to yesterday, were missed, and so is any day still carrying a balance forward (a fill that failed leaves those, even with known days after them). Recorded and imported days don't count, since the fill never replaces them.
  - A fill that fails is tried again by the first sync at least 6 hours later (`missed_retry_at`), not by every webhook sync in between: a bank fill asks Plaid for a new report each time.
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
npm run dev                           # http://localhost:5173 (applies new local migrations first)
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
2. **Deploy:** `CUSTOM_DOMAIN=wattle.example.com PLAID_ENV=sandbox npm run deploy`. It creates the `wattle-jobs` queue if it doesn't exist, finds the D1 database named `wattle` (creating it the first time), builds with its id, applies migrations and deploys to the domain with the plain settings in the environment. The id is never written to the repo: `wrangler.jsonc` keeps a placeholder.
3. **Worker secrets:** these persist across deploys. For each `<NAME>`, run `npx wrangler secret put <NAME>`:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `TOKEN_ENC_KEY` (generate with `openssl rand -base64 32`)
   - `PLAID_CLIENT_ID`, `PLAID_SECRET`
   - `TIINGO_API_KEY`, `FINNHUB_API_KEY`
4. **Who can sign in:** `npm run allow -- add you@gmail.com partner@gmail.com`.
5. **GitHub Actions** (`.github/workflows/deploy.yml`): every push to `main` typechecks, lints and tests. Once these are set, it also runs `npm run deploy`. Until then the deploy step is skipped.
   - Secret: `CLOUDFLARE_API_TOKEN` (`gh secret set CLOUDFLARE_API_TOKEN`). The "Edit Cloudflare Workers" template, plus Account → D1 → Edit and Account → Queues → Edit (the deploy creates the jobs queue).
   - Variables: `CLOUDFLARE_ACCOUNT_ID` and `CUSTOM_DOMAIN` (`gh variable set NAME --body VALUE`). Not secret, just kept out of the repo.
   - Plain settings, as variables too: `PLAID_ENV` and any others from the table below.

The nightly job runs from the Cron Trigger. Locally, `npm run daily` triggers it on the dev server.

**Workers plan:** use Workers Paid ($5/month), with `D1_DAILY_WRITE_BUDGET=0` and `JOB_CHUNK_ROWS=5000`. Paid allows 30 s of CPU per invocation (Free: 10 ms), 10,000 outside requests (Free: 50) and 50 million D1 rows written a month with no daily cap (Free: 100,000 a day). On Free, background work still fits (small jobs, the default `JOB_CHUNK_ROWS` of 1,000), but a large first history load is spread over days by the write budget, and some requests come close to the CPU limit. Measured on Node, including SQLite's share:
- a routine sync takes about 20 ms
- a 2-year history chart by category takes about 80 ms
- a realistic first history load (2 accounts, 30 positions, 2 years): 57 jobs of up to 17 ms at `JOB_CHUNK_ROWS=1000`, 13 jobs of up to 62 ms at 5,000, writing about 117,000 rows as D1 counts them

With Workers Paid, Plaid sets the limits: 10 logins on the Trial plan, Investments calls per call, bank reports per report. Then Tiingo: its free plan allows 50 requests an hour, and a first history load asks for each ticker's history (a rate-limited price job waits and tries again).

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
| `JOB_CHUNK_ROWS` | GitHub variable (optional) | About how many rows one background job builds (default `1000`, sized for Workers Free's 10 ms of CPU). `5000` on Workers Paid for fewer, larger jobs; keep it under about 8,000 (D1 allows 1,000 queries per invocation) |
| `PLAID_ALLOW_REMOVE` | GitHub variable (optional) | `true` makes Disconnect also remove the login at Plaid (`/item/remove`, can't be undone). Default off: the login is kept so it can be reconnected without using another Item |
| `D1_DAILY_WRITE_BUDGET` | GitHub variable (optional) | Rows written a day (UTC, as D1 counts them) after which history and bank-report jobs wait for the next day. Default `80000` (D1 Free allows 100,000); `0` turns it off on Workers Paid |
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

Background jobs run in the same process: the fairest due job, one at a time, swept every minute.

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

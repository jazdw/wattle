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
- **Rotating the token key** (`services/crypto.ts`, `services/tokenRotation.ts`). The key that encrypts can't be read back from the Worker, so moving to one you hold goes through the Worker, which can still decrypt:
  1. Generate a key (`openssl rand -base64 32`) and save it in your password manager.
  2. `npx wrangler secret put TOKEN_ENC_KEY_NEXT` with it. It encrypts from then on; the current key still decrypts.
  3. Open Wattle Wealth: the first request queues a `rotate_tokens` job per household, which re-encrypts every stored token with the new key (each only if it hasn't changed since it was read) and notes "Moved its tokens to the new encryption key" on each login's Activity. The nightly job does the same pass as a safety net.
  4. Check none are left on the old key (each token starts with its key's version, `v2.` for the new one):
     `npx wrangler d1 execute wattle --remote --config .wrangler/remote-d1.json --command "select count(*) as old_key from connections where access_token_enc not like 'v2.%' or (asset_report_token_enc is not null and asset_report_token_enc not like 'v2.%')"`
  5. `npx wrangler secret put TOKEN_ENC_KEY` with the new key (with or without its `v2:` prefix: a token whose version isn't listed is tried with each key), then `npx wrangler secret delete TOKEN_ENC_KEY_NEXT`.
- **Nothing personal in logs.** Errors are logged through `describeError` (`server/lib/errors.ts`), which keeps a failed query's SQL but drops its values (Drizzle puts them in the message).
- **Sessions** last 30 days and end as soon as the email leaves the allow-list. Signing out also tells the browser to drop cached pages, and a page restored by the back button reloads.
- **App shell.** The app installs as a web app. Its service worker (Workbox, through `vite-plugin-pwa`) caches only the app's own files, never financial data: API calls always reach the Worker. The app is one bundle rather than a file per page, so a tab left open across a deploy never asks for a file the deploy removed. A deploy's new version installs in the background and waits: open tabs keep the version they loaded until the banner's **Reload** switches them all to it. Tabs check for a new version when they come back into view and hourly. Reopening the app's last tab can still get an old page whose bundle is gone (the new version takes over just after the old one served the page), so a bundle that fails to load reloads the page once (`public/boot.js`). Anything that would crash the app shows an error screen with Reload instead of a blank page, and `?reset=1` on any page drops the service worker and its caches.
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
- **Investments calls.** Plaid bills holdings and investment transactions per call (the Trial plan counts them against its free credits), so a sync fetches only what's needed: a `HOLDINGS` webhook fetches holdings, an `INVESTMENTS_TRANSACTIONS` webhook transactions, a bank-report webhook neither; Sync, linking, Choose accounts and a repaired login fetch both. The nightly sync always fetches holdings, for the institution's latest prices, and skips transactions already fetched since the market's last close (4pm New York), recorded in `transactions_fetched_at`: a webhook that came after the close already has the day, while one earlier in the day doesn't count, so a trade made during the day is still caught that night when its webhook was missed.
- **Provisional prices.** A snapshot values each public holding at a close dated for the day (the last trading day's on a weekend): Tiingo's, Plaid's own `close_price` (dated by `close_price_as_of`, kept in `securities.plaid_close`), or the institution's price when its `institution_price_datetime` (parsed into `holdings.price_at`; a midnight placeholder counts as none) falls between that day's 4pm close and the next 9:30 open. A price is never assigned to a day by when it was fetched, and Plaid's `institution_price_as_of` isn't used (some institutions' funds arrive dated a day early). Until a dated close exists (mutual fund NAVs often reach Tiingo only the next morning) the holding carries its last dated close and is provisional (`price_source = 'provisional'`). Every snapshot reprices the previous 7 days' provisional rows once a dated close for their day exists, and moves those days' synced account balances by the difference; a final row isn't rewritten.
- **Plaid's responses and webhooks.** The data calls' responses (`/accounts/get`, `/investments/holdings/get`, each `/investments/transactions/get` page, `/asset_report/get`), scrubbed of account numbers like everything from Plaid, are kept in `plaid_responses` for 30 days with the sync they belong to (a body over 1.5 million characters is recorded as omitted: D1 rows top out at 2 MB). Every verified webhook is kept in `plaid_webhooks` for 30 days too. Both are for checking later exactly what Plaid said.
- **Transaction history.** Every investment transactions fetch asks for the full two years: the history Plaid holds grows after a link (it can keep growing for days after a link), and it's one call either way. `INVESTMENTS_TRANSACTIONS: HISTORICAL_UPDATE` fetches transactions like `DEFAULT_UPDATE`. A bank history report's posted transactions (not pending ones, whose ids change) are kept too, as current as the last report.
- **Transactions.** Every account's transactions are in one table, `transactions`, whatever brought them (`source`: `plaid` for Plaid's investment transactions, `report` for a bank history report's, `import` for a file's), amounts in cents positive when money leaves the account (Plaid's convention). Each has a kind (`shared/transactionKinds.ts`): buy, sell, reinvest, income, deposit, withdrawal, fee, transfer (shares in or out) or sweep (within the account's cash). It's set by you, or else worked out when read, so a better mapping applies to everything already stored: an imported file's own (its readers' mapping, kept in `subtype`), Plaid's investment subtype before its type (dividends come under both `cash` and `fee`; a buy or sale of the account's cash fund is a sweep; a cancellation, or anything unrecognised, needs one set), or a bank transaction's sign (a card's purchases are money out and its payments money in; interest and fees by their description). The **Transactions** page lists every account's together (with each one's account) or one account's, newest first, the last month to begin with, filtered by a range (the Growth page's presets, or dates from and to) and a search (words in the description, or an amount either way), with each one's kind to change and its transfer; transfers to check are asked about there, a list on whichever side has several candidates.
- **Where the value came from** (`server/services/breakdown.ts`; the Growth page's Activity, Returns and Overview). Each day's change in an account's value is split, from its transactions' kinds, into money in and out, dividends and interest, fees, and what's left: market gain or loss for an investment account (exchange-rate moves included, as each day is converted at its own rate). A reinvestment moving no cash is its dividend; an account holding and moving no cash (a plan bought into directly) has its buys as money in and sales as money out, each day's offsetting first (a switch between its funds is neither), as are Plaid's buy `contribution`s and sell `distribution`s; shares moved in or out are money in or out at that day's price, unless within three days of a split. What can't be told apart is "not broken down", never a gain: days before an account's first known transaction, its first and last days (its starting value isn't a gain), a non-investment account's leftovers, and transactions whose kind isn't known. For the household, transfers between its accounts are left out of money in and out. Start + money in − money out + dividends − fees + market + not broken down is the end, to the cent.
- **Transfers between your accounts** (`server/services/transfers.ts`, the `match_transfers` job, queued after a sync brings new transactions, a bank report and an import). Money out of one account and the same money into another, in the same currency, to the cent, dated within 5 days either way (money can arrive before the other bank shows it leaving), is one transfer: linked automatically when each has only the other as a candidate, when both descriptions quote the same reference number (nine digits or more, as a bank quotes on both sides of a transfer between its own accounts) whatever else is near, or when identical ones can't be told apart (as many of the same amount out of one account on a day as into another on a day, or one whose candidates are all alike: the same account, day, amount and description; any pairing is the same); otherwise suggested on the Transactions page for you to confirm or reject. You can also link two yourself (within 10 days) or unlink one; what you decide is never changed, and a rejected pair isn't suggested again. Partial unique indexes keep each transaction in one link at most. Linked transfers are counted on one date in the household's totals: one that arrives before it leaves is in both accounts until it leaves, so it's taken off once (by account, it's left out of the account it arrived in until it leaves the other; cash by category), and one that leaves first is added until it arrives (by account, kept in the account it left).
- **Share splits.** Tiingo's daily prices give each day's split factor (a 4-for-1 split: 4 on its first day at the new price), kept in `prices_daily.split_factor`; closes stay the prices actually traded. Rebuilding an investment account's history from today's holdings divides a security's shares by the factor when walking back past a split, so the days before it show the shares held then. A split the institution recorded itself (a Plaid transaction with subtype `split` within 5 days) is undone by that transaction instead. Closes from Tiingo's IEX endpoint (the nightly bulk prices for stocks and ETFs) carry no split factor, and only a rebuild needs one (days written by snapshots have the share counts actually held), so nothing checks for splits on a schedule: a history load's price step fetches the days stored without a factor again from Tiingo's daily prices, in the same request as any missing days, before the history is rebuilt. Days Tiingo doesn't return count as no split.
- **Daily job** (cron `0 10 * * *` UTC: 6am New York in summer, 5am in winter, before the open, once Plaid's overnight update and the overnight fund NAVs are in; Plaid's webhooks usually trigger a sync and snapshot sooner, and this is the fallback). The cron adds the night's jobs first (so a cron stopped part-way still syncs), then does the light upkeep (FX rates, pruning, the sweep), adding any failure to the night's errors. A second trigger within a few hours joins the night already running. The jobs: a `sync` per active login, then per household a `snapshot` waiting for its syncs (one `account_daily` and one `holding_daily` row per account and holding), then `nightly_finish`, which completes the `job_runs` row with any job that failed. One household's failures never hold up another's. Manual and imported values are never overwritten.
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
  - With Investments, investment accounts are rebuilt from transactions and daily closes, each from where its history is known (its first transaction, or its first day synced, imported or entered), at most 24 months back. Nothing is shown before that: today's holdings copied back would be made up. Days where the institution's history has gaps (the walk back finds an impossible state) are marked `unmatched`. The jobs: `history_plan` decides the work, `history_prices` fetches closes for a few tickers each, `history_block` rebuilds one account's window of days each (independent: each walks back from today's holdings, so windows can run in any order), and `history_finish` records the outcome. `test/historyChunks.test.ts` checks that many small jobs write exactly the rows one large job would.
  - With Assets, the login's other accounts (bank, card, a brokerage's cash account) use Plaid Asset Report daily balances (up to 2 years), collected by `report_collect` once Plaid has built the report (a large report becomes one `report_account` job per account, then `report_finish`). It's first looked for a minute after it's asked for, then every 10 minutes. A report that isn't ready after a day, or can't be collected after retries, is given up and deleted at Plaid: a first load is marked failed (Reload history asks for a new one), and missed days wait for a later fill.
  - **Imports** (one page, `/import`, and one endpoint, `POST /api/imports`) take anything else: one or more files, each with one or more accounts.
    - **The page** (`src/pages/Import.tsx`) has a section per account in the files: where it goes, the balance a file of transactions is worked out from, and a preview of every row it writes (each transaction with the cash and the security's shares after it, worked back as the server does, and the day's close beside each trade; or each balance). As the choices settle, the same request is checked by `POST /api/imports/check`, which runs every check and writes nothing; its problems show on their accounts with their days marked in the preview, and Import stays off until there are none. Afterwards the page lists each account with its progress.
    - **Reading.** Files are read in the browser (`src/lib/imports.ts`) into one shape whatever the format (`importSchema` in `shared/schemas.ts`): an account's holdings (positions and cash now, then transactions, each mapped to a kind: buy, sell, reinvest, income, deposit, withdrawal, fee, transfer or sweep), or its dated balances. Quicken downloads (QFX/OFX, either version, read with [ofx-js](https://github.com/bradenmacdonald/ofx-js)) hold investment, bank and card accounts (a bank or card statement is its balance on each day a transaction posted, worked back from the closing balance to the day the statement starts; a card's is what's owed, and a new account from one is a credit card); a CSV is either a date and a balance per row, its columns and date format found from its header and values when it names a date and a balance column (else picked by hand), or transactions, found from the header the same way: investments when it has shares and the security they're in (kinds from its type column, or the shares' sign without one), cash when it has amounts (one column, or debits and credits; pending rows left out). A CSV may hold several tables, separated by blank lines (a block with no header of its own, as wide as the table above, is more of it): a table of holdings now (shares in securities, no transaction dates) is what the account holds, and an account number column makes an account of each number. The cash rules are the Quicken reader's: a $1 holding with no symbol, or one cash is swept into, is the account's cash, so moving money into or out of it is a sweep; a trade naming no security and moving no shares stays in the cash; a reinvestment is paid for by the income the file lists for it (else it only adds shares). A position's share count comes from its value to the cent over its price (files round share counts, to three decimals say, but not values), when that agrees with the count shown to within its rounding, or alone when the file shows none; otherwise the count shown stands. A file of transactions with no holdings has no balance in it, so you give one, before its first transaction or after its last (cash, and each security's shares), and every day is worked out from there (`src/lib/known.ts`): forwards from a known start and backwards from a known end are the same sum, so a start becomes the end it leads to and the import works back from that as usual. A row whose date or amount can't be read stops the import, saying which. Transaction types a reader doesn't know are listed, never guessed, and that account can't be imported. The same account in several files is merged: overlapping downloads count a transaction once (by the institution's id, else by its details), and positions come from the latest file (balances by date, the later file's winning). Files without account numbers (a CSV a year) are combined the same way when you choose "Same account as" another file; a file of holdings combined with one of transactions makes the holdings the known point. One account's Quicken file and a CSV of it aren't combined: their transactions can't be matched to count each once.
    - **Quicken files, as other downloads list them.** OFX's available cash includes sweep funds, so a $1 money market or bank sweep position worth exactly that much is the cash itself, and moving money into or out of it is a sweep. A reinvestment is its income plus the purchase, unless the file already lists that income a few days before (some institutions do, and may take a fee from it first); each takes the closest income at least as large, largest reinvestment first, so two on one day each find their own. A withdrawal matching that day's cash income is the income moving into the sweep.
    - **Where each account goes.** Each account in the files goes into the account with the same last four digits (picked for you), another of yours, a new manual account (named after the institution, or the file for one without a number; its last four digits are kept and shown beside the name, as a linked account's are), or nowhere. New accounts are created only once every account has checked out; choosing a new account where a linked one has the same digits warns that the money would count twice.
    - **Holdings** (`importAccounts` in `server/services/holdingsImport.ts`). Each day's shares and cash come from walking back from the positions through the transactions: shares and cash both move on the trade date, so a purchase isn't counted twice while it settles; a split is its own transaction; cash may go below zero, as when something is bought or a fee charged before the money arrives. An account holding and moving no cash at all (a 401(k)) buys and sells its funds directly with contributions and fees. Funds with a market ticker are valued at each day's close (fetched once for the whole import); funds without one, such as a plan's collective trusts, a ticker the market data provider doesn't know, or one whose closes can't be fetched just now (the provider down or rate-limited), from the file's own prices: the institution's on days it has one (`price_source = institution`), on a straight line between them otherwise, or the nearest held beyond the first and last (`interpolated`).
    - **Tickers the file leaves out.** Some institutions give a security no longer held only its CUSIP. The page lists securities without a ticker and suggests one (`POST /api/imports/tickers`): a security of yours with the same name (letters and digits compared), else the market data provider's search by name (Tiingo's doesn't find CUSIPs or ISINs). Each is filled in, to change or clear; one whose name only starts the same is marked to check. A ticker given there values it at each day's close; left blank, it's priced from the file.
    - **Estimates priced later.** Imported days of a market fund priced from the file because its closes couldn't be fetched say so in the result, and are repriced overnight: the nightly snapshot queues `import_reprice` for any account that has them, which fetches the missing closes (those still failing wait another night) and reprices each window of days, moving the day's balance by the difference.
    - **Checks**, before anything is written: no fund may go below zero shares; a fund priced from the file must have totals that are its shares × price (allowing for charges and rounded share counts); each buy and sell of a market fund must be within 5% of that day's close (not reinvestments: their price is the dividend over a rounded share count, filled when it's paid); and a linked account's walk must reach the share counts synced since the link, up to the day the file's positions are as of, but for the file's own transactions of the last five days in that security or the cash (the newest, or the newest few together), which the institution's feed can show a day or two late (a reinvested dividend). Any account failing stops the whole import, naming the account.
    - **What's written**, as `import` by `import_block` jobs. A linked account's days through the day the file's positions are as of, replacing the synced days it covers (the institution's own records are the better source), its holdings now left to the institution. Into a bank account (a brokerage's cash management account, which Plaid lists as one), each day's total as its balance, with no holdings. A manual account's days through today (replacing its snapshot days), its positions becoming its holdings, carried by the nightly snapshot at the last file price until the next import. Balances are written as entered values are, each held until the next. A history rebuild later doesn't touch imported days.
    - **The file's transactions** are kept as the account's (bank and card statements' and a cash CSV's too), each known by the file's id (a Quicken FITID), with the file's text as it has it (a Quicken file's NAME as the description and MEMO as the memo, shown joined), else by its details and its place among identical rows, so a re-import finds the same rows again: a kind you set and its transfer stay, and rows the new file no longer has, in its days, go. In a linked account, the file is the institution's own record, so on the days an import wrote its transactions count and Plaid's or the bank report's are kept but left out (`server/services/importedRecord.ts`: `counted()`, used by the Transactions page, the breakdown and transfer matching); on every other day the institution's count. Nothing is deleted, as a sync sends its transactions again anyway, and removing or replacing the import brings them back. There's no id in common (Plaid's are its own), so before transfers are matched each of the institution's transactions is paired with the file's that has the same amount, security and share count within five days (each at most once, the nearest), as feeds often show a transaction a day or two late: a paired one is left out wherever it's dated (one just after the file's last day would otherwise count twice), and gives the file's its description when that has all of the file's text, spacing aside (a bank's file splits it across NAME and MEMO, cutting NAME at 32 characters), a kind you set on it, and a transfer you confirmed or rejected. The history rebuild still walks back through Plaid's own transactions; it can't overwrite an import's days (they're trusted more).
- **Where each day's value came from.** Every `account_daily` and `holding_daily` row has a `source` (`carried`, `rebuilt`, `snapshot`, `import` or `manual`), a `price_source` (`close`, `provisional`, `institution`, or null for a balance) and `unmatched`. `shared/quality.ts` holds the meanings and the trust order: `import` = `manual` > `snapshot` > `rebuilt` > `carried`. A write replaces a row only if its source is trusted at least as much (`replaceWhere` in `server/services/quality.ts`, the same order in SQL), so your imports and entries beat anything from the institution, and between an import and an entry the later one wins. The history API returns each value's quality (combined over its parts for totals), though nothing shows it yet.
- **Missed days.** Each night's snapshot records the day's balance. Which figure wins for a day:
  - A linked account's balance reported that day is the bank's figure (`snapshot`), and replaces rebuilt and carried values, never entered or imported ones.
  - If a sync fails (or the login is disconnected), the last balance and holdings are carried forward (`carried`).
  - After each sync, each account's last day covered by the institution's figure (a reported balance or bank history) is checked. Days after it, up to yesterday, were missed, and so is any day still carrying a balance forward (a fill that failed leaves those, even with known days after them). Recorded and imported days don't count, since the fill never replaces them.
  - A fill that fails is tried again by the first sync at least 6 hours later (`missed_retry_at`), not by every webhook sync in between: a bank fill asks Plaid for a new report each time.
  - Bank accounts on an Assets login: a small asset report is requested for just those days. Its balances (`rebuilt`) replace the carried ones, but never reported, entered or imported days.
  - Investment accounts: they're rebuilt for just those days from the transactions that arrived since, so a trade made during the gap shows up. The rebuild checks itself: walking back across the gap must arrive at the holdings synced the day before it (share counts, and cash to the cent). If it doesn't, a transaction is missing or wrong, so the days keep their carried values, marked `unmatched`, the run says so on the Activity page, and that gap isn't tried again on every sync (a full rebuild redoes it).
  - Each gap is asked for once. Days the bank has no figure for keep the carried-forward balance, relabelled as bank history (`rebuilt`), so they count as covered and aren't asked for again.
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
4. Add `https://<your-domain>/plaid-oauth` under **Allowed redirect URIs** in the dashboard (Developers → API). Banks with their own login page (OAuth: Northwind, Contoso, …) send phones back there to finish linking. It's sent over HTTPS only; on a local http address Link uses its desktop popup and needs no redirect URI.

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
   - `TOKEN_ENC_KEY` (generate with `openssl rand -base64 32`, and **keep a copy in your password manager**: the Worker's secret can't be read back, and a database backup restored anywhere else needs it to use its Plaid logins)
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
| `TOKEN_ENC_KEY_NEXT` | Worker secret, only while rotating | A new key to move the tokens to (see Secrets at rest) |
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
- **Rate of return.** The Growth page splits market gain or loss from money in and out in dollars; a percentage, time-weighted (performance alone) and money-weighted (your actual experience), would follow from the same breakdown.
- **Inflation adjustment.** Values in today's money, from each currency's consumer price index, applied as the currency conversion is (needs an outside data source).
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
- **Show data quality on charts.** The history API already says where each value came from; charts could mark carried, provisional or unmatched days (e.g. shading), and draw straight segments instead of curves so a line doesn't overshoot at its corners.

### History and imports
- **A better check for dividend reinvestments.** They're skipped by the import's price check today; compare them with a range of nearby closes, or allow for the share count's rounding, instead.
- **Rebuild history on request** for investment logins: a button that marks the history stale and rebuilds it, rather than a change in the database.
- **History older than a download reaches.** Institution downloads can be capped (e.g. 18 months); earlier history could come from statements.
- **CUSIP lookups.** A security a file names only by CUSIP is matched by name today; a CUSIP-to-ticker service (e.g. OpenFIGI) would find any, at the cost of an outside service.

### Transactions phase (checking and credit cards)
- **Sync** with Plaid `/transactions/sync`, fetching on demand and daily rather than continuously, which keeps Plaid usage down.
- **Categories, merchants and tags**, with rules that categorise automatically and remember manual corrections. Only uncategorised transactions go to a classifier, and any single transaction can override the merchant's usual category (e.g. tyres bought at Costco are Auto, not Shopping).
- **Classification model.** A small decision/classification model instead of a chat LLM, e.g. TypeSafe's [Jev](https://openrouter.ai/typesafe/jev-1.13): it returns typed choices with probabilities, so anything below a confidence threshold goes to a review queue. Could also suggest fund classifications (category, size, style) for funds without a seeded profile. It needs only merchant or fund names and amounts, never account details. Vendor-reported accuracy and cost are unverified.
- **Transfers in cash flow.** Transfers between your accounts are matched (see How it works); cash flow and budgets should leave them out of income and spending too. Share transfers between institutions, and transfers between currencies or less a fee, aren't matched yet.
- **Edits ripple through.** Editing or recategorising an old transaction updates every derived view (cash flow, budgets, balances).
- **Cash flow and budgets.** Monthly income vs spending (a Sankey diagram is popular), category budgets with remaining amounts, and trends.
- **Recurring transactions and a planner.** Upcoming bills and income, projected cash flow, and the ability to drop in a planned transaction and see its effect.
- **Per-property pages.** Rent, mortgage and expenses for each property, with only net cash flow feeding the household budget.
- **Search** across transactions, merchants and categories.
- **Imports** that fill gaps without creating duplicates, for banks Plaid can't reach (a CSV of balances is already supported).

### Data sources and platform
- Australian bank sync through a Consumer Data Right (CDR) aggregator (Basiq/Fiskil), behind the existing aggregator port.
- SimpleFIN as a cheap fallback for balances and transactions where Plaid fails. It provides no holdings, and users report reliability problems.
- Automatic property valuations.
- Invites and multiple households in the UI.
- Passkey (WebAuthn) sign-in as an alternative to Google.
- **Investments on or off per login.** A login whose institution lists Investments always fetches holdings and investment transactions; a switch would stop that for logins with nothing to fetch.
- **Fewer Plaid investment calls.** The nightly sync always fetches holdings, for the institution's latest prices; it could skip them when a webhook's sync already fetched them since the market closed.
- **One FX fetch at a time.** Several requests at once can each fetch the same day's exchange rate; they could share one fetch.
- **Bulk inserts without Drizzle.** Building statements row by row in Drizzle is most of the CPU time of a history load (about 6.6 µs a row: per-column encoding and checks on every SQL piece; a 30-position load writes ~47,000 rows in ~3,600 statements). A small hand-written bulk insert for `holding_daily`, `account_daily` and `prices_daily` would cut it substantially. Reads and ordinary writes are fine as they are. `test/budgets.test.ts` measures the statements built.

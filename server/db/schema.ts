/**
 * Database schema (SQLite dialect: D1 in production, libsql in tests/Node).
 *
 * Conventions:
 *  - ids are TEXT UUIDs; timestamps are INTEGER epoch milliseconds;
 *    calendar dates are TEXT `YYYY-MM-DD`.
 *  - Money is INTEGER minor units (cents) with a currency code; quantities and
 *    unit prices are REAL.
 *  - Every table holding household data has `household_id` and is only
 *    queried through the tenant helpers in ./tenant.ts.
 *  - Account numbers are never stored — only Plaid's `mask` (last ≤4 chars).
 *    test/schema.test.ts enforces that no such column exists.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { Classification } from '../../shared/taxonomy';
import type { SyncChange } from '../../shared/types';

/* ------------------------------------------------------------------ */
/* Tenancy & auth                                                      */
/* ------------------------------------------------------------------ */

export const households = sqliteTable('households', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  displayCurrency: text('display_currency').notNull().default('USD'),
  createdAt: integer('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  picture: text('picture'),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const householdMembers = sqliteTable(
  'household_members',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull().default('member'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.householdId, table.userId] }),
    // One household per user for now; drop this to allow several.
    uniqueIndex('household_members_user').on(table.userId),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 hash of the session cookie value. */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('sessions_user').on(table.userId)],
);

/** Who may sign in, and which household they join on first sign-in. */
export const allowedEmails = sqliteTable('allowed_emails', {
  email: text('email').primaryKey(),
  householdId: text('household_id').references(() => households.id, { onDelete: 'cascade' }),
  note: text('note'),
  addedAt: integer('added_at').notNull(),
});

/* ------------------------------------------------------------------ */
/* Aggregator connections & accounts                                   */
/* ------------------------------------------------------------------ */

/** A login at an institution via an aggregator (a Plaid "Item"). */
export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    provider: text('provider', { enum: ['plaid'] }).notNull().default('plaid'),
    /** The provider's id for this connection (Plaid item_id). */
    externalId: text('external_id').notNull(),
    /** AES-GCM encrypted access token (see server/services/crypto.ts). */
    accessTokenEnc: text('access_token_enc').notNull(),
    institutionId: text('institution_id'),
    institutionName: text('institution_name'),
    /** Which Link button created it: account (Assets first) or investments (Investments only). */
    kind: text('kind', { enum: ['investments', 'account'] }).notNull(),
    /** The login has Plaid Investments: holdings, investment transactions, rebuilt history. */
    hasInvestments: integer('has_investments', { mode: 'boolean' }).notNull().default(false),
    /** The login has Plaid Assets: daily balance history from an asset report. */
    hasBalanceHistory: integer('has_balance_history', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['ok', 'login_required', 'pending_expiration', 'error', 'disconnected', 'removed'] })
      .notNull()
      .default('ok'),
    errorCode: text('error_code'),
    /**
     * When the status was last observed (a sync's Plaid fetch, or a webhook).
     * A status is only written if it's newer than this: newest information wins.
     */
    statusObservedAt: integer('status_observed_at'),
    consentExpiresAt: integer('consent_expires_at'),
    /** Plaid warned the login's consent is ending (PENDING_EXPIRATION / PENDING_DISCONNECT); cleared by re-linking. */
    consentWarningAt: integer('consent_warning_at'),
    /** Plaid said the login has accounts not yet shared with Wattle (NEW_ACCOUNTS_AVAILABLE); cleared once accounts are chosen. */
    newAccountsAt: integer('new_accounts_at'),
    lastSyncedAt: integer('last_synced_at'),
    /** Last day covered by stored investment transactions. */
    txnSyncedThrough: text('txn_synced_through'),
    backfillStatus: text('backfill_status', { enum: ['pending', 'running', 'done', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
    /** The day the investment history was rebuilt as of (later days come from daily snapshots). */
    historyAsOf: text('history_as_of'),
    /**
     * A transaction dated before historyAsOf arrived after the history was
     * built: rebuild it. Cleared only by a rebuild that started after this.
     */
    historyStaleAt: integer('history_stale_at'),
    /** A fill of missed days failed: the next isn't tried before then (each may ask the bank for a report). */
    missedRetryAt: integer('missed_retry_at'),
    /** Encrypted Plaid asset_report_token while a balance-history report is pending. */
    assetReportTokenEnc: text('asset_report_token_enc'),
    /** Plaid asset_report_id of the pending report (matches the ASSETS webhook; not secret). */
    assetReportId: text('asset_report_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('connections_household').on(table.householdId),
    uniqueIndex('connections_external').on(table.provider, table.externalId),
  ],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['plaid', 'manual'] }).notNull(),
    connectionId: text('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    /** Aggregator account id (Plaid account_id). */
    externalId: text('external_id'),
    /** Shown name. For linked accounts it follows plaidName until you rename the account. */
    name: text('name').notNull(),
    /** The institution's name for a linked account, as of the last sync. */
    plaidName: text('plaid_name'),
    officialName: text('official_name'),
    institutionName: text('institution_name'),
    /** Last ≤4 characters of the account number, as Plaid's `mask`. Never more. */
    mask: text('mask'),
    /** depository | credit | loan | investment | property | other */
    type: text('type').notNull(),
    subtype: text('subtype'),
    currency: text('currency').notNull().default('USD'),
    /** NULL means joint. */
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Hidden accounts are not synced and are excluded from every total. */
    isHidden: integer('is_hidden', { mode: 'boolean' }).notNull().default(false),
    /** Allocation category used when the account has no holdings (cash, property, super…). */
    category: text('category'),
    /** Latest balance (minor units, account currency; liabilities negative). */
    balance: integer('balance'),
    balanceAsOf: integer('balance_as_of'),
    /**
     * Set when the institution stopped reporting this account (closed, or
     * deselected in Plaid). It then drops out of totals; history is kept.
     */
    missingSince: integer('missing_since'),
    /**
     * A no-longer-reported account of the same login this one looked like
     * (Plaid gives an account chosen again a new id), which you said is a
     * different account: not suggested again.
     */
    distinctFrom: text('distinct_from'),
    sort: integer('sort').notNull().default(0),
    /** Bumped on each save of a manual account's holdings, so a stale editor can't overwrite a newer save. */
    holdingsVersion: integer('holdings_version').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('accounts_household').on(table.householdId),
    uniqueIndex('accounts_external').on(table.connectionId, table.externalId),
  ],
);

/* ------------------------------------------------------------------ */
/* Securities & holdings                                               */
/* ------------------------------------------------------------------ */

/** Household-scoped so private plan/trust names never cross tenants. */
export const securities = sqliteTable(
  'securities',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Plaid security_id, when the security came from Plaid. */
    externalId: text('external_id'),
    ticker: text('ticker'),
    /** Identifiers for securities without a ticker (individual bonds), when the institution sends them. */
    cusip: text('cusip'),
    isin: text('isin'),
    name: text('name'),
    type: text('type'),
    subtype: text('subtype'),
    currency: text('currency').notNull().default('USD'),
    /** Whether market-data providers can price it by ticker. */
    isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
    /** JSON Classification (shared/taxonomy.ts). */
    classification: text('classification', { mode: 'json' }).$type<Classification>(),
    classificationSource: text('classification_source', { enum: ['seed', 'heuristic', 'user'] }),
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    /** Latest known unit price (e.g. Plaid institution_price) for non-public securities. */
    lastPrice: real('last_price'),
    lastPriceDate: text('last_price_date'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('securities_household').on(table.householdId),
    uniqueIndex('securities_external').on(table.householdId, table.externalId),
    index('securities_ticker').on(table.householdId, table.ticker),
  ],
);

/** Current holdings (latest sync or manual entry). History lives in holding_daily. */
export const holdings = sqliteTable(
  'holdings',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    securityId: text('security_id')
      .notNull()
      .references(() => securities.id, { onDelete: 'cascade' }),
    quantity: real('quantity').notNull(),
    price: real('price'),
    priceAsOf: text('price_as_of'),
    /** Minor units, in `currency`. */
    value: integer('value').notNull(),
    costBasis: integer('cost_basis'),
    currency: text('currency').notNull().default('USD'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.securityId] }),
    index('holdings_household').on(table.householdId),
  ],
);

export const investmentTransactions = sqliteTable(
  'investment_transactions',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    securityId: text('security_id').references(() => securities.id, { onDelete: 'set null' }),
    date: text('date').notNull(),
    name: text('name'),
    /** buy | sell | cash | fee | transfer | cancel */
    type: text('type').notNull(),
    subtype: text('subtype'),
    /** Units; positive for buys, negative for sells. */
    quantity: real('quantity').notNull().default(0),
    /** Minor units; positive when cash leaves the account (Plaid convention). */
    amount: integer('amount').notNull().default(0),
    price: real('price'),
    fees: integer('fees'),
    currency: text('currency').notNull().default('USD'),
  },
  (table) => [
    index('inv_txn_account_date').on(table.accountId, table.date),
    index('inv_txn_household').on(table.householdId),
    uniqueIndex('inv_txn_external').on(table.accountId, table.externalId),
  ],
);

/* ------------------------------------------------------------------ */
/* Daily history                                                       */
/* ------------------------------------------------------------------ */

export const SNAPSHOT_SOURCES = ['sync', 'backfill', 'import', 'manual'] as const;

export const accountDaily = sqliteTable(
  'account_daily',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    /** Minor units in `currency`; liabilities negative. */
    balance: integer('balance').notNull(),
    currency: text('currency').notNull(),
    source: text('source', { enum: SNAPSHOT_SOURCES }).notNull(),
    /** Backfilled values that hit an inconsistency (e.g. a negative position). */
    estimated: integer('estimated', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.date] }),
    index('account_daily_household_date').on(table.householdId, table.date),
  ],
);

export const holdingDaily = sqliteTable(
  'holding_daily',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    securityId: text('security_id')
      .notNull()
      .references(() => securities.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    quantity: real('quantity').notNull(),
    price: real('price'),
    value: integer('value').notNull(),
    currency: text('currency').notNull(),
    source: text('source', { enum: SNAPSHOT_SOURCES }).notNull(),
    estimated: integer('estimated', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.securityId, table.date] }),
    index('holding_daily_household_date').on(table.householdId, table.date),
  ],
);

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

export const targets = sqliteTable(
  'targets',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /** JSON Weights<Category>. */
    weights: text('weights', { mode: 'json' }).notNull().$type<Record<string, number>>(),
    /** Tolerance band in percentage points. */
    bandPct: real('band_pct').notNull().default(5),
    /** Account ids and categories left out of the allocation (e.g. property, emergency fund). */
    excludedAccountIds: text('excluded_account_ids', { mode: 'json' }).notNull().$type<string[]>().default(sql`'[]'`),
    excludedCategories: text('excluded_categories', { mode: 'json' }).notNull().$type<string[]>().default(sql`'[]'`),
    /** Bumped on each save, so a stale editor can't overwrite a newer save. */
    version: integer('version').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('targets_household').on(table.householdId)],
);

/* ------------------------------------------------------------------ */
/* Public reference data (not tenant data)                             */
/* ------------------------------------------------------------------ */

export const pricesDaily = sqliteTable(
  'prices_daily',
  {
    ticker: text('ticker').notNull(),
    date: text('date').notNull(),
    close: real('close').notNull(),
    currency: text('currency').notNull().default('USD'),
    source: text('source').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ticker, table.date] })],
);

export const fxDaily = sqliteTable(
  'fx_daily',
  {
    base: text('base').notNull(),
    quote: text('quote').notNull(),
    date: text('date').notNull(),
    rate: real('rate').notNull(),
  },
  (table) => [primaryKey({ columns: [table.base, table.quote, table.date] })],
);

/* ------------------------------------------------------------------ */
/* Activity logs                                                       */
/* ------------------------------------------------------------------ */

export const SYNC_ACTIONS = ['sync', 'history', 'balance_history', 'relink', 'disconnect', 'account'] as const;
export const SYNC_TRIGGERS = ['link', 'webhook', 'nightly', 'manual', 'refresh'] as const;
export const JOB_STATUSES = ['running', 'ok', 'errors', 'interrupted'] as const;

/**
 * Every sync, history load and balance-history collection for a connection:
 * when, why, which Plaid requests (by request_id), what it stored and what
 * changed. Household data, kept two years.
 */
export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    action: text('action', { enum: SYNC_ACTIONS }).notNull(),
    trigger: text('trigger', { enum: SYNC_TRIGGERS }).notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at').notNull(),
    /**
     * 'skipped': looked, but had nothing to do (see `note`). 'running': written
     * as the run starts; one still running when the next run takes the
     * connection's lease was stopped part-way (it becomes an INTERRUPTED error).
     */
    outcome: text('outcome', { enum: ['ok', 'error', 'skipped', 'running'] }).notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** Why a run was skipped, e.g. another sync was running. */
    note: text('note'),
    /** Plaid calls: [{ endpoint, requestId, error? }]. */
    plaidCalls: text('plaid_calls', { mode: 'json' }).$type<{ endpoint: string; requestId: string | null; error?: string }[]>().notNull(),
    /** What was stored, e.g. { accounts: 3, holdings: 12, transactions: 40 }. */
    counts: text('counts', { mode: 'json' }).$type<Record<string, number>>().notNull(),
    changes: text('changes', { mode: 'json' }).$type<SyncChange[]>().notNull(),
    /** More changes than were kept. */
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [index('sync_runs_connection_started').on(table.householdId, table.connectionId, table.startedAt)],
);

/**
 * Each snapshot of a household's day (the nightly one, and redoing today's
 * after a change): when, for which date, how many rows it wrote. Written
 * 'running' as it starts, like sync_runs, so one stopped part-way shows.
 * Household data, kept two years.
 */
export const snapshotRuns = sqliteTable(
  'snapshot_runs',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    trigger: text('trigger', { enum: ['nightly', 'change'] }).notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at').notNull(),
    outcome: text('outcome', { enum: ['ok', 'error', 'running'] }).notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    accounts: integer('accounts').notNull().default(0),
    holdings: integer('holdings').notNull().default(0),
  },
  (table) => [index('snapshot_runs_started').on(table.householdId, table.startedAt)],
);

/** One price-provider call, as recorded in price_runs. */
export interface PriceCall {
  provider: string;
  endpoint: string;
  tickers: string[];
  from?: string;
  to?: string;
  /** Closes (or rates) returned. */
  returned: number;
  error?: string;
}

/** A stored close replaced with a different value. */
export interface PriceChange {
  ticker: string;
  date: string;
  before: number;
  beforeSource: string;
  after: number;
  afterSource: string;
}

/**
 * Each time prices or FX rates were fetched from a provider: the calls, how
 * much was stored, and any stored value that changed. Public market data, not
 * household data — no household column, and not shown in household views
 * (the tickers would reveal what households hold). Kept two years.
 */
export const priceRuns = sqliteTable(
  'price_runs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['latest', 'history', 'fx'] }).notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at').notNull(),
    /** 'skipped': everything was already stored, so nothing was fetched. */
    outcome: text('outcome', { enum: ['ok', 'error', 'skipped'] }).notNull().default('ok'),
    error: text('error'),
    note: text('note'),
    calls: text('calls', { mode: 'json' }).$type<PriceCall[]>().notNull(),
    saved: integer('saved').notNull(),
    changes: text('changes', { mode: 'json' }).$type<PriceChange[]>().notNull(),
  },
  (table) => [index('price_runs_started').on(table.startedAt)],
);

/** Each nightly job run: households processed and errors. Not household data. */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    job: text('job', { enum: ['daily'] }).notNull(),
    date: text('date').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at').notNull(),
    /**
     * Written 'running' as the job starts. One still 'running' when the next
     * starts (or long after) was stopped part-way: 'interrupted'.
     */
    status: text('status', { enum: JOB_STATUSES }).notNull().default('ok'),
    households: integer('households').notNull(),
    errors: text('errors', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (table) => [index('job_runs_started').on(table.startedAt)],
);

/**
 * Leases (see services/lease.ts): at most one holder at a time per key, e.g.
 * `connection:<id>` or `snapshot:<household id>`. A note asks the holder to
 * run again before releasing.
 */
export const leases = sqliteTable('leases', {
  key: text('key').primaryKey(),
  householdId: text('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  /** Random token of the current holder; null when free. */
  holder: text('holder'),
  /** The holder must renew before then, or the lease is free for others. */
  until: integer('until'),
  /** When someone asked the holder to run again (cleared by a run that started after it). */
  noteAt: integer('note_at'),
});

/** Small TTL cache (quotes, Plaid webhook keys). Not for household data. */
export const kvCache = sqliteTable('kv_cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const JOB_TYPES = [
  'sync',
  'snapshot',
  'nightly_finish',
  'history_plan',
  'history_prices',
  'history_block',
  'history_finish',
  'report_collect',
  'report_account',
  'report_finish',
] as const;
export const JOB_STATES = ['waiting', 'queued', 'running', 'done', 'failed'] as const;

/**
 * Background work, as small jobs (services/jobRunner.ts). The table is the
 * record: the platform only wakes a runner for a job id (a Cloudflare Queue
 * message, or the Node process's own loop), so lost wake-ups are recovered by
 * the sweep and nothing depends on the queue keeping messages.
 *
 * Jobs that belong together share a `group_id`. A job can wait for a group
 * (`waits_for`, status 'waiting'); it's queued once that group has no
 * unfinished jobs. Household data, finished jobs kept 30 days.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** The login the job works on, if any (its card shows progress and failures). */
    connectionId: text('connection_id').references(() => connections.id, { onDelete: 'cascade' }),
    type: text('type', { enum: JOB_TYPES }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    groupId: text('group_id'),
    waitsFor: text('waits_for'),
    status: text('status', { enum: JOB_STATES }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Not before then (backoff, or a delay the job asked for). */
    runAfter: integer('run_after').notNull(),
    /** The running attempt must renew before then, or the job is free to run again. */
    lockedUntil: integer('locked_until'),
    lockToken: text('lock_token'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index('jobs_due').on(table.status, table.runAfter),
    index('jobs_group').on(table.groupId, table.status),
    index('jobs_waits_for').on(table.waitsFor),
    index('jobs_household').on(table.householdId, table.createdAt),
    // Fair picking (jobRunner.dueJobs): each household's running jobs and last start.
    index('jobs_household_status').on(table.householdId, table.status),
    index('jobs_household_started').on(table.householdId, table.startedAt),
  ],
);

/**
 * Rows written each day (UTC, as D1 counts them), added up by each job and
 * request that wrote any: what the daily write budget is checked against
 * (D1 Free stops all writes for the rest of the day at 100,000).
 */
export const dbUsage = sqliteTable('db_usage', {
  day: text('day').primaryKey(),
  rowsWritten: integer('rows_written').notNull(),
});

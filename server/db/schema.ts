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
    /** investments | banking — which Link flow created it. */
    kind: text('kind', { enum: ['investments', 'banking'] }).notNull(),
    status: text('status', { enum: ['ok', 'login_required', 'pending_expiration', 'error', 'removed'] })
      .notNull()
      .default('ok'),
    errorCode: text('error_code'),
    consentExpiresAt: integer('consent_expires_at'),
    lastSyncedAt: integer('last_synced_at'),
    /** Last day covered by stored investment transactions. */
    txnSyncedThrough: text('txn_synced_through'),
    backfillStatus: text('backfill_status', { enum: ['pending', 'running', 'done', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
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
    name: text('name').notNull(),
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
    sort: integer('sort').notNull().default(0),
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

/** Small TTL cache (quotes, Plaid webhook keys). Not for household data. */
export const kvCache = sqliteTable('kv_cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

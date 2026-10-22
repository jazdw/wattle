/** API types shared by the Worker and the browser. */
import type { IsoDate } from './dates';
import type { Currency } from './money';
import type { Category, Classification, ClassificationSource } from './taxonomy';
import type { StyleBreakdown } from './allocation';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  picture: string | null;
  householdId: string;
  role: 'owner' | 'member';
}

export interface Member {
  id: string;
  name: string;
  email: string;
  picture: string | null;
}

export interface Household {
  id: string;
  name: string;
  displayCurrency: Currency;
  members: Member[];
}

export interface MeResponse {
  user: AuthUser;
  household: Household;
}

/** 'disconnected': not synced, but the Plaid login is kept so it can be reconnected. 'removed': removed at Plaid too. */
export type ConnectionStatus = 'ok' | 'login_required' | 'pending_expiration' | 'error' | 'disconnected' | 'removed';

export interface ConnectionSummary {
  id: string;
  institutionName: string | null;
  /** Which Link button created it. */
  kind: 'account' | 'investments';
  /** Holdings and rebuilt investment history. */
  hasInvestments: boolean;
  /** Daily balance history from the bank (Plaid Assets). */
  hasBalanceHistory: boolean;
  status: ConnectionStatus;
  errorCode: string | null;
  ownerUserId: string | null;
  lastSyncedAt: number | null;
  backfillStatus: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  consentExpiresAt: number | null;
  createdAt: number;
}

/** One change a sync made to stored data (balances in minor units, holdings in units). */
export type SyncChange =
  | { kind: 'balance'; accountId: string; account: string; before: number | null; after: number | null; currency: string }
  | { kind: 'account_added' | 'account_missing'; accountId: string; account: string }
  | { kind: 'holding'; accountId: string; account: string; security: string; before: number | null; after: number | null };

/** A logged sync, history load or balance-history collection (GET /api/connections/:id/activity). */
export interface SyncRunSummary {
  id: string;
  action: 'sync' | 'history' | 'balance_history' | 'relink' | 'disconnect' | 'account';
  trigger: 'link' | 'webhook' | 'nightly' | 'manual' | 'refresh';
  startedAt: number;
  finishedAt: number;
  /** 'skipped': looked, but had nothing to do (`note` says why). */
  outcome: 'ok' | 'error' | 'skipped' | 'running';
  errorCode: string | null;
  errorMessage: string | null;
  note: string | null;
  plaidCalls: { endpoint: string; requestId: string | null; error?: string }[];
  counts: Record<string, number>;
  changes: SyncChange[];
  truncated: boolean;
}

export type AccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'property' | 'other';

export interface AccountSummary {
  id: string;
  source: 'plaid' | 'manual';
  connectionId: string | null;
  institutionName: string | null;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: Currency;
  ownerUserId: string | null;
  isHidden: boolean;
  category: Category | null;
  /** Native currency, minor units; liabilities negative. */
  balance: number | null;
  balanceAsOf: number | null;
  /** When the institution stopped reporting the account (excluded from totals). */
  missingSince: number | null;
  /** Balance in the requested display currency. */
  displayBalance: number | null;
  holdingCount: number;
  /**
   * Another visible linked account (from a different login) that looks like
   * the same one, e.g. a joint account you've both linked: hide one copy.
   */
  possibleDuplicateOf: string | null;
}

/** Kinds of background job (server/db/schema.ts JOB_TYPES). */
export type JobType =
  | 'sync'
  | 'snapshot'
  | 'nightly_finish'
  | 'history_plan'
  | 'history_prices'
  | 'history_block'
  | 'history_finish'
  | 'report_collect'
  | 'report_account'
  | 'report_finish';

/** One entry in the household's activity: a login's run, a snapshot, or the nightly job. */
export type ActivityEntry =
  | { kind: 'run'; startedAt: number; connectionId: string; institutionName: string; run: SyncRunSummary }
  | {
      kind: 'snapshot';
      id: string;
      startedAt: number;
      finishedAt: number;
      date: string;
      trigger: 'nightly' | 'change';
      outcome: 'ok' | 'error' | 'running';
      errorCode: string | null;
      errorMessage: string | null;
      accounts: number;
      holdings: number;
    }
  | { kind: 'nightly'; id: string; startedAt: number; finishedAt: number; date: string; state: 'finished' | 'running' | 'interrupted' };

export interface ActivityResponse {
  entries: ActivityEntry[];
  /** Where the next (older) page starts; null at the end. */
  next: { startedAt: number; kind: ActivityEntry['kind']; id: string } | null;
}

/** Background work that didn't finish, for the warning shown on every page. */
export interface StatusResponse {
  /**
   * The latest daily job: finished (whatever its errors, which may be other
   * households'), still running, stopped part-way, or late (none for over a day).
   */
  nightly: { date: string; state: 'finished' | 'running' | 'interrupted' | 'late' } | null;
  /** This household's runs stopped part-way in the last three days. */
  interrupted: { connectionId: string; institutionName: string; action: SyncRunSummary['action']; startedAt: number }[];
  /** This household's background jobs that failed for good (after their retries) in the last three days. */
  failedJobs: {
    type: JobType;
    connectionId: string | null;
    institutionName: string | null;
    finishedAt: number;
    errorCode: string | null;
    attempts: number;
  }[];
}

export interface ConnectionsResponse {
  connections: ConnectionSummary[];
  plaidEnv: 'sandbox' | 'production' | null;
  /** Plaid Trial plan allows 10 Items in production; removed ones still count. */
  itemsUsed: number;
}

export interface AccountsResponse {
  accounts: AccountSummary[];
}

export interface HoldingRow {
  securityId: string;
  ticker: string | null;
  /** Identifiers for a security without a ticker (an individual bond), when the institution sends them. */
  cusip: string | null;
  isin: string | null;
  name: string | null;
  type: string | null;
  /** Entered by hand (not from an institution), so you can set its type. */
  typeEditable: boolean;
  isPublic: boolean;
  quantity: number;
  /** Unit price in native currency. */
  price: number | null;
  /** Display currency, minor units. */
  value: number;
  costBasis: number | null;
  accounts: { accountId: string; name: string; quantity: number; value: number }[];
  classification: Classification;
  classificationSource: ClassificationSource | null;
  needsReview: boolean;
}

export interface PortfolioResponse {
  currency: Currency;
  asOf: IsoDate;
  netWorth: number;
  assets: number;
  liabilities: number;
  /** Totals by allocation category for invested assets (after target scope). */
  categories: Record<Category, number>;
  /** Totals by category across all assets (ignores target scope). */
  allCategories: Record<Category, number>;
  holdings: HoldingRow[];
  style: StyleBreakdown;
  fxRate: number | null;
}

export type HistoryGroup = 'total' | 'account' | 'category' | 'holding';

export interface HistorySeries {
  key: string;
  label: string;
  values: (number | null)[];
}

export interface HistoryResponse {
  currency: Currency;
  group: HistoryGroup;
  dates: IsoDate[];
  series: HistorySeries[];
  /** Per date: whether any value was estimated (backfilled with gaps). */
  estimated: boolean[];
}

export interface TargetResponse {
  target: {
    id: string;
    name: string;
    weights: Partial<Record<Category, number>>;
    bandPct: number;
    excludedAccountIds: string[];
    excludedCategories: Category[];
    /** Send back when saving; a save is refused if someone saved since. */
    version: number;
  } | null;
}

export interface QuoteRow {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  time: number;
}

export interface QuotesResponse {
  quotes: QuoteRow[];
  /** Mutual funds and others without live quotes: last close. */
  closes: { ticker: string; close: number; date: IsoDate }[];
}

export interface SecurityRow {
  id: string;
  ticker: string | null;
  name: string | null;
  type: string | null;
  isPublic: boolean;
  classification: Classification | null;
  classificationSource: ClassificationSource | null;
  needsReview: boolean;
}

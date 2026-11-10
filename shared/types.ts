/** API types shared by the Worker and the browser. */
import type { IsoDate } from './dates';
import type { Currency } from './money';
import type { Quality } from './quality';
import type { Category, Classification, ClassificationSource } from './taxonomy';
import type { StyleBreakdown } from './allocation';
import type { TransactionKind } from './transactionKinds';

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
  /** While a history load runs as background jobs: how many of its parts (prices, blocks) are done. */
  /** Of a history load underway: parts done, and until when it waits for the next day's database writes. */
  historyProgress: { done: number; total: number; waitingUntil: number | null } | null;
  consentExpiresAt: number | null;
  /** Plaid says the login has accounts not shared with Wattle yet (Choose accounts adds them). */
  newAccountsAvailable: boolean;
  createdAt: number;
}

/** One change a sync made to stored data (balances in minor units, holdings in units). */
export type SyncChange =
  | { kind: 'balance'; accountId: string; account: string; before: number | null; after: number | null; currency: string }
  | { kind: 'account_added' | 'account_missing' | 'account_returned'; accountId: string; account: string }
  | { kind: 'holding'; accountId: string; account: string; security: string; before: number | null; after: number | null };

/** A logged sync, history load or balance-history collection (GET /api/connections/:id/activity). */
export interface SyncRunSummary {
  id: string;
  action: 'sync' | 'history' | 'balance_history' | 'relink' | 'disconnect' | 'account' | 'tokens';
  /** `key`: a new encryption key was set (services/crypto.ts). */
  trigger: 'link' | 'webhook' | 'nightly' | 'manual' | 'refresh' | 'key';
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

/** One transaction of an account: an investment one from Plaid's Investments data, or a bank one from a bank history report. */
export interface TransactionEntry {
  id: string;
  /** Its account, and the currency its amount is in. */
  accountId: string;
  currency: Currency;
  date: string;
  /** Where it came from: Plaid's investment transactions, a bank history report, or a file you imported. */
  source: 'plaid' | 'report' | 'import';
  /** The institution's own type: Plaid's buy | sell | cash | fee | transfer | cancel, a file's type name; bank: null. */
  type: string | null;
  /** Plaid's subtype (dividend, reinvestment, split, …). */
  subtype: string | null;
  /** What it does (shared/transactionKinds.ts); null when it can't be told and needs one set. */
  kind: TransactionKind | null;
  /** The kind was set by you. */
  kindByYou: boolean;
  /** The kind worked out from its type, without yours. */
  automatic: TransactionKind | null;
  /** The transfer between your accounts it's one side of (linked automatically or by you). */
  transfer: { id: string; status: 'auto' | 'confirmed'; accountId: string; accountName: string; institutionName: string | null; mask: string | null; date: string } | null;
  description: string | null;
  /** A Quicken file's MEMO beside its NAME: shown joined (shared/descriptions.ts fullDescription). */
  memo: string | null;
  ticker: string | null;
  security: string | null;
  quantity: number | null;
  price: number | null;
  /** Minor units, in the response's currency; positive when money leaves the account (Plaid's convention). */
  amount: number;
}

/** One side of a transfer between your accounts. */
export interface TransferSide {
  transactionId: string;
  accountId: string;
  accountName: string;
  institutionName: string | null;
  mask: string | null;
  date: string;
  /** Cents, positive when money leaves the account (Plaid's convention). */
  amount: number;
  currency: Currency;
  /** Its description and memo joined (shared/descriptions.ts). */
  description: string | null;
}

export interface TransferEntry {
  id: string;
  status: 'auto' | 'suggested' | 'confirmed' | 'rejected';
  out: TransferSide;
  in: TransferSide;
}

export interface TransfersResponse {
  transfers: TransferEntry[];
}

/** Transactions that could be a transaction's other side. */
export interface TransferCandidatesResponse {
  candidates: TransferSide[];
}

export interface TransactionsResponse {
  /** An investment account's, a bank account's, or every account's. */
  kind: 'investment' | 'bank' | 'all';
  currency: Currency;
  /** The earliest and latest transaction dates held. */
  from: string | null;
  to: string | null;
  /** Newest first, at most TRANSACTIONS_LIMIT, of those the filters (dates, search) match. */
  transactions: TransactionEntry[];
  /** How many the filters match. */
  matched: number;
  /** More matched than were returned. */
  truncated: boolean;
}

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
  /** An import still being written into the account (as background jobs): its windows of days done of all. */
  importProgress: { done: number; total: number } | null;
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
  | 'report_finish'
  | 'import_block'
  | 'import_reprice'
  | 'match_transfers'
  | 'rotate_tokens';

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
  | { kind: 'nightly'; id: string; startedAt: number; finishedAt: number; date: string; state: 'finished' | 'running' | 'interrupted' }
  /** A background job that failed for good (listed when it failed: `startedAt` is that time). */
  | {
      kind: 'job';
      id: string;
      startedAt: number;
      type: JobType;
      connectionId: string | null;
      institutionName: string | null;
      attempts: number;
      errorCode: string | null;
      errorMessage: string | null;
    };

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
  /** False for a currency's cash row, which can't be reclassified (a bank account's category is set on the account). */
  classifiable: boolean;
  isPublic: boolean;
  quantity: number;
  /** The security's own currency, which its price is in. */
  currency: Currency;
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

/** An asset account with no holdings, valued at its balance (a home, a super fund); cash accounts join their currency's cash row instead. */
export interface BalanceRow {
  accountId: string;
  name: string;
  type: string;
  subtype: string | null;
  /** The account's allocation category (set on the account, else from its type). */
  category: Category;
  /** Display currency, minor units. */
  value: number;
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
  /** Asset accounts with no holdings that aren't cash, so holdings and balances add up to the assets. */
  balances: BalanceRow[];
  style: StyleBreakdown;
  fxRate: number | null;
}

export type HistoryGroup = 'total' | 'account' | 'category' | 'holding' | 'source';

export interface HistorySeries {
  key: string;
  label: string;
  values: (number | null)[];
  /** Per date, where the value came from (null without a value of its own). */
  quality: (Quality | null)[];
}

export interface HistoryResponse {
  currency: Currency;
  group: HistoryGroup;
  dates: IsoDate[];
  series: HistorySeries[];
  /** Grouped by source: where each account's value (and the household's) came from over the range. */
  breakdown?: BreakdownRow[];
}

/**
 * Where an account's value came from over a range, in the display
 * currency's cents: start + moneyIn − moneyOut + income − fees + market +
 * other = end.
 */
export interface BreakdownRow {
  /** The account's id, or 'household'. */
  key: string;
  label: string;
  start: number;
  end: number;
  moneyIn: number;
  moneyOut: number;
  /** Dividends and interest. */
  income: number;
  fees: number;
  /** Market gain or loss (exchange-rate moves included). */
  market: number;
  /** Changes that can't be told apart: before its transactions are known, its first and last days, a bank's leftovers. */
  other: number;
  /** Transactions in the range whose kind isn't known. */
  needsType: number;
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

/** POST /api/imports: each account imported, in the order sent. */
export interface ImportedAccount {
  label: string;
  accountId: string;
  created: boolean;
  /** The days written (holdings: as jobs, appearing over a minute or so). */
  days: number;
  from: string;
  to: string;
  /** Market funds priced from the file's prices because their closes couldn't be fetched: import again later for daily closes. */
  estimated: string[];
}

export interface ImportResponse {
  accounts: ImportedAccount[];
}

/** Something wrong with an account in an import, on a day of it where it's one day's. */
export interface ImportProblem {
  label: string;
  date: string | null;
  text: string;
}

/** POST /api/imports/check: what an import would write, and what's wrong with it, writing nothing. */
export interface ImportCheck {
  accounts: (Omit<ImportedAccount, 'accountId'> & { closes: { date: string; security: string; close: number }[] })[];
  problems: ImportProblem[];
}

/** POST /api/imports/tickers: a ticker for a security a file names without one. */
export interface TickerSuggestion {
  /** The file's id for the security. */
  id: string;
  ticker: string;
  /** From a security you have with the same name, or the market data provider's search. */
  from: 'yours' | 'search';
  /** The name is the file's exactly (letters and digits compared): used as it is; otherwise it only starts the same, to check. */
  exact: boolean;
}

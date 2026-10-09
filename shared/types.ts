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

export type ConnectionStatus = 'ok' | 'login_required' | 'pending_expiration' | 'error' | 'removed';

export interface ConnectionSummary {
  id: string;
  institutionName: string | null;
  kind: 'investments' | 'banking';
  status: ConnectionStatus;
  errorCode: string | null;
  ownerUserId: string | null;
  lastSyncedAt: number | null;
  backfillStatus: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  consentExpiresAt: number | null;
  createdAt: number;
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
  name: string | null;
  type: string | null;
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

/** Configurable fakes for the external providers (no network in tests). */
import type { AccountBase, Holding, InvestmentTransaction, Security } from 'plaid';
import { PlaidApiError, type PlaidApi } from '../server/adapters/plaid';
import { bytesToBase64Url, sha256Hex } from '../server/lib/encoding';
import type { DailyClose, FxProvider, PriceProvider, Quote, QuoteProvider } from '../server/ports';

type Partialish<T> = { [K in keyof T]?: unknown } & Record<string, unknown>;

export interface PlaidState {
  itemId: string;
  institutionName: string;
  accounts: Partialish<AccountBase>[];
  holdings: Partialish<Holding>[];
  securities: Partialish<Security>[];
  transactions: Partialish<InvestmentTransaction>[];
  /** Error code thrown by data calls (e.g. ITEM_LOGIN_REQUIRED). */
  failWith: string | null;
  transactionsNotReady: boolean;
  historicalBalances: Record<string, { date: string; current: number }[]>;
  assetReportReady: boolean;
  assetReportFails: boolean;
  calls: string[];
  removed: string[];
}

export function account(id: string, type: string, current: number, extra: Partialish<AccountBase> = {}) {
  return {
    account_id: id,
    name: id,
    official_name: null,
    mask: '0000',
    type,
    subtype: null,
    balances: { current, available: null, iso_currency_code: 'USD' },
    ...extra,
  } as Partialish<AccountBase>;
}

export function security(id: string, ticker: string | null, type: string, closePrice: number | null, name = ticker ?? id) {
  return {
    security_id: id,
    ticker_symbol: ticker,
    name,
    type,
    close_price: closePrice,
    close_price_as_of: '2026-10-08',
    iso_currency_code: 'USD',
  } as Partialish<Security>;
}

export function holding(accountId: string, securityId: string, quantity: number, price: number) {
  return {
    account_id: accountId,
    security_id: securityId,
    quantity,
    institution_price: price,
    institution_value: quantity * price,
    cost_basis: null,
    iso_currency_code: 'USD',
  } as Partialish<Holding>;
}

export function fakePlaid(initial: Partial<PlaidState> = {}): PlaidApi & { state: PlaidState } {
  const state: PlaidState = {
    itemId: 'item-1',
    institutionName: 'Vanguard',
    accounts: [],
    holdings: [],
    securities: [],
    transactions: [],
    failWith: null,
    transactionsNotReady: false,
    historicalBalances: {},
    assetReportReady: true,
    assetReportFails: false,
    calls: [],
    removed: [],
    ...initial,
  };
  const guard = (name: string) => {
    state.calls.push(name);
    if (state.failWith) throw new PlaidApiError(400, 'ITEM_ERROR', state.failWith, 'fake failure');
  };
  return {
    state,
    env: 'sandbox',
    createLinkToken: async (options) => {
      state.calls.push(`link:${options.kind}:${options.accessToken ? 'update' : 'new'}`);
      return 'link-sandbox-token';
    },
    exchangePublicToken: async () => ({ accessToken: `access-sandbox-${state.itemId}`, itemId: state.itemId }),
    getItem: async () => ({ item_id: state.itemId, institution_id: 'ins_1', consent_expiration_time: null }) as never,
    getInstitutionName: async () => state.institutionName,
    getAccounts: async () => {
      guard('accounts');
      return state.accounts as never;
    },
    getHoldings: async () => {
      guard('holdings');
      return { accounts: state.accounts, holdings: state.holdings, securities: state.securities } as never;
    },
    getInvestmentTransactions: async (_token, _start, _end, offset) => {
      guard('transactions');
      if (state.transactionsNotReady) throw new PlaidApiError(400, 'ITEM_ERROR', 'PRODUCT_NOT_READY', 'not ready');
      const page = state.transactions.slice(offset, offset + 2);
      return {
        accounts: state.accounts,
        securities: state.securities,
        investment_transactions: page,
        total_investment_transactions: state.transactions.length,
      } as never;
    },
    createAssetReport: async () => {
      state.calls.push('asset_report:create');
      if (state.assetReportFails) throw new PlaidApiError(400, 'ASSET_REPORT_ERROR', 'PRODUCTS_NOT_SUPPORTED', 'nope');
      return { token: 'assets-sandbox-token', id: 'ar-1' };
    },
    getAssetReport: async () => {
      state.calls.push('asset_report:get');
      if (!state.assetReportReady) throw new PlaidApiError(400, 'ASSET_REPORT_ERROR', 'PRODUCT_NOT_READY', 'wait');
      return {
        items: [
          {
            accounts: Object.entries(state.historicalBalances).map(([accountId, balances]) => ({
              account_id: accountId,
              historical_balances: balances.map((balance) => ({ ...balance, iso_currency_code: 'USD' })),
            })),
          },
        ],
      } as never;
    },
    removeAssetReport: async () => {
      state.calls.push('asset_report:remove');
    },
    removeItem: async (token) => {
      state.removed.push(token);
    },
    getWebhookVerificationKey: async () => (await webhookKeys()).jwk as never,
  };
}

/* ------------------------------------------------------------------ */
/* Market data                                                         */
/* ------------------------------------------------------------------ */

export function fakePrices(series: Record<string, DailyClose[]>): PriceProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async dailyCloses(ticker, start, end) {
      calls.push(`${ticker}:${start}:${end}`);
      return (series[ticker.toUpperCase()] ?? []).filter((row) => row.date >= start && row.date <= end);
    },
  };
}

export function fakeQuotes(quotes: Record<string, Partial<Quote>>): QuoteProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async quote(ticker) {
      calls.push(ticker);
      const quote = quotes[ticker];
      return quote ? { ticker, price: 0, change: 0, changePercent: 0, previousClose: 0, time: 0, ...quote } : null;
    },
  };
}

export function fakeFx(rate = 1.5): FxProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async rates(_base, _quote, start, end) {
      calls.push(`${start}:${end}`);
      const rows = [];
      for (let date = new Date(`${start}T00:00:00Z`); date <= new Date(`${end}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
        rows.push({ date: date.toISOString().slice(0, 10), rate });
      }
      return rows;
    },
  };
}

/** Daily closes from `start` for `days` days, stepping by `step` per day. */
export function closes(start: string, days: number, first: number, step = 0): DailyClose[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(`${start}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), close: first + step * index };
  });
}

/* ------------------------------------------------------------------ */
/* Plaid webhook signing                                               */
/* ------------------------------------------------------------------ */

let keys: Promise<{ jwk: JsonWebKey; privateKey: CryptoKey }> | null = null;

function webhookKeys() {
  keys ??= (async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return { jwk: { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), expired_at: null } as JsonWebKey, privateKey: pair.privateKey };
  })();
  return keys;
}

const encode = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

/** A `Plaid-Verification` header for `body`, signed with the fake Plaid key. */
export async function signWebhook(body: string, issuedAt: Date, kid = 'test-key'): Promise<string> {
  const { privateKey } = await webhookKeys();
  const head = `${encode({ alg: 'ES256', kid, typ: 'JWT' })}.${encode({ iat: Math.floor(issuedAt.getTime() / 1000), request_body_sha256: await sha256Hex(body) })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(head));
  return `${head}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

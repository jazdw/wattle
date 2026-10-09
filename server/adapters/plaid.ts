/**
 * Minimal Plaid client over `fetch` (works on Workers and Node). Only the
 * endpoints Wattle uses are wrapped. The official `plaid` package is used for
 * its TypeScript types only — its runtime (axios) is never bundled.
 *
 * Deliberately absent: /auth/get and the `auth` product, which return full
 * account and routing numbers. Wattle never requests them.
 */
import type {
  AccountBase,
  AssetReport,
  Holding,
  InvestmentTransaction,
  Item,
  JWKPublicKey,
  Security,
} from 'plaid';

export type PlaidEnvironment = 'sandbox' | 'production';

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnvironment;
}

export class PlaidApiError extends Error {
  readonly code: string;
  readonly type: string;
  readonly status: number;

  constructor(status: number, type: string, code: string, message: string) {
    super(`Plaid ${code}: ${message}`);
    this.name = 'PlaidApiError';
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

export type LinkKind = 'investments' | 'banking';

export interface LinkTokenOptions {
  /** Stable, non-identifying id for the Wattle user. */
  clientUserId: string;
  kind: LinkKind;
  webhook: string | null;
  /** Update mode: re-authenticate an existing connection. */
  accessToken?: string;
  redirectUri?: string;
}

export interface InvestmentsHoldings {
  accounts: AccountBase[];
  holdings: Holding[];
  securities: Security[];
}

export interface InvestmentsTransactionsPage {
  accounts: AccountBase[];
  securities: Security[];
  investment_transactions: InvestmentTransaction[];
  total_investment_transactions: number;
}

export interface PlaidApi {
  readonly env: PlaidEnvironment;
  createLinkToken(options: LinkTokenOptions): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getItem(accessToken: string): Promise<Item>;
  getInstitutionName(institutionId: string): Promise<string | null>;
  getAccounts(accessToken: string): Promise<AccountBase[]>;
  getHoldings(accessToken: string): Promise<InvestmentsHoldings>;
  getInvestmentTransactions(
    accessToken: string,
    start: string,
    end: string,
    offset: number,
  ): Promise<InvestmentsTransactionsPage>;
  createAssetReport(
    accessToken: string,
    daysRequested: number,
    webhook: string | null,
  ): Promise<{ token: string; id: string }>;
  getAssetReport(assetReportToken: string): Promise<AssetReport>;
  removeAssetReport(assetReportToken: string): Promise<void>;
  removeItem(accessToken: string): Promise<void>;
  getWebhookVerificationKey(keyId: string): Promise<JWKPublicKey>;
}

const PRODUCTS: Record<LinkKind, { products: string[]; optional?: string[] }> = {
  // Brokerages, 401(k)s, HSAs.
  investments: { products: ['investments'] },
  // Checking, savings, credit cards. Assets gives up to two years of daily
  // balance history for the backfill; no transactions are stored.
  banking: { products: ['assets'] },
};

export function createPlaidClient(config: PlaidConfig): PlaidApi {
  const baseUrl = `https://${config.env}.plaid.com`;

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new PlaidApiError(
        response.status,
        String(json.error_type ?? 'API_ERROR'),
        String(json.error_code ?? 'UNKNOWN'),
        String(json.error_message ?? response.statusText),
      );
    }
    return json as T;
  }

  return {
    env: config.env,

    async createLinkToken(options) {
      const body: Record<string, unknown> = {
        client_name: 'Wattle Wealth',
        language: 'en',
        country_codes: ['US', 'CA'],
        user: { client_user_id: options.clientUserId },
      };
      if (options.webhook) body.webhook = options.webhook;
      if (options.redirectUri) body.redirect_uri = options.redirectUri;
      if (options.accessToken) {
        body.access_token = options.accessToken;
      } else {
        const products = PRODUCTS[options.kind];
        body.products = products.products;
        if (products.optional) body.optional_products = products.optional;
      }
      const result = await call<{ link_token: string }>('/link/token/create', body);
      return result.link_token;
    },

    async exchangePublicToken(publicToken) {
      const result = await call<{ access_token: string; item_id: string }>('/item/public_token/exchange', {
        public_token: publicToken,
      });
      return { accessToken: result.access_token, itemId: result.item_id };
    },

    async getItem(accessToken) {
      const result = await call<{ item: Item }>('/item/get', { access_token: accessToken });
      return result.item;
    },

    async getInstitutionName(institutionId) {
      try {
        const result = await call<{ institution: { name: string } }>('/institutions/get_by_id', {
          institution_id: institutionId,
          country_codes: ['US', 'CA'],
        });
        return result.institution.name;
      } catch {
        return null;
      }
    },

    async getAccounts(accessToken) {
      const result = await call<{ accounts: AccountBase[] }>('/accounts/get', { access_token: accessToken });
      return result.accounts;
    },

    async getHoldings(accessToken) {
      return call<InvestmentsHoldings>('/investments/holdings/get', { access_token: accessToken });
    },

    async getInvestmentTransactions(accessToken, start, end, offset) {
      return call<InvestmentsTransactionsPage>('/investments/transactions/get', {
        access_token: accessToken,
        start_date: start,
        end_date: end,
        options: { count: 500, offset },
      });
    },

    async createAssetReport(accessToken, daysRequested, webhook) {
      const result = await call<{ asset_report_token: string; asset_report_id: string }>('/asset_report/create', {
        access_tokens: [accessToken],
        days_requested: daysRequested,
        options: webhook ? { webhook } : {},
      });
      return { token: result.asset_report_token, id: result.asset_report_id };
    },

    async getAssetReport(assetReportToken) {
      const result = await call<{ report: AssetReport }>('/asset_report/get', {
        asset_report_token: assetReportToken,
        include_insights: false,
      });
      return result.report;
    },

    async removeAssetReport(assetReportToken) {
      await call('/asset_report/remove', { asset_report_token: assetReportToken });
    },

    async removeItem(accessToken) {
      await call('/item/remove', { access_token: accessToken });
    },

    async getWebhookVerificationKey(keyId) {
      const result = await call<{ key: JWKPublicKey }>('/webhook_verification_key/get', { key_id: keyId });
      return result.key;
    },
  };
}

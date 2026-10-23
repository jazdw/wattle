/** A realistically sized investment login, shared by the work-budget and write-budget tests. */
import type { InvestmentTransaction } from 'plaid';
import { account, closes, fakeFx, fakePlaid, fakePrices, holding, security } from './fakes';

const ETFS = Array.from({ length: 25 }, (_, index) => `E${String(index).padStart(2, '0')}`);
const FUNDS = ['FNDAX', 'FNDBX', 'FNDCX', 'FNDDX', 'FNDEX'];
const TICKERS = [...ETFS, ...FUNDS];
const HISTORY_START = '2024-09-01';

/** A brokerage login: 2 accounts, 30 positions (25 ETFs, 5 mutual funds), 500 buys over two years. */
export function brokerage() {
  const securities = TICKERS.map((ticker) => security(`s-${ticker}`, ticker, FUNDS.includes(ticker) ? 'mutual fund' : 'etf', 100));
  const accountFor = (index: number) => (index < 18 ? 'brk1' : 'brk2');
  const transactions = Array.from({ length: 500 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 9, 10) + Math.floor((index * 720) / 500) * 86400_000).toISOString().slice(0, 10);
    const ticker = TICKERS[index % TICKERS.length];
    return {
      investment_transaction_id: `t${index}`,
      account_id: accountFor(TICKERS.indexOf(ticker)),
      security_id: `s-${ticker}`,
      date,
      name: `Buy ${ticker}`,
      type: 'buy',
      subtype: 'buy',
      quantity: 1,
      amount: 100,
      price: 100,
      fees: 0,
      iso_currency_code: 'USD',
    } as Partial<InvestmentTransaction>;
  });
  const plaid = fakePlaid({
    accounts: [account('brk1', 'investment', 180_000), account('brk2', 'investment', 120_000)],
    securities,
    holdings: TICKERS.map((ticker, index) => holding(accountFor(index), `s-${ticker}`, 100, 100)),
    transactions: transactions as never,
  });
  plaid.state.transactionsPageSize = 500;
  return plaid;
}

export function marketData() {
  const series = Object.fromEntries(TICKERS.map((ticker) => [ticker, closes(HISTORY_START, 800, 100, 0.01)]));
  const latest = Object.fromEntries(ETFS.map((ticker) => [ticker, series[ticker].at(-1)!]));
  return { prices: fakePrices(series, latest), fx: fakeFx() };
}


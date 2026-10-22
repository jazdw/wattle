import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import type {
  AccountsResponse,
  ConnectionsResponse,
  HistoryGroup,
  HistoryResponse,
  PortfolioResponse,
  QuotesResponse,
  SecurityRow,
  StatusResponse,
  TargetResponse,
} from '../../shared/types';
import { api } from '../api';
import { useAuth } from './useAuth';

export type Range = '1M' | '3M' | '6M' | 'YTD' | '1Y' | '2Y' | 'ALL';

export function usePortfolio() {
  const { currency } = useAuth();
  return useQuery({
    queryKey: ['portfolio', currency],
    queryFn: () => api<PortfolioResponse>(`/api/portfolio?currency=${currency}`),
    placeholderData: keepPreviousData,
  });
}

export function useHistory(range: Range, group: HistoryGroup, accountId?: string) {
  const { currency } = useAuth();
  const params = new URLSearchParams({ range, group, currency });
  if (accountId) params.set('accountId', accountId);
  return useQuery({
    queryKey: ['history', range, group, accountId ?? null, currency],
    queryFn: () => api<HistoryResponse>(`/api/history?${params}`),
    placeholderData: keepPreviousData,
  });
}

export function useAccounts() {
  const { currency } = useAuth();
  return useQuery({
    queryKey: ['accounts', currency],
    queryFn: () => api<AccountsResponse>(`/api/accounts?currency=${currency}`),
  });
}

/** Plaid connections, shared by useConnections() and HistoryWatcher. */
export const connectionsQuery = queryOptions({ queryKey: ['connections'], queryFn: () => api<ConnectionsResponse>('/api/connections') });

export function useConnections() {
  return useQuery(connectionsQuery);
}

/** Background work that didn't finish; checked every few minutes. */
export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: () => api<StatusResponse>('/api/status'), refetchInterval: 5 * 60_000 });
}

export function useTarget() {
  return useQuery({ queryKey: ['target'], queryFn: () => api<TargetResponse>('/api/targets') });
}

export function useSecurities() {
  return useQuery({
    queryKey: ['securities'],
    queryFn: () => api<{ securities: SecurityRow[] }>('/api/securities'),
  });
}

/** True during regular US market hours (9:30–16:00 New York, weekdays). */
/**
 * A quote is live if it was updated in the last 15 minutes. Prices stop
 * updating when the market closes (weekends, holidays, early closes
 * included), so no market calendar is needed: the data says when it's live.
 */
export const LIVE_WINDOW_MS = 15 * 60_000;

export function isLiveQuote(quote: { time: number }, now = Date.now()): boolean {
  return now - quote.time < LIVE_WINDOW_MS;
}

/**
 * Live quotes. Polls every minute while any quote is live, otherwise every
 * 15 minutes (which is how it notices the market has opened).
 */
export function useQuotes(enabled = true) {
  return useQuery({
    queryKey: ['quotes'],
    queryFn: () => api<QuotesResponse>('/api/quotes'),
    enabled,
    refetchInterval: (query) => (query.state.data?.quotes.some((quote) => isLiveQuote(quote)) ? 60_000 : LIVE_WINDOW_MS),
    staleTime: 30_000,
  });
}

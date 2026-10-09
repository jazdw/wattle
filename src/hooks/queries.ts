import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AccountsResponse,
  ConnectionsResponse,
  HistoryGroup,
  HistoryResponse,
  PortfolioResponse,
  QuotesResponse,
  SecurityRow,
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

export function useConnections() {
  return useQuery({ queryKey: ['connections'], queryFn: () => api<ConnectionsResponse>('/api/connections') });
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
export function isMarketOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Live quotes; polls every minute while the market is open. */
export function useQuotes(enabled = true) {
  return useQuery({
    queryKey: ['quotes'],
    queryFn: () => api<QuotesResponse>('/api/quotes'),
    enabled,
    refetchInterval: () => (isMarketOpen() ? 60_000 : false),
    staleTime: 30_000,
  });
}

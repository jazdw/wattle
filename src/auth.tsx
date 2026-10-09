import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { isCurrency, type Currency } from '../shared/money';
import type { MeResponse } from '../shared/types';
import { api, ApiError } from './api';
import { AuthContext } from './hooks/useAuth';

const CURRENCY_KEY = 'wt-currency';

function readCurrency(): Currency | null {
  try {
    const value = localStorage.getItem(CURRENCY_KEY);
    return isCurrency(value) ? value : null;
  } catch {
    return null;
  }
}

/** Loads the signed-in user and household. Nothing financial is cached offline. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [currencyOverride, setCurrencyOverride] = useState<Currency | null>(() => readCurrency());

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/api/auth/me'),
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
    staleTime: 5 * 60_000,
  });

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      window.location.assign('/login');
    }
  }, [queryClient]);

  const setCurrency = useCallback((currency: Currency) => {
    setCurrencyOverride(currency);
    try {
      localStorage.setItem(CURRENCY_KEY, currency);
    } catch {
      // ignore
    }
  }, []);

  const me = meQuery.data ?? null;
  const value = useMemo(
    () => ({
      me,
      loading: meQuery.isPending,
      currency: currencyOverride ?? me?.household.displayCurrency ?? 'USD',
      setCurrency,
      logout,
    }),
    [me, meQuery.isPending, currencyOverride, setCurrency, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

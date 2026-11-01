import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { AccountsResponse } from '../../shared/types';
import { useAccounts } from '../hooks/queries';

const importing = (data: AccountsResponse | undefined) => data?.accounts.some((account) => account.importProgress !== null) ?? false;

/**
 * While an import is being written (background jobs on the server), poll the
 * accounts every few seconds so each shows its progress, and refresh
 * everything once it's in. Mounted once for the signed-in app (App.tsx).
 */
export function ImportWatcher() {
  const queryClient = useQueryClient();
  const accounts = useAccounts({ refetchInterval: (query) => (importing(query.state.data) ? 3_000 : false) });
  const busy = importing(accounts.data);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'accounts' });
    wasBusy.current = busy;
  }, [busy, queryClient]);
  return null;
}

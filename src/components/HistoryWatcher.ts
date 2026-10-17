import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { ConnectionsResponse } from '../../shared/types';
import { connectionsQuery } from '../hooks/queries';

const loadingHistory = (data: ConnectionsResponse | undefined) =>
  data?.connections.some((connection) => connection.backfillStatus === 'pending' || connection.backfillStatus === 'running') ?? false;

/**
 * While a connection's history is loading (in the background on the server),
 * poll for it, and refresh everything once it's in. Polls at a tenth of the
 * time spent waiting (5 s at first, at most every 5 min): investment history
 * takes seconds, but bank history waits on Plaid's webhook, and if that's
 * missed it arrives with the next Sync or the nightly job.
 *
 * Mounted once for the signed-in app (App.tsx). It keeps the shared query
 * cache fresh; components just read connections with useConnections().
 */
export function HistoryWatcher() {
  const queryClient = useQueryClient();
  const since = useRef<number | null>(null);
  const query = useQuery({
    ...connectionsQuery,
    refetchInterval: (q) => {
      if (!loadingHistory(q.state.data)) return false;
      since.current ??= Date.now();
      return Math.min(Math.max((Date.now() - since.current) / 10, 5_000), 5 * 60_000);
    },
  });
  const loading = loadingHistory(query.data);
  const wasLoading = useRef(loading);
  useEffect(() => {
    if (!loading) since.current = null;
    if (wasLoading.current && !loading) void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== connectionsQuery.queryKey[0] });
    wasLoading.current = loading;
  }, [loading, queryClient]);
  return null;
}

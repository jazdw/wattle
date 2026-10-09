import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { api } from '../api';
import { Button } from './ui/button';

interface Props {
  kind: 'investments' | 'banking';
  /** Update mode: re-authenticate this connection. */
  connectionId?: string;
  label: string;
  variant?: 'default' | 'outline' | 'accent';
  size?: 'default' | 'sm';
  onError?: (message: string) => void;
}

/** Fetches a link token on click, then opens Plaid Link. */
export function PlaidLinkButton({ kind, connectionId, label, variant = 'default', size = 'default', onError }: Props) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);

  const exchange = useMutation({
    mutationFn: (publicToken: string) =>
      api('/api/plaid/exchange', { method: 'POST', body: JSON.stringify({ publicToken, kind }) }),
    onSuccess: () => void queryClient.invalidateQueries(),
    onError: (error) => onError?.(error.message),
  });

  const onSuccess = useCallback(
    (publicToken: string | null) => {
      setToken(null);
      if (!publicToken) return;
      if (connectionId) {
        // Update mode keeps the same access token; just resync.
        void api(`/api/connections/${connectionId}/sync`, { method: 'POST' }).finally(() => void queryClient.invalidateQueries());
      } else {
        exchange.mutate(publicToken);
      }
    },
    [connectionId, exchange, queryClient],
  );

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit: () => setToken(null) });

  useEffect(() => {
    if (token && ready) open();
  }, [token, ready, open]);

  const start = useMutation({
    mutationFn: () =>
      api<{ linkToken: string }>('/api/plaid/link-token', { method: 'POST', body: JSON.stringify({ kind, connectionId }) }),
    onSuccess: (result) => setToken(result.linkToken),
    onError: (error) => onError?.(error.message),
  });

  return (
    <Button variant={variant} size={size} onClick={() => start.mutate()} disabled={start.isPending || exchange.isPending}>
      {exchange.isPending ? 'Importing…' : label}
    </Button>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { loadPlaid, openPlaidLink } from '../lib/plaidLink';

export type LinkKind = 'investments' | 'account';

/**
 * Fetches a link token, then opens Plaid Link. Link stays open only while the
 * component using this is mounted, so a chooser dialog that closes as Link
 * opens should take it from the page instead.
 */
export function usePlaidLink({ connectionId, onError }: { connectionId?: string; onError?: (message: string) => void } = {}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const close = useRef<(() => void) | null>(null);

  // Load Plaid's script while this is on screen, so Link opens quickly.
  useEffect(() => {
    loadPlaid().catch(() => {}); // reported on click
    return () => close.current?.();
  }, []);

  const exchange = useMutation({
    mutationFn: ({ publicToken, kind }: { publicToken: string; kind: LinkKind }) =>
      api('/api/plaid/exchange', { method: 'POST', body: JSON.stringify({ publicToken, kind }) }),
    onSuccess: () => void queryClient.invalidateQueries(),
    onError: (error) => onError?.(error.message),
  });

  const onSuccess = (publicToken: string, kind: LinkKind) => {
    if (connectionId) {
      // Update mode keeps the same access token; just resync.
      void api(`/api/connections/${connectionId}/sync`, { method: 'POST' }).finally(() => void queryClient.invalidateQueries());
    } else {
      exchange.mutate({ publicToken, kind });
    }
  };

  const start = useMutation({
    mutationFn: async (kind: LinkKind) => {
      const { linkToken } = await api<{ linkToken: string }>('/api/plaid/link-token', {
        method: 'POST',
        body: JSON.stringify({ kind, connectionId }),
      });
      setOpen(true);
      close.current = await openPlaidLink(linkToken, {
        onSuccess: (publicToken) => {
          close.current = null;
          setOpen(false);
          onSuccess(publicToken, kind);
        },
        onExit: (message) => {
          close.current = null;
          setOpen(false);
          if (message) onError?.(message);
        },
      });
    },
    onError: (error) => {
      setOpen(false);
      onError?.(error.message);
    },
  });

  return {
    start: (kind: LinkKind) => start.mutate(kind),
    busy: start.isPending || open || exchange.isPending,
    importing: exchange.isPending,
  };
}

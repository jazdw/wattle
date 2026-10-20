import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { loadPlaid, openPlaidLink } from '../lib/plaidLink';
import { Button } from './ui/button';

interface Props {
  kind: 'investments' | 'account';
  /** Update mode: re-authenticate this connection. */
  connectionId?: string;
  label: string;
  variant?: 'default' | 'outline' | 'accent' | 'link';
  size?: 'default' | 'sm';
  onError?: (message: string) => void;
}

/** Fetches a link token on click, then opens Plaid Link. */
export function PlaidLinkButton({ kind, connectionId, label, variant = 'default', size = 'default', onError }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const close = useRef<(() => void) | null>(null);

  // Load Plaid's script while the button is on screen, so Link opens quickly.
  useEffect(() => {
    loadPlaid().catch(() => {}); // reported on click
    return () => close.current?.();
  }, []);

  const exchange = useMutation({
    mutationFn: (publicToken: string) =>
      api('/api/plaid/exchange', { method: 'POST', body: JSON.stringify({ publicToken, kind }) }),
    onSuccess: () => void queryClient.invalidateQueries(),
    onError: (error) => onError?.(error.message),
  });

  const onSuccess = (publicToken: string) => {
    if (connectionId) {
      // Update mode keeps the same access token; just resync.
      void api(`/api/connections/${connectionId}/sync`, { method: 'POST' }).finally(() => void queryClient.invalidateQueries());
    } else {
      exchange.mutate(publicToken);
    }
  };

  const start = useMutation({
    mutationFn: async () => {
      const { linkToken } = await api<{ linkToken: string }>('/api/plaid/link-token', {
        method: 'POST',
        body: JSON.stringify({ kind, connectionId }),
      });
      setOpen(true);
      close.current = await openPlaidLink(linkToken, {
        onSuccess: (publicToken) => {
          close.current = null;
          setOpen(false);
          onSuccess(publicToken);
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

  return (
    <Button variant={variant} size={size} onClick={() => start.mutate()} disabled={start.isPending || open || exchange.isPending}>
      {exchange.isPending ? 'Importing…' : label}
    </Button>
  );
}

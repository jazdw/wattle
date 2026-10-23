import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { askAboutNewAccounts, type NewAccountsQuestion } from '../lib/newAccountsQuestion';
import { loadPlaid, openPlaidLink } from '../lib/plaidLink';

export type LinkKind = 'investments' | 'account';

/**
 * A Link session that may continue on the OAuth redirect page. On a phone, a
 * bank's own login (Chase, Capital One) replaces this page, then sends the
 * browser to /plaid-oauth, which reopens Link with the same token.
 */
export interface PendingLink {
  linkToken: string;
  kind: LinkKind;
  connectionId?: string;
  /** Choosing which of the connection's accounts to share. */
  chooseAccounts?: boolean;
}

const PENDING_KEY = 'wt-plaid-link';

function savePending(pending: PendingLink): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Without storage, only the popup flow (desktop) works.
  }
}

export function readPendingLink(): PendingLink | null {
  try {
    const value = sessionStorage.getItem(PENDING_KEY);
    const pending = value ? (JSON.parse(value) as Partial<PendingLink>) : null;
    return pending?.linkToken && (pending.kind === 'investments' || pending.kind === 'account') ? (pending as PendingLink) : null;
  } catch {
    return null;
  }
}

function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

/**
 * Fetches a link token, then opens Plaid Link. Link stays open only while the
 * component using this is mounted, so a chooser dialog that closes as Link
 * opens should take it from the page instead.
 */
export function usePlaidLink({
  connectionId,
  chooseAccounts,
  onError,
  onLinked,
}: { connectionId?: string; chooseAccounts?: boolean; onError?: (message: string) => void; onLinked?: () => void } = {}) {
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
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onLinked?.();
    },
    onError: (error) => onError?.(error.message),
  });

  const onSuccess = (publicToken: string, { kind, chooseAccounts: choosing }: PendingLink) => {
    if (connectionId) {
      // Update mode keeps the same access token: resync (after choosing
      // accounts, straight away, loading new accounts' history; for new bank
      // accounts, Accounts asks first whether to get a bank report).
      const path = choosing ? `/api/connections/${connectionId}/accounts-chosen` : `/api/connections/${connectionId}/sync`;
      void api<{ newAccounts?: NewAccountsQuestion['accounts'] }>(path, { method: 'POST' })
        .then((result) => {
          if (result.newAccounts?.length) askAboutNewAccounts({ connectionId, accounts: result.newAccounts });
        })
        .finally(() => {
          void queryClient.invalidateQueries();
          onLinked?.();
        });
    } else {
      exchange.mutate({ publicToken, kind });
    }
  };

  const openLink = async (pending: PendingLink, receivedRedirectUri?: string) => {
    const { linkToken } = pending;
    setOpen(true);
    close.current = await openPlaidLink(
      linkToken,
      {
        onSuccess: (publicToken) => {
          close.current = null;
          clearPending();
          setOpen(false);
          onSuccess(publicToken, pending);
        },
        onExit: (message) => {
          close.current = null;
          clearPending();
          setOpen(false);
          if (message) onError?.(message);
        },
      },
      receivedRedirectUri,
    );
  };

  const start = useMutation({
    mutationFn: async (kind: LinkKind) => {
      const { linkToken } = await api<{ linkToken: string }>('/api/plaid/link-token', {
        method: 'POST',
        body: JSON.stringify({ kind, connectionId, ...(chooseAccounts ? { chooseAccounts } : {}) }),
      });
      const pending = { linkToken, kind, ...(connectionId ? { connectionId } : {}), ...(chooseAccounts ? { chooseAccounts } : {}) };
      savePending(pending);
      await openLink(pending);
    },
    onError: (error) => {
      setOpen(false);
      onError?.(error.message);
    },
  });

  /** On the redirect page: finish the Link session a bank's login interrupted. */
  const resume = useMutation({
    mutationFn: (pending: PendingLink) => openLink(pending, window.location.href),
    onError: (error) => {
      clearPending();
      setOpen(false);
      onError?.(error.message);
    },
  });

  return {
    start: (kind: LinkKind) => start.mutate(kind),
    resume: (pending: PendingLink) => resume.mutate(pending),
    busy: start.isPending || resume.isPending || open || exchange.isPending,
    importing: exchange.isPending,
  };
}

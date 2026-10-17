import { vi } from 'vitest';
import type { PlaidGlobal } from '../lib/plaidLink';

/** What the app last passed to Plaid Link; tests read and drive it. */
export const plaidLink = {
  open: vi.fn(),
  token: null as string | null,
  onSuccess: null as null | ((publicToken: string) => void),
  onExit: null as null | ((error: { error_message?: string; display_message?: string | null } | null) => void),
};

/** Stands in for Plaid's script (window.Plaid), which tests don't load. */
export const fakePlaid: PlaidGlobal = {
  create: (options) => {
    plaidLink.token = options.token;
    plaidLink.onSuccess = options.onSuccess;
    plaidLink.onExit = options.onExit;
    queueMicrotask(() => options.onLoad?.());
    return { open: plaidLink.open, exit: vi.fn(), destroy: vi.fn() };
  },
};

export function resetPlaid() {
  plaidLink.open.mockReset();
  plaidLink.token = null;
  plaidLink.onSuccess = null;
  plaidLink.onExit = null;
  window.Plaid = fakePlaid;
}

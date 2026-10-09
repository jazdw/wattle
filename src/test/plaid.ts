import { vi } from 'vitest';

/** Test double for react-plaid-link (see setup.ts): tests read and drive it. */
export const plaidLink = {
  open: vi.fn(),
  ready: false,
  token: null as string | null,
  onSuccess: null as null | ((publicToken: string | null) => void),
};

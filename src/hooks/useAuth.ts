import { createContext, useContext } from 'react';
import type { Currency } from '../../shared/money';
import type { MeResponse } from '../../shared/types';

export interface AuthState {
  me: MeResponse | null;
  loading: boolean;
  /** Display currency for this browser (defaults to the household's). */
  currency: Currency;
  setCurrency: (currency: Currency) => void;
  logout: () => Promise<void>;
}

/** Provided by `AuthProvider` (src/auth.tsx). */
export const AuthContext = createContext<AuthState>({
  me: null,
  loading: true,
  currency: 'USD',
  setCurrency: () => {},
  logout: async () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/** Display name for an account owner: a member's first name, or "Joint". */
export function useOwnerName(): (userId: string | null) => string {
  const { me } = useAuth();
  return (userId) => {
    if (!userId) return 'Joint';
    const member = me?.household.members.find((candidate) => candidate.id === userId);
    return member ? member.name.split(' ')[0] : 'Former member';
  };
}

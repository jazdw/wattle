import { useSyncExternalStore } from 'react';

/**
 * Choose accounts added bank accounts: whether to ask Plaid for a bank report
 * (their history; billed per report) is the person's call. The question waits
 * here, in session storage, so it survives the phone's OAuth redirect page
 * handing over to Accounts, which asks it.
 */
export interface NewAccountsQuestion {
  connectionId: string;
  accounts: { id: string; name: string; bank: boolean }[];
}

const KEY = 'wt-new-accounts';
const listeners = new Set<() => void>();
let current: NewAccountsQuestion | null = read();

function read(): NewAccountsQuestion | null {
  try {
    const value = sessionStorage.getItem(KEY);
    return value ? (JSON.parse(value) as NewAccountsQuestion) : null;
  } catch {
    return null;
  }
}

function set(question: NewAccountsQuestion | null): void {
  current = question;
  try {
    if (question) sessionStorage.setItem(KEY, JSON.stringify(question));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Without storage the question still shows on this page.
  }
  for (const listener of listeners) listener();
}

export const askAboutNewAccounts = (question: NewAccountsQuestion) => set(question);
export const clearNewAccountsQuestion = () => set(null);

export function useNewAccountsQuestion(): NewAccountsQuestion | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

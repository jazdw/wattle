/**
 * Plaid Link, via Plaid's browser API (window.Plaid). The script is added to
 * the page at most once and never removed: removing a script tag while it is
 * still downloading doesn't stop it running, so it would run twice.
 */

const SCRIPT_URL = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidHandler {
  open: () => void;
  exit: (options?: { force: boolean }) => void;
  destroy: () => void;
}

interface PlaidCreateOptions {
  token: string;
  /** Back from a bank's own login (OAuth) on the redirect page: where it sent us. */
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string) => void;
  onExit: (error: { error_message?: string; display_message?: string | null } | null) => void;
  onLoad?: () => void;
}

export interface PlaidGlobal {
  create: (options: PlaidCreateOptions) => PlaidHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidGlobal;
  }
}

let loading: Promise<PlaidGlobal> | null = null;

/** Load Plaid's script (once per page) and resolve with window.Plaid. */
export function loadPlaid(): Promise<PlaidGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  loading ??= new Promise<PlaidGlobal>((resolve, reject) => {
    const script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`) ?? document.createElement('script');
    script.addEventListener('load', () => (window.Plaid ? resolve(window.Plaid) : reject(new Error('Plaid Link did not load.'))));
    script.addEventListener('error', () => {
      // A failed script never ran, so it's safe to remove and try again later.
      script.remove();
      loading = null;
      reject(new Error('Could not load Plaid Link. Check your connection and try again.'));
    });
    if (!script.isConnected) {
      script.src = SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return loading;
}

export interface LinkCallbacks {
  onSuccess: (publicToken: string) => void;
  /** Link closed without linking; `message` is set when Plaid reported an error. */
  onExit: (message?: string) => void;
}

/**
 * Open Plaid Link for a link token. Returns a function that closes it. With
 * `receivedRedirectUri`, Link picks up where a bank's login left off.
 */
export async function openPlaidLink(token: string, callbacks: LinkCallbacks, receivedRedirectUri?: string): Promise<() => void> {
  const Plaid = await loadPlaid();
  let closed = false;
  const finish = (then: () => void) => {
    if (closed) return;
    closed = true;
    handler.destroy();
    then();
  };
  const handler = Plaid.create({
    token,
    ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
    onLoad: () => {
      if (!closed) handler.open();
    },
    onSuccess: (publicToken) => finish(() => callbacks.onSuccess(publicToken)),
    onExit: (error) => finish(() => callbacks.onExit(error ? (error.display_message ?? error.error_message) : undefined)),
  });
  return () => finish(() => {});
}

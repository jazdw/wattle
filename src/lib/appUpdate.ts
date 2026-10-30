import { useSyncExternalStore } from 'react';

/**
 * A new version of the app waiting to take over (the service worker has
 * installed it; see src/main.tsx). Holds the function that switches to it and
 * reloads, or null while there's none.
 */
let update: (() => Promise<void>) | null = null;
const listeners = new Set<() => void>();

export function newVersionWaiting(apply: () => Promise<void>): void {
  update = apply;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Switches to the waiting version and reloads; null while there isn't one. */
export function useNewVersion(): (() => Promise<void>) | null {
  return useSyncExternalStore(subscribe, () => update);
}

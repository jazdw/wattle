import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import { AuthProvider } from './auth.tsx';
import { ErrorScreen } from './components/ErrorScreen';
import { UpdateBanner } from './components/UpdateBanner';
import { newVersionWaiting } from './lib/appUpdate';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: true },
  },
});

async function clearServiceWorkerCaches(): Promise<void> {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
}

// Escape hatch: open any page with ?reset=1 to drop the service worker and all caches.
if (new URLSearchParams(window.location.search).has('reset')) {
  void clearServiceWorkerCaches().finally(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('reset');
    window.location.replace(url.toString());
  });
} else if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) registerServiceWorker();
  else void clearServiceWorkerCaches();
}

/** How often an open tab asks whether a new version has been deployed. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * The service worker serves the app's files from its cache. A deploy's new
 * version installs alongside and waits: open tabs keep the version they
 * loaded (its files are still cached) until the banner's Reload switches to
 * the new one (src/components/UpdateBanner.tsx). Without that, it waits until
 * every tab is closed.
 */
function registerServiceWorker() {
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => newVersionWaiting(() => update(true)),
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      // The browser only checks at a navigation and about once a day: also check
      // when the tab comes back into view, and hourly while it stays open.
      const check = () => void registration.update().catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      setInterval(check, UPDATE_CHECK_MS);
    },
  });
}

// A page restored from the back-forward cache shows whatever it held when
// left, even after signing out in between. Reload it so it asks the server
// again (and goes to the sign-in page if the session has ended).
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorScreen>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
        <UpdateBanner />
      </ErrorScreen>
    </QueryClientProvider>
  </StrictMode>,
);

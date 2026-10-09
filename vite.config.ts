import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

import { cloudflare } from '@cloudflare/vite-plugin'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Bind address for the dev server.
  //  - default: localhost only
  //  - set DEV_HOST (in `.env.local` or the environment) to a LAN IP, or to
  //    0.0.0.0 for all interfaces, to test from another device.
  const env = loadEnv(mode, process.cwd(), '')
  const devHost = (process.env.DEV_HOST || env.DEV_HOST || 'localhost').trim()

  return {
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    plugins: [
      react(),
      tailwindcss(),
      cloudflare(),
      // Installable app shell only. Financial data is NEVER cached by the
      // service worker: API responses are always fetched from the network.
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false, // registered in src/main.tsx
        manifest: false, // public/manifest.webmanifest is used as-is
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
          navigateFallback: '/index.html',
          // OAuth and API calls must always reach the Worker.
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
          runtimeCaching: [],
        },
      }),
    ],
    server: {
      host: devHost,
      // Vite's host check: only relevant when binding beyond localhost.
      allowedHosts: devHost === 'localhost' ? undefined : true,
    },
  }
})

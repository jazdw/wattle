import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts so tests don't start the Cloudflare
// Worker runtime or the PWA plugin. Server tests run the platform-agnostic app
// on Node against in-memory SQLite (libsql).
export default defineConfig({
  test: {
    include: ['shared/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
})

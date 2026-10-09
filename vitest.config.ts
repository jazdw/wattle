import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts so tests don't start the Cloudflare
// Worker runtime or the PWA plugin. Server tests run the platform-agnostic app
// on Node against in-memory SQLite (libsql), with D1's limits enforced.
export default defineConfig({
  test: {
    include: ['shared/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Logic only: React components and pages are checked by rendering the app.
      include: ['server/**/*.ts', 'shared/**/*.ts', 'src/lib/**/*.ts'],
      // schema.ts is declarations (its callbacks are FK references Drizzle never calls).
      exclude: ['**/*.test.ts', 'server/db/schema.ts', 'server/ports.ts', 'server/env.ts', 'shared/types.ts'],
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
})

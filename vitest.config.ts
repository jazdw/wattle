import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts so tests don't start the Cloudflare
// Worker runtime or the PWA plugin. Two projects:
//  - node: server + shared logic; the platform-agnostic app runs against
//    in-memory SQLite (libsql) with D1's limits enforced.
//  - dom: React components and pages in jsdom, with the API served by MSW.
// Browser tests (Playwright, e2e/) are separate: `npm run test:e2e`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['shared/**/*.test.ts', 'src/lib/**/*.test.ts', 'server/**/*.test.ts', 'test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'shared/**/*.ts', 'src/**/*.{ts,tsx}'],
      // Declarations, entry points and test helpers.
      exclude: [
        '**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'server/db/schema.ts',
        'server/ports.ts',
        'server/env.ts',
        'shared/types.ts',
      ],
      thresholds: { statements: 90, branches: 80, functions: 85, lines: 90 },
    },
  },
})

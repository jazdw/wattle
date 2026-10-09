import { defineConfig } from 'drizzle-kit'

// `npm run db:generate` writes SQL migrations into migrations/. They are
// applied with Wrangler on D1 (npm run db:migrate) and with Drizzle's migrator
// on libsql (tests and the Node entry).
export default defineConfig({
  dialect: 'sqlite',
  schema: './server/db/schema.ts',
  out: './migrations',
})

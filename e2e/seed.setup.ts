import { execFileSync } from 'node:child_process';
import { test as setup } from '@playwright/test';

// Fill the fresh database with demo accounts and a year of history, through
// the public API (the same script developers use).
setup('seed demo data', () => {
  execFileSync('node', ['scripts/seed-demo.mjs', 'http://localhost:8788', 'demo@example.com'], { stdio: 'inherit' });
});

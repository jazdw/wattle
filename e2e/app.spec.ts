import { test as plain } from '@playwright/test';
import { expect, test } from './fixtures';

plain('signed-out visitors land on the login page', async ({ page }) => {
  await page.goto('/allocation');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});

test('net worth shows the seeded household', async ({ page }) => {
  await expect(page.getByText(/^\$[\d,]+$/).first()).toBeVisible();
  for (const group of ['Cash', 'Investments', 'Property', 'Credit cards', 'Loans']) {
    await expect(page.getByRole('heading', { name: group, level: 3 })).toBeVisible();
  }
  await expect(page.getByText('Vanguard Brokerage (demo)')).toBeVisible();
  // The chart rendered real data points.
  await expect(page.locator('.recharts-area-curve')).toHaveCount(1);
});

test('every page loads from the sidebar', async ({ page }) => {
  for (const name of ['Growth', 'Allocation', 'Holdings', 'Style', 'Accounts', 'Settings', 'Net worth']) {
    await page.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  }
});

test('the display currency survives a reload', async ({ page }) => {
  await page.getByRole('tab', { name: 'AUD' }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'AUD' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'USD' }).click();
});

test('editing the target updates the drift table', async ({ page }) => {
  await page.goto('/allocation');
  await page.getByRole('button', { name: /Edit target/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Target allocation' });
  await dialog.getByLabel('US stocks').fill('55');
  await dialog.getByRole('textbox', { name: 'Cash', exact: true }).fill('0');
  await expect(dialog.getByText('Total 100.0%')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save target' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /^US stocks/ })).toContainText('55.0%');
});

test('a manual account can be added and updated', async ({ page }) => {
  await page.goto('/accounts');
  await page.getByRole('button', { name: /Manual account/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a manual account' });
  await dialog.getByLabel('Name').fill('E2E Savings');
  await dialog.getByLabel('Currency').selectOption('USD');
  await dialog.getByLabel('Current balance').fill('1234');
  await dialog.getByRole('button', { name: 'Add account' }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'E2E Savings' });
  await expect(row).toContainText('$1,234');

  await row.getByRole('button', { name: 'Edit account' }).click();
  const edit = page.getByRole('dialog', { name: 'E2E Savings' });
  await edit.getByPlaceholder('Balance').fill('2000');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('$2,000');
});

test('a Westpac CSV export imports as daily balances', async ({ page }) => {
  await page.goto('/accounts');
  await page.getByRole('button', { name: /Import CSV/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Import balance history' });
  await dialog.getByLabel('Account').selectOption({ label: 'Westpac Everyday (demo)' });
  await dialog.getByLabel('CSV file').setInputFiles({
    name: 'westpac.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial\n' +
        '032000123456,02/01/2025,SALARY,,1000.00,5000.00,INCOME,\n' +
        '032000123456,01/01/2025,RENT,600.00,,4000.00,OTHER,\n',
    ),
  });
  await expect(dialog.getByText('Recognised a Westpac transactions export.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Import' }).click();
  await expect(dialog.getByText('Imported 2 days.')).toBeVisible();
});

test('growth drills from accounts into holdings', async ({ page }) => {
  await page.goto('/growth');
  await page.getByRole('row', { name: /Vanguard Brokerage \(demo\)/ }).click();
  await expect(page.getByText('Vanguard Brokerage (demo) — holdings')).toBeVisible();
  await expect(page.getByRole('row', { name: /VTSAX/ })).toBeVisible();
  await page.getByRole('button', { name: /All accounts/ }).click();
  await expect(page.getByRole('tab', { name: 'By account' })).toBeVisible();
});

test('a guessed fund classification can be corrected', async ({ page }) => {
  await page.goto('/holdings');
  const aapl = page.getByRole('row').filter({ hasText: 'AAPL' });
  await expect(aapl.getByText('Review')).toBeVisible();
  await aapl.getByRole('button', { name: 'US stocks' }).click();
  const dialog = page.getByRole('dialog', { name: 'Classify AAPL' });
  await dialog.getByLabel('Large').fill('100');
  await dialog.getByLabel('Growth').fill('100');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(aapl.getByText('Review')).toBeHidden();
});

test('hiding an account removes it from net worth', async ({ page }) => {
  const netWorth = page.locator('p.text-3xl');
  const before = await netWorth.textContent();
  await page.goto('/accounts');
  const row = page.getByRole('listitem').filter({ hasText: 'Chase Checking (demo)' });
  await row.getByRole('button', { name: 'Edit account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Chase Checking (demo)' });
  await dialog.getByRole('switch', { name: /Hide this account/ }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('Hidden — not synced or counted');
  await page.getByRole('link', { name: 'Net worth' }).click();
  await expect(netWorth).not.toHaveText(before ?? '');
});

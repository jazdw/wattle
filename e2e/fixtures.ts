import { expect, test as base, type Page } from '@playwright/test';

/**
 * `page` arrives signed in (dev sign-in) and the test fails if the page logs
 * a console error or throws.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/api/auth/dev?email=demo@example.com');
    await expect(page.getByRole('heading', { name: 'Net worth', level: 1 })).toBeVisible();
    await use(page);
    expect(errors, 'console errors').toEqual([]);
  },
});

export { expect };

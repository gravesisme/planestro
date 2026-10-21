// The board and the item page in a real browser (planestro sample: dry-run engine, simulated git/GitHub/agents).
import { test, expect, type Page } from '@playwright/test';

/** Fails the test on any uncaught page error or console error, reported at the end so the steps still show. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return () => expect(errors, 'no page or console errors').toEqual([]);
}

const COLUMNS = ['NOT YET SUBMITTED', 'QUEUED', 'PLAN IN PROGRESS', 'PLAN READY', 'IN PROGRESS', 'IN REVIEW'];

test('the board lists every column and the sample items, and filters by category', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  for (const c of COLUMNS) await expect(page.getByRole('heading', { level: 3, name: new RegExp(`^${c}`) })).toBeVisible();
  await expect(page.locator('.card', { hasText: 'TD-7' })).toContainText('Times are wrong for a station');
  await expect(page.getByRole('button', { name: /items? need you/ })).toBeVisible();

  // A category filter hides the cards outside it and brings them back.
  const docsCard = page.locator('.card', { hasText: 'TD-8' });
  await expect(docsCard).toBeVisible();
  await page.getByRole('button', { name: 'Bug', exact: true }).click();
  await expect(docsCard).toBeHidden();
  await expect(page.locator('.card', { hasText: 'TD-7' })).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(docsCard).toBeVisible();

  // Finished work is on Done.
  await page.getByRole('link', { name: 'Done', exact: true }).click();
  await expect(page.locator('.card', { hasText: 'TD-5' })).toBeVisible();
  noErrors();
});

test('an item goes from the board through plan approval to merged, driven from its page', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  await page.locator('.card', { hasText: 'TD-7' }).click();
  await page.getByRole('button', { name: 'queue', exact: true }).click();

  // The planner (simulated) writes a plan and the item waits for the user.
  await expect(page.getByRole('button', { name: '1 item needs you' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Full details', exact: true }).click();
  await expect(page).toHaveURL(/\/items\/TD-7$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Times are wrong for a station');
  await expect(page.locator('.pill').first()).toHaveText(/plan ready/i);

  await page.getByRole('button', { name: 'Approve & implement' }).first().click();
  // Implementation, PR, CI and merge all run in the dry-run engine; the page follows them live.
  await expect(page.locator('.pill').first()).toHaveText(/merged|finished/i, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: '0 items need you' })).toBeVisible();
  noErrors();
});

test('the board and an item page fit a phone without sideways scrolling', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/items/TD-8']) {
    await page.goto(path);
    await expect(page.locator('.card, h1').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  }
  noErrors();
});

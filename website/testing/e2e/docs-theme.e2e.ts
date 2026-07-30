import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const DOCS_PATH = '/docs/getting-started/introduction';
const STORAGE_KEY = 'splitbrief-docs-theme';

test('persists the docs theme across reloads without retheming the landing', async ({ page }) => {
  const runtimeFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeFailures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => runtimeFailures.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => {
    runtimeFailures.push(`request: ${request.url()} (${request.failure()?.errorText})`);
  });

  await page.goto(DOCS_PATH);

  const root = page.locator('html');
  const toggle = page.getByRole('button', {
    name: 'Theme: dark. Switch to light.',
  });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  const target = await toggle.boundingBox();
  if (!target) throw new Error('Theme toggle has no rendered hit target');
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);

  await toggle.focus();
  // Polled: a one-shot read can race first-paint style settling and see the
  // used outline width before the focus token applies.
  await expect
    .poll(() =>
      toggle.evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: style.outlineWidth };
      }),
    )
    .toEqual({ style: 'solid', width: '2px' });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await toggle.click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('button', {
      name: 'Theme: light. Switch to dark.',
    }),
  ).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe('light');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('button', {
      name: 'Theme: light. Switch to dark.',
    }),
  ).toBeVisible();

  await page.goto('/');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe('light');

  await page.goto(DOCS_PATH);
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('button', {
      name: 'Theme: light. Switch to dark.',
    }),
  ).toBeVisible();
  expect(runtimeFailures).toEqual([]);
});

test('applies the stored docs theme before hydration can run', async ({ page }) => {
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(key, 'light');
    },
    { key: STORAGE_KEY },
  );
  await page.route('**/*.js', (route) => route.abort());

  await page.goto(DOCS_PATH);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('button', {
      name: 'Theme: dark. Switch to light.',
    }),
  ).toBeDisabled();
});

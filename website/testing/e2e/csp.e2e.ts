import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { WEBSITE_ROOT } from '../../scripts/site.js';

const CSP_INCLUDE_PATH = resolve(WEBSITE_ROOT, 'dist/nginx-csp.conf');
const CSP_HEADER = /^add_header Content-Security-Policy "([^"]+)" always;\s*$/;

async function generatedPolicy(): Promise<string> {
  const include = await readFile(CSP_INCLUDE_PATH, 'utf8');
  const policy = CSP_HEADER.exec(include)?.[1];
  if (!policy) {
    throw new Error('Generated nginx CSP include is malformed');
  }
  return policy;
}

async function browserViolations(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          splitbriefCspViolations?: string[];
        }
      ).splitbriefCspViolations ?? [],
  );
}

test('the generated static CSP permits hydration, theme persistence, matrix, and search', async ({
  page,
}) => {
  const policy = await generatedPolicy();
  const runtimeErrors: string[] = [];

  await page.route('**/*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy': policy,
      },
    });
  });
  await page.addInitScript(() => {
    const state = window as Window & {
      splitbriefCspViolations?: string[];
    };
    state.splitbriefCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      state.splitbriefCspViolations?.push(
        `${event.effectiveDirective}: ${event.blockedURI || 'inline'}`,
      );
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    runtimeErrors.push(`page: ${error.message}`);
  });

  await page.goto('/');
  await expect(page.locator('.matrix__controls')).not.toHaveAttribute('inert', '');
  const pairing = page.getByRole('gridcell', { name: 'Codex LM Studio' });
  await pairing.click();
  await expect(pairing).toHaveAttribute('aria-selected', 'true');
  expect(await browserViolations(page)).toEqual([]);

  await page.goto('/docs/getting-started/introduction');
  const themeToggle = page.getByRole('button', { name: 'Theme: dark. Switch to light.' });
  await expect(themeToggle).toBeEnabled();
  await themeToggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const searchTrigger = page.getByRole('button', { name: 'Search' });
  await expect(searchTrigger).toBeEnabled();
  await searchTrigger.click();
  const search = page.getByRole('searchbox', { name: 'Query' });
  await search.fill('Task Brief');
  await expect(page.getByRole('dialog', { name: 'Search documentation' })).toContainText(
    'Task Brief',
  );

  expect(await browserViolations(page)).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';

const DOCS_PATH = '/docs/concepts/task-briefs';
const DOCS_THEME_STORAGE_KEY = 'splitbrief-docs-theme';

async function settlePage(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    window.scrollTo(0, 0);
  });
}

test('matches the landing at 1440 × 900', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await settlePage(page, '/');

  await expect(page.locator('.landing-shell')).toBeVisible();
  await expect(page.locator('[data-matrix-prerender]')).toHaveCount(0);
  await expect(page.getByRole('grid', { name: 'Planner × implementer pairings' })).toBeVisible();
  await expect(page).toHaveScreenshot('landing-1440x900.png');
});

test('matches the landing at 390 × 844', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await settlePage(page, '/');

  await expect(page.locator('.landing-shell')).toBeVisible();
  await expect(page.locator('[data-matrix-prerender]')).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Planner' })).toBeVisible();
  await expect(page).toHaveScreenshot('landing-390x844.png');
});

for (const theme of ['dark', 'light'] as const) {
  test(`matches the Task Briefs docs page in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.addInitScript(
      ({ key, value }) => {
        localStorage.setItem(key, value);
      },
      { key: DOCS_THEME_STORAGE_KEY, value: theme },
    );
    await settlePage(page, DOCS_PATH);

    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.docs-shell')).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: theme === 'dark' ? 'Theme: dark. Switch to light.' : 'Theme: light. Switch to dark.',
      }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(`docs-task-briefs-${theme}-1440x900.png`);
  });
}

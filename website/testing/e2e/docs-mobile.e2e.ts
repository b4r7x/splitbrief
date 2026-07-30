import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { sitePages } from '../../scripts/pages.js';

const DOCS_PATH = '/docs/getting-started/introduction';
const DOCS_PATHS = sitePages()
  .filter((page) => page.kind === 'page' && page.path.startsWith('/docs/'))
  .map((page) => page.path);

async function expectHorizontalScrollRegionsRemainOperable(locator: Locator): Promise<number> {
  return locator.evaluateAll((elements) => {
    let scrollableCount = 0;

    for (const element of elements) {
      const style = getComputedStyle(element);
      if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') {
        throw new Error(`Expected horizontal scrolling on ${element.tagName.toLowerCase()}`);
      }
      if (element.scrollWidth <= element.clientWidth) {
        continue;
      }

      element.scrollLeft = element.scrollWidth;
      if (element.scrollLeft <= 0) {
        throw new Error(`Could not scroll ${element.tagName.toLowerCase()} horizontally`);
      }
      scrollableCount += 1;
    }

    return scrollableCount;
  });
}

test('keeps mobile docs navigation keyboard-operable without crowding the header', async ({
  page,
}) => {
  const runtimeFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeFailures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => runtimeFailures.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => {
    runtimeFailures.push(`request: ${request.url()} (${request.failure()?.errorText})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      runtimeFailures.push(`response: ${response.status()} ${response.url()}`);
    }
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto(DOCS_PATH);
  expect(response?.status()).toBe(200);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const index = page.locator('details.docs-index--mobile');
  const indexSummary = index.locator('summary');
  await expect(index).not.toHaveAttribute('inert', '');
  await indexSummary.focus();
  await page.keyboard.press('Enter');
  await expect(index).toHaveAttribute('open', '');

  const currentPage = index.getByRole('link', { name: 'Introduction' });
  await expect(currentPage).toHaveAttribute('aria-current', 'page');
  await currentPage.focus();
  await page.keyboard.press('Tab');
  await expect(index.getByRole('link', { name: 'Installation' })).toBeFocused();

  const toc = page.locator('details.docs-toc--mobile');
  await expect(toc).not.toHaveAttribute('inert', '');
  await toc.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(toc).toHaveAttribute('open', '');
  await expect(toc.getByRole('navigation', { name: 'On this page menu' })).toBeVisible();

  const themeToggle = page.getByRole('button', { name: 'Theme: dark. Switch to light.' });
  await expect(themeToggle).toBeEnabled();
  await themeToggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const wordmarkBox = await page.locator('.docs-header__name').boundingBox();
  const searchBox = await page.getByRole('button', { name: 'Search' }).boundingBox();
  if (!wordmarkBox || !searchBox) {
    throw new Error('Mobile header controls must have rendered bounds');
  }

  const headerItemsOverlap =
    wordmarkBox.x < searchBox.x + searchBox.width &&
    wordmarkBox.x + wordmarkBox.width > searchBox.x &&
    wordmarkBox.y < searchBox.y + searchBox.height &&
    wordmarkBox.y + wordmarkBox.height > searchBox.y;
  expect(headerItemsOverlap).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(await new AxeBuilder({ page }).analyze()).toMatchObject({ violations: [] });
  expect(runtimeFailures).toEqual([]);
});

for (const docsPath of DOCS_PATHS) {
  test(`${docsPath} stays inside a 390px viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto(docsPath);

    expect(response?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveCount(1);

    const widths = await page.evaluate(() => ({
      bodyClient: document.body.clientWidth,
      bodyScroll: document.body.scrollWidth,
      rootClient: document.documentElement.clientWidth,
      rootScroll: document.documentElement.scrollWidth,
    }));
    expect(widths.rootScroll, `${docsPath} overflows the root element`).toBeLessThanOrEqual(
      widths.rootClient,
    );
    expect(widths.bodyScroll, `${docsPath} overflows the body`).toBeLessThanOrEqual(
      widths.bodyClient,
    );

    await expectHorizontalScrollRegionsRemainOperable(page.locator('.docs-table-scroll'));
    await expectHorizontalScrollRegionsRemainOperable(page.locator('.docs-code-frame pre'));
  });
}

test('keeps wide CLI tables and code frames horizontally scrollable at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/docs/reference/cli');

  const scrollableTables = await expectHorizontalScrollRegionsRemainOperable(
    page.locator('.docs-table-scroll'),
  );
  const scrollableCodeFrames = await expectHorizontalScrollRegionsRemainOperable(
    page.locator('.docs-code-frame pre'),
  );

  expect(scrollableTables).toBeGreaterThan(0);
  expect(scrollableCodeFrames).toBeGreaterThan(0);
});

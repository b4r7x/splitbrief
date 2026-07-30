import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const DOCS_PATH = '/docs/concepts/task-briefs';
const STORAGE_KEY = 'splitbrief-docs-theme';
const VIEWPORTS = [
  { name: 'desktop', width: 1440 },
  { name: 'mobile', width: 390 },
] as const;
const THEMES = ['dark', 'light'] as const;

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`hydrates MDX identically in ${theme} at ${viewport.name} width`, async ({
      browser,
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

      await page.setViewportSize({ height: 900, width: viewport.width });
      await page.addInitScript(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: STORAGE_KEY, value: theme },
      );

      const serverContext = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { height: 900, width: viewport.width },
      });

      try {
        const serverPage = await serverContext.newPage();
        const serverResponse = await serverPage.goto(DOCS_PATH);
        const hydratedResponse = await page.goto(DOCS_PATH);
        await page.waitForLoadState('networkidle');
        expect(serverResponse?.status()).toBe(200);
        expect(hydratedResponse?.status()).toBe(200);

        const lineSelector = '.docs-code-frame pre code > .line';
        const serverLine = serverPage.locator(lineSelector).filter({ hasText: 'id: T003' }).first();
        const hydratedLine = page.locator(lineSelector).filter({ hasText: 'id: T003' }).first();

        await expect(serverLine).toHaveText('id: T003');
        await expect(hydratedLine).toHaveText('id: T003');
        expect(await hydratedLine.innerHTML()).toBe(await serverLine.innerHTML());
        await expect(hydratedLine.locator(':scope > span')).toHaveCount(3);

        if (viewport.name === 'mobile') {
          const wordmark = page.locator('.docs-header__name');
          const search = page.getByRole('button', { name: 'Search' });
          await expect(wordmark).toHaveText('Splitbrief');
          const wordmarkBox = await wordmark.boundingBox();
          const searchBox = await search.boundingBox();
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
        }

        const codeFrames = page.locator('.docs-code-frame');
        const codeFrameCount = await codeFrames.count();
        expect(codeFrameCount).toBeGreaterThan(0);
        await expect(codeFrames.locator('pre > code')).toHaveCount(codeFrameCount);
        await expect(codeFrames.locator('pre[icon]')).toHaveCount(0);
        await expect(codeFrames.getByRole('button', { name: 'Copy code' })).toHaveCount(
          codeFrameCount,
        );

        const tableScrolls = page.getByRole('group', { name: 'Scrollable data table' });
        expect(await tableScrolls.count()).toBeGreaterThanOrEqual(1);
        await tableScrolls.first().focus();
        await expect(tableScrolls.first()).toBeFocused();

        await expect(page.locator('.docs-heading__anchor').first()).toBeVisible();
        if (viewport.width >= 1200) {
          await expect(page.locator('.docs-toc--desktop')).toBeVisible();
          await expect(page.locator('.docs-toc--mobile')).toBeHidden();
        } else {
          await expect(page.locator('.docs-toc--desktop')).toBeHidden();
          await expect(page.locator('.docs-toc--mobile')).toBeVisible();
        }

        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(runtimeFailures).toEqual([]);
      } finally {
        await serverContext.close();
      }
    });
  }
}

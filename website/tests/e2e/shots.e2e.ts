import { mkdir } from 'node:fs/promises';
import { test } from '@playwright/test';
import { openPage, scrollScene } from './browser.js';

const directory = process.env.SHOT_DIR;
const tag = process.env.SHOT_TAG ?? 'website';
test.skip(!directory, 'Set SHOT_DIR to capture the current website');
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

for (const [width, height] of [
  [1800, 957],
  [1440, 900],
  [390, 844],
  [320, 740],
  [320, 568],
  [844, 390],
] as const) {
  test(`captures both scenes at ${width}×${height}`, async ({ page }) => {
    if (!directory) return;
    const size = `${width}x${height}`;
    const output = `${directory}/${tag}-${size}`;
    await mkdir(directory, { recursive: true });
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPage(page);
    await page.screenshot({ path: `${output}-hero.png` });
    await scrollScene(page, '[data-scroll-track]', 0.4);
    await page.screenshot({ path: `${output}-workflow.png` });
    await page.locator('.closing').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}-transition.png` });
    for (const hash of ['roles', 'record', 'install']) {
      await openPage(page, `/#${hash}`);
      await page.screenshot({ path: `${output}-${hash}.png` });
    }
    await page.getByRole('tab', { name: 'From source', exact: true }).click();
    await page.screenshot({ path: `${output}-source.png` });
    await page.locator('.page-footer').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}-footer.png` });
    await page.goto('/docs/getting-started/');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}-docs.png` });
    await page.locator('.docs-back-top').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}-docs-footer.png` });
    await page.goto('/docs/getting-started/#3-installation');
    await page.screenshot({ path: `${output}-docs-install.png` });
    await page
      .locator('.docs-table')
      .filter({ hasText: 'Find any doc by topic' })
      .screenshot({ path: `${output}-docs-table.png` });
    await page.goto('/docs/');
    await page.screenshot({ path: `${output}-docs-index.png` });
    await page.goto('/docs/configuration/');
    await page.screenshot({ path: `${output}-docs-reference.png` });
    if (width < 900) await page.locator('.docs-menu > summary').click();
    await page.getByRole('searchbox', { name: 'Find a documentation page' }).fill('workflow');
    await page.screenshot({ path: `${output}-docs-menu.png` });
    await page.goto('/404.html');
    await page.screenshot({ path: `${output}-not-found.png` });
  });
}

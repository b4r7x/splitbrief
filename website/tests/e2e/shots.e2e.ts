import { mkdir } from 'node:fs/promises';
import { test } from '@playwright/test';
import { openPage, scrollScene } from './browser.js';

const directory = process.env.SHOT_DIR;
const tag = process.env.SHOT_TAG ?? 'website';
test.skip(!directory, 'Set SHOT_DIR to capture the current website');

for (const [width, height] of [
  [1800, 957],
  [1440, 900],
  [390, 844],
  [320, 740],
] as const) {
  test(`captures both scenes at ${width} pixels`, async ({ page }) => {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPage(page);
    await page.screenshot({ path: `${directory}/${tag}-${width}-hero.png` });
    await scrollScene(page, '[data-scroll-track]', 0.4);
    await page.screenshot({ path: `${directory}/${tag}-${width}-workflow.png` });
    for (const hash of ['roles', 'record', 'install']) {
      await openPage(page, `/#${hash}`);
      await page.screenshot({ path: `${directory}/${tag}-${width}-${hash}.png` });
    }
  });
}

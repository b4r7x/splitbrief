// Screenshot helper for the design cadence: node scripts/shot.mjs <url> <name> [--reduced-motion]
// Saves <name>-1440.png / <name>-1440-full.png / <name>-390.png / <name>-390-full.png to .design-shots/.
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [url, name, ...flags] = process.argv.slice(2);
if (!url || !name) {
  console.error('usage: node scripts/shot.mjs <url> <name> [--reduced-motion]');
  process.exit(1);
}

const outDir = new URL('../.design-shots/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const reducedMotion = flags.includes('--reduced-motion') ? 'reduce' : 'no-preference';
const viewports = [
  { width: 1440, height: 900, tag: '1440' },
  { width: 390, height: 844, tag: '390' },
];

const browser = await chromium.launch();
for (const { width, height, tag } of viewports) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}${name}-${tag}.png` });
  await page.screenshot({ path: `${outDir}${name}-${tag}-full.png`, fullPage: true });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(`${name}-${tag}: viewport ${width}x${height}, scrollWidth ${scrollWidth}`);
  await page.close();
}
await browser.close();

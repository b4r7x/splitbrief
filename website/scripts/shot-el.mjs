// Element screenshot: node scripts/shot-el.mjs <url> <selector> <name> [width]
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [url, selector, name, width = '1440'] = process.argv.slice(2);
const outDir = new URL('../.design-shots/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(width), height: 900 },
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const el = page.locator(selector).first();
await el.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
await el.screenshot({ path: `${outDir}${name}.png` });
console.log(`${name}.png`);
await browser.close();

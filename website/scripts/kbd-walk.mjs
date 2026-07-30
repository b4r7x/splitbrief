// Keyboard walk: composer Enter jump, matrix roving tabindex + Enter seat, install copy focus.
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const composer = page.locator('.terminal__input');
await composer.focus();
await composer.type('codex x groq');
await composer.press('Enter');
await page.waitForTimeout(900);
const scrolled = await page.evaluate(() => window.scrollY > 200);
const cleared = (await composer.inputValue()) === '';
console.log(`composer enter: scrolled=${scrolled} cleared=${cleared}`);

const selectedCell = page.locator('[role="gridcell"][aria-selected="true"]');
await selectedCell.focus();
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowDown');
const focusInfo = await page.evaluate(() => {
  const el = document.activeElement;
  return {
    role: el?.getAttribute('role'),
    tabindex: el?.getAttribute('tabindex'),
    outline: el ? getComputedStyle(el).outlineStyle : null,
  };
});
console.log(`matrix focus after arrows: ${JSON.stringify(focusInfo)}`);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const seated = await page.evaluate(() => {
  const cell = document.querySelector('[role="gridcell"][aria-selected="true"]');
  return {
    row: cell?.getAttribute('data-row-index'),
    col: cell?.getAttribute('data-column-index'),
  };
});
console.log(`pin seated at: ${JSON.stringify(seated)}`);
const yaml = await page.locator('.config-output code').textContent();
console.log(
  `yaml mentions: ${yaml?.includes('planner') && yaml.includes('implementer') ? 'planner+implementer' : 'MISSING'}`,
);

const copy = page.locator('.install-block__copy');
await copy.scrollIntoViewIfNeeded();
await copy.focus();
const copyOutline = await copy.evaluate((el) => getComputedStyle(el).outlineStyle);
console.log(`install copy focus outline: ${copyOutline}`);

await browser.close();

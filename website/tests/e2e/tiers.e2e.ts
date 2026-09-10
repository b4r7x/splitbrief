import { expect, type Locator, type Page, test } from '@playwright/test';

async function at(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function box(locator: Locator): Promise<{ x: number; y: number; w: number; h: number }> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${locator} has no box`);
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

test('the three-column row', async ({ page }) => {
  await at(page, 1360, 900);
  const head = await box(page.locator('.s02 .head'));
  const panel = await box(page.locator('.s02 .panel'));
  const notes = await box(page.locator('.s02 .notes'));
  const grid = await box(page.locator('.s02 .grid'));
  expect(Math.abs(head.y - panel.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(notes.y - panel.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(panel.x - (grid.x + 310 + 24))).toBeLessThanOrEqual(1);
  await expect(page.locator('.marg:visible')).toHaveCount(6);
  await expect(page.locator('.rail')).toBeVisible();
});

test('the two-row band at 1200', async ({ page }) => {
  await at(page, 1200, 900);
  const head = await box(page.locator('.s02 .head'));
  const panel = await box(page.locator('.s02 .panel'));
  const notes = await box(page.locator('.s02 .notes'));
  const grid = await box(page.locator('.s02 .grid'));
  const breath = await box(page.locator('.s04 .breath'));
  const s04head = await box(page.locator('.s04 .head'));
  expect(head.y).toBeLessThan(panel.y);
  expect(Math.abs(panel.x - grid.x)).toBeLessThanOrEqual(1);
  expect(notes.x).toBeGreaterThan(panel.x + panel.w);
  await expect(page.locator('.marg:visible')).toHaveCount(0);
  await expect(page.locator('.rail')).toBeHidden();
  await expect(page.locator('.dots--desk:visible')).toHaveCount(0);
  expect(breath.x).toBeGreaterThan(s04head.x + s04head.w);
});

test('the two-row band at 1024', async ({ page }) => {
  await at(page, 1024, 900);
  const head = await box(page.locator('.s02 .head'));
  const panel = await box(page.locator('.s02 .panel'));
  const notes = await box(page.locator('.s02 .notes'));
  const grid = await box(page.locator('.s02 .grid'));
  const breath = await box(page.locator('.s04 .breath'));
  const s04head = await box(page.locator('.s04 .head'));
  expect(head.y).toBeLessThan(panel.y);
  expect(Math.abs(panel.x - grid.x)).toBeLessThanOrEqual(1);
  expect(notes.x).toBeGreaterThan(panel.x + panel.w);
  await expect(page.locator('.marg:visible')).toHaveCount(0);
  await expect(page.locator('.rail')).toBeHidden();
  await expect(page.locator('.dots--desk:visible')).toHaveCount(0);
  expect(breath.x).toBeGreaterThan(s04head.x + s04head.w);
});

test('the stacked row at 768', async ({ page }) => {
  await at(page, 768, 900);
  const panel = await box(page.locator('.s02 .panel'));
  const notes = await box(page.locator('.s02 .notes'));
  const grid = await box(page.locator('.s02 .grid'));
  const breath = await box(page.locator('.s04 .breath'));
  const s04grid = await box(page.locator('.s04 .grid'));
  const tools = await box(page.locator('.callout--tools'));
  const models = await box(page.locator('.callout--models'));
  const rules = await box(page.locator('.callout--rules'));
  const tree = await box(page.locator('.tree'));
  expect(Math.abs(panel.w - grid.w)).toBeLessThanOrEqual(1);
  expect(notes.y).toBeGreaterThan(panel.y + panel.h);
  expect(Math.abs(breath.w - s04grid.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(tools.y - models.y)).toBeLessThanOrEqual(1);
  expect(rules.y).toBeGreaterThan(tools.y + tools.h);
  expect(rules.y).toBeGreaterThan(models.y + models.h);
  expect(Math.abs(tree.w - s04grid.w)).toBeLessThanOrEqual(1);
});

test('the phone column at 390', async ({ page }) => {
  await at(page, 390, 844);
  const kids = await page.locator('.lower .grid > *:visible').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, w: r.width };
    }),
  );
  expect(kids.length).toBeGreaterThan(0);
  for (const kid of kids) {
    expect(Math.abs(kid.x - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(kid.w - 350)).toBeLessThanOrEqual(1);
  }
  const tick = await box(page.locator('.s02 .tick-list'));
  expect(Math.abs(tick.h - 32)).toBeLessThanOrEqual(1);
  await expect(page.locator('.s03 .tail:visible')).toHaveCount(0);
  await expect(page.locator('.bar .status span:last-child:visible')).toHaveCount(0);
  expect(
    await page
      .locator('.tree .note')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'block')),
  ).toBe(true);
  const brand = await box(page.locator('.foot .brand'));
  const right = await box(page.locator('.foot .right'));
  expect(right.y).toBeGreaterThan(brand.y + brand.h);
  await expect(page.locator('canvas.dots:visible')).toHaveCount(0);
  await expect(page.locator('.lower .fragment')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test('the FHD row', async ({ page }) => {
  await at(page, 1600, 900);
  const head = await box(page.locator('.s02 .head'));
  const panel = await box(page.locator('.s02 .panel'));
  expect(Math.abs(head.w - 330)).toBeLessThanOrEqual(1);
  expect(Math.abs(panel.w - 517)).toBeLessThanOrEqual(1);
  await expect(page.locator('.dots--gutter')).toBeVisible();
});

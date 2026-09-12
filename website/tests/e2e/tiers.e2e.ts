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
});

test('the two-row band at 1200', async ({ page }) => {
  await at(page, 1200, 900);
  const head = await box(page.locator('.s02 .head'));
  const panel = await box(page.locator('.s02 .panel'));
  const notes = await box(page.locator('.s02 .notes'));
  const grid = await box(page.locator('.s02 .grid'));
  const tree = await box(page.locator('.s04 .tree'));
  const s04head = await box(page.locator('.s04 .head'));
  const s04notes = await box(page.locator('.s04 .notes'));
  expect(head.y).toBeLessThan(panel.y);
  expect(Math.abs(panel.x - grid.x)).toBeLessThanOrEqual(1);
  expect(notes.x).toBeGreaterThan(panel.x + panel.w);
  await expect(page.locator('.marg:visible')).toHaveCount(0);
  expect(tree.y).toBeGreaterThan(s04head.y + s04head.h);
  expect(s04notes.x).toBeGreaterThan(tree.x + tree.w);
});

test('the two-row band at 1024', async ({ page }) => {
  await at(page, 1024, 900);
  const head = await box(page.locator('.s02 .head'));
  const panel = await box(page.locator('.s02 .panel'));
  const notes = await box(page.locator('.s02 .notes'));
  const grid = await box(page.locator('.s02 .grid'));
  const tree = await box(page.locator('.s04 .tree'));
  const s04notes = await box(page.locator('.s04 .notes'));
  expect(head.y).toBeLessThan(panel.y);
  expect(Math.abs(panel.x - grid.x)).toBeLessThanOrEqual(1);
  expect(notes.x).toBeGreaterThan(panel.x + panel.w);
  await expect(page.locator('.marg:visible')).toHaveCount(0);
  expect(s04notes.x).toBeGreaterThan(tree.x + tree.w);
});

test('the stacked row at 768', async ({ page }) => {
  await at(page, 768, 900);
  const panel = await box(page.locator('.s02 .panel'));
  const notes = await box(page.locator('.s02 .notes'));
  const grid = await box(page.locator('.s02 .grid'));
  const s04grid = await box(page.locator('.s04 .grid'));
  const s04notes = await box(page.locator('.s04 .notes'));
  const tree = await box(page.locator('.tree'));
  expect(Math.abs(panel.w - grid.w)).toBeLessThanOrEqual(1);
  expect(notes.y).toBeGreaterThan(panel.y + panel.h);
  expect(Math.abs(tree.w - s04grid.w)).toBeLessThanOrEqual(1);
  expect(s04notes.y).toBeGreaterThan(tree.y + tree.h);
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
  expect(Math.abs(tick.h - 49)).toBeLessThanOrEqual(1);
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
  await expect(page.locator('.backdrop')).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test('wide tiers preserve panel sizing and never enlarge the Canvas cells', async ({ page }) => {
  const rows = [
    { width: 1599, head: 310, panel: 494 },
    { width: 1600, head: 351, panel: 546 },
    { width: 1920, head: 351, panel: 655 },
    { width: 2560, head: 351, panel: 655 },
  ];
  let wideGhosts: { width: number; height: number }[] | undefined;
  for (const row of rows) {
    await at(page, row.width, 1080);
    const head = await box(page.locator('.s02 .head'));
    const panel = await box(page.locator('.s02 .panel'));
    expect(Math.abs(head.w - row.head)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.w - row.panel)).toBeLessThanOrEqual(1);
    const ghosts = await page.locator('canvas.ghost').evaluateAll((canvases) =>
      canvases.map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(ghosts).toHaveLength(3);
    if (row.width >= 1600) {
      if (wideGhosts) expect(ghosts).toEqual(wideGhosts);
      wideGhosts = ghosts;
    }
  }
});

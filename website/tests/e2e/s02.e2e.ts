import { expect, type Locator, type Page, test } from '@playwright/test';

async function open(page: Page): Promise<void> {
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

async function lines(locator: Locator): Promise<number> {
  return locator.evaluate((el) =>
    Math.round(
      el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight),
    ),
  );
}

const DESKTOP: [number, number][] = [
  [1440, 900],
  [1920, 1080],
];

test('the 02 row at 1440 and 1920', async ({ page }) => {
  const rows: {
    w: number;
    h: number;
    xs: [number, number, number];
    pw: number;
    ph: number;
    sh: number;
  }[] = [
    { w: 1440, h: 900, xs: [64, 398, 916], pw: 494, ph: 508, sh: 557 },
    { w: 1920, h: 1080, xs: [128, 482, 1130], pw: 624, ph: 546, sh: 595 },
  ];
  for (const row of rows) {
    await page.setViewportSize({ width: row.w, height: row.h });
    await open(page);
    const head = await box(page.locator('.s02 .head'));
    const panel = await box(page.locator('.s02 .panel'));
    const notes = await box(page.locator('.s02 .notes'));
    const section = await box(page.locator('.s02'));
    expect(Math.abs(head.x - row.xs[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.x - row.xs[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(notes.x - row.xs[2])).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.w - row.pw)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.h - row.ph)).toBeLessThanOrEqual(1);
    expect(Math.abs(section.h - row.sh)).toBeLessThanOrEqual(2);
    expect(Math.abs(panel.y - (section.y + 25))).toBeLessThanOrEqual(1);
  }
});

test('no editor row wraps', async ({ page }) => {
  for (const [width, height] of DESKTOP) {
    await page.setViewportSize({ width, height });
    await open(page);
    expect(
      await page
        .locator('.s02 .lines .t')
        .evaluateAll((els) =>
          els.every((el) => el.scrollWidth <= el.clientWidth && el.getClientRects().length === 1),
        ),
    ).toBe(true);
  }
});

test('the notes set 5 / 3 / 5 / 2 lines', async ({ page }) => {
  for (const [width, height] of DESKTOP) {
    await page.setViewportSize({ width, height });
    await open(page);
    const counts = await page.locator('.s02 .notes > p:nth-of-type(-n+4)').evaluateAll((ps) =>
      ps.map((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      }),
    );
    expect(counts).toEqual([5, 3, 5, 2]);
    expect(await lines(page.locator('.s02 .notes > p:nth-of-type(3)'))).toBe(5);
  }
});

test('marginalia on their anchors at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const section = await box(page.locator('.s02'));
  const first = await box(page.locator('.s02 .notes > p:first-child'));
  const caps1 = await box(page.locator('.s02 .caps').nth(0));
  const margA = await box(page.locator('.s02 .marg-a'));
  const margList = await box(page.locator('.s02 .marg-list'));
  const margB = await box(page.locator('.s02 .marg-b'));
  const stop = await box(page.locator('.s02 .stop'));
  const caps2Bottom = await page
    .locator('.s02 .caps')
    .nth(1)
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()];
      const lastTop = rects.reduce((m, r) => (r.top > m ? r.top : m), 0);
      return lastTop + Number.parseFloat(getComputedStyle(el).lineHeight);
    });
  expect(Math.abs(margA.y - (first.y + 4 * 20.8 + 4))).toBeLessThanOrEqual(1);
  expect(Math.abs(margList.y - (caps1.y + 16))).toBeLessThanOrEqual(1);
  expect(Math.abs(margB.y - (caps2Bottom + 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(margA.x + margA.w - 1376)).toBeLessThanOrEqual(1);
  expect(Math.abs(margB.x + margB.w - 1352)).toBeLessThanOrEqual(1);
  expect(Math.abs(margList.x - 1304)).toBeLessThanOrEqual(1);
  expect(Math.abs(stop.x - 1304)).toBeLessThanOrEqual(1);
  expect(Math.abs(stop.y - (section.y + 17))).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const notes = await box(page.locator('.s02 .notes'));
  const a = await box(page.locator('.s02 .marg-a'));
  const list = await box(page.locator('.s02 .marg-list'));
  const b = await box(page.locator('.s02 .marg-b'));
  const stopWide = await box(page.locator('.s02 .stop'));
  expect(Math.abs(a.y - (notes.y + 104))).toBeLessThanOrEqual(1);
  expect(Math.abs(list.y - (notes.y + 177))).toBeLessThanOrEqual(1);
  expect(Math.abs(b.y - (notes.y + 438))).toBeLessThanOrEqual(1);
  expect(Math.abs(a.x + a.w - 1792)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.x + b.w - 1768)).toBeLessThanOrEqual(1);
  expect(Math.abs(list.x - 1720)).toBeLessThanOrEqual(1);
  expect(Math.abs(stopWide.x - 1720)).toBeLessThanOrEqual(1);
});

test('the 02 fold at 1920', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const top = (await box(page.locator('.s02'))).y;
  await page.evaluate((y) => window.scrollTo(0, y), top);
  expect(
    await page.locator('.s02').evaluate((el) => el.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(1080);
});

test('the 02 phone column at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const kids = await page.locator('.s02 .grid > *').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, w: r.width };
    }),
  );
  for (const kid of kids) {
    expect(Math.abs(kid.x - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(kid.w - 350)).toBeLessThanOrEqual(1);
  }
  const tick = await box(page.locator('.s02 .tick-list'));
  const panel = await box(page.locator('.s02 .panel'));
  const section = await box(page.locator('.s02'));
  expect(Math.abs(tick.h - 32)).toBeLessThanOrEqual(1);
  expect(Math.abs(panel.h - 713)).toBeLessThanOrEqual(3);
  expect(Math.abs(section.h - 1418)).toBeLessThanOrEqual(3);
  expect(
    await page
      .locator('.s02 .marg, .s02 .marg-list, .s02 .stop')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'none')),
  ).toBe(true);
});

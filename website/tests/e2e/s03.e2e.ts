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

test('the 03 row at 1440 and 1920', async ({ page }) => {
  const rows: {
    w: number;
    h: number;
    xs: [number, number, number];
    pw: number;
    ph: number;
    sh: number;
  }[] = [
    { w: 1440, h: 900, xs: [64, 398, 916], pw: 494, ph: 313, sh: 388 },
    { w: 1920, h: 1080, xs: [264, 618, 1159], pw: 517, ph: 336, sh: 404 },
  ];
  for (const row of rows) {
    await page.setViewportSize({ width: row.w, height: row.h });
    await open(page);
    const head = await box(page.locator('.s03 .head'));
    const panel = await box(page.locator('.s03 .panel'));
    const notes = await box(page.locator('.s03 .notes'));
    const section = await box(page.locator('.s03'));
    expect(Math.abs(head.x - row.xs[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.x - row.xs[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(notes.x - row.xs[2])).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.w - row.pw)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.h - row.ph)).toBeLessThanOrEqual(1);
    expect(Math.abs(section.h - row.sh)).toBeLessThanOrEqual(2);
    expect(Math.abs(panel.y - (section.y + 25))).toBeLessThanOrEqual(1);
  }
});

test('no terminal row wraps and the last serif line holds', async ({ page }) => {
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    await open(page);
    expect(
      await page
        .locator('.s03 .lines .t')
        .evaluateAll((els) =>
          els.every((el) => el.scrollWidth <= el.clientWidth && el.getClientRects().length === 1),
        ),
    ).toBe(true);
  }
  for (const width of [1360, 1440, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const last = page.locator('.s03 .sub .line:last-child');
    expect(await last.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await lines(last)).toBe(1);
  }
});

test('the notes set 4 / 6 lines and five steps', async ({ page }) => {
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    await open(page);
    const counts = await page
      .locator('.s03 .notes > p:nth-of-type(1), .s03 .notes > p:nth-of-type(2)')
      .evaluateAll((ps) =>
        ps.map((p) => {
          const range = document.createRange();
          range.selectNodeContents(p);
          return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        }),
      );
    expect(counts, String(width)).toEqual([4, 6]);
    const items = page.locator('.s03 .steps li');
    await expect(items).toHaveCount(5);
    expect(
      await items.evaluateAll((lis) =>
        lis.every((li) => {
          const span = li.querySelector('span:last-child');
          return span !== null && getComputedStyle(span).borderLeftWidth === '1px';
        }),
      ),
    ).toBe(true);
  }
});

test('marginalia on their anchors', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const section = await box(page.locator('.s03'));
  const first = await box(page.locator('.s03 .notes > p:first-child'));
  const second = await box(page.locator('.s03 .notes > p:nth-child(2)'));
  const steps = await box(page.locator('.s03 .steps'));
  const margA = await box(page.locator('.s03 .marg-a'));
  const margList = await box(page.locator('.s03 .marg-list'));
  const margB = await box(page.locator('.s03 .marg-b'));
  const stop = await box(page.locator('.s03 .stop'));
  expect(Math.abs(margA.y - (first.y + 3 * 20.8 + 2.4))).toBeLessThanOrEqual(1);
  expect(Math.abs(margList.y - (second.y + 16))).toBeLessThanOrEqual(1);
  expect(Math.abs(margB.y - (steps.y + 36))).toBeLessThanOrEqual(1);
  expect(Math.abs(margA.x + margA.w - 1376)).toBeLessThanOrEqual(1);
  expect(Math.abs(margB.x + margB.w - 1352)).toBeLessThanOrEqual(1);
  expect(Math.abs(margList.x - 1304)).toBeLessThanOrEqual(1);
  expect(Math.abs(stop.x - 1304)).toBeLessThanOrEqual(1);
  expect(Math.abs(stop.y - (section.y + 17))).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const notes = await box(page.locator('.s03 .notes'));
  const a = await box(page.locator('.s03 .marg-a'));
  const list = await box(page.locator('.s03 .marg-list'));
  const b = await box(page.locator('.s03 .marg-b'));
  const stopWide = await box(page.locator('.s03 .stop'));
  expect(Math.abs(a.y - (notes.y + 78))).toBeLessThanOrEqual(1);
  expect(Math.abs(list.y - (notes.y + 122))).toBeLessThanOrEqual(1);
  expect(Math.abs(b.y - (notes.y + 284))).toBeLessThanOrEqual(1);
  expect(Math.abs(a.x + a.w - 1656)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.x + b.w - 1632)).toBeLessThanOrEqual(1);
  expect(Math.abs(list.x - 1584)).toBeLessThanOrEqual(1);
  expect(Math.abs(stopWide.x - 1584)).toBeLessThanOrEqual(1);
});

test('the 03 fold at 1920', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const top = (await box(page.locator('.s03'))).y;
  await page.evaluate((y) => {
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, y);
  }, top);
  expect(
    await page.locator('.s03').evaluate((el) => el.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(1080);
});

test('the 03 phone column at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const kids = await page.locator('.s03 .grid > *').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, w: r.width };
    }),
  );
  for (const kid of kids) {
    expect(Math.abs(kid.x - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(kid.w - 350)).toBeLessThanOrEqual(1);
  }
  const panel = await box(page.locator('.s03 .panel'));
  const section = await box(page.locator('.s03'));
  expect(Math.abs(panel.h - 383) / 383).toBeLessThanOrEqual(0.03);
  expect(Math.abs(section.h - 1074) / 1074).toBeLessThanOrEqual(0.03);
  expect(
    await page
      .locator('.s03 .tail')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'none')),
  ).toBe(true);
  await expect(page.locator('.s03 .bar .status span:last-child')).toBeHidden();
  expect(
    await page
      .locator('.s03 .marg, .s03 .marg-list, .s03 .stop')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'none')),
  ).toBe(true);
});

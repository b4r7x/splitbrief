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

async function textStart(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    if (!el.firstChild) throw new Error('no text');
    const range = document.createRange();
    range.setStart(el.firstChild, 0);
    range.setEnd(el.firstChild, 1);
    return range.getBoundingClientRect().x;
  });
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

// references/briefs.png scaled by 1920/1122: panel 503–1158 × 43–721 with a 40px bar, notes at
// 1210, code text 77px inside the panel on a 17.3px pitch (36 rows over 354 src px), section
// 748px tall.
test('the 02 row at 1440 and 1920', async ({ page }) => {
  const rows: {
    w: number;
    h: number;
    xs: [number, number, number];
    pw: number;
    ph: number;
    sh: number;
    py: number;
    pitch: number;
    text: number;
  }[] = [
    { w: 1440, h: 900, xs: [64, 398, 916], pw: 494, ph: 508, sh: 557, py: 25, pitch: 13, text: 26 },
    {
      w: 1920,
      h: 1080,
      xs: [128, 503, 1182],
      pw: 655,
      ph: 677,
      sh: 750,
      py: 49,
      pitch: 17.3,
      text: 77,
    },
  ];
  for (const row of rows) {
    await page.setViewportSize({ width: row.w, height: row.h });
    await open(page);
    const head = await box(page.locator('.s02 .head'));
    const section = await box(page.locator('.s02'));
    const panel = await box(page.locator('.s02 .panel'));
    const notes = await box(page.locator('.s02 .notes'));
    const first = await box(page.locator('.s02 .lines li').first());
    const last = await box(page.locator('.s02 .lines li').last());
    const text = await page
      .locator('.s02 .lines .t')
      .first()
      .evaluate(
        (el) => el.getBoundingClientRect().x + Number.parseFloat(getComputedStyle(el).paddingLeft),
      );
    expect(Math.abs(head.x - row.xs[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.x - row.xs[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(notes.x - row.xs[2])).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.w - row.pw)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.h - row.ph)).toBeLessThanOrEqual(1);
    expect(Math.abs(section.h - row.sh)).toBeLessThanOrEqual(2);
    expect(Math.abs(panel.y - (section.y + row.py))).toBeLessThanOrEqual(1);
    expect(Math.abs((last.y - first.y) / 35 - row.pitch)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(text - panel.x - row.text)).toBeLessThanOrEqual(1);
  }
});

test('no editor row wraps', async ({ page }) => {
  for (const [width, height] of [...DESKTOP, [1600, 900] as const]) {
    await page.setViewportSize({ width, height });
    await open(page);
    expect(
      await page
        .locator('.s02 .lines .t')
        .evaluateAll((els) =>
          els.every(
            (el) =>
              el.getBoundingClientRect().height <=
              Number.parseFloat(getComputedStyle(el).lineHeight) + 0.5,
          ),
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
  const first = await box(page.locator('.s02 .notes > p:first-child'));
  const caps1 = await box(page.locator('.s02 .caps').nth(0));
  const margA = await box(page.locator('.s02 .marg-a'));
  const margList = await box(page.locator('.s02 .marg-list'));
  const margB = await box(page.locator('.s02 .marg-b'));
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

  // briefs.png at 1920/1122: the right list is one object from its tick (x 1720, y 246 under the
  // section top) to its dash, text 10px right of the tick; the marginalia mono is 15px
  // (CONTRACTS 52 src, EXECUTE 39 src, 'less context' 63 src wide), marg-a 13px (115 src for 25
  // chars), marg-b left-aligned on a 25.7px pitch; the tick list closes with a dash 76 src below
  // its tick.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const notes = await box(page.locator('.s02 .notes'));
  const a = await box(page.locator('.s02 .marg-a'));
  const list = await box(page.locator('.s02 .marg-list'));
  const b = await box(page.locator('.s02 .marg-b'));
  const tickList = await box(page.locator('.s02 .tick-list'));
  const contracts = await box(page.locator('.s02 .tick-list .line').nth(1));
  expect(Math.abs(a.y - (notes.y + 138))).toBeLessThanOrEqual(1);
  expect(Math.abs(list.y - (notes.y + 197))).toBeLessThanOrEqual(1);
  expect(Math.abs(b.y - (notes.y + 538))).toBeLessThanOrEqual(1);
  expect(Math.abs(a.x + a.w - 1856)).toBeLessThanOrEqual(1);
  expect(Math.abs(a.w - 195)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.x + b.w - 1792)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.h - 52)).toBeLessThanOrEqual(1);
  expect(Math.abs((await textStart(page.locator('.s02 .marg-b'))) - b.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(list.x - 1720)).toBeLessThanOrEqual(1);
  expect(Math.abs((await textStart(page.locator('.s02 .marg-list'))) - 1730)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(contracts.w - 92)).toBeLessThanOrEqual(1);
  expect(Math.abs(tickList.h - 129)).toBeLessThanOrEqual(1);
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
  expect(Math.abs(tick.h - 49)).toBeLessThanOrEqual(1);
  expect(Math.abs(panel.h - 713)).toBeLessThanOrEqual(3);
  expect(Math.abs(section.h - 1435)).toBeLessThanOrEqual(3);
  expect(
    await page
      .locator('.s02 .marg, .s02 .marg-list')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'none')),
  ).toBe(true);
});

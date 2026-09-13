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

// references/validation.png scaled by 1920/1122: title column at 91, terminal 503–1158 from y 31,
// notes at 1211, section 453px tall with the terminal's bottom border on the footer seam; code text
// (the 1440 tier stays at its baseline geometry so the aura keeps its fragment slots — X01 owns that);
// 86px inside the panel on a 17.5px pitch (the BRIEFS document metrics, one shared >=1600 panel rule).
test('the 03 row at 1440 and 1920', async ({ page }) => {
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
    { w: 1440, h: 900, xs: [64, 398, 916], pw: 494, ph: 313, sh: 388, py: 25, pitch: 13, text: 26 },
    {
      w: 1920,
      h: 1080,
      xs: [128, 503, 1182],
      pw: 655,
      ph: 411,
      sh: 452,
      py: 33,
      pitch: 17,
      text: 77,
    },
  ];
  for (const row of rows) {
    await page.setViewportSize({ width: row.w, height: row.h });
    await open(page);
    const head = await box(page.locator('.s03 .head'));
    const panel = await box(page.locator('.s03 .panel'));
    const notes = await box(page.locator('.s03 .notes'));
    const section = await box(page.locator('.s03'));
    const first = await box(page.locator('.s03 .lines li').first());
    const last = await box(page.locator('.s03 .lines li').last());
    const text = await page
      .locator('.s03 .lines .t')
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
    expect(Math.abs((last.y - first.y) / 20 - row.pitch)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(text - panel.x - row.text)).toBeLessThanOrEqual(1);
  }
});

test('no terminal row wraps and the last serif line holds', async ({ page }) => {
  for (const [width, height] of [
    [1440, 900],
    [1600, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    await open(page);
    expect(
      await page
        .locator('.s03 .lines .t')
        .evaluateAll((els) =>
          els.every(
            (el) =>
              el.getBoundingClientRect().height <=
              Number.parseFloat(getComputedStyle(el).lineHeight) + 0.5,
          ),
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

test('the notes set 4 / 6 and 4 / 5 lines and five steps', async ({ page }) => {
  for (const [width, height, second] of [
    [1440, 900, 6],
    [1920, 1080, 5],
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
    expect(counts, String(width)).toEqual([4, second]);
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
    // the list is as wide as its own rows (PNG: 110 source px of ink = 188 css at 1920), not the column
    const steps = await box(page.locator('.s03 .steps'));
    const widest = Math.max(...(await items.evaluateAll((lis) => lis.map((li) => li.scrollWidth))));
    expect(Math.abs(steps.w - widest)).toBeLessThanOrEqual(1);
    if (width === 1920) expect(Math.abs(steps.w - 188)).toBeLessThanOrEqual(9);
  }
});

// the marginalia list box starts at its tick, 24px above the first word (PNG: tick 88–97, text from 103
// in crop rows), so the text keeps its anchor while the box reaches up to where the tick is drawn.
async function firstWordOffset(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const word = range.getClientRects()[0];
    if (!word) throw new Error('marginalia list has no text');
    return word.top - el.getBoundingClientRect().top;
  });
}

test('marginalia on their anchors', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const first = await box(page.locator('.s03 .notes > p:first-child'));
  const second = await box(page.locator('.s03 .notes > p:nth-child(2)'));
  const steps = await box(page.locator('.s03 .steps'));
  const margA = await box(page.locator('.s03 .marg-a'));
  const margList = await box(page.locator('.s03 .marg-list'));
  const margB = await box(page.locator('.s03 .marg-b'));
  expect(Math.abs(margA.y - (first.y + 3 * 20.8 + 2.4))).toBeLessThanOrEqual(1);
  expect(Math.abs(margList.y - (second.y - 8))).toBeLessThanOrEqual(1);
  expect(
    Math.abs((await firstWordOffset(page.locator('.s03 .marg-list'))) - 24),
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(margB.y - (steps.y + 36))).toBeLessThanOrEqual(1);
  expect(Math.abs(margA.x + margA.w - 1376)).toBeLessThanOrEqual(1);
  expect(Math.abs(margB.x + margB.w - 1352)).toBeLessThanOrEqual(1);
  expect(Math.abs(margList.x - 1304)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const notes = await box(page.locator('.s03 .notes'));
  const a = await box(page.locator('.s03 .marg-a'));
  const list = await box(page.locator('.s03 .marg-list'));
  const b = await box(page.locator('.s03 .marg-b'));
  expect(Math.abs(a.y - (notes.y + 67))).toBeLessThanOrEqual(1);
  expect(Math.abs(list.y - (notes.y + 122))).toBeLessThanOrEqual(1);
  expect(
    Math.abs((await firstWordOffset(page.locator('.s03 .marg-list'))) - 24),
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(b.y - (notes.y + 329))).toBeLessThanOrEqual(1);
  // A SMALLER LOOP / A HIGHER BAR / REAL PROGRESS rag right, flush left as in the PNG (crop x 959)
  expect(
    await page.locator('.s03 .marg-b').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const lefts = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.left);
      return new Set(lefts.map(Math.round)).size;
    }),
  ).toBe(1);
  expect(Math.abs(a.x + a.w - 1856)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.x + b.w - 1768)).toBeLessThanOrEqual(1);
  expect(Math.abs(list.x - 1720)).toBeLessThanOrEqual(1);
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
      .locator('.s03 .marg, .s03 .marg-list')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'none')),
  ).toBe(true);
});

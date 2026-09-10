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

const TIERS: [number, number][] = [
  [1440, 900],
  [1920, 1080],
];

test('the colophon at 1440 and 1920', async ({ page }) => {
  for (const [width, height] of TIERS) {
    await page.setViewportSize({ width, height });
    await open(page);
    const wide = width === 1920;
    const s04 = await box(page.locator('.s04'));
    expect(Math.abs(s04.h - (wide ? 858 : 819))).toBeLessThanOrEqual(2);
    const breath = await box(page.locator('.s04 .breath'));
    const lead = await box(page.locator('.s04 .lead'));
    const callouts = await box(page.locator('.callouts'));
    const creed = await box(page.locator('.s04 .creed'));
    const tree = await box(page.locator('.tree'));
    const pairs: [number, number][] = [
      [breath.x, wide ? 854 : 621],
      [breath.y, s04.y + 128],
      [breath.w, wide ? 802 : 755],
      [breath.h, wide ? 259 : 226],
      [lead.x, wide ? 264 : 64],
      [lead.y, s04.y + (wide ? 435 : 402)],
      [callouts.x, wide ? 854 : 621],
      [callouts.y, lead.y],
      [creed.y, s04.y + (wide ? 710 : 670)],
      [creed.y + creed.h, tree.y + tree.h],
      [tree.x, wide ? 854 : 621],
      [tree.y, s04.y + (wide ? 618 : 578)],
      [tree.w, wide ? 566 : 533],
      [tree.h, 144],
    ];
    for (const [got, want] of pairs) expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
    const wantH = wide ? [112, 127, 150] : [109, 127, 145];
    const rects = await page
      .locator('.callout')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
    const t0 = rects[0];
    if (!t0) throw new Error('callout');
    for (const [i, want] of wantH.entries()) {
      const got = rects[i];
      if (!got) throw new Error('callout');
      expect(Math.abs(got.height - want)).toBeLessThanOrEqual(1);
      expect(Math.abs(got.top - t0.top)).toBeLessThanOrEqual(1);
    }
    const rows = page.locator('.tree .row');
    await expect(rows).toHaveCount(9);
    for (const h of await rows.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    )) {
      expect(Math.abs(h - 16)).toBeLessThanOrEqual(1);
    }
    const noteXs = await page.locator('.tree .note').evaluateAll((els) =>
      els.map((el) => {
        const node = el.closest('.tree');
        return node ? el.getBoundingClientRect().left - node.getBoundingClientRect().left : 0;
      }),
    );
    const n0 = noteXs[0];
    if (n0 === undefined) throw new Error('notes');
    for (const x of noteXs) expect(Math.abs(x - n0)).toBeLessThanOrEqual(0.5);
  }
});
test('marginalia (grid-relative)', async ({ page }) => {
  for (const [width, height] of TIERS) {
    await page.setViewportSize({ width, height });
    await open(page);
    const wide = width === 1920;
    const s04 = await box(page.locator('.s04'));
    const grid = await box(page.locator('.s04 .grid'));
    const a = await box(page.locator('.s04 .marg-a'));
    const list = await box(page.locator('.s04 .marg-list'));
    const b = await box(page.locator('.s04 .marg-b'));
    const stop = await box(page.locator('.s04 .stop'));
    const pairs: [number, number][] = [
      [a.y, grid.y + (wide ? 124 : 107)],
      [a.x + a.w, wide ? 1656 : 1376],
      [list.y, grid.y + (wide ? 158 : 141)],
      [list.x, wide ? 1584 : 1304],
      [b.y + b.h, grid.y + grid.h - 32],
      [b.x + b.w, wide ? 1632 : 1352],
      [stop.y, s04.y + (wide ? 610 : 571)],
    ];
    for (const [got, want] of pairs) expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
  }
});
test('display lines hold', async ({ page }) => {
  const viewports: [number, number][] = [...TIERS, [390, 844]];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await open(page);
    const stanza = page.locator('.s04 .breath .line--stanza');
    expect(await stanza.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await lines(stanza)).toBe(1);
    for (const line of await page.locator('.s04 .sub .line').all())
      expect(await lines(line)).toBe(1);
  }
});

test('the 04 fold at 1920', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const top = (await box(page.locator('.s04'))).y;
  await page.evaluate((y) => {
    const maxScroll = document.documentElement.scrollHeight - innerHeight;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, Math.min(y, maxScroll));
  }, top);
  expect(
    Math.round(
      await page.locator('footer.foot').evaluate((el) => el.getBoundingClientRect().bottom),
    ),
  ).toBeLessThanOrEqual(1080);
});

test('the footer row', async ({ page }) => {
  for (const [width, height] of TIERS) {
    await page.setViewportSize({ width, height });
    await open(page);
    const wide = width === 1920;
    const foot = await box(page.locator('.foot'));
    expect(Math.abs(foot.h - 87)).toBeLessThanOrEqual(1);
    const wordmark = await box(page.locator('.foot .wordmark'));
    const claim = await box(page.locator('.foot .claim'));
    const a1 = await box(page.locator('.foot .links a:nth-child(1)'));
    const a2 = await box(page.locator('.foot .links a:nth-child(2)'));
    const seats = await box(page.locator('.foot .seats'));
    const xs = wide ? [264, 436, 1241, 1330, 1444] : [64, 236, 961, 1050, 1164];
    const got = [wordmark.x, claim.x, a1.x, a2.x, seats.x];
    for (const [i, want] of xs.entries()) {
      const x = got[i];
      if (x === undefined) throw new Error('foot x');
      expect(Math.abs(x - want)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(seats.x + seats.w - (wide ? 1656 : 1376))).toBeLessThanOrEqual(1);
    const ruleW = await page
      .locator('hr.rule--bleed')
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(ruleW).toBe(width);
    for (const h of await page
      .locator('.foot .links a')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(h).toBeGreaterThanOrEqual(44);
    }
  }
});

test('the phone colophon and footer at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const order = await page.locator('.s04 .grid > *').evaluateAll((els) =>
    els
      .filter((el) => getComputedStyle(el).display !== 'none')
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map((el) => el.className.trim().split(/\s+/)[0] ?? ''),
  );
  expect(order).toEqual(['head', 'breath', 'lead', 'creed', 'callouts', 'tree']);
  expect(
    await page
      .locator('.tree .note')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'block')),
  ).toBe(true);
  const tree = await box(page.locator('.tree'));
  const s04 = await box(page.locator('.s04'));
  const foot = await box(page.locator('.foot'));
  expect(Math.abs(tree.h - 224)).toBeLessThanOrEqual(0.03 * 224);
  expect(Math.abs(s04.h - 1492)).toBeLessThanOrEqual(0.03 * 1492);
  expect(Math.abs(foot.h - 162)).toBeLessThanOrEqual(0.03 * 162);
  const claim = await box(page.locator('.foot .claim'));
  const wordmark = await box(page.locator('.foot .wordmark'));
  expect(claim.y).toBeGreaterThan(wordmark.y + wordmark.h);
  const d1 = await box(page.locator('.foot .links a:nth-child(1)'));
  const d2 = await box(page.locator('.foot .links a:nth-child(2)'));
  expect(Math.abs(d2.x - (d1.x + d1.w) - 24)).toBeLessThanOrEqual(1);
  await expect(page.locator('.foot .seats')).toHaveText('PLANS / EXECUTES / REVIEWS');
});

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

// C02 variant B: section 04 is one low stanza on the 02/03 skeleton — head · session tree ·
// notes (lead, WORKS WITH, docs links, creed) — with no second display and no callouts.
test('the ending at 1440 and 1920', async ({ page }) => {
  for (const [width, height] of TIERS) {
    await page.setViewportSize({ width, height });
    await open(page);
    const wide = width === 1920;
    const s04 = await box(page.locator('.s04'));
    const grid = await box(page.locator('.s04 .grid'));
    const head = await box(page.locator('.s04 .head'));
    const tree = await box(page.locator('.s04 .tree'));
    const notes = await box(page.locator('.s04 .notes'));
    const panel = await box(page.locator('.s03 .panel'));
    const validation = await box(page.locator('.s03'));
    expect(Math.abs(head.x - grid.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(tree.x - panel.x)).toBeLessThanOrEqual(1);
    expect(notes.x).toBeGreaterThan(tree.x + tree.w);
    expect(Math.abs(tree.y - head.y)).toBeLessThanOrEqual(wide ? 5 : 1);
    expect(Math.abs(notes.y - head.y)).toBeLessThanOrEqual(wide ? 5 : 1);
    expect(s04.h).toBeLessThan(validation.h);
    expect(
      Math.abs(s04.y + s04.h - (Math.max(tree.y + tree.h, notes.y + notes.h) + 16)),
    ).toBeLessThanOrEqual(1);
    const rows = page.locator('.tree .row');
    await expect(rows).toHaveCount(9);
    for (const h of await rows.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    )) {
      expect(Math.abs(h - 16)).toBeLessThanOrEqual(1);
    }
    const noteXs = await page
      .locator('.tree .note')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
    const n0 = noteXs[0];
    if (n0 === undefined) throw new Error('notes');
    for (const x of noteXs) expect(Math.abs(x - n0)).toBeLessThanOrEqual(0.5);
    const order = await page
      .locator('.s04 .notes > *:not(.marg, .marg-list)')
      .evaluateAll((els) =>
        els.map((el) => el.className.trim().split(/\s+/)[0] ?? el.tagName.toLowerCase()),
      );
    expect(order).toEqual(['dash', 'tools', 'links', 'caps']);
    await expect(page.locator('.s04 .links a').nth(0)).toHaveAttribute(
      'href',
      'https://github.com/b4r7x/splitbrief/blob/main/docs/CONFIGURATION.md',
    );
    await expect(page.locator('.s04 .links a').nth(1)).toHaveAttribute(
      'href',
      'https://github.com/b4r7x/splitbrief/blob/main/docs/FEATURES.md',
    );
    for (const h of await page
      .locator('.s04 .links a')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(h).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('.s04 .breath, .s04 .callout')).toHaveCount(0);
  }
});

test('marginalia (notes-relative)', async ({ page }) => {
  for (const [width, height] of TIERS) {
    await page.setViewportSize({ width, height });
    await open(page);
    const notes = await box(page.locator('.s04 .notes'));
    const a = await box(page.locator('.s04 .marg-a'));
    const list = await box(page.locator('.s04 .marg-list'));
    const b = await box(page.locator('.s04 .marg-b'));
    expect(a.y).toBeGreaterThan(notes.y);
    expect(list.y).toBeGreaterThan(a.y + a.h);
    expect(b.y).toBeGreaterThan(list.y + list.h);
    expect(b.y + b.h).toBeLessThanOrEqual(notes.y + notes.h + 1);
    expect(list.x).toBeGreaterThan(notes.x + notes.w / 2);
  }
});

test('display lines hold', async ({ page }) => {
  const viewports: [number, number][] = [...TIERS, [390, 844]];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await open(page);
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
    const s04 = await box(page.locator('.s04'));
    const foot = await box(page.locator('.foot'));
    const wordmark = await box(page.locator('.foot .wordmark'));
    const claim = await box(page.locator('.foot .claim'));
    const a1 = await box(page.locator('.foot .links a:nth-child(1)'));
    const a2 = await box(page.locator('.foot .links a:nth-child(2)'));
    const seats = await box(page.locator('.foot .seats'));
    const wordmarkText = await page
      .locator('.foot .wordmark')
      .evaluate(
        (el) => el.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(el).paddingTop),
      );
    expect(Math.abs(foot.y - (s04.y + s04.h))).toBeLessThanOrEqual(1);
    expect(Math.abs(wordmarkText - (s04.y + s04.h) - 8)).toBeLessThanOrEqual(2);
    // references/footer.png: the band is 36 src px, x 1920/1122 = 61.6 -> 62 (C03 attempt-01
    // target-landmarks: 16 + 61 = 77 from 04's last ink to the page end). The DOM row is
    // 8 + 32 padding + one 12px line at 1.45 = 60.4 at both tiers, so the pin is +-5 % (-2.6 %),
    // not +-1 px. Was 87 +-1 before the C03 footer.
    expect(Math.abs(foot.h - 62)).toBeLessThanOrEqual(0.05 * 62);
    expect(Math.abs(wordmark.x - (wide ? 128 : 64))).toBeLessThanOrEqual(1);
    expect(Math.abs(claim.x - (wordmark.x + wordmark.w) - 32)).toBeLessThanOrEqual(1);
    expect(Math.abs(a2.x - (a1.x + a1.w) - 32)).toBeLessThanOrEqual(1);
    expect(Math.abs(seats.x - (a2.x + a2.w) - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs(seats.x + seats.w - (wide ? 1792 : 1376))).toBeLessThanOrEqual(1);
    for (const h of await page
      .locator('.foot a')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(h).toBeGreaterThanOrEqual(44);
    }
  }
});

test('the phone ending and footer at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const order = await page.locator('.s04 .grid > *').evaluateAll((els) =>
    els
      .filter((el) => getComputedStyle(el).display !== 'none')
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map((el) => el.className.trim().split(/\s+/)[0] ?? ''),
  );
  expect(order).toEqual(['head', 'tree', 'notes']);
  expect(
    await page
      .locator('.tree .note')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).display === 'block')),
  ).toBe(true);
  const tree = await box(page.locator('.tree'));
  const notes = await box(page.locator('.s04 .notes'));
  const s04 = await box(page.locator('.s04'));
  const foot = await box(page.locator('.foot'));
  expect(Math.abs(tree.h - 224)).toBeLessThanOrEqual(0.03 * 224);
  expect(notes.y).toBeGreaterThan(tree.y + tree.h);
  expect(Math.abs(s04.y + s04.h - (notes.y + notes.h + 16))).toBeLessThanOrEqual(1);
  const claim = await box(page.locator('.foot .claim'));
  const wordmark = await box(page.locator('.foot .wordmark'));
  const seats = await box(page.locator('.foot .seats'));
  expect(Math.abs(foot.y + foot.h - (seats.y + seats.h) - 32)).toBeLessThanOrEqual(1);
  expect(claim.x + claim.w).toBeLessThanOrEqual(foot.x + foot.w);
  const d1 = await box(page.locator('.foot .links a:nth-child(1)'));
  const d2 = await box(page.locator('.foot .links a:nth-child(2)'));
  expect(d1.y).toBeGreaterThan(Math.max(claim.y + claim.h, wordmark.y + wordmark.h - 13));
  expect(Math.abs(d2.x - (d1.x + d1.w) - 32)).toBeLessThanOrEqual(1);
  await expect(page.locator('.foot .seats')).toHaveText('PLANS / EXECUTES / REVIEWS');
});

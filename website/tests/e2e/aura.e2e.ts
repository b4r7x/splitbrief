import { expect, type Locator, type Page, test } from '@playwright/test';

const clockStart = new Date('2026-09-08T12:00:00Z');
const GUTTER_GLYPHS: readonly string[] = ['∴', '°', '×', '→'];
const POOL_BRIEFS: readonly string[] = [
  'const brief = compile(spec)',
  'one file per brief',
  'brief -> implementer',
  'depends_on: [T001]',
  'fresh context',
  'no memory of the last one',
  'in bounds · out of bounds',
  'stop and ask',
  'contract blocked',
  'T1 ✓',
  'T2 ▸',
  '( 39%, 46% )',
  '//',
  '∴',
  '· · · · · · · · ln 36',
  '· · · · · · · · · · · · col 1',
  '· · · · · · · · · · T002',
];
const POOL_VALIDATION: readonly string[] = [
  'validate(task)',
  'typecheck · lint · test',
  'while (red) retry()',
  'retry(3) -> escalate',
  'first failure',
  'attempt 2/3',
  '412ms',
  'evidence saved',
  'not its own judge',
  'promote(diff)',
  'hash ok',
  '→',
  '×',
  '· · · · · · · · · · · · 14:28:16',
  '· · · · · · · · 47s',
  '· · · · · · · · · · 3/3',
];
const POOL_CONTROL: readonly string[] = [
  'max_budget: 5.00',
  'pause at 85 %',
  'snapshot: pre_task',
  'state.json',
  'session.jsonl',
  'append-only',
  'less context',
  'more progress',
  'lower spend',
  'fewer blind spots',
  'real software',
  'smaller loops',
  'higher confidence',
  '0x2f 0x62 0x72 0x69 0x65 0x66',
  'seed 8088',
  '[ 3 / 7 ]',
  '°',
  '∴',
  'worktree',
  '· · · · · · · · · · · · 85 %',
  '· · · · · · · · 5.00 usd',
  '· · · · · · · · · · 3 seats',
];

async function open(page: Page): Promise<void> {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart.getTime() + 60_000);
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
}

async function seek(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => {
    for (const animation of document.getAnimations()) {
      if (animation.timeline !== document.timeline) continue;
      animation.pause();
      animation.currentTime = t;
    }
  }, ms);
}

type Box = { left: number; top: number; right: number; bottom: number };

async function box(locator: Locator): Promise<Box> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${locator} has no box`);
  return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
}

function keepClear(el: Element, railX: number): boolean {
  const hit = (a: DOMRect, b: DOMRect) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const grow = (r: DOMRect, n: number) =>
    new DOMRect(r.left - n, r.top - n, r.width + 2 * n, r.height + 2 * n);
  const lines: DOMRect[] = [];
  const take = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) lines.push(r);
  };
  const grid = el.querySelector('.grid');
  if (grid !== null) {
    const w = document.createTreeWalker(grid, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n !== null; n = w.nextNode()) take(n);
  }
  const rects = (q: string) => [...el.querySelectorAll(q)].map((n) => n.getBoundingClientRect());
  const panels = rects('.panel');
  const marks = rects('.panel,.tree,.marg,.marg-list,.stop,canvas.dots');
  const items = [...el.querySelectorAll('[class="fragment"]')];
  const strip = new DOMRect(railX - 8, -1e5, 16, 2e5);
  for (const node of items) {
    const b = node.getBoundingClientRect();
    const g = grow(b, 6);
    if (lines.some((l) => hit(g, grow(l, 24))) || marks.some((m) => hit(g, m)) || hit(g, strip))
      return false;
    if (items.some((o) => o !== node && hit(g, o.getBoundingClientRect()))) return false;
    const text = node.textContent ?? '';
    if (text.length <= 1) continue;
    const gap = text.startsWith('· ·') ? 192 : 96;
    for (const l of lines) {
      if (panels.some((p) => hit(l, p))) continue;
      if (b.top - 8 >= l.bottom || b.bottom + 8 <= l.top) continue;
      if (!(b.left >= l.right + gap || b.right <= l.left - gap)) return false;
    }
  }
  return true;
}

test('each section places its fragments', async ({ page }) => {
  await open(page);
  const s02 = page.locator('.s02 [class="fragment"]');
  const s03 = page.locator('.s03 [class="fragment"]');
  const s04 = page.locator('.s04 [class="fragment"]');
  expect(await s02.count()).toBeGreaterThanOrEqual(6);
  expect(await s03.count()).toBeGreaterThanOrEqual(4);
  expect(await s04.count()).toBeGreaterThanOrEqual(14);
  const traces = async (loc: Locator): Promise<number> =>
    await loc.evaluateAll(
      (els) => els.filter((el) => (el.textContent ?? '').startsWith('· ·')).length,
    );
  expect(await traces(s04)).toBeGreaterThanOrEqual(1);
  const rows: [Locator, readonly string[]][] = [
    [s02, POOL_BRIEFS],
    [s03, POOL_VALIDATION],
    [s04, POOL_CONTROL],
  ];
  for (const [loc, pool] of rows) {
    const allowed = new Set([...pool, ...GUTTER_GLYPHS]);
    const texts = await loc.evaluateAll((els) => els.map((el) => el.textContent ?? ''));
    for (const text of texts) expect(allowed.has(text)).toBe(true);
  }
});

test('fragments keep clear', async ({ page }) => {
  let armed = false;
  for (const width of [1440, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    if (armed) await page.goto('/');
    else await open(page);
    armed = true;
    await page.evaluate(() => document.fonts.ready);
    const railX = (await box(page.locator('.rail'))).left;
    for (const sel of ['.s02', '.s03', '.s04']) {
      const root = page.locator(sel);
      const origins = await root.locator('[class="fragment"]').evaluateAll((els) =>
        els.map((el) => ({
          x: Number.parseFloat(el.style.left),
          y: Number.parseFloat(el.style.top),
        })),
      );
      origins.forEach((a, i) => {
        for (const b of origins.slice(i + 1))
          expect(Math.hypot(a.x - b.x, a.y - b.y), `${sel} ${width}`).toBeGreaterThanOrEqual(60);
      });
      for (const ms of [0, 10000]) {
        await seek(page, ms);
        expect(await root.evaluate(keepClear, railX), `${sel} ${width} ${ms}`).toBe(true);
      }
    }
  }
});

test('the fields are drawn', async ({ page }) => {
  await open(page);
  expect(
    await page.locator('canvas.dots:visible').evaluateAll((els) =>
      els.every((el) => {
        if (!(el instanceof HTMLCanvasElement)) return false;
        const ctx = el.getContext('2d');
        const s = ctx?.getImageData(0, 0, el.width, el.height).data.reduce((a, n) => a + n, 0) ?? 0;
        return el.width === Number(el.dataset.cols) * 7 * Math.min(2, devicePixelRatio) && s > 0;
      }),
    ),
  ).toBe(true);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the phone has no aura', async ({ page }) => {
    await open(page);
    await expect(page.locator('.lower [class="fragment"]')).toHaveCount(0);
    await expect(page.locator('canvas.dots:visible')).toHaveCount(0);
    await expect(page.locator('.stop:visible')).toHaveCount(0);
    await expect(page.locator('.rail')).toBeHidden();
  });
});

test('the wide tier carries a trace in every section', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  for (const sel of ['.s02', '.s03', '.s04']) {
    const texts = await page
      .locator(`${sel} [class="fragment"]`)
      .evaluateAll((els) => els.map((el) => el.textContent ?? ''));
    expect(texts.filter((t) => t.startsWith('· ·')).length, sel).toBeGreaterThanOrEqual(1);
  }
});

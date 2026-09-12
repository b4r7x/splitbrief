import { expect, type Page, test } from '@playwright/test';

const clockStart = new Date('2026-09-08T12:00:00Z');
// One streak block of the edge model (dots.ts BLOCK = 24 rows of 11px): a rim column lights at
// most one streak per block; between streaks the rim's grain keeps every 40 px band beside a
// section seam lit.
const WINDOW = 264;
const BAND = 40;
const END_PAD = 16;

type Box = { left: number; top: number; right: number; bottom: number };

async function open(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart.getTime() + 60_000);
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.locator('.backdrop .field').first().waitFor({ state: 'attached' });
}

// Entrances finish, loops rest at their origin: the placer measured the page this way.
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.timeline !== document.timeline) continue;
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === 'number' && Number.isFinite(end)) {
        animation.finish();
        continue;
      }
      animation.pause();
      animation.currentTime = 0;
    }
  });
}

function seamsOf(page: Page): Promise<{ seams: number[]; end: number }> {
  return page.evaluate(() => ({
    seams: [...document.querySelectorAll('.lower section, .foot')].map(
      (el) => el.getBoundingClientRect().top + scrollY,
    ),
    end: document.documentElement.scrollHeight,
  }));
}

function inkOf(page: Page): Promise<{ fragments: (Box & { text: string })[]; cells: Box[] }> {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left + scrollX,
        top: r.top + scrollY,
        right: r.right + scrollX,
        bottom: r.bottom + scrollY,
      };
    };
    return {
      fragments: [...document.querySelectorAll<HTMLElement>('.backdrop .fragment')].map((el) => ({
        ...box(el),
        text: el.textContent ?? '',
      })),
      cells: [...document.querySelectorAll('.backdrop .field span')].map(box),
    };
  });
}

function keepClearOf(page: Page): Promise<(Box & { what: string })[]> {
  return page.evaluate(() => {
    const box = (r: DOMRect, what: string): Box & { what: string } => ({
      left: r.left + scrollX,
      top: r.top + scrollY,
      right: r.right + scrollX,
      bottom: r.bottom + scrollY,
      what,
    });
    const out: (Box & { what: string })[] = [];
    for (const root of document.querySelectorAll('main, footer')) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.parentElement?.closest('.backdrop, .ghost-fallback')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width > 0 && r.height > 0) {
            const grown = new DOMRect(r.x - 4, r.y - 4, r.width + 8, r.height + 8);
            out.push(box(grown, `text ${(node.textContent ?? '').trim().slice(0, 24)}`));
          }
        }
      }
    }
    const marks =
      '.panel, .tree, .marg, .marg-list, .brief, .label, .seat, canvas, .route, .cross, .cta';
    for (const el of document.querySelectorAll(marks)) {
      out.push(box(el.getBoundingClientRect(), `mark ${el.className}`));
    }
    const nav = document.querySelector('.nav')?.getBoundingClientRect();
    if (nav)
      out.push({ left: 0, top: 0, right: innerWidth, bottom: nav.bottom + scrollY, what: 'nav' });
    return out;
  });
}

function hits(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

test('one backdrop lies behind the whole page and no section carries its own', async ({ page }) => {
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
  ] as const) {
    await open(page, width, height);
    await expect(page.locator('.backdrop')).toHaveCount(1);
    await expect(page.locator('.aura, canvas.dots, .rail, .stop')).toHaveCount(0);
    const size = await page.evaluate(() => ({
      layer: document.querySelector('.backdrop')?.getBoundingClientRect().height ?? 0,
      document: document.documentElement.scrollHeight,
    }));
    expect(Math.abs(size.layer - size.document), `${width}`).toBeLessThanOrEqual(1);
    const { seams, end } = await seamsOf(page);
    const fields = await page.locator('.backdrop .field').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left };
      }),
    );
    for (const y of seams) {
      const reach = Math.min(y + WINDOW, end - END_PAD);
      const crossing = fields.filter((f) => f.top <= y - WINDOW && f.bottom >= reach);
      expect(crossing.length, `${width}: fields crossing the seam at ${y}`).toBe(2);
      expect(Math.min(...crossing.map((f) => f.left))).toBeLessThan(width / 2);
      expect(Math.max(...crossing.map((f) => f.left))).toBeGreaterThan(width / 2);
    }
  }
});

test('the ink is continuous through every seam', async ({ page }) => {
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
  ] as const) {
    await open(page, width, height);
    const { seams, end } = await seamsOf(page);
    const edges = await page.locator('.backdrop .field').evaluateAll(
      (els, window) =>
        els
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              top: r.top + scrollY,
              height: r.height,
              cols: Number(el.dataset.cols),
              cells: [...el.querySelectorAll('span')].map((span) => ({
                y: r.top + scrollY + Number.parseFloat(span.style.top),
                alpha: Number.parseFloat(span.style.opacity),
              })),
            };
          })
          .filter((f) => f.height > 4 * window),
      WINDOW,
    );
    for (const y of seams) {
      const side = (from: number, to: number): { share: number; alpha: number; lit: number } => {
        let lit = 0;
        let present = 0;
        let alpha = 0;
        for (const field of edges) {
          if (field.top > from || field.top + field.height < to) continue;
          present += field.cols * ((to - from) / 11);
          for (const cell of field.cells) {
            if (cell.y < from || cell.y >= to) continue;
            lit++;
            alpha += cell.alpha;
          }
        }
        return { share: lit / present, alpha: lit ? alpha / lit : 0, lit };
      };
      // Sampled cells are too sparse for a tight band statistic (dots.test.ts proves the model has
      // no step); here: the same two edge fields carry ink into both sides of every seam. Under
      // the footer only a few rows of the faded field end remain, so there the fields must reach
      // the page end instead of carrying a lit cell.
      const above = side(y - WINDOW, y);
      const below = side(y, Math.min(y + WINDOW, end - END_PAD));
      const label = `${width}: seam at ${y}`;
      expect(above.lit, label).toBeGreaterThan(0);
      expect(above.alpha, label).toBeGreaterThan(0.3);
      if (y === seams.at(-1)) {
        expect(edges.length, label).toBeGreaterThanOrEqual(2);
        for (const field of edges)
          expect(field.top + field.height, label).toBeGreaterThanOrEqual(end - END_PAD - 2);
        continue;
      }
      expect(below.lit, label).toBeGreaterThan(0);
      expect(below.alpha, label).toBeGreaterThan(0.3);
      expect(side(y - BAND, y).lit, `${label}, ${BAND}px above`).toBeGreaterThan(0);
      expect(side(y, y + BAND).lit, `${label}, ${BAND}px below`).toBeGreaterThan(0);
    }
  }
});

test('nothing in the backdrop lands on text, marks or the diagram', async ({ page }) => {
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
    [1024, 900],
    [768, 900],
  ] as const) {
    await open(page, width, height);
    await settle(page);
    const clear = await keepClearOf(page);
    const { fragments, cells } = await inkOf(page);
    expect(fragments.length + cells.length).toBeGreaterThan(0);
    const ink = [...fragments, ...cells.map((rect) => ({ ...rect, text: '·' }))];
    const collisions = ink.flatMap((mark) =>
      clear.filter((other) => hits(mark, other)).map((other) => ({ mark, other })),
    );
    expect(collisions, `${width}`).toEqual([]);
  }
});

test('the backdrop drifts slowly, pauses in a hidden tab and stands still under reduced motion', async ({
  page,
}) => {
  await open(page, 1920, 1080);
  const alphas = (): Promise<string[]> =>
    page.locator('.backdrop .field span').evaluateAll((els) => els.map((el) => el.style.opacity));
  const rest = await alphas();
  await page.clock.runFor(2000);
  const drifted = await alphas();
  const changed = drifted.filter((a, i) => a !== rest[i]).length / rest.length;
  expect(changed).toBeGreaterThan(0.01);
  expect(changed).toBeLessThanOrEqual(0.1);
  const whispers = await page
    .locator('.backdrop .fragment')
    .evaluateAll((els) =>
      els.map((el) => el.getAnimations().map((a) => a.effect?.getComputedTiming().duration)),
    );
  for (const [duration] of whispers) expect(Number(duration)).toBeGreaterThanOrEqual(14_000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = await alphas();
  await page.clock.runFor(3000);
  expect(await alphas()).toEqual(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(3000);
  expect(await alphas()).not.toEqual(hidden);
  const composition = await page
    .locator('.backdrop .field span')
    .evaluateAll((els) => els.map((el) => `${el.style.left},${el.style.top}`));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.locator('.backdrop .field').first().waitFor({ state: 'attached' });
  expect(
    await page
      .locator('.backdrop .field span')
      .evaluateAll((els) => els.map((el) => `${el.style.left},${el.style.top}`)),
  ).toEqual(composition);
  expect(
    await page.evaluate(
      () => document.querySelector('.backdrop')?.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  const still = await alphas();
  await page.clock.runFor(4000);
  expect(await alphas()).toEqual(still);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the phone has no backdrop', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(page.locator('.backdrop')).toBeHidden();
    await expect(page.locator('.backdrop *')).toHaveCount(0);
  });
});

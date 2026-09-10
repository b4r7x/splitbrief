import { expect, type Page, test } from '@playwright/test';

const clockStart = new Date('2026-09-08T12:00:00Z');

async function open(page: Page): Promise<void> {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart.getTime() + 60_000);
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function settle(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = await page.evaluate(() => innerHeight);
  for (let y = step; y <= height; y += step) {
    await page.evaluate((top) => scrollTo(0, top), y);
    await page.clock.runFor(50);
    await page.waitForTimeout(50);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.clock.runFor(50);
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.timeline !== document.timeline) continue;
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === 'number' && Number.isFinite(end)) {
        animation.finish();
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        if (animation instanceof CSSAnimation && target instanceof HTMLElement)
          target.style.animation = 'none';
        continue;
      }
      animation.cancel();
    }
  });
}

type Layout = {
  height: number;
  grids: string[];
  reveals: number;
  lines: string[];
};

async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const rect = (r: DOMRect) =>
      `${round(r.left)},${round(r.top + scrollY)},${round(r.width)},${round(r.height)}`;
    const grids = [...document.querySelectorAll('.grid')];
    const lines: string[] = [];
    for (const grid of grids) {
      const walker = document.createTreeWalker(grid, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects())
          if (r.width > 0 && r.height > 0) lines.push(rect(r));
      }
    }
    return {
      height: document.documentElement.scrollHeight,
      grids: grids.map((el) => rect(el.getBoundingClientRect())),
      reveals: document.querySelectorAll('.reveal').length,
      lines,
    };
  });
}

test('sections reveal once', async ({ page }) => {
  await open(page);
  await expect(page.locator('.s03')).not.toHaveClass(/is-in/);
  await expect(page.locator('.s03 .lines li').first()).toHaveCSS('opacity', '0');
  const top = await page.locator('.s03').evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => scrollTo(0, y), top);
  await page.waitForTimeout(100);
  await page.clock.runFor(3000);
  await page.evaluate(() => {
    const section = document.querySelector('.s03');
    if (section === null) return;
    for (const animation of section.getAnimations({ subtree: true })) {
      if (animation.timeline !== document.timeline) continue;
      animation.pause();
      animation.currentTime = 3000;
    }
  });
  await page.waitForTimeout(100);
  await expect(page.locator('.s03')).toHaveClass(/is-in/);
  expect(
    await page
      .locator('.s03 .lines li')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).opacity === '1')),
  ).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('.s03')).toHaveClass(/is-in/);
  expect(
    await page
      .locator('.s03 .lines li')
      .evaluateAll((els) => els.every((el) => getComputedStyle(el).opacity === '1')),
  ).toBe(true);
});

test('the spark rides the rail', async ({ page }) => {
  let armed = false;
  for (const [width, height, ys] of [
    [1440, 900, [617, 94, 444, 807]],
    [1920, 1080, [642, 139, 502, 987]],
  ] as const) {
    await page.setViewportSize({ width, height });
    if (armed) {
      await page.goto('/');
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
    } else {
      await open(page);
      armed = true;
    }
    const supported = await page.evaluate(() => CSS.supports('animation-timeline: view()'));
    expect(await page.locator('.spark').evaluate((el) => getComputedStyle(el).display)).toBe(
      supported ? 'block' : 'none',
    );
    const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    const samples: [number, number][] = [
      [0.25, ys[0]],
      [0.5, ys[1]],
      [0.75, ys[2]],
      [1, ys[3]],
    ];
    for (const [p, want] of samples) {
      await page.evaluate((y) => scrollTo(0, y), p * max);
      await page.waitForTimeout(100);
      const got = await page.locator('.spark').evaluate((el) => el.getBoundingClientRect().top);
      expect(Math.abs(got - want)).toBeLessThanOrEqual(height * 0.03);
    }
  }
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('reduced motion is the final frame', async ({ page }) => {
    await open(page);
    expect(
      await page.evaluate(() => {
        const lower = document.querySelector('.lower');
        return lower ? lower.getAnimations({ subtree: true }).length : -1;
      }),
    ).toBe(0);
    const clip = await page.locator('.lower').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    });
    const first = await page.screenshot({ fullPage: true, clip });
    await page.clock.runFor(4000);
    expect((await page.screenshot({ fullPage: true, clip })).equals(first)).toBe(true);
    await expect(page.locator('.spark')).toBeHidden();
    expect(
      await page
        .locator('.reveal')
        .evaluateAll((els) => els.every((el) => getComputedStyle(el).opacity === '1')),
    ).toBe(true);
    await expect(page.locator('.is-in')).toHaveCount(0);
  });

  test('reduced motion equals the settled page', async ({ page }) => {
    await open(page);
    const before = await layout(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await settle(page);
    const after = await layout(page);
    expect(after).toEqual(before);
  });
});

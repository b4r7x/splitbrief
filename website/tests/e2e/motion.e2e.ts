import { expect, type Locator, type Page, test } from '@playwright/test';

const clockStart = new Date('2026-09-08T12:00:00Z');

// install() leaves the fake clock running, so the rAF-driven ghosts would keep advancing in real
// time between a runFor and the capture that follows it; paused one step ahead of the install time
// (pausing at that instant races the clock's own tick), every tick happens inside runFor.
async function open(page: Page): Promise<void> {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart.getTime() + 60_000);
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function seek(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = t;
    }
  }, ms);
}

async function box(
  locator: Locator,
): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${locator} has no box`);
  return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
}

function intersects(
  a: Awaited<ReturnType<typeof box>>,
  b: Awaited<ReturnType<typeof box>>,
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the diagram holds frame 0 and hides the packets', async ({ page }) => {
    await open(page);
    const diagram = page.locator('.diagram');
    const first = await diagram.screenshot();
    await page.clock.runFor(4000);
    expect(await diagram.screenshot()).toEqual(first);
    await expect(page.locator('.packet--impl')).toBeHidden();
    await expect(page.locator('.packet--rev')).toBeHidden();
  });
});

test('the ghosts breathe', async ({ page }) => {
  await open(page);
  const diagram = page.locator('.diagram');
  const first = await diagram.screenshot();
  await page.clock.runFor(4000);
  expect(await diagram.screenshot()).not.toEqual(first);
});

test('the implementer packet rides route B at 2.0 s', async ({ page }) => {
  await open(page);
  await seek(page, 2000);
  const packet = await box(page.locator('.packet--impl'));
  const route = await box(page.locator('.route-lines--wide .route--b'));
  expect(intersects(packet, route)).toBe(true);
  expect(packet.left).toBeGreaterThan(route.left);
  expect(packet.right).toBeLessThan(route.right);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the implementer packet rides the vertical route B at 2.0 s', async ({ page }) => {
    await open(page);
    await seek(page, 2000);
    const packet = await box(page.locator('.packet--impl'));
    const route = await box(page.locator('.route-lines--compact .route--b'));
    expect(intersects(packet, route)).toBe(true);
    expect(packet.top).toBeGreaterThan(route.top);
    expect(packet.bottom).toBeLessThan(route.bottom);
    expect(Math.abs(packet.left + packet.right - route.left - route.right)).toBeLessThan(1);
  });

  test('the phone hero carries no fragments', async ({ page }) => {
    await open(page);
    await expect(page.locator('.fragment')).toHaveCount(0);
  });
});

test('fragments never cross the header band, headline, lede or CTA', async ({ page }) => {
  await open(page);
  const fragments = page.locator('.fragment');
  await expect(fragments).toHaveCount(19);
  const header = await box(page.locator('.nav'));
  const band = { ...header, left: 0, right: 1440 };
  const keepClear = [
    band,
    ...(await Promise.all(['h1', '.lede', '.cta'].map((s) => box(page.locator(s))))),
  ];
  for (const ms of [0, 10_000, 20_000, 30_000]) {
    await seek(page, ms);
    for (const fragment of await fragments.all()) {
      const rect = await box(fragment);
      for (const clear of keepClear) expect(intersects(rect, clear), `${ms}ms`).toBe(false);
    }
  }
});

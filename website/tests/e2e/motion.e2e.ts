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
      if (animation.timeline !== document.timeline) continue;
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
    expect((await diagram.screenshot()).equals(first)).toBe(true);
    await expect(page.locator('.packet--impl')).toBeHidden();
    await expect(page.locator('.packet--rev')).toBeHidden();
  });
});

test('the ghosts breathe', async ({ page }) => {
  await open(page);
  const diagram = page.locator('.diagram');
  const first = await diagram.screenshot();
  await page.clock.runFor(4000);
  expect((await diagram.screenshot()).equals(first)).toBe(false);
});

// Route B is the last leg of the implementer's ride; 1.8 s is its middle (H05: the routes now
// stop at the 162px card's edges, so the ride is shorter than with the 108px card).
test('the implementer packet rides route B at 1.8 s', async ({ page }) => {
  await open(page);
  await seek(page, 1800);
  const packet = await box(page.locator('.packet--impl'));
  const route = await box(page.locator('.route-lines--wide .route--b'));
  expect(intersects(packet, route)).toBe(true);
  expect(packet.left).toBeGreaterThan(route.left);
  expect(packet.right).toBeLessThan(route.right);
});

function centre(rect: Awaited<ReturnType<typeof box>>): { x: number; y: number } {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

test('the triangle keeps its shape and nothing rides through a label', async ({ page }) => {
  await open(page);
  const at = async (selector: string): Promise<{ x: number; y: number }> =>
    centre(await box(page.locator(selector)));
  const planner = await at('.ghost--planner');
  const implementer = await at('.ghost--implementer');
  const reviewer = await at('.ghost--reviewer');
  const across = implementer.x - planner.x;
  const down = reviewer.y - planner.y;
  expect(down / across).toBeGreaterThan(0.9);
  expect(down / across).toBeLessThan(1.1);
  const labels = await Promise.all(
    ['.label--planner', '.label--implementer', '.label--reviewer'].map((s) => box(page.locator(s))),
  );
  const clearOfLabels = async (locator: Locator, when: string): Promise<void> => {
    const rect = await box(locator);
    for (const label of labels) expect(intersects(rect, label), when).toBe(false);
  };
  for (const route of await page.locator('.route-lines--wide .route').all()) {
    await clearOfLabels(route, 'route');
  }
  // The packets overshoot the drawn routes by 8 px at both ends; one ride period is under 8 s.
  for (let ms = 0; ms <= 8000; ms += 250) {
    await seek(page, ms);
    await clearOfLabels(page.locator('.packet--impl'), `implementer packet at ${ms}ms`);
    await clearOfLabels(page.locator('.packet--rev'), `reviewer packet at ${ms}ms`);
  }
});

// H08: the bracket under the top pair is drawn in the routes' own ink, and every route ends in
// an arrowhead — into the card from the planner, into the implementer and the reviewer from it.
test("the bracket carries the routes' ink and every route ends in an arrowhead", async ({
  page,
}) => {
  await open(page);
  const stroke = (selector: string): Promise<string> =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).stroke);
  expect(await stroke('.route-lines--wide .branch')).toBe(
    await stroke('.route-lines--wide .route--a'),
  );
  for (const route of ['a', 'b', 'c']) {
    const marker = await page
      .locator(`.route-lines--wide .route--${route}`)
      .evaluate((el) => getComputedStyle(el).markerEnd);
    expect(marker, route).toContain('route-arrow');
  }
  await expect(page.locator('.route-lines--wide marker path')).toHaveCount(1);
});

// One packet at a time: plan → card → implementer, a pause for the implementer's answer, then the
// review packet; the answer is a ripple — the tick lights first, the seat list lifts 150 ms later.
test('the contract hands off in order and the implementer answers before the review leaves', async ({
  page,
}) => {
  await open(page);
  const opacity = async (selector: string): Promise<number> =>
    Number(await page.locator(selector).evaluate((el) => getComputedStyle(el).opacity));
  const shown: { t: number; impl: boolean; rev: boolean }[] = [];
  for (let t = 0; t <= 8000; t += 50) {
    await seek(page, t);
    shown.push({
      t,
      impl: (await opacity('.packet--impl')) > 0.05,
      rev: (await opacity('.packet--rev')) > 0.05,
    });
  }
  expect(shown.some((s) => s.impl && s.rev)).toBe(false);
  const revFirst = shown.find((s) => s.rev)?.t;
  if (revFirst === undefined) throw new Error('the review packet never showed');
  const implLast = shown.filter((s) => s.impl && s.t < revFirst).at(-1)?.t;
  if (implLast === undefined) throw new Error('the brief never showed before the review');
  expect(revFirst - implLast).toBeGreaterThanOrEqual(1000);
  expect(shown.some((s) => s.impl && s.t > revFirst)).toBe(true);
  const landing = implLast - 120;
  const colour = async (selector: string, prop: 'color' | 'backgroundColor'): Promise<number> =>
    page.locator(selector).evaluate((el, name) => {
      const value = getComputedStyle(el)[name];
      return (value.match(/\d+/g) ?? []).slice(0, 3).reduce((sum, n) => sum + Number(n), 0) / 3;
    }, prop);
  await seek(page, landing + 100);
  const tickLit = await colour('.tick--implementer', 'backgroundColor');
  const seatEarly = await colour('.seat--implementer', 'color');
  await seek(page, landing + 350);
  const seatLate = await colour('.seat--implementer', 'color');
  await seek(page, landing - 200);
  const tickRest = await colour('.tick--implementer', 'backgroundColor');
  expect(tickLit).toBeGreaterThan(tickRest + 60);
  expect(seatLate).toBeGreaterThan(seatEarly + 20);
});

test('a live reduced-motion change stops and restarts the cycle', async ({ page }) => {
  await open(page);
  await page.clock.runFor(500);
  expect(
    await page.locator('.stage').evaluate((el) => el.getAnimations({ subtree: true }).length),
  ).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(50);
  expect(
    await page.locator('.stage').evaluate((el) => el.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await expect(page.locator('.packet--impl')).toBeHidden();
  const still = await page.locator('.diagram').screenshot();
  await page.clock.runFor(2000);
  expect((await page.locator('.diagram').screenshot()).equals(still)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(50);
  expect(
    await page.locator('.stage').evaluate((el) => el.getAnimations({ subtree: true }).length),
  ).toBeGreaterThan(0);
});

test.describe('on FHD', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  // Object centres of references/reference-v2.png normalised to its hero frame
  // (results/H04/attempt-01/target-landmarks.json); 2pp of the frame is the sprint tolerance.
  const reference = {
    '.ghost--planner': { x: 0.546, y: 0.365 },
    '.ghost--implementer': { x: 0.783, y: 0.366 },
    '.brief': { x: 0.663, y: 0.453 },
    '.ghost--reviewer': { x: 0.657, y: 0.765 },
  };

  test('the triangle sits where the reference puts it', async ({ page }) => {
    await open(page);
    const hero = await box(page.locator('.hero'));
    for (const [selector, target] of Object.entries(reference)) {
      const actual = centre(await box(page.locator(selector)));
      expect(Math.abs(actual.x / 1920 - target.x), `${selector} x`).toBeLessThan(0.02);
      expect(Math.abs(actual.y / hero.bottom - target.y), `${selector} y`).toBeLessThan(0.02);
    }
  });
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

test('the hero whispers never cross the header band, headline ink, lede or CTA', async ({
  page,
}) => {
  await open(page);
  const fragments = page.locator('.backdrop .fragment');
  // X01: the reference's eight hero whispers, each beside the object it annotates; at 1440 the
  // strip under the nav holds two of its three.
  expect(await fragments.count()).toBeGreaterThanOrEqual(7);
  const header = await box(page.locator('.nav'));
  const band = { ...header, left: 0, right: 1440 };
  // The headline counts by its ink, line by line: the reference tucks 'understands / the big
  // picture' beside its short lines, inside the headline's column.
  const headline = await page.locator('.hero h1 .line').evaluateAll((els) =>
    els.map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  );
  const keepClear = [
    band,
    ...headline,
    ...(await Promise.all(['.lede', '.cta'].map((s) => box(page.locator(s))))),
  ];
  for (const ms of [0, 10_000, 20_000, 30_000]) {
    await seek(page, ms);
    for (const fragment of await fragments.all()) {
      const rect = await box(fragment);
      for (const clear of keepClear) expect(intersects(rect, clear), `${ms}ms`).toBe(false);
    }
  }
});

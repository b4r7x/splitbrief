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
      lines,
    };
  });
}

const GROUPS = '.lower .head, .lower .panel, .lower .tree, .lower .notes';

// The smooth scroll passes the sections above; the one landed on may be waiting its 660 ms turn
// behind the last of them, so the paused clock runs one choreography before the section is read.
async function enter(page: Page, selector: string): Promise<void> {
  const top = await page
    .locator(selector)
    .evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => scrollTo(0, y), top);
  await page.waitForTimeout(100);
  await page.clock.runFor(700);
  await expect(page.locator(selector)).toHaveClass(/is-in/);
}

async function timing(
  page: Page,
  selector: string,
): Promise<{ delay: number; duration: number; name: string }[]> {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      return {
        delay: Number.parseFloat(style.animationDelay) * 1000,
        duration: Number.parseFloat(style.animationDuration) * 1000,
        name: style.animationName,
      };
    }),
  );
}

test('the hero enters as two groups within 700 ms, a few pixels at most; the nav is there from the first frame', async ({
  page,
}) => {
  await open(page);
  expect(await page.locator('.nav').evaluate((el) => el.getAnimations().length)).toBe(0);
  const entrances = await page.locator('.hero > *').evaluateAll((els) =>
    els.flatMap((el) =>
      el.getAnimations().map((animation) => {
        const timing = animation.effect?.getComputedTiming();
        const keyframe =
          animation.effect instanceof KeyframeEffect
            ? animation.effect.getKeyframes()[0]
            : undefined;
        return {
          delay: Number(timing?.delay),
          end: Number(timing?.endTime),
          easing: getComputedStyle(el).animationTimingFunction,
          translate: String(keyframe?.translate ?? ''),
        };
      }),
    ),
  );
  expect(entrances.length).toBeGreaterThanOrEqual(8);
  expect(new Set(entrances.map((e) => e.delay)).size).toBeLessThanOrEqual(3);
  for (const e of entrances) {
    expect(e.end).toBeLessThanOrEqual(700);
    expect(e.easing).toBe('ease-out');
    const rise = Number.parseFloat(e.translate.split(' ')[1] ?? '0');
    expect(Math.abs(rise)).toBeLessThanOrEqual(12);
  }
  expect(
    await page
      .locator('.hero h1 .line')
      .evaluateAll((els) => els.flatMap((el) => el.getAnimations()).length),
  ).toBe(0);
});

test('a lower section enters as three groups, 120 ms apart, marginalia with the notes', async ({
  page,
}) => {
  await open(page);
  for (const [section, groups] of [
    ['.s02', ['.s02 .head', '.s02 .panel', '.s02 .notes']],
    ['.s04', ['.s04 .head', '.s04 .tree', '.s04 .notes']],
  ] as const) {
    await enter(page, section);
    const delays: number[] = [];
    for (const group of groups) {
      const members = await timing(page, group);
      expect(members.length, group).toBeGreaterThan(0);
      for (const m of members) {
        expect(m.name, group).toBe('enter');
        expect(m.duration, group).toBeGreaterThanOrEqual(360);
        expect(m.duration, group).toBeLessThanOrEqual(480);
        expect(m.delay, group).toBe(members[0]?.delay);
      }
      delays.push(members[0]?.delay ?? Number.NaN);
    }
    expect(delays[0]).toBe(0);
    for (let i = 1; i < delays.length; i++) {
      const gap = (delays[i] ?? 0) - (delays[i - 1] ?? 0);
      expect(gap, `${section} group ${i}`).toBeGreaterThanOrEqual(90);
      expect(gap, `${section} group ${i}`).toBeLessThanOrEqual(140);
    }
  }
  for (const m of await timing(page, '.s02 .lines li, .s04 .tree .row'))
    expect(m.name).toBe('none');
});

// X02: at 1440 (and 1920) BRIEFS and VALIDATION share the first lower fold; the second waits for
// the first section's choreography (2 × 120 + 420 ms) instead of entering at the same instant.
test('two sections sharing a fold enter one after the other', async ({ page }) => {
  await open(page);
  const top = await page.locator('.s02').evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => scrollTo(0, y), top);
  await page.waitForTimeout(100);
  await expect(page.locator('.s02')).toHaveClass(/is-in/);
  await expect(page.locator('.s03')).not.toHaveClass(/is-in/);
  await page.clock.runFor(600);
  await expect(page.locator('.s03')).not.toHaveClass(/is-in/);
  await page.clock.runFor(100);
  await expect(page.locator('.s03')).toHaveClass(/is-in/);
});

test('the terminal keeps its two beats and the editor appears whole', async ({ page }) => {
  await open(page);
  await enter(page, '.s03');
  const at = async (ms: number): Promise<string[]> => {
    await page.evaluate((t) => {
      const section = document.querySelector('.s03');
      if (section === null) return;
      for (const animation of section.getAnimations({ subtree: true })) {
        if (animation.timeline !== document.timeline) continue;
        animation.pause();
        animation.currentTime = t;
      }
    }, ms);
    return page
      .locator('.s03 .lines li')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity));
  };
  const early = await at(700);
  expect(early.slice(0, 12).every((o) => o === '1')).toBe(true);
  expect(early.slice(12).every((o) => o === '0')).toBe(true);
  expect(await page.locator('.s03 .panel').evaluate((el) => getComputedStyle(el).opacity)).toBe(
    '1',
  );
  const late = await at(2500);
  expect(late.every((o) => o === '1')).toBe(true);
});

test('anchors land on their section and scrolling back leaves it in place', async ({ page }) => {
  await open(page);
  await page.addStyleTag({ content: 'html { scroll-behavior: auto !important; }' });
  await page.locator('.hero .steps a[href="#validation"]').click();
  await page.waitForTimeout(150);
  // The page ends 04 + footer after VALIDATION; when that is shorter than the viewport the anchor
  // lands as far down as the page scrolls.
  const { top, reach } = await page.locator('.s03').evaluate((el) => ({
    top: el.getBoundingClientRect().top,
    reach: Math.max(
      0,
      el.getBoundingClientRect().top +
        scrollY -
        (document.documentElement.scrollHeight - innerHeight),
    ),
  }));
  expect(Math.abs(top - reach)).toBeLessThanOrEqual(2);
  await expect(page.locator('.s03')).toHaveClass(/is-in/);
  await page.clock.runFor(2500);
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(100);
  await expect(page.locator('.s03')).toHaveClass(/is-in/);
  expect(await page.locator('.s03 .notes').evaluate((el) => getComputedStyle(el).opacity)).toBe(
    '1',
  );
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('every group is visible at once', async ({ page }) => {
    await page.goto('/');
    expect(
      await page
        .locator(GROUPS)
        .evaluateAll((els) => els.every((el) => getComputedStyle(el).opacity === '1')),
    ).toBe(true);
    expect(
      await page
        .locator('.s03 .lines li')
        .evaluateAll((els) => els.every((el) => getComputedStyle(el).opacity === '1')),
    ).toBe(true);
    await expect(page.locator('.backdrop')).toHaveCount(0);
  });
});

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
    expect(
      await page
        .locator(GROUPS)
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

import { writeFileSync } from 'node:fs';
import { type Page, test } from '@playwright/test';

const shot = { dir: process.env.SHOT_DIR ?? '', tag: process.env.SHOT_TAG ?? '' };
const time = Number(process.env.SHOT_TIME_MS ?? 4000);
const clockStart = new Date('2026-09-08T12:00:00Z');

test.skip(shot.dir === '' || shot.tag === '', 'set SHOT_DIR and SHOT_TAG to capture');

// install() leaves the fake clock running, so the rAF-driven ghosts and the fragment re-placement
// would keep advancing in real time after runFor; paused one step ahead of the install time
// (pausing at that instant races the clock's own tick), every tick happens inside runFor.
async function settle(page: Page): Promise<void> {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart.getTime() + 60_000);
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = await page.evaluate(() => innerHeight);
  for (let y = step; y <= height; y += step) {
    await page.evaluate((y) => scrollTo(0, y), y);
    await page.clock.runFor(50);
    await page.waitForTimeout(50);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.clock.runFor(50);
  await page.waitForTimeout(50);
  await page.clock.runFor(time);
  // A full-page capture flips the width tiers in passing, which restarts the CSS entrance of any
  // element a tier hides; finished, an entrance paints as its base style, so drop it from the cascade.
  await page.evaluate((t) => {
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
      animation.pause();
      animation.currentTime = t;
    }
  }, time);
}

function target(name: string): string {
  return `${shot.dir}/${shot.tag}-${name}.png`;
}

test('1440 full page', async ({ page }) => {
  await settle(page);
  await page.screenshot({ path: target('1440'), fullPage: true });
});

test('1440 fold', async ({ page }) => {
  await settle(page);
  await page.screenshot({ path: target('fold') });
});

test('390 full page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.screenshot({ path: target('390'), fullPage: true });
});

test('1920 full page', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await settle(page);
  await page.screenshot({ path: target('1920'), fullPage: true });
});

test('1920 fold', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await settle(page);
  await page.screenshot({ path: target('1920-fold') });
});

test('1024 full page', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await settle(page);
  await page.screenshot({ path: target('1024'), fullPage: true });
});

test('768 full page', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await settle(page);
  await page.screenshot({ path: target('768'), fullPage: true });
});

test('1920 section folds', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await settle(page);
  for (const fold of [
    { sel: '.s02', name: '1920-s02' },
    { sel: '.s03', name: '1920-s03' },
    { sel: '.s04', name: '1920-s04' },
  ]) {
    if ((await page.locator(fold.sel).count()) === 0) continue;
    const top = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().top + scrollY : 0;
    }, fold.sel);
    await page.evaluate(
      (y) => scrollTo(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)),
      top,
    );
    await page.clock.runFor(50);
    await page.screenshot({ path: target(fold.name) });
  }
});

test('hero boxes', async ({ page }) => {
  const selectors = [
    '.nav',
    '.nav .wordmark',
    '.tagline',
    '.nav .links',
    '.nav .mark',
    '.hero',
    '.hero .steps',
    '.draft-mark',
    '.hero .claim',
    '.hero h1',
    '.hero h1 .line',
    '.lede',
    '.cta',
    '.works',
    '.diagram',
    '.stage',
    '.stage canvas',
    '.stage .tick',
    '.stage .label',
    '.stage .seat',
    '.brief',
    '.cross',
    '.route-lines--wide',
  ];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await settle(page);
    const list = await page.evaluate((SELECTORS) => {
      return SELECTORS.flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((element, index) => {
          const r = element.getBoundingClientRect();
          const round = (v: number): number => Math.round(v * 10) / 10;
          return {
            selector,
            index,
            x: round(r.x),
            y: round(r.y),
            w: round(r.width),
            h: round(r.height),
          };
        }),
      );
    }, selectors);
    writeFileSync(
      `${shot.dir}/${shot.tag}-hero-${viewport.width}.json`,
      JSON.stringify(list, null, 1),
    );
  }
});

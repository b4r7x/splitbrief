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
  await page.clock.runFor(time);
  // A full-page capture flips the width tiers in passing, which restarts the CSS entrance of any
  // element a tier hides; finished, an entrance paints as its base style, so drop it from the cascade.
  await page.evaluate((t) => {
    for (const animation of document.getAnimations()) {
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

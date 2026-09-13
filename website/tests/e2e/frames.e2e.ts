import { test } from '@playwright/test';

const shot = { dir: process.env.SHOT_DIR ?? '', tag: process.env.SHOT_TAG ?? '' };
const clockStart = new Date('2026-09-08T12:00:00Z');

test.skip(shot.dir === '' || shot.tag === '', 'set SHOT_DIR and SHOT_TAG to capture');

function target(name: string): string {
  return `${shot.dir}/${shot.tag}-${name}.png`;
}

test('transcript frames', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart.getTime() + 60_000);
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.evaluate(() => {
    const el = document.querySelector('.s03');
    if (el instanceof HTMLElement)
      scrollTo({ top: el.getBoundingClientRect().top + scrollY, behavior: 'instant' });
  });
  await page.waitForTimeout(100);
  for (const ms of [500, 1200, 2400]) {
    await page.evaluate((t) => {
      const root = document.querySelector('.s03');
      if (root === null) return;
      for (const animation of root.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = t;
      }
    }, ms);
    await page.screenshot({ path: target(`s03-${ms}`) });
  }
});

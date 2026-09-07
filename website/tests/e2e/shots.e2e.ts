import { type Page, test } from '@playwright/test';

const shot = { dir: process.env.SHOT_DIR ?? '', tag: process.env.SHOT_TAG ?? '' };
const time = Number(process.env.SHOT_TIME_MS ?? 4000);

test.skip(shot.dir === '' || shot.tag === '', 'set SHOT_DIR and SHOT_TAG to capture');

async function settle(page: Page): Promise<void> {
  await page.clock.install();
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.clock.runFor(time);
  await page.evaluate((t) => {
    for (const animation of document.getAnimations()) {
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === 'number' && Number.isFinite(end)) {
        animation.finish();
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

import { expect, test } from '@playwright/test';
import {
  canvasImage,
  clickInPlace,
  openPage,
  scrollScene,
  settleCanvas,
  settleScenes,
} from './browser.js';

test('settled content and artwork stay untouched without scrolling', async ({ page }) => {
  for (const path of ['/', '/#roles', '/docs/getting-started/']) {
    await openPage(page, path);
    await page.waitForTimeout(800);
    await settleScenes(page);
    const before = await canvasImage(page);
    const mutations = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let count = 0;
          const observer = new MutationObserver((records) => {
            count += records.length;
          });
          for (const scene of document.querySelectorAll(
            '[data-scroll-track], [data-continuation], .docs-article',
          )) {
            observer.observe(scene, {
              attributes: true,
              childList: true,
              characterData: true,
              subtree: true,
            });
          }
          setTimeout(() => {
            count += observer.takeRecords().length;
            observer.disconnect();
            resolve(count);
          }, 400);
        }),
    );
    expect(mutations, path).toBe(0);
    expect(await canvasImage(page), path).toBe(before);
  }
});

test('background drift follows pause, reduced motion and visibility throughout the page', async ({
  page,
}) => {
  await openPage(page);
  const background = page.locator('.atmosphere');
  const fragments = background.locator('.ascii-drift');
  const positions = () =>
    fragments.evaluateAll(async (elements) => {
      await Promise.all(
        elements.flatMap((element) => element.getAnimations()).map((animation) => animation.ready),
      );
      return elements.map((element) => getComputedStyle(element).transform);
    });
  await expect(background).toHaveAttribute('aria-hidden', 'true');
  await expect(fragments.first()).toBeInViewport();
  const moving = await positions();
  await expect.poll(positions).not.toEqual(moving);

  await clickInPlace(page, page.locator('.scene-controls').getByRole('button'));
  await expect(fragments.first()).toHaveCSS('animation-play-state', 'paused');
  const paused = await positions();
  await scrollScene(page, '#details', 0.15);
  expect(await positions()).toEqual(paused);
  await clickInPlace(page, page.locator('.details-controls').getByRole('button'));
  await expect.poll(positions).not.toEqual(paused);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.details-controls button')).toBeDisabled();
  const reduced = await positions();
  await page.waitForTimeout(250);
  expect(await positions()).toEqual(reduced);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(positions).not.toEqual(reduced);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(fragments.first()).toHaveCSS('animation-play-state', 'paused');
  const hidden = await positions();
  await page.waitForTimeout(250);
  expect(await positions()).toEqual(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(positions).not.toEqual(hidden);

  await page.locator('.page-footer').scrollIntoViewIfNeeded();
  await expect(fragments.first()).toBeInViewport();
  const footer = await positions();
  await expect.poll(positions).not.toEqual(footer);
});

test('the continuation mark transforms with its chapters and reverses to the same pose', async ({
  page,
}) => {
  await openPage(page, '/#roles');
  const poses: string[] = [];
  for (const progress of [0.15, 0.49, 0.82, 0.15]) {
    await scrollScene(page, '#details', progress);
    const pose = await canvasImage(page);
    await page.waitForTimeout(1200);
    expect(await canvasImage(page)).toBe(pose);
    poses.push(pose);
  }
  expect(new Set(poses.slice(0, 3)).size).toBe(3);
  expect(poses[3]).toBe(poses[0]);
});

test('scrolling changes the sculpture with background motion paused or running', async ({
  page,
}) => {
  await openPage(page);
  const first = await canvasImage(page);
  await page.waitForTimeout(350);
  expect(await canvasImage(page)).toBe(first);
  const pause = page.locator('.scene-controls').getByRole('button');
  await clickInPlace(page, pause);
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(100);
  const frozen = await canvasImage(page);
  await page.waitForTimeout(400);
  expect(await canvasImage(page)).toBe(frozen);
  await scrollScene(page, '[data-scroll-track]', 0.4);
  await settleScenes(page);
  expect(await canvasImage(page)).not.toBe(frozen);
  await expect(
    page.getByRole('heading', { name: 'One brief in. A scoped change out.' }),
  ).toBeInViewport();
  const moved = await canvasImage(page);
  await page.waitForTimeout(250);
  expect(await canvasImage(page)).toBe(moved);
  await clickInPlace(
    page,
    page.locator('.scene-controls').getByRole('button', { name: 'Resume motion' }),
  );
  await page.waitForTimeout(300);
  expect(await canvasImage(page)).toBe(moved);
});

test('live reduced-motion preferences leave both scenes operable and the sculpture still', async ({
  page,
}) => {
  await openPage(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.scene-controls button')).toHaveText('Motion reduced');
  await expect(page.locator('.scene-controls button')).toBeDisabled();
  await page.waitForTimeout(150);
  const frozen = await canvasImage(page);
  await page.waitForTimeout(300);
  expect(await canvasImage(page)).toBe(frozen);
  await clickInPlace(page, page.getByRole('button', { name: /Review Stronger tool/ }));
  await expect(
    page.getByRole('heading', { name: 'Bring the planner back to the diff.' }),
  ).toBeInViewport();
  await page.goto('/#install');
  await expect(page.locator('#install .is-decoding')).toHaveCount(0);
  await expect(page.locator('#start-command')).toBeInViewport();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.details-controls button')).toBeEnabled();
  const resumed = await canvasImage(page);
  await page.waitForTimeout(350);
  expect(await canvasImage(page)).toBe(resumed);
});

test('hiding and returning to a tab preserves the sculpture at the current scroll position', async ({
  page,
}) => {
  await openPage(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const frozen = await canvasImage(page);
  await page.waitForTimeout(400);
  expect(await canvasImage(page)).toBe(frozen);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(350);
  expect(await canvasImage(page)).toBe(frozen);
});

test('documentation art changes on scroll and stays fixed between gestures', async ({ page }) => {
  await openPage(page, '/docs/getting-started/');
  const poses: string[] = [];
  for (const progress of [0.15, 0.49, 0.82, 0.15]) {
    await page.evaluate((value) => {
      scrollTo({
        top: value * (document.documentElement.scrollHeight - innerHeight),
        behavior: 'instant',
      });
    }, progress);
    await page.waitForTimeout(1200);
    const pose = await canvasImage(page);
    await page.waitForTimeout(400);
    expect(await canvasImage(page)).toBe(pose);
    poses.push(pose);
  }
  expect(new Set(poses.slice(0, 3)).size).toBe(3);
  expect(poses[3]).toBe(poses[0]);
});

test('compact footers reveal the mark after the pinned text and hold it still', async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 414, height: 621 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await openPage(page);
    await page.goto('/#install');
    await expect(page.locator('#install')).toHaveAttribute('data-active', 'true');
    await settleCanvas(page);
    const region = page.locator('[data-footer-art-region]');
    await expect(region).not.toBeInViewport();
    const beforeFooter = await canvasImage(page);
    await page.locator('.page-footer').evaluate((footer) => {
      scrollBy({ top: footer.getBoundingClientRect().top - innerHeight - 1, behavior: 'instant' });
    });
    await expect(region).toBeInViewport({ ratio: 1 });
    expect(await canvasImage(page)).toBe(beforeFooter);
    await page.evaluate(() => scrollBy({ top: 50, behavior: 'instant' }));
    await expect.poll(() => canvasImage(page)).not.toBe(beforeFooter);
    const revealing = await canvasImage(page);
    await page.waitForTimeout(250);
    expect(await canvasImage(page)).toBe(revealing);
    await page.evaluate(() => scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await expect(region).toBeInViewport({ ratio: 1 });
    await expect.poll(() => canvasImage(page)).not.toBe(beforeFooter);
    const mark = await canvasImage(page);
    expect(mark).not.toBe(revealing);
    await page.waitForTimeout(250);
    expect(await canvasImage(page)).toBe(mark);
    const layout = await page.evaluate(() => {
      const art = document.querySelector('[data-footer-art-region]')?.getBoundingClientRect();
      const guide = document.querySelector('#install .text-link')?.getBoundingClientRect();
      const footer = document.querySelector('.page-footer')?.getBoundingClientRect();
      if (!art || !guide || !footer) throw new Error('Footer artwork is missing');
      return {
        gapFromGuide: art.top - guide.bottom,
        gapToFooter: footer.top - art.bottom,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(layout.gapFromGuide).toBeGreaterThanOrEqual(8);
    expect(layout.gapToFooter).toBeGreaterThanOrEqual(27);
    expect(layout.overflow).toBe(0);
    await page.evaluate(() => scrollBy({ top: -40, behavior: 'instant' }));
    await expect.poll(() => canvasImage(page)).not.toBe(mark);
    await page.evaluate(() => scrollBy({ top: 40, behavior: 'instant' }));
    await expect.poll(() => canvasImage(page)).toBe(mark);
    await page.locator('#tab-source').click();
    await expect(page.locator('#tab-source')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.install-methods > .decode-layer')).toBeHidden();
    await page.evaluate(() => scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await expect(region).toBeInViewport({ ratio: 1 });
    const sourceGuideGap = await region.evaluate((element) => {
      const guide = document.querySelector('#install .text-link')?.getBoundingClientRect();
      if (!guide) throw new Error('Setup guide is missing');
      return element.getBoundingClientRect().top - guide.bottom;
    });
    expect(sourceGuideGap).toBeGreaterThanOrEqual(8);
  }
});

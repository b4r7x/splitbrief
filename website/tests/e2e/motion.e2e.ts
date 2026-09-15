import { expect, test } from '@playwright/test';
import { canvasImage, clickInPlace, openPage, scrollScene, settleScenes } from './browser.js';

test('settled story content stays untouched while ambient art continues moving', async ({
  page,
}) => {
  for (const path of ['/', '/#roles']) {
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
            '[data-scroll-track], [data-continuation]',
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
    expect(await canvasImage(page), path).not.toBe(before);
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
  await clickInPlace(page, page.locator('.details-controls').getByRole('button'));
  const poses: string[] = [];
  for (const progress of [0.15, 0.49, 0.82, 0.15]) {
    await scrollScene(page, '#details', progress);
    poses.push(await canvasImage(page));
  }
  expect(new Set(poses.slice(0, 3)).size).toBe(3);
  expect(poses[3]).toBe(poses[0]);
});

test('pause freezes ambient motion, scrolling still works and resume restarts motion', async ({
  page,
}) => {
  await openPage(page);
  const first = await canvasImage(page);
  await page.waitForTimeout(350);
  expect(await canvasImage(page)).not.toBe(first);
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
  expect(await canvasImage(page)).not.toBe(moved);
});

test('live reduced-motion preferences stop ambient time and leave both scenes operable', async ({
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
  expect(await canvasImage(page)).not.toBe(resumed);
});

test('a hidden tab freezes its art and visibility resumes without a time jump', async ({
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
  expect(await canvasImage(page)).not.toBe(frozen);
});

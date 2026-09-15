import { expect, test } from '@playwright/test';
import { openPage } from './browser.js';

test('Get started reaches readable installation immediately without animated scrolling', async ({
  page,
}) => {
  await openPage(page);
  const frames = await page.evaluate(async () => {
    const link = document.querySelector<HTMLAnchorElement>('.get-started');
    if (!link) throw new Error('Get started link is missing');
    const samples: number[] = [];
    link.click();
    samples.push(scrollY);
    await new Promise<void>((resolve) => {
      const end = performance.now() + 600;
      const sample = () => {
        samples.push(scrollY);
        if (performance.now() < end) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return samples;
  });
  const destination = frames.at(-1) ?? 0;
  expect(destination).toBeGreaterThan(0);
  expect(new Set(frames)).toEqual(new Set([destination]));
  await expect(page.locator('#install .is-decoding')).toHaveCount(0);
  await expect(page.locator('#install')).toBeFocused();
});

for (const path of ['/', '/#roles']) {
  test(`native scroll survives a simultaneous resize without later movement at ${path}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPage(page, path);
    const result = await page.evaluate(async () => {
      const requested = scrollY + 160;
      scrollTo({ top: requested, behavior: 'instant' });
      window.dispatchEvent(new Event('resize'));
      const positions: number[] = [];
      for (let frame = 0; frame < 20; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        positions.push(scrollY);
      }
      return {
        requested,
        positions,
        behavior: getComputedStyle(document.documentElement).scrollBehavior,
      };
    });
    expect(new Set(result.positions)).toEqual(new Set([result.requested]));
    expect(result.behavior).toBe('auto');
    const before = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 160);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(before + 160);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => scrollY)).toBe(before + 160);
  });
}

test('reduced motion and browser history land directly on readable chapters', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPage(page, '/#roles');
  await page.getByRole('link', { name: '02 Record' }).click();
  await expect(page.locator('#record')).toHaveAttribute('aria-hidden', 'false');
  await page.getByRole('link', { name: '03 Install' }).click();
  await expect(page.locator('#install .is-decoding')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('#record')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#record .is-decoding')).toHaveCount(0);
});

test('normal-motion history restores the requested chapter without intermediate panels', async ({
  page,
}) => {
  await openPage(page, '/#roles');
  await page.getByRole('link', { name: '03 Install' }).click();
  await expect(page.locator('#install')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#install .is-decoding')).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const frames: string[] = [];
    await new Promise<void>((resolve) => {
      window.addEventListener(
        'hashchange',
        () => {
          let count = 0;
          function sample() {
            frames.push(document.querySelector('[data-panel][data-active="true"]')?.id ?? '');
            if (++count < 16) requestAnimationFrame(sample);
            else resolve();
          }
          requestAnimationFrame(sample);
        },
        { once: true },
      );
      history.back();
    });
    return frames;
  });
  expect(new Set(result)).toEqual(new Set(['roles']));
  await expect(page.locator('#roles .is-decoding')).toHaveCount(0);
});

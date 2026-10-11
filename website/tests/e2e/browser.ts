import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';

type Site = {
  origin: string;
  repository: string;
  npm: { package: string; published: boolean };
};

export const site: Site = JSON.parse(
  readFileSync(new URL('../../site.json', import.meta.url), 'utf8'),
);

export async function openPage(page: Page, path = '/') {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('html.is-enhanced');
  await page.waitForTimeout(150);
}

export async function scrollScene(page: Page, selector: string, progress: number) {
  await page.evaluate(
    ({ selector, progress }) => {
      const scene = document.querySelector(selector);
      if (!scene) throw new Error(`Missing scene: ${selector}`);
      const bounds = scene.getBoundingClientRect();
      const stage = scene.querySelector('[data-scroll-stage], [data-details-stage]');
      if (!stage) throw new Error(`Missing stage: ${selector}`);
      const inset = Number.parseFloat(getComputedStyle(stage).top) || 0;
      scrollTo({
        top: scrollY + bounds.top - inset + progress * (bounds.height - stage.clientHeight),
        behavior: 'instant',
      });
    },
    { selector, progress },
  );
  await page.waitForTimeout(800);
}

export async function clickInPlace(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('The control is not rendered');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function settleScenes(page: Page) {
  await page.locator('[data-scroll-track], [data-continuation]').evaluateAll(
    (elements) =>
      new Promise<void>((resolve) => {
        let quietFrames = 0;
        const observer = new MutationObserver(() => {
          quietFrames = 0;
        });
        for (const element of elements) {
          observer.observe(element, {
            attributes: true,
            childList: true,
            characterData: true,
            subtree: true,
          });
        }
        function frame() {
          quietFrames += 1;
          if (quietFrames >= 6) {
            observer.disconnect();
            resolve();
          } else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }),
  );
}

// Resolves once the canvas reads the same across several animation frames, twice in a row.
export async function settleCanvas(page: Page, selector = '[data-ambient]') {
  await page.locator(selector).evaluate(async (element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Expected a canvas');
    const frames = async (count: number) => {
      for (let index = 0; index < count; index++)
        await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    let previous = element.toDataURL();
    let quiet = 0;
    while (quiet < 2) {
      await frames(3);
      const next = element.toDataURL();
      quiet = next === previous ? quiet + 1 : 0;
      previous = next;
    }
  });
}

// A fingerprint, not the data URL: a failed toBe on two ~100 KB strings diffs them
// for seconds, so an expect.poll over it gets no second sample in its budget.
export async function canvasImage(page: Page, selector = '[data-ambient]') {
  const dataUrl = await page.locator(selector).evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Expected a canvas');
    return element.toDataURL();
  });
  return createHash('sha256').update(dataUrl).digest('hex');
}

import type { Locator, Page } from '@playwright/test';

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
      scrollTo({
        top: scrollY + bounds.top + progress * (bounds.height - innerHeight),
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

export async function canvasImage(page: Page, selector = '[data-ambient]') {
  return page.locator(selector).evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Expected a canvas');
    return element.toDataURL();
  });
}

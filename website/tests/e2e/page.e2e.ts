import { gzipSync } from 'node:zlib';
import { expect, type Locator, type Page, test } from '@playwright/test';

const FAMILIES = ['Bodoni Moda', 'JetBrains Mono', 'Space Mono'];
const LEDE =
  'splitbrief runs two coding tools against one job — three when another lab reviews. The stronger one plans and reviews, the cheaper one executes — and splitbrief holds the contract between them.';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function box(locator: Locator): Promise<{ width: number; height: number }> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${locator} has no box`);
  return { width: Math.round(rect.width), height: Math.round(rect.height) };
}

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

test('document structure and copy', async ({ page }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('splitbrief — one plans, one executes, one contract');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', LEDE);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('canvas')).toHaveCount(3);
  await expect(page.locator('canvas:not([role="img"][aria-label])')).toHaveCount(0);
  await expect(page.locator('a:not([href]), a[href=""]')).toHaveCount(0);
  await expect(page.locator('tbody tr')).toHaveCount(5);
});

async function fontLoaded(page: Page, family: string): Promise<boolean> {
  return page.evaluate(
    (name) =>
      document.fonts.check(`16px "${name}"`) &&
      [...document.fonts].some((face) => face.family === name && face.status === 'loaded'),
    family,
  );
}

test('the three families are loaded', async ({ page }) => {
  await open(page);
  for (const family of FAMILIES) {
    expect(await fontLoaded(page, family), family).toBe(true);
  }
});

test('loads with zero console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  expect(errors).toEqual([]);
});

test('no horizontal scroll at 390 and 360', async ({ page }) => {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBe(0);
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the diagram becomes the compact vertical stage with the ghosts on one spine', async ({
    page,
  }) => {
    await open(page);
    const stage = await box(page.locator('.stage'));
    expect([stage.width, stage.height]).toEqual([350, 980]);
    await expect(page.locator('.route-lines--compact')).toBeVisible();
    await expect(page.locator('.route-lines--wide')).toBeHidden();
    const centres = await page.locator('canvas').evaluateAll((canvases) =>
      canvases.map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return Math.round(rect.left + rect.width / 2);
      }),
    );
    expect(new Set(centres).size).toBe(1);
  });

  test('every link and the CTA offers a 44px target and a 2px focus ring', async ({ page }) => {
    await open(page);
    for (const target of await page.locator('.links a, .cta, .foot-link a').all()) {
      const rect = await box(target);
      expect(rect.height, (await target.textContent()) ?? '').toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const focused = document.activeElement;
      const style = focused ? getComputedStyle(focused) : undefined;
      return {
        text: focused?.textContent?.trim(),
        visible: focused?.matches(':focus-visible'),
        outline: `${style?.outlineWidth} ${style?.outlineStyle}`,
      };
    });
    expect(ring).toEqual({ text: '[ docs ]', visible: true, outline: '2px solid' });
  });
});

test('label ink clears AA against the lightest vignette stop', async ({ page }) => {
  await open(page);
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      ink: style.getPropertyValue('--ink-3'),
      vignette: style.getPropertyValue('--bg-vignette'),
    };
  });
  const stops = tokens.vignette.match(/#[0-9a-f]{6}/gi) ?? [];
  const lightest = stops.reduce((best, stop) => (luminance(stop) > luminance(best) ? stop : best));
  const ink = luminance(tokens.ink.trim());
  const stop = luminance(lightest);
  expect((Math.max(ink, stop) + 0.05) / (Math.min(ink, stop) + 0.05)).toBeGreaterThanOrEqual(4.5);
});

test('ships under 90 KB gzipped of JavaScript, 12 KB of it our own', async ({ page }) => {
  await open(page);
  const scripts = await page.evaluate(() => ({
    own: [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map(
      (script) => script.src,
    ),
    vendor: [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map(
      (link) => link.href,
    ),
  }));
  const gzipped = async (urls: string[]): Promise<number> => {
    let bytes = 0;
    for (const url of urls) bytes += gzipSync(await (await page.request.get(url)).body()).length;
    return bytes;
  };
  const own = await gzipped(scripts.own);
  const vendor = await gzipped(scripts.vendor);
  expect(own).toBeLessThanOrEqual(12_000);
  expect(own + vendor).toBeLessThanOrEqual(90_000);
});

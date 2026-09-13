import { gzipSync } from 'node:zlib';
import { expect, type Locator, type Page, test } from '@playwright/test';

const FAMILIES = ['Bodoni Moda', 'JetBrains Mono'];
const LEDE =
  'splitbrief runs two or more coding tools against one job. The stronger one plans and reviews, the cheaper one executes — and splitbrief holds the contract between them.';

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
  await expect(page.locator('canvas.ghost')).toHaveCount(3);
  await expect(page.locator('canvas.ghost:not([role="img"][aria-label])')).toHaveCount(0);
  await expect(page.locator('a:not([href]), a[href=""]')).toHaveCount(0);
});

async function fontLoaded(page: Page, family: string): Promise<boolean> {
  return page.evaluate(
    (name) =>
      document.fonts.check(`16px "${name}"`) &&
      [...document.fonts].some((face) => face.family === name && face.status === 'loaded'),
    family,
  );
}

test('the two families are loaded', async ({ page }) => {
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
  const viewports: [number, number][] = [
    [1440, 900],
    [1920, 1080],
    [390, 844],
  ];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await open(page);
    expect(errors, `${width}×${height}`).toEqual([]);
  }
});

test('no horizontal scroll from phone to wide desktop', async ({ page }) => {
  for (const width of [360, 390, 768, 1024, 1440, 1600, 1920, 2560]) {
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

  test('every link and the CTA offers a 44px target and a 2px focus ring', async ({ page }) => {
    await open(page);
    for (const target of await page.locator('.links a, .cta').all()) {
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

test('navigation keeps real links, keyboard focus and non-overlapping targets', async ({
  page,
}) => {
  for (const width of [360, 390, 768, 1024, 1440, 1600, 1920, 2560]) {
    await page.setViewportSize({ width, height: 1080 });
    await open(page);
    await page.locator('.nav').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const targets = page.locator('.nav a');
    const rects = await targets.evaluateAll((elements) =>
      elements.map((element) => {
        const r = element.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      }),
    );
    for (const [index, rect] of rects.entries()) {
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(Math.round(rect.height * 100) / 100).toBeGreaterThanOrEqual(44);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(96);
      const previous = rects[index - 1];
      if (previous)
        expect(rect.left - previous.right, `${width}px targets`).toBeGreaterThanOrEqual(0);
      await page.keyboard.press('Tab');
      await expect(targets.nth(index)).toBeFocused();
      await expect(targets.nth(index)).toHaveCSS('outline-width', '2px');
      await expect(targets.nth(index)).toHaveCSS('outline-style', 'solid');
    }
    if (width >= 768) {
      const groups = await page.locator('.nav > *').evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, bottom: rect.bottom };
        }),
      );
      for (const [index, group] of groups.entries()) {
        const previous = groups[index - 1];
        if (previous) expect(group.left - previous.right, `${width}px groups`).toBeGreaterThan(0);
        expect(group.bottom).toBeLessThanOrEqual(96);
      }
    }
    await expect(page.locator('.nav .links a').nth(0)).toHaveAttribute(
      'href',
      'https://github.com/b4r7x/splitbrief/tree/main/docs',
    );
    await expect(page.locator('.nav .links a').nth(1)).toHaveAttribute(
      'href',
      'https://github.com/b4r7x/splitbrief',
    );
    await expect(page.locator('.nav .mark')).toHaveAttribute('aria-hidden', 'true');
    await expect(
      page.locator('.nav button, .nav [role="button"], .nav .mark[tabindex]'),
    ).toHaveCount(0);
  }
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

test('ships under 90 KB gzipped of JavaScript, 16 KB of it our own', async ({ page }) => {
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
  expect(own).toBeLessThanOrEqual(16_000);
  expect(own + vendor).toBeLessThanOrEqual(90_000);
});

test('the headline keeps four readable lines and an accessible eyebrow', async ({ page }) => {
  for (const width of [360, 390, 768, 1024, 1440, 1600, 1920]) {
    await page.setViewportSize({ width, height: 1080 });
    await open(page);
    const heading = page.getByRole('heading', {
      level: 1,
      name: 'Two models are good. A system is better.',
      exact: true,
    });
    await expect(heading).toBeVisible();
    const eyebrow = page.getByText('A BETTER WAY TO BUILD', { exact: true });
    await expect(eyebrow).toBeVisible();
    await heading.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    await expect(heading.locator('.line')).toHaveText([
      'TWO MODELS',
      'ARE GOOD.',
      'A SYSTEM',
      'IS BETTER.',
    ]);
    const frame = await heading.boundingBox();
    if (!frame) throw new Error('headline has no frame');
    const lines = await heading.locator('.line').evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          textWidth: text.width,
          textRight: text.right,
          fragments: range.getClientRects().length,
        };
      }),
    );
    expect(lines).toHaveLength(4);
    for (const [index, line] of lines.entries()) {
      expect(line.fragments, `${width}px line ${index + 1} wrapping`).toBe(1);
      expect(line.textRight).toBeLessThanOrEqual(frame.x + frame.width);
      expect(line.height).toBeGreaterThanOrEqual(32);
      const previous = lines[index - 1];
      if (previous) expect(Math.abs(line.top - previous.bottom)).toBeLessThanOrEqual(1);
    }
    const label = await eyebrow.boundingBox();
    if (!label) throw new Error('eyebrow has no box');
    expect(label.y + label.height).toBeLessThan(lines[0]?.top ?? 0);
    expect(label.y).toBeGreaterThanOrEqual(frame.y);
    // Functional copy against the vignette's lightest stop: AA is 4.5, or 3 from 24px up.
    const inks = await page
      .locator('.hero-eyebrow, .hero .line, .benefits li, .s04 .tools')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          const channels = style.color.match(/\d+/g) ?? [];
          return {
            ink: `#${channels
              .slice(0, 3)
              .map((value) => Number(value).toString(16).padStart(2, '0'))
              .join('')}`,
            size: Number.parseFloat(style.fontSize),
          };
        }),
      );
    expect(inks).toHaveLength(9);
    for (const { ink, size } of inks) {
      const ratio = (luminance(ink) + 0.05) / (luminance('#101216') + 0.05);
      expect(ratio, `${ink} at ${size}px`).toBeGreaterThanOrEqual(size >= 24 ? 3 : 4.5);
    }
  }
});

test('the install command copies with feedback and keeps its size', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const width of [390, 1920]) {
    await page.setViewportSize({ width, height: 1080 });
    await open(page);
    const cta = page.getByRole('button', { name: /npm install -g splitbrief/ });
    const before = await box(cta);
    expect(before.height).toBe(56);
    await cta.focus();
    await expect(cta).toHaveCSS('outline-width', '2px');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'copied to clipboard' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'npm install -g splitbrief',
    );
    expect(await box(page.locator('.cta'))).toEqual(before);
    await expect(cta).toBeVisible();
    expect(await box(cta)).toEqual(before);
  }
});

test('the hero fold at 1920', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  expect(
    await page.locator('.works').evaluate((el) => el.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(1080);
});

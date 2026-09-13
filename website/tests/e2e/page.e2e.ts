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

  test('the diagram becomes the compact vertical stage with the ghosts on one spine', async ({
    page,
  }) => {
    await open(page);
    const stage = await box(page.locator('.stage'));
    // H06: three 210x275 canvases (the reference's equal figures) need a taller spine than 980.
    expect([stage.width, stage.height]).toEqual([350, 1130]);
    await expect(page.locator('.route-lines--compact')).toBeVisible();
    await expect(page.locator('.route-lines--wide')).toBeHidden();
    const centres = await page.locator('canvas.ghost').evaluateAll((canvases) =>
      canvases.map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return Math.round(rect.left + rect.width / 2);
      }),
    );
    expect(new Set(centres).size).toBe(1);
  });

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

test('H01 navigation follows the reference landmarks inside the current frame', async ({
  page,
}) => {
  // hero-header.png, x53..1069 outer frame; ink boxes measured before implementation.
  const landmarks = [
    { selector: '.nav .wordmark', x: 103 },
    { selector: '.tagline', x: 248 },
    { selector: '.nav .links a:first-child', x: 819 },
    { selector: '.nav .links a:last-child', x: 881 },
    { selector: '.nav .mark', x: 1004 },
  ];
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 1080 });
    await open(page);
    const nav = await page.locator('.nav').boundingBox();
    if (!nav) throw new Error('navigation has no frame');
    const scale = nav.width / 1016;
    for (const landmark of landmarks) {
      const element = page.locator(landmark.selector);
      const rect = await element.boundingBox();
      if (!rect) throw new Error(`${landmark.selector} has no box`);
      const targetX = nav.x + (landmark.x - 53) * scale;
      expect(Math.abs(rect.x - targetX) / nav.width, landmark.selector).toBeLessThanOrEqual(0.02);
    }
    // Text target boxes include side bearings and 44px hit areas; ink sizes are checked in captures.
    const mark = await box(page.locator('.nav .mark'));
    expect(Math.abs(mark.width / (12 * scale) - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(mark.height / (13 * scale) - 1)).toBeLessThanOrEqual(0.05);
    const tagline = await page.locator('.tagline').evaluate((element) => ({
      lines: element.innerHTML.split('<br>').length,
      pitch: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(tagline.lines).toBe(3);
    expect(Math.abs(tagline.pitch / (12 * scale) - 1)).toBeLessThanOrEqual(0.1);
    // hero-header.png: the steps list is 16px mono on a 24px pitch at 1920 (5.65 src per glyph,
    // 14.5 src rows), three rows on one rule; no stray mark above the claim.
    const steps = await page.locator('.hero .steps li').evaluateAll((items) =>
      items.map((item) => ({
        size: Number.parseFloat(getComputedStyle(item).fontSize),
        height: item.getBoundingClientRect().height,
      })),
    );
    expect(steps).toHaveLength(3);
    if (width === 1920) {
      for (const step of steps) {
        expect(Math.abs(step.size / 16 - 1)).toBeLessThanOrEqual(0.05);
        expect(Math.abs(step.height / 24 - 1)).toBeLessThanOrEqual(0.05);
      }
    }
    await expect(page.locator('.draft-mark')).toHaveCount(0);
    const brand = page.locator('.nav .wordmark');
    await brand.evaluate((element) => {
      element.style.transform = 'translateX(40px)';
    });
    const shifted = await brand.boundingBox();
    if (!shifted) throw new Error('perturbed brand has no box');
    expect(Math.abs(shifted.x - (nav.x + 50 * scale)) / nav.width).toBeGreaterThan(0.02);
    await brand.evaluate((element) => {
      element.style.removeProperty('transform');
    });
  }
});

test('H01 navigation keeps real links, keyboard focus and non-overlapping targets', async ({
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

test('H02 headline follows the crop with four unwrapped lines and a readable eyebrow', async ({
  page,
}) => {
  // hero-copy.png: 400px copy frame, 381px title ink, 56px pitch, 212px ink height.
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
    const scale = Math.min(frame.width, width <= 1099 ? 544 : frame.width) / 400;
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
      expect(Math.abs(line.height / (56 * scale) - 1)).toBeLessThanOrEqual(0.1);
      const previous = lines[index - 1];
      if (previous) expect(Math.abs(line.top - previous.bottom)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs((lines[0]?.textWidth ?? 0) / (381 * scale) - 1)).toBeLessThanOrEqual(0.05);
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

    if (width === 1920) {
      await heading.evaluate((element) => {
        element.style.lineHeight = '140px';
      });
      const perturbed = await heading.locator('.line').first().boundingBox();
      if (!perturbed) throw new Error('perturbed line has no box');
      expect(Math.abs(perturbed.height / (56 * scale) - 1)).toBeGreaterThan(0.1);
      await heading.evaluate((element) => element.style.removeProperty('line-height'));
    }
  }
});

test('the whole page shares the wide FHD grid', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [360, 390, 768, 1024, 1440, 1599, 1600, 1920, 2560]) {
    await page.setViewportSize({ width, height: 1080 });
    await open(page);
    const containers = await page
      .locator('.nav, .hero, .lower .grid, .foot')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, width: rect.width };
        }),
      );
    expect(containers).toHaveLength(6);
    const first = containers[0];
    if (!first) throw new Error('page has no container');
    for (const container of containers) {
      expect(container.left, `${width}px left edge`).toBeCloseTo(first.left, 0);
      expect(container.width, `${width}px width`).toBeCloseTo(first.width, 0);
    }
    if (width === 1440 || width >= 1600) {
      // G01 target-landmarks: reference-v2.png outer frame x53..1069 on 1122px.
      const targetLeft = (53 / 1122) * width;
      const targetWidth = (1016 / 1122) * width;
      for (const container of containers) {
        expect(
          (Math.abs(container.left - targetLeft) / width) * 100,
          `${width}px reference left edge (percentage points)`,
        ).toBeLessThanOrEqual(2);
        expect(
          (Math.abs(container.left + container.width - (width - targetLeft)) / width) * 100,
          `${width}px reference right edge (percentage points)`,
        ).toBeLessThanOrEqual(2);
        expect(
          (Math.abs(container.width - targetWidth) / targetWidth) * 100,
          `${width}px reference width (relative percent)`,
        ).toBeLessThanOrEqual(5);
      }
    }
    if (width === 1920) {
      const cta = await page.locator('.cta').boundingBox();
      if (!cta) throw new Error('CTA has no box');
      expect(cta.y + cta.height).toBeLessThanOrEqual(1080);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      `${width}px overflow`,
    ).toBe(0);
  }
});

test('H03 copy block follows the crop: lede measure, CTA, three benefits and the closing quote', async ({
  page,
}) => {
  // hero-copy.png: lede 6.45 src px/char (18.4px at 1920), 31px pitch, three lines; CTA 226x34 src
  // (386x58); benefits in one row of three, separated by hairlines, 14px; the dim two-line quote
  // 34 src below the benefits; hero frame 664 src (1136px at 1920).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const lede = page.locator('.lede');
  const metrics = await lede.evaluate((element) => {
    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
    return {
      size: Number.parseFloat(style.fontSize),
      lines: lines.size,
      width: element.clientWidth,
    };
  });
  expect(Math.abs(metrics.size / 18.4 - 1)).toBeLessThanOrEqual(0.05);
  expect(metrics.lines).toBe(3);
  expect(metrics.width).toBeLessThanOrEqual(680);
  const cta = page.locator('.cta');
  const before = await box(cta);
  expect(Math.abs(before.width / 386 - 1)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(before.height / 58 - 1)).toBeLessThanOrEqual(0.05);
  await cta.focus();
  await expect(cta).toHaveCSS('outline-width', '2px');
  await cta.click();
  await expect(page.locator('.cta-notice')).toBeVisible();
  expect(await box(cta)).toEqual(before);
  const benefits = page.locator('.benefits li');
  await expect(benefits).toHaveText([
    'HIGHER QUALITY SOFTWARE',
    'LOWER SPEND PER TASK',
    'REAL EVIDENCE NOT VIBES',
  ]);
  const rows = await benefits.evaluateAll((items) =>
    items.map((item) => Math.round(item.getBoundingClientRect().top)),
  );
  expect(new Set(rows).size).toBe(1);
  const works = await page.locator('.works').boundingBox();
  if (!works) throw new Error('works block has no box');
  expect(works.y + works.height).toBeLessThanOrEqual(1080);
  const quote = page.locator('.hero .quote');
  await expect(quote).toHaveAttribute('aria-hidden', 'true');
  await expect(quote).toContainText('“A SMALLER, CLEARER LOOP');
  await expect(quote).toContainText('FOR LARGER THINGS.”');
  const quoteBox = await quote.boundingBox();
  const hero = await page.locator('.hero').boundingBox();
  if (!quoteBox || !hero) throw new Error('quote or hero has no box');
  expect(quoteBox.y - (works.y + works.height)).toBeGreaterThanOrEqual(48);
  expect(quoteBox.y - (works.y + works.height)).toBeLessThanOrEqual(64);
  expect(quoteBox.y + quoteBox.height).toBeLessThanOrEqual(hero.y + hero.height);
  expect(Math.abs((hero.y + hero.height) / 1136 - 1)).toBeLessThanOrEqual(0.02);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const stacked = await page.locator('.benefits li').evaluateAll((items) =>
    items.map((item) => {
      const r = item.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), height: Math.round(r.height) };
    }),
  );
  expect(new Set(stacked.map((item) => item.left)).size).toBe(1);
  expect(stacked.map((item) => item.top)).toEqual(
    [...stacked.map((item) => item.top)].sort((a, b) => a - b),
  );
  for (const item of stacked) expect(item.height).toBeLessThanOrEqual(24);
});

test('the hero fold at 1920', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  expect(
    await page.locator('.works').evaluate((el) => el.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(1080);
});

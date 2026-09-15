import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { clickInPlace, openPage } from './browser.js';

test('presents accessible copy, the CLI wordmark, local fonts and real project links', async ({
  page,
}) => {
  await openPage(page);
  await expect(page).toHaveTitle(/SPLITBRIEF/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Two tools. One clear handoff.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.locator('.logo-figlet')).toHaveAttribute('aria-hidden', 'true');
  await expect(
    page.getByRole('link', { name: 'SPLITBRIEF — back to the beginning' }),
  ).toBeVisible();
  await expect(page.locator('a:not([href]), a[href=""], a[href="#"]')).toHaveCount(0);
  const projectLinks = page.getByRole('navigation', { name: 'Project links' });
  await expect(projectLinks.getByRole('link', { name: '[ docs ]' })).toHaveAttribute(
    'href',
    'https://github.com/b4r7x/splitbrief/blob/main/docs/GETTING-STARTED.md',
  );
  await expect(projectLinks.getByRole('link', { name: '[ github ]' })).toHaveAttribute(
    'href',
    'https://github.com/b4r7x/splitbrief',
  );
  const fonts = await page.evaluate(() => ({
    loaded: [...document.fonts]
      .filter((font) => font.status === 'loaded')
      .map((font) => font.family),
    requests: performance
      .getEntriesByType('resource')
      .map((resource) => resource.name)
      .filter((name) => name.endsWith('.woff2')),
  }));
  expect(fonts.loaded).toHaveLength(3);
  expect(fonts.requests).toHaveLength(3);
  expect(fonts.requests.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(
    true,
  );
  expect((await page.locator('.introduction').boundingBox())?.x).toBe(
    (await page.locator('.terminal').boundingBox())?.x,
  );
});

test('has no errors, missing assets or horizontal overflow from 320 to 2560 pixels', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  for (const width of [320, 390, 768, 1024, 1440, 1800, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/#install']) {
      await openPage(page, path);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        `${width} ${path}`,
      ).toBe(0);
      expect(await page.evaluate(() => scrollX), `${width} ${path}`).toBe(0);
    }
  }
  expect(errors).toEqual([]);
});

test('offers 44px controls, visible keyboard focus and a working installation CTA', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page);
  for (const control of await page
    .locator('.brand, .corner-links a, .get-started, .timeline-step, .scene-controls button')
    .all()) {
    const bounds = await control.boundingBox();
    expect(bounds?.height, (await control.textContent()) ?? '').toBeGreaterThanOrEqual(44);
    expect(bounds?.width, (await control.textContent()) ?? '').toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to installation' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Skip to installation' })).toHaveCSS(
    'outline-style',
    'solid',
  );
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'SPLITBRIEF — back to the beginning' }),
  ).toBeFocused();
  await clickInPlace(page, page.getByRole('link', { name: 'Get started', exact: true }));
  await expect(page).toHaveURL(/#install$/);
  await expect(
    page.getByRole('heading', { name: 'Start with your next change.' }),
  ).toBeInViewport();
  for (const control of await page.locator('.copy-command, .text-link').all()) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
});

test('ships within the 16 KB own JavaScript and 90 KB total gzip budgets', async ({ page }) => {
  await openPage(page);
  const scripts = await page.evaluate(() => ({
    own: [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map(
      (script) => script.src,
    ),
    vendor: [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map(
      (link) => link.href,
    ),
  }));
  const size = async (urls: string[]) => {
    let bytes = 0;
    for (const url of urls) bytes += gzipSync(await (await page.request.get(url)).body()).length;
    return bytes;
  };
  const own = await size(scripts.own);
  expect(own).toBeLessThanOrEqual(16_000);
  expect(own + (await size(scripts.vendor))).toBeLessThanOrEqual(90_000);
});

test('keeps the full story and installation readable without JavaScript', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  if (!baseURL) throw new Error('The website preview URL is missing');
  await page.goto(baseURL);
  const sections = page.locator('.document-section, .detail-panel');
  expect(await sections.count()).toBe(9);
  let previousBottom = 0;
  for (const section of await sections.all()) {
    await expect(section).toBeVisible();
    const bounds = await section.boundingBox();
    if (!bounds) throw new Error('Story section is missing');
    expect(bounds.y).toBeGreaterThanOrEqual(previousBottom - 1);
    previousBottom = bounds.y + bounds.height;
  }
  await expect(page.locator('.timeline')).toBeHidden();
  await expect(page.locator('.copy-command').first()).toBeHidden();
  await page.getByRole('link', { name: 'Get started', exact: true }).click();
  await expect(page.locator('#install-command')).toBeInViewport();
  await expect(page.locator('#start-command')).toContainText('splitbrief start "your change"');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await context.close();
});

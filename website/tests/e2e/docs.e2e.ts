import { expect, type Page, test } from '@playwright/test';
import { site } from './browser.js';

function decodeEntities(text: string) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

// The server-rendered page is the source of truth for what client-side navigation must restore.
async function expectPageMetadata(page: Page, route: string, title: string) {
  const path = route ? `/docs/${route}/` : '/docs/';
  const html = await (await page.request.get(path)).text();
  const content = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
  if (content === undefined) throw new Error(`/docs/${route}/ has no description`);
  const description = decodeEntities(content);
  const documentTitle = `${title} · SPLITBRIEF`;
  const url = `${site.origin}${path}`;
  const image = `${site.origin}/social.png`;
  const imageAlt = 'The SPLITBRIEF wordmark above the line: Two tools. One clear handoff.';
  await expect(page).toHaveTitle(documentTitle);
  const expected: Array<[string, string, string]> = [
    ['link[rel="canonical"]', 'href', url],
    ['meta[property="og:url"]', 'content', url],
    ['meta[property="og:type"]', 'content', route ? 'article' : 'website'],
    ['meta[property="og:site_name"]', 'content', 'SPLITBRIEF'],
    ['meta[name="description"]', 'content', description],
    ['meta[property="og:title"]', 'content', documentTitle],
    ['meta[name="twitter:title"]', 'content', documentTitle],
    ['meta[property="og:description"]', 'content', description],
    ['meta[name="twitter:description"]', 'content', description],
    ['meta[name="twitter:card"]', 'content', 'summary_large_image'],
    ['meta[property="og:image"]', 'content', image],
    ['meta[property="og:image:width"]', 'content', '1200'],
    ['meta[property="og:image:height"]', 'content', '630'],
    ['meta[property="og:image:alt"]', 'content', imageAlt],
    ['meta[name="twitter:image"]', 'content', image],
    ['meta[name="twitter:image:alt"]', 'content', imageAlt],
  ];
  for (const [selector, attribute, value] of expected) {
    const element = page.locator(`head ${selector}`);
    await expect(element, `${route} ${selector}`).toHaveCount(1);
    await expect(element, `${route} ${selector}`).toHaveAttribute(attribute, value);
  }
}

test('the guide has source content, working contents links and copyable npm commands', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/docs/getting-started/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Getting started with SPLITBRIEF',
  );
  await expect(page.locator('body')).toHaveClass(/docs-enhanced/);
  const installation = page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Installation', exact: true });
  await installation.click();
  await expect(
    page.getByRole('heading', { name: '3. Installation', exact: true }),
  ).toBeInViewport();
  const npm = page.locator('.docs-code').filter({ hasText: 'npm install -g splitbrief' });
  await npm.getByRole('button').click();
  await expect(page.getByRole('status')).toHaveText('Commands copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'npm install -g splitbrief\nsplitbrief --help',
  );
  await expect(page.locator('.docs-article')).toContainText('npx splitbrief start "your change"');
  await expect(page.locator('a[href^="./"][href*=".md"], a[href^="../"][href*=".md"]')).toHaveCount(
    0,
  );
  await expect(page.locator('[data-atmosphere] .ascii-stream')).toHaveCount(8);
  await expect(page.locator('.logo-figlet')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile docs keep the contents collapsible and wide code within the article', async ({
  page,
}) => {
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/docs/getting-started/');
    await expect(page.locator('body')).toHaveClass(/docs-enhanced/);
    await expect(page.locator('.docs-contents details')).not.toHaveAttribute('open', '');
    await page.locator('.docs-contents summary').click();
    await page.getByRole('link', { name: 'Installation', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '3. Installation', exact: true }),
    ).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  }
});

test('the complete guide is static HTML and readable without JavaScript', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(`${baseURL}/docs/getting-started/`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Build from source', exact: true })).toBeVisible();
  await expect(page.locator('.docs-article h2')).toHaveCount(12);
  await expect(page.locator('.docs-code button').first()).toBeHidden();
  await page.getByRole('link', { name: 'Installation', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '3. Installation', exact: true }),
  ).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await context.close();
});

test('article navigation encodes and decodes while preserving the shared ASCII scene', async ({
  page,
}) => {
  await page.goto('/docs/getting-started/');
  await expect(page.locator('body')).toHaveClass(/docs-enhanced/);
  const result = await page.evaluate(async () => {
    const art = document.querySelector('[data-atmosphere] .ascii-drift');
    const header = document.querySelector('.corners');
    const link = document.querySelector<HTMLAnchorElement>(
      '.docs-library a[href$="/cli-reference/"]',
    );
    if (!link) throw new Error('CLI reference link missing');
    let encoded = false;
    let faded = false;
    link.click();
    await new Promise<void>((resolve) => {
      const end = performance.now() + 1300;
      function sample() {
        encoded ||= !!document.querySelector('.docs-heading .is-decoding');
        faded ||=
          Number(
            getComputedStyle(document.querySelector('.docs-article') ?? document.body).opacity,
          ) < 0.8;
        if (performance.now() < end) requestAnimationFrame(sample);
        else resolve();
      }
      requestAnimationFrame(sample);
    });
    return {
      encoded,
      faded,
      sameArt: art === document.querySelector('[data-atmosphere] .ascii-drift'),
      sameHeader: header === document.querySelector('.corners'),
    };
  });
  expect(result).toEqual({ encoded: true, faded: true, sameArt: true, sameHeader: true });
  await expect(page).toHaveURL(/\/docs\/cli-reference\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('CLI Reference');
  await expect(page.locator('.is-decoding')).toHaveCount(0);
  await expect(page.locator('#guide')).toBeFocused();
});

test('search and history keep local links, page metadata and reading position', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/docs/');
  await expect(page.locator('body')).toHaveClass(/docs-enhanced/);
  await page.evaluate(() => Object.assign(window, { sameDocument: true }));
  await expectPageMetadata(page, '', 'Documentation');
  const search = page.getByRole('searchbox', { name: 'Find a documentation page' });
  await search.fill('Getting started');
  await page
    .getByRole('navigation', { name: 'Documentation' })
    .getByRole('link', { name: 'Getting started', exact: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/getting-started\/$/);
  await expectPageMetadata(page, 'getting-started', 'Getting started');
  await page.evaluate(() => scrollTo({ top: 1300, behavior: 'instant' }));
  const before = await page.evaluate(() => scrollY);
  await search.fill('Repo-map');
  await page
    .getByRole('navigation', { name: 'Documentation' })
    .getByRole('link', { name: 'Repo-map context', exact: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/repomap\/$/);
  await expect(page.locator('.brand')).toHaveAttribute('href', new URL('/', page.url()).href);
  await expectPageMetadata(page, 'repomap', 'Repo-map context');
  await search.fill('CLI');
  await page
    .getByRole('navigation', { name: 'Documentation' })
    .getByRole('link', { name: 'CLI Reference', exact: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/cli-reference\/$/);
  await expectPageMetadata(page, 'cli-reference', 'CLI Reference');
  await page.evaluate(() => scrollTo({ top: 1800, behavior: 'instant' }));
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Repo-map context');
  await expectPageMetadata(page, 'repomap', 'Repo-map context');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Getting started with SPLITBRIEF',
  );
  await expectPageMetadata(page, 'getting-started', 'Getting started');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(before, 0);
  await expect(page.locator('.is-decoding')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/docs\/$/);
  await expectPageMetadata(page, '', 'Documentation');
  await page.goForward();
  await expect(page).toHaveURL(/\/docs\/getting-started\/$/);
  await expectPageMetadata(page, 'getting-started', 'Getting started');
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Repo-map context');
  await expectPageMetadata(page, 'repomap', 'Repo-map context');
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('CLI Reference');
  await expectPageMetadata(page, 'cli-reference', 'CLI Reference');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(1800, 0);
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
});

test('long prose stays within the narrow article while code can scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const path of ['mental-model', 'migration']) {
    await page.goto(`/docs/${path}/`);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), path).toBe(
      0,
    );
  }
});

test('the latest request wins when documentation fetches finish out of order', async ({ page }) => {
  await page.route('**/docs/cli-reference/', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await page.goto('/docs/getting-started/');
  await expect(page.locator('body')).toHaveClass(/docs-enhanced/);
  await page.evaluate(() => {
    document.querySelector<HTMLAnchorElement>('.docs-library a[href$="/cli-reference/"]')?.click();
    document
      .querySelector<HTMLAnchorElement>('.docs-library a[href$="/troubleshooting/"]')
      ?.click();
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Troubleshooting');
  await expect(page.locator('.is-decoding')).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/docs\/troubleshooting\/$/);
});

test('clicking another article during a delayed Back keeps the earlier reading position', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/docs/getting-started/');
  await expect(page.locator('body')).toHaveClass(/docs-enhanced/);
  await page.evaluate(() => {
    scrollTo({ top: 1000, behavior: 'instant' });
    document.querySelector<HTMLAnchorElement>('.docs-library a[href$="/cli-reference/"]')?.click();
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('CLI Reference');
  await page.route('**/docs/getting-started/', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.evaluate(() => {
    scrollTo({ top: 1800, behavior: 'instant' });
    history.back();
  });
  await expect(page).toHaveURL(/\/docs\/getting-started\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('CLI Reference');
  await page.evaluate(() =>
    document
      .querySelector<HTMLAnchorElement>('.docs-library a[href$="/troubleshooting/"]')
      ?.click(),
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Troubleshooting');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Getting started with SPLITBRIEF',
  );
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(1000, 0);
});

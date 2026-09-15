import { expect, test } from '@playwright/test';
import { canvasImage, clickInPlace, openPage, scrollScene } from './browser.js';

test('installation methods encode and decode at their own content height without scrolling', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openPage(page, '/#install');
  const before = await page.locator('.install-methods').boundingBox();
  const position = await page.evaluate(() => scrollY);
  const source = page.getByRole('tab', { name: 'From source', exact: true });
  await source.click();
  await expect(page.locator('.install-methods > .decode-layer')).toBeVisible();
  await expect(source).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.install-methods > .decode-layer')).toBeHidden();
  const expanded = await page.locator('.install-methods').boundingBox();
  if (!before || !expanded) throw new Error('Installation methods are missing');
  expect(expanded.height).toBeGreaterThan(before.height + 30);
  expect(await page.evaluate(() => scrollY)).toBe(position);
  await page.locator('[data-copy="source"]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'git clone https://github.com/b4r7x/splitbrief.git\ncd splitbrief\nnpm install\nnpm run build\nnpm link',
  );
  await source.focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'npm', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#install-command')).toBeVisible();
  await expect(page.locator('.install-methods > .decode-layer')).toBeHidden();
  expect(await page.locator('.install-methods').boundingBox()).toEqual(before);
  expect(await page.evaluate(() => scrollY)).toBe(position);
});

test('file tabs encode only their description and the latest rapid selection wins', async ({
  page,
}) => {
  await openPage(page, '/#record');
  await page.getByRole('tab', { name: 'review.md', exact: true }).click();
  await expect(page.locator('#file-description .decode-layer')).toBeVisible();
  await expect(page.locator('#record > .decode-layer')).toBeHidden();
  await page.getByRole('tab', { name: 'session.jsonl', exact: true }).click();
  await page.getByRole('tab', { name: 'state.json', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Where the session stands.');
  await expect(page.locator('#file-description .decode-layer')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'state.json', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('one centered scene holds setup, record and installation with clickable chapters', async ({
  page,
}) => {
  await openPage(page, '/#roles');
  const initial = await page.locator('.details-composition').boundingBox();
  if (!initial) throw new Error('Continuation is missing');
  expect(initial.x + initial.width / 2).toBeCloseTo(720, 0);
  expect(initial.y + initial.height / 2).toBeCloseTo(450, 0);
  const navigation = page.getByRole('navigation', {
    name: 'Explore setup, session files and installation',
  });
  const chapters = [
    ['Setup', 'Your tools. Your roles.'],
    ['Record', 'Open the files. Follow the work.'],
    ['Install', 'Start your next change.'],
  ] as const;
  for (const [index, [name, heading]] of chapters.entries()) {
    const link = navigation.getByRole('link', { name: new RegExp(name) });
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(link).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeInViewport();
    expect(await page.locator('.details-composition').boundingBox()).toEqual(initial);
    await expect(page.locator(`[data-panel="${index}"] .is-decoding`)).toHaveCount(0);
  }
  await scrollScene(page, '#details', 0.16);
  await expect(page.getByRole('heading', { name: chapters[0][1] })).toBeVisible();
  expect(await page.locator('.details-composition').boundingBox()).toEqual(initial);
  await scrollScene(page, '#details', 1);
  await page.mouse.wheel(0, 900);
  await expect(page.locator('.page-footer')).toBeInViewport();
});

test('decoding reverses deterministically without changing text or layout', async ({ page }) => {
  await openPage(page, '/#roles');
  const sources = page.locator('#roles [data-decode]');
  const text = await sources.allTextContents();
  const boxes = await sources.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON()),
  );
  await scrollScene(page, '#details', 0.04);
  await expect(page.locator('#roles .decode-layer')).toBeVisible();
  const decoded = await canvasImage(page, '#roles .decode-layer');
  await page.waitForTimeout(250);
  expect(await canvasImage(page, '#roles .decode-layer')).toBe(decoded);
  await scrollScene(page, '#details', 0.18);
  await expect(page.locator('#roles .decode-layer')).toBeHidden();
  await scrollScene(page, '#details', 0.04);
  expect(await canvasImage(page, '#roles .decode-layer')).toBe(decoded);
  expect(await sources.allTextContents()).toEqual(text);
  expect(
    await sources.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().toJSON()),
    ),
  ).toEqual(boxes);
});

test('resized details remain pinned and navigable on short screens', async ({ page }) => {
  await openPage(page, '/#roles');
  const details = page.locator('#details');
  await expect(details).toHaveClass(/is-pinned/);
  await scrollScene(page, '#details', 1.65 / 3);
  await expect(page.locator('#record')).toHaveAttribute('data-active', 'true');

  await page.setViewportSize({ width: 1024, height: 580 });
  await expect(details).toHaveClass(/is-pinned/);
  await expect(details).toHaveClass(/is-compact/);
  await scrollScene(page, '#details', 1.65 / 3);
  await expect(page.locator('#record')).toHaveAttribute('data-active', 'true');
  await expect(details.locator('.is-decoding')).toHaveCount(0);
  await expect(page.locator('#roles')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#install')).toHaveAttribute('aria-hidden', 'true');

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(details).toHaveClass(/is-pinned/);
  await expect(details).not.toHaveClass(/is-compact/);
  await scrollScene(page, '#details', 1.65 / 3);
  await expect(page.locator('#record')).toHaveAttribute('data-active', 'true');
  await scrollScene(page, '#details', 0.04);
  await expect(page.locator('#roles .decode-layer')).toBeVisible();
  await scrollScene(page, '#details', 0.15);
  await expect(page.locator('#roles .decode-layer')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Your tools. Your roles.' })).toBeInViewport();
});

for (const [width, height] of [
  [320, 568],
  [320, 740],
  [390, 844],
  [844, 390],
] as const) {
  test(`compact details show each complete chapter without internal scrolling at ${width}×${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPage(page, '/#roles');
    const details = page.locator('#details');
    await expect(details).toHaveClass(/is-pinned/);
    const frame = await page.locator('.details-composition').boundingBox();
    const endings = ['#roles .detail-footnote', '#record .detail-footnote', '#install .text-link'];
    for (const [index, ending] of endings.entries()) {
      await scrollScene(page, '#details', (index + 0.45) / 3);
      const panel = details.locator(`[data-panel="${index}"]`);
      await expect(panel.locator('h2')).toBeInViewport({ ratio: 1 });
      await expect(page.locator(ending)).toBeInViewport({ ratio: 1 });
      const before = await panel.boundingBox();
      const window = await page.locator('.detail-panels').boundingBox();
      if (!before || !window) throw new Error('Missing details panel');
      expect(before.height).toBeLessThanOrEqual(window.height);
      await scrollScene(page, '#details', (index + 0.81) / 3);
      await expect(page.locator(ending)).toBeInViewport({ ratio: 1 });
      expect(await page.locator('.details-composition').boundingBox()).toEqual(frame);
      expect(await panel.boundingBox()).toEqual(before);
    }
    await scrollScene(page, '#details', 1);
    await page.mouse.wheel(0, 900);
    await expect(page.locator('.page-footer')).toBeInViewport();
  });
}

test('compact installation shows all source commands and controls without additional scrolling', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPage(page, '/#install');
  const position = await page.evaluate(() => scrollY);
  const npmHeight = await page.locator('.install-methods').evaluate((node) => node.clientHeight);
  await page.locator('#tab-source').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#tab-source')).toHaveAttribute('aria-selected', 'true');
  expect(
    await page.locator('.install-methods').evaluate((node) => node.clientHeight),
  ).toBeGreaterThan(npmHeight + 30);
  await page.keyboard.press('Tab');
  const copy = page.locator('[data-copy="source"]');
  await expect(copy).toBeFocused();
  await expect(copy).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'npm run build\nnpm link',
  );
  await page.locator('[data-copy="start"]').focus();
  await expect(page.locator('[data-copy="start"]')).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Tab');
  await expect(page.locator('#install .text-link')).toBeFocused();
  await expect(page.locator('#install .text-link')).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => scrollY)).toBe(position);
  const code = page.locator('#source-command');
  await expect(code).toBeInViewport({ ratio: 1 });
  expect(await code.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  await expect(page.locator('#start-command')).toBeInViewport({ ratio: 1 });
  await page.locator('#tab-npm').click();
  await expect(page.locator('#tab-npm')).toHaveAttribute('aria-selected', 'true');
  expect(await page.locator('.install-methods').evaluate((node) => node.clientHeight)).toBe(
    npmHeight,
  );
  expect(await page.evaluate(() => scrollY)).toBe(position);
});

test('session files support pointer, arrow keys, Home and End', async ({ page }) => {
  await openPage(page, '/#record');
  const first = page.getByRole('tab', { name: 'tasks.md', exact: true });
  const panel = page.getByRole('tabpanel');
  await first.focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'state.json', exact: true })).toBeFocused();
  await expect(panel).toContainText('Where the session stands.');
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(panel).toContainText('Where the session stands.');
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await clickInPlace(page, page.getByRole('tab', { name: 'review.md', exact: true }));
  await expect(panel).toHaveAttribute('aria-labelledby', 'tab-review');
  await expect(panel).toContainText('The stronger tool’s assessment.');
});

test('returning to the first file restores the description supplied by the document', async ({
  page,
}) => {
  const heading = 'The task brief sent to the implementation tool.';
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace('The brief the implementer receives.', heading),
    });
  });
  await openPage(page, '/#record');
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('heading')).toHaveText(heading);
  const original = await panel.textContent();
  await clickInPlace(page, page.getByRole('tab', { name: 'review.md', exact: true }));
  await expect(panel).toContainText('The stronger tool’s assessment.');
  await clickInPlace(page, page.getByRole('tab', { name: 'tasks.md', exact: true }));
  await expect(panel).toHaveText(original ?? '');
});

test('a direct install link is fully readable and copies the exact source commands', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openPage(page, '/#install');
  await expect(page.getByRole('heading', { name: 'Start your next change.' })).toBeInViewport();
  await expect(page.locator('#install .is-decoding')).toHaveCount(0);
  const expected = {
    install: 'npm install -g splitbrief',
    start: 'splitbrief doctor\nsplitbrief init\nsplitbrief start "your change"',
  };
  for (const [name, text] of Object.entries(expected)) {
    const button = page.locator(`[data-copy="${name}"]`);
    await clickInPlace(page, button);
    await expect(button).toHaveText('[ copied ]');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await expect(page.getByRole('status')).toHaveText('Commands copied.');
  }
  await expect(page.locator('[data-copy="start"]')).toHaveText('[ copy ]', { timeout: 4000 });
  await expect(page.getByRole('status')).toBeEmpty();
});

for (const failure of ['denied', 'missing']) {
  test(`clipboard ${failure} keeps commands available and announces a manual fallback`, async ({
    page,
  }) => {
    await page.addInitScript((mode) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value:
          mode === 'missing'
            ? undefined
            : {
                writeText: async () => {
                  throw new Error('Denied');
                },
              },
      });
    }, failure);
    await openPage(page, '/#install');
    await clickInPlace(page, page.locator('[data-copy="install"]'));
    await expect(page.getByRole('status')).toHaveText('Select and copy the commands above.');
    await expect(page.locator('#install-command')).toBeInViewport();
    await expect(page.locator('#install-command')).toContainText('npm install -g splitbrief');
  });
}

test('a late clipboard result cannot replace feedback for the latest click', async ({ page }) => {
  const commands: string[] = [];
  await page.exposeFunction('copyFromBrowser', async (text: string) => {
    commands.push(text);
    if (commands.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      throw new Error('First request denied late');
    }
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => Reflect.get(window, 'copyFromBrowser')(text),
      },
    });
  });
  await openPage(page, '/#install');
  await clickInPlace(page, page.locator('[data-copy="install"]'));
  await clickInPlace(page, page.locator('[data-copy="start"]'));
  await expect(page.locator('[data-copy="start"]')).toHaveText('[ copied ]');
  await page.waitForTimeout(700);
  await expect(page.getByRole('status')).toHaveText('Commands copied.');
  await expect(page.locator('[data-copy="install"]')).toHaveText('[ copy ]');
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe('splitbrief doctor\nsplitbrief init\nsplitbrief start "your change"');
});

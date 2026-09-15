import { expect, test } from '@playwright/test';
import { canvasImage, clickInPlace, openPage, scrollScene } from './browser.js';

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
    ['Install', 'Start with your next change.'],
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

test('resizing through document flow restores readable panels and then scroll decoding', async ({
  page,
}) => {
  await openPage(page, '/#roles');
  const details = page.locator('#details');
  await expect(details).toHaveClass(/is-pinned/);
  await scrollScene(page, '#details', 0.04);
  await expect(page.locator('#roles .decode-layer')).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 580 });
  await expect(details).not.toHaveClass(/is-pinned/);
  await expect(details.locator('.is-decoding')).toHaveCount(0);
  for (const panel of await details.locator('[data-panel]').all()) {
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(details).toHaveClass(/is-pinned/);
  await scrollScene(page, '#details', 0.04);
  await expect(page.locator('#roles .decode-layer')).toBeVisible();
  await scrollScene(page, '#details', 0.15);
  await expect(page.locator('#roles .decode-layer')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Your tools. Your roles.' })).toBeInViewport();
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
  await expect(
    page.getByRole('heading', { name: 'Start with your next change.' }),
  ).toBeInViewport();
  await expect(page.locator('#install .is-decoding')).toHaveCount(0);
  const expected = {
    install:
      'git clone https://github.com/b4r7x/splitbrief.git\ncd splitbrief\nnpm install\nnpm run build\nnpm link',
    start: 'splitbrief init\nsplitbrief start "your change"',
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
    await expect(page.locator('#install-command')).toContainText(
      'git clone https://github.com/b4r7x/splitbrief.git',
    );
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
  expect(commands[1]).toBe('splitbrief init\nsplitbrief start "your change"');
});

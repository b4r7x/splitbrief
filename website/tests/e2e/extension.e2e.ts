import { expect, type Locator, type Page, test } from '@playwright/test';

const HEADINGS = [
  'Description',
  'Signature',
  'Implementation Steps',
  'Tests',
  'Scope',
  'Escalation',
  'Evidence',
  'Constraints',
];

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function box(locator: Locator): Promise<{ left: number; bottom: number; height: number }> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${locator} has no box`);
  return { left: rect.x, bottom: rect.y + rect.height, height: rect.height };
}

async function animations(page: Page, selector: string): Promise<number> {
  return page.evaluate(
    (s) => document.querySelector(s)?.getAnimations({ subtree: true }).length ?? -1,
    selector,
  );
}

async function lastWholeLine(page: Page, heading: string, height: number): Promise<void> {
  const sheet = await box(page.locator('figure.sheet'));
  const line = await box(page.locator('figure.sheet').getByText(heading, { exact: true }));
  expect(Math.abs(sheet.height - height), `sheet height ${sheet.height}`).toBeLessThanOrEqual(1);
  expect(Math.abs(line.bottom - sheet.bottom), heading).toBeLessThanOrEqual(1);
}

test('the brief sheet is the tasks.md card opened and cropped', async ({ page }) => {
  await open(page);
  const sheet = page.locator('figure.sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('figcaption')).toHaveText('tasks.md');
  await expect(sheet.locator('.eyebrow')).toHaveText('TASK BRIEF');
  for (const heading of HEADINGS)
    await expect(sheet.locator('pre')).toContainText(`### ${heading}`);
  await expect(sheet.locator('pre')).toContainText('id: T002');
  expect(await sheet.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const statements = page.locator('section.brief-sheet .statement');
  await expect(statements).toHaveCount(2);
  await expect(statements.nth(1)).toContainText('CONTRACT BLOCKED');
  await expect(page.locator('section.brief-sheet + hr.rule')).toHaveCount(1);
  expect(await animations(page, 'section.brief-sheet')).toBe(0);
  await lastWholeLine(page, '### Evidence', 707);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await lastWholeLine(page, '### Scope', 689);
});

test('the ladder transcript fails test, retries, and passes, in DOM order', async ({ page }) => {
  await open(page);
  const rows = page.locator('ol.transcript li');
  await expect(rows).toHaveCount(13);
  const texts = await rows.allTextContents();
  const failed = texts.findIndex((text) => text.includes('✗ test'));
  const retried = texts.indexOf('retry  attempt 2/3');
  const passed = texts.map((text) => text.includes('✓ test')).lastIndexOf(true);
  expect(failed).toBeGreaterThanOrEqual(0);
  expect(failed).toBeLessThan(retried);
  expect(retried).toBeLessThan(passed);
  expect(texts[0]).toContain('Add the auth guard');
  expect(await page.locator('li.error').textContent()).toBe('error  test');
  await expect(page.locator('figure.run .bar')).toContainText('◉ Build');
  const rungs = page.locator('ol.rungs li');
  await expect(rungs).toHaveCount(6);
  expect(await rungs.nth(4).textContent()).toMatch(/°$/);
  expect(await page.locator('.ladder .fine').textContent()).toMatch(/^°/);
  expect(await animations(page, 'section.ladder')).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  for (const tail of await page.locator('.ladder .tail').all()) await expect(tail).toBeHidden();
  const phases = await box(page.locator('.phases'));
  const now = await box(page.locator('.phases .now'));
  expect(Math.abs(phases.height - 36), 'two lines').toBeLessThanOrEqual(1);
  expect(Math.abs(now.left - phases.left), '◉ Build opens the second line').toBeLessThanOrEqual(1);
});

test('the record lists the session folder and the two commands', async ({ page }) => {
  await open(page);
  const tree = page.locator('pre.tree');
  expect(await tree.textContent()).toMatch(/^\.splitbrief\//);
  for (const entry of ['evidence.json', 'review.md', 'snapshots/']) {
    await expect(tree).toContainText(entry);
  }
  await expect(tree.locator('.note')).toHaveCount(6);
  const commands = page.locator('.record .commands');
  await expect(commands).toContainText('$ splitbrief init');
  await expect(commands).toContainText('splitbrief start "add user auth"');
  await expect(commands.locator('a')).toHaveCount(0);
  await expect(page.locator('.record .fine')).toContainText('Neither is measured yet.');
  await expect(page.locator('.record .fine')).toContainText('MACOS AND LINUX');
  expect(await animations(page, 'section.record')).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  expect(await tree.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const note of await tree.locator('.note').all())
    await expect(note).toHaveCSS('display', 'block');
  expect(Math.abs((await box(commands)).height - 53), 'two one-line commands').toBeLessThanOrEqual(
    2,
  );
});

test('every new claim sits on the col-11 rail', async ({ page }) => {
  await open(page);
  const rail = (await box(page.locator('.routes .claim'))).left;
  for (const section of ['.brief-sheet', '.ladder', '.record']) {
    const { left } = await box(page.locator(`${section} .claim`));
    expect(Math.abs(left - rail), section).toBeLessThanOrEqual(1);
  }
});

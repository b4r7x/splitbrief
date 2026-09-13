import { expect, type Page, test } from '@playwright/test';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

test('the page is nav, hero, three sections, footer', async ({ page }) => {
  await open(page);
  const sel = 'main > section.hero#top, main > .lower > section, footer.foot';
  const ids = ['top', 'briefs', 'validation', 'control', 'foot'];
  expect(await page.locator(sel).evaluateAll((els) => els.map((e) => e.id || e.className))).toEqual(
    ids,
  );
  expect(
    await page.evaluate(() =>
      [
        ...document.querySelectorAll('main > section, main > .lower > section, main > hr, footer'),
      ].map((e) => e.id || e.className),
    ),
  ).toEqual(ids);
});

test('the steps are anchors', async ({ page }) => {
  await open(page);
  const anchors = page.locator('.hero .steps a');
  await expect(anchors).toHaveCount(3);
  const got = await anchors.evaluateAll((els: HTMLElement[]) => ({
    hrefs: els.map((el) => el.getAttribute('href')),
    texts: els.map((el) => el.textContent?.trim()),
    sizes: els.map((el) => ({ r: el.getBoundingClientRect().height, b: el.offsetHeight })),
    ok: els
      .map((el) => el.getAttribute('href'))
      .every((href) => href !== null && document.querySelector(href) !== null),
  }));
  expect(got.hrefs).toEqual(['#top', '#briefs', '#validation']);
  expect(got.texts).toEqual(['HERO', 'BRIEFS', 'VALIDATION']);
  expect(got.ok).toBe(true);
  for (const { r, b } of got.sizes) expect(b >= 24 && r >= 23.99).toBe(true);
  for (let n = 0; n < 4; n++) await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    const s = el ? getComputedStyle(el) : undefined;
    return { text: el?.textContent?.trim(), outline: `${s?.outlineWidth} ${s?.outlineStyle}` };
  });
  expect(ring).toEqual({ text: 'HERO', outline: '2px solid' });
});

test('the h2 names are the titles', async ({ page }) => {
  await open(page);
  for (const name of ['Before any code', 'After every task', 'For the whole run']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
});

test('the brief, failed check, retry and saved evidence tell a complete run', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const editor = page.locator('.s02 .panel');
  await expect(editor.locator('ol.lines li')).toHaveCount(36);
  await expect(editor.locator('.h')).toHaveText([
    '# TASK BRIEF',
    '## Description',
    '## Signature',
    '## Implementation Steps',
    '## Tests',
    '## Scope',
    '## Escalation',
    '## Evidence',
  ]);
  for (const text of [
    'tasks.md',
    'depends_on: [T001]',
    'src/auth/guard.ts',
    'Include test output and typecheck logs in the task result',
  ]) {
    await expect(editor).toContainText(text);
  }
  const terminal = page.locator('.s03 .panel');
  await expect(terminal.locator('.bar')).toContainText('splitbrief start');
  await expect(terminal.locator('.bar')).toContainText('example run');
  await expect(terminal.locator('ol.lines li')).toHaveCount(21);
  const transcript = await terminal.locator('.lines .t').allTextContents();
  const failure = transcript.findIndex((row) =>
    row.includes('expected AuthError for expired token'),
  );
  const retry = transcript.findIndex((row) => row.includes('retry 2/3'));
  const pass = transcript.findIndex((row) => row.includes('3/3 tests passing'));
  const saved = transcript.findIndex((row) => row.includes('Evidence saved to'));
  expect(failure).toBeGreaterThanOrEqual(0);
  expect(retry).toBeGreaterThan(failure);
  expect(pass).toBeGreaterThan(retry);
  expect(saved).toBeGreaterThan(pass);
  await expect(terminal).toContainText('Task complete');
  await expect(page.locator('pre.tree .row')).toHaveCount(9);
  await expect(page.locator('pre.tree .note')).toHaveCount(5);
  for (const file of [
    'state.json',
    'session.jsonl',
    'spec.md',
    'plan.md',
    'tasks.md',
    'evidence.json',
    'review.md',
    'snapshots/',
  ]) {
    await expect(page.locator('pre.tree')).toContainText(file);
  }
});

import { expect, type Page, test } from '@playwright/test';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

const STRINGS: Record<string, string[]> = {
  '.s02': [
    'BEFORE ANY CODE',
    'ONE FILE.',
    'NOTHING ELSE.',
    'BRIEFS',
    'CLARITY',
    'tasks.md',
    'Ln 1, Col 1',
    'markdown',
    '# TASK BRIEF',
    'depends_on: [T001]',
    '## Evidence',
    'Include test output and typecheck logs in the task result',
    'no memory of the last one.',
    'scope, file, dependencies, signature',
    'CLEAR INPUTS.',
    'REVIEW',
  ],
  '.s03': [
    'AFTER EVERY TASK',
    'KEEP THE EVIDENCE.',
    'splitbrief run',
    'task: T002',
    '14:28:16',
    'Spec → Plan → Briefs → Build → Verify',
    '✗ test',
    'expected AuthError for expired token',
    'retry 2/3',
    'PASS',
    '3/3 tests passing (412ms)',
    'Task complete',
    '.splitbrief/sessions/2026-03-08-auth-guard/',
    "Correctness is not the implementer's to judge.",
    'HIGHER QUALITY',
    'YOUR RULES',
    'IMPROVE',
  ],
  '.s04': [
    'FOR THE WHOLE RUN',
    'WHAT YOU SET.',
    'on disk when it stops.',
    'WORKS WITH',
    'CLAUDE CODE',
    'KILO CODE',
    'LM STUDIO',
    '[ configuration ]',
    '[ features ]',
    'CONTRACTS OVER CONTEXT.',
    'SMALLER LOOPS. BETTER OUTPUT.',
    'evidence.json',
    'snapshots/',
    'LIMITS',
    'EVIDENCE',
  ],
  '.foot': ['BUILDS BETTER SOFTWARE.', '[ docs ]', '[ github ]', 'PLANS / EXECUTES / REVIEWS'],
};

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

test('every §16.10 string is on the page', async ({ page }) => {
  await open(page);
  for (const [sel, strings] of Object.entries(STRINGS)) {
    for (const s of strings)
      await expect(page.locator(sel)).toContainText(s, { useInnerText: true });
  }
});

test('whispers are decorative DOM', async ({ page }) => {
  await open(page);
  await expect(page.locator('.s02 .marg-a')).toHaveText('// contracts over context');
  await expect(page.locator('.s02 .marg-b')).toContainText('less context');
  await expect(page.locator('.s02 .marg-b')).toContainText('more progress.');
  await expect(page.locator('.s03 .marg-a')).toHaveText('// not its own judge');
  for (const s of ['A SMALLER LOOP', 'A HIGHER BAR', 'REAL PROGRESS']) {
    await expect(page.locator('.s03 .marg-b')).toContainText(s);
  }
  await expect(page.locator('.s04 .marg-a')).toHaveText('// your tools, your models, your rules');
  await expect(page.locator('.s04 .marg-b')).toContainText('smaller loops');
  await expect(page.locator('.s04 .marg-b')).toContainText('higher confidence.');
  await expect(page.locator('.marg:not([aria-hidden="true"])')).toHaveCount(0);
});

test('the h2 names are the titles', async ({ page }) => {
  await open(page);
  for (const name of ['Before any code', 'After every task', 'For the whole run']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
});

test('counts', async ({ page }) => {
  await open(page);
  await expect(page.locator('.s02 ol.lines li')).toHaveCount(36);
  await expect(page.locator('.s02 .h')).toHaveCount(8);
  await expect(page.locator('.s03 ol.lines li')).toHaveCount(21);
  await expect(page.locator('.s03 .mk')).toHaveCount(9);
  await expect(page.locator('.s03 .ok')).toHaveCount(6);
  await expect(page.locator('.s03 .err')).toHaveCount(2);
  await expect(page.locator('.s03 .fail')).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const fail = document.querySelector('.s03 .fail');
      const pass = document.querySelector('.s03 .pass');
      const prop = (el: Element, name: string) =>
        el instanceof HTMLElement ? el.style.getPropertyValue(name).trim() : '';
      return (
        !!fail &&
        !!pass &&
        (fail.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
        [...document.querySelectorAll('ol.lines')].every((ol) =>
          [...ol.querySelectorAll('li')].every((li, i) => prop(li, '--row') === String(i + 1)),
        ) &&
        [...document.querySelectorAll('.s03 .lines li:nth-child(n+13)')].every(
          (li) => prop(li, '--beat') === '1',
        )
      );
    }),
  ).toBe(true);
  await expect(page.locator('.s03 ol.steps li')).toHaveCount(5);
  await expect(page.locator('.s04 .links a')).toHaveCount(2);
  await expect(page.locator('pre.tree .row')).toHaveCount(9);
  await expect(page.locator('pre.tree .note')).toHaveCount(5);
  const lists = page.locator('.marg-list');
  await expect(lists).toHaveCount(3);
  expect(
    await lists.evaluateAll((els) => els.every((el) => el.innerHTML.split('<br>').length === 5)),
  ).toBe(true);
  await expect(page.locator('.marg')).toHaveCount(6);
});

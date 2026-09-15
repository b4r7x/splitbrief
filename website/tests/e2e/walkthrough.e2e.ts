import { expect, test } from '@playwright/test';
import { clickInPlace, openPage, scrollScene, settleScenes } from './browser.js';

const chapters = [
  ['Plan', 'Turn a request into a plan.'],
  ['Brief', 'Give the next tool a complete job.'],
  ['Build', 'One brief in. A scoped change out.'],
  ['Check', 'Check the work. Keep the evidence.'],
  ['Review', 'Bring the planner back to the diff.'],
  ['Saved', 'The handoff leaves a trail.'],
] as const;

test('all six workflow steps work by pointer and keyboard on desktop and phone', async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openPage(page);
    for (const [index, [name, heading]] of chapters.entries()) {
      const button = page
        .getByRole('navigation', { name: 'Choose a workflow step' })
        .getByRole('button', { name: new RegExp(name ?? '') });
      if (index % 2) {
        await button.focus();
        await page.keyboard.press('Enter');
      } else await clickInPlace(page, button);
      await expect(button).toHaveAttribute('aria-current', 'step');
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeInViewport();
      if (index === 0) {
        for (const reveal of await page.locator('#plan [data-reveal]').all()) {
          await expect(reveal).toHaveCSS('clip-path', 'none');
        }
      }
    }
    await expect(page.locator('.closed')).toBeInViewport();
  }
});

test('the terminal stays centered while its content advances and reverses', async ({ page }) => {
  await openPage(page);
  const terminal = await page.locator('.terminal').boundingBox();
  if (!terminal) throw new Error('Terminal is missing');
  expect(terminal.x + terminal.width / 2).toBeCloseTo(720, 0);
  const snapshots: string[] = [];
  for (const progress of [0.02, 0.3, 0.67, 0.96, 0.3]) {
    await scrollScene(page, '[data-scroll-track]', progress);
    await settleScenes(page);
    const position = await page.locator('.terminal').boundingBox();
    expect(position?.x).toBe(terminal.x);
    expect(position?.y).toBe(terminal.y);
    snapshots.push(
      await page
        .locator('.work-document')
        .evaluate((element) => getComputedStyle(element).transform),
    );
  }
  expect(new Set(snapshots.slice(0, 4)).size).toBe(4);
  expect(snapshots[1]).toBe(snapshots[4]);
  await scrollScene(page, '[data-scroll-track]', 1);
  await page.mouse.wheel(0, 900);
  await expect(page.getByText('Plan. Hand off. Verify.', { exact: false })).toBeInViewport();
});

test('choosing a workflow step moves through intermediate positions before landing', async ({
  page,
}) => {
  await openPage(page);
  const document = page.locator('.work-document');
  const destination = await page
    .locator('#brief')
    .evaluate((element) => (element instanceof HTMLElement ? element.offsetTop : 0));
  expect(destination).toBeGreaterThan(0);
  const intermediate = page.waitForFunction(
    (destination) => {
      const document = window.document.querySelector('.work-document');
      if (!document) throw new Error('Workflow document is missing');
      const offset = -new DOMMatrixReadOnly(getComputedStyle(document).transform).m42;
      return offset > 1 && offset < destination - 1;
    },
    destination,
    { polling: 'raf' },
  );
  await clickInPlace(page, page.getByRole('button', { name: /Brief Human approval/ }));
  await intermediate;
  await expect
    .poll(() =>
      document.evaluate(
        (element) => -new DOMMatrixReadOnly(getComputedStyle(element).transform).m42,
      ),
    )
    .toBeCloseTo(destination, 0);
  await expect(
    page.getByRole('heading', { name: 'Give the next tool a complete job.' }),
  ).toBeInViewport();
});

test('low-height screens use ordinary flow and still reach every chapter', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 580 });
  await openPage(page);
  for (const [, heading] of chapters) {
    const title = page.getByRole('heading', { name: heading, exact: true });
    await title.scrollIntoViewIfNeeded();
    await expect(title).toBeInViewport();
  }
  await page.goto('/#install');
  await expect(
    page.getByRole('heading', { name: 'Start with your next change.' }),
  ).toBeInViewport();
  await page.locator('#start-command').scrollIntoViewIfNeeded();
  await expect(page.locator('#start-command')).toBeInViewport();
});

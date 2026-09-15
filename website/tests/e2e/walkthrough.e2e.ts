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

test('choosing a workflow step reaches its heading without a delayed document slide', async ({
  page,
}) => {
  await openPage(page);
  const destination = await page
    .locator('#brief')
    .evaluate((element) => (element instanceof HTMLElement ? element.offsetTop : 0));
  expect(destination).toBeGreaterThan(0);
  await clickInPlace(page, page.getByRole('button', { name: /Brief Human approval/ }));
  const offsets = await page.locator('.work-document').evaluate(async (element) => {
    const offsets: number[] = [];
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      offsets.push(-new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);
    }
    return offsets;
  });
  for (const offset of offsets) expect(offset).toBeCloseTo(destination, 0);
  await expect(
    page.getByRole('heading', { name: 'Give the next tool a complete job.' }),
  ).toBeInViewport();
});

test('a scroll burst softens only the terminal and finishes without a long tail', async ({
  page,
}) => {
  await openPage(page);
  const result = await page.evaluate(async () => {
    const track = document.querySelector('[data-scroll-track]');
    const stage = document.querySelector('[data-scroll-stage]');
    const transcript = document.querySelector('.work-document');
    const brief = document.querySelector('#brief');
    if (!track || !stage || !transcript || !(brief instanceof HTMLElement))
      throw new Error('Workflow is missing');
    const bounds = track.getBoundingClientRect();
    scrollTo({
      top: scrollY + bounds.top + (bounds.height - stage.clientHeight) * 0.24,
      behavior: 'instant',
    });
    const position = scrollY;
    const started = performance.now();
    const frames: Array<{ elapsed: number; y: number; offset: number }> = [];
    while (performance.now() - started < 300) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push({
        elapsed: performance.now() - started,
        y: scrollY,
        offset: -new DOMMatrixReadOnly(getComputedStyle(transcript).transform).m42,
      });
    }
    return { position, destination: brief.offsetTop, frames };
  });
  expect(new Set(result.frames.map((frame) => frame.y))).toEqual(new Set([result.position]));
  const intermediate = result.frames.filter(
    (frame) => frame.offset > 1 && frame.offset < result.destination - 1,
  );
  expect(new Set(intermediate.map((frame) => frame.offset)).size).toBeGreaterThan(2);
  const reached = result.frames.find((frame) => Math.abs(frame.offset - result.destination) < 0.01);
  expect(reached?.elapsed).toBeLessThan(200);
  expect(result.frames.at(-1)?.offset).toBe(result.destination);
  expect(
    result.frames
      .filter((frame) => frame.elapsed >= 200)
      .every((frame) => frame.offset === result.destination),
  ).toBe(true);
});

test('scrolling onward from a clicked chapter keeps its content revealed', async ({ page }) => {
  await openPage(page);
  await clickInPlace(page, page.getByRole('button', { name: /Build Smaller tool/ }));
  await settleScenes(page);
  const frames = await page.evaluate(async () => {
    const track = document.querySelector('[data-scroll-track]');
    const stage = document.querySelector('[data-scroll-stage]');
    const transcript = document.querySelector('.work-document');
    const build = document.querySelector('#build');
    if (!track || !stage || !transcript || !(build instanceof HTMLElement))
      throw new Error('Workflow is missing');
    const snapshot = () => ({
      offset: -new DOMMatrixReadOnly(getComputedStyle(transcript).transform).m42 - build.offsetTop,
      revealed: [...build.querySelectorAll('[data-reveal]')].every(
        (node) => getComputedStyle(node).clipPath === 'none',
      ),
    });
    const frames = [snapshot()];
    const observer = new MutationObserver(() => frames.push(snapshot()));
    observer.observe(transcript, { attributes: true, subtree: true, attributeFilter: ['style'] });
    const bounds = track.getBoundingClientRect();
    scrollTo({
      top: scrollY + bounds.top + (bounds.height - stage.clientHeight) * 0.6,
      behavior: 'instant',
    });
    for (let frame = 0; frame < 12; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    observer.disconnect();
    return frames;
  });
  expect(frames[0]?.offset).toBeCloseTo(0, 1);
  expect(frames.at(-1)?.offset).toBeGreaterThan(1);
  expect(frames.every((frame) => frame.revealed)).toBe(true);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 1024, height: 580 },
]) {
  test(`the terminal holds complete chapters at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openPage(page);
    await expect(page.locator('[data-scroll-track]')).toHaveAttribute('data-pinned', 'true');
    await scrollScene(page, '[data-scroll-track]', 0.02);
    const terminal = await page.locator('.terminal').boundingBox();
    const window = await page.locator('.work-window').boundingBox();
    if (!terminal || !window) throw new Error('Pinned terminal is missing');
    expect(terminal.y).toBeCloseTo(12, 0);
    expect(window.height).toBeGreaterThanOrEqual(200);
    const positions: string[] = [];
    const endings = [
      [0.12, '#plan .document-note'],
      [0.31, '#brief .approval'],
      [0.48, '#build .receipt'],
      [0.68, '#check .receipt'],
      [0.84, '#review .document-note'],
      [1, '#saved .closed'],
    ] as const;
    for (const [index, [progress, selector]] of endings.entries()) {
      const chapter = chapters[index];
      if (!chapter) throw new Error('Workflow chapter is incomplete');
      await clickInPlace(
        page,
        page.getByRole('navigation', { name: 'Choose a workflow step' }).getByRole('button', {
          name: new RegExp(`^${chapter[0]}`),
        }),
      );
      await settleScenes(page);
      const initialOffset = await page
        .locator('.work-document')
        .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);
      await scrollScene(page, '[data-scroll-track]', Math.max(0, progress - 0.0005));
      await settleScenes(page);
      expect(await page.locator('.terminal').boundingBox()).toEqual(terminal);
      const heading = await page
        .getByRole('heading', { name: chapter[1], exact: true })
        .boundingBox();
      const ending = await page.locator(selector).boundingBox();
      if (!heading || !ending) throw new Error('Chapter text is missing');
      expect(heading.y).toBeGreaterThanOrEqual(window.y - 1);
      expect(ending.y).toBeGreaterThanOrEqual(window.y - 1);
      expect(ending.y + ending.height).toBeLessThanOrEqual(window.y + window.height + 1);
      await expect(page.locator(selector)).toHaveCSS('clip-path', 'none');
      expect(
        await page
          .locator('.work-document')
          .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42),
      ).toBeCloseTo(initialOffset, 0);
      positions.push(
        await page
          .locator('.work-document')
          .evaluate((element) => getComputedStyle(element).transform),
      );
    }
    await scrollScene(page, '[data-scroll-track]', 0.3095);
    await settleScenes(page);
    expect(
      await page
        .locator('.work-document')
        .evaluate((element) => getComputedStyle(element).transform),
    ).toBe(positions[1]);
    await clickInPlace(page, page.getByRole('button', { name: 'Build', exact: true }));
    await expect(
      page.getByRole('heading', { name: 'One brief in. A scoped change out.' }),
    ).toBeInViewport();
    await scrollScene(page, '[data-scroll-track]', 1);
    await page.mouse.wheel(0, viewport.height);
    await expect(page.getByText('Plan. Hand off. Verify.', { exact: false })).toBeInViewport();
  });
}

test('workflow chapters remain operable after orientation and motion preference changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openPage(page);
  const check = page.getByRole('button', { name: 'Check', exact: true });
  await clickInPlace(page, check);
  await expect(check).toHaveAttribute('aria-current', 'step');
  await settleScenes(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await check.click();
  await expect(check).toHaveAttribute('aria-current', 'step');
  await expect(
    page.getByRole('heading', { name: 'Check the work. Keep the evidence.' }),
  ).toBeInViewport();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await check.focus();
  await page.keyboard.press('Enter');
  await expect(check).toHaveAttribute('aria-current', 'step');
  await scrollScene(page, '[data-scroll-track]', 1);
  await expect(page.locator('.closed')).toBeInViewport();
  await expect(page.locator('.closed')).toHaveCSS('clip-path', 'none');
});

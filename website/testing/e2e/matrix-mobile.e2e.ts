import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

async function expectRadioGroupContract(group: Locator): Promise<void> {
  const radios = group.getByRole('radio');
  await expect(radios).toHaveCount(6);
  await expect(group.getByRole('radio', { checked: true })).toHaveCount(1);
  expect(
    await radios.evaluateAll(
      (elements) =>
        elements.filter((element) => element instanceof HTMLElement && element.tabIndex === 0)
          .length,
    ),
  ).toBe(1);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(
    widths.scroll,
    `page scroll width ${widths.scroll}px exceeds ${widths.client}px`,
  ).toBeLessThanOrEqual(widths.client);
}

test('keeps the native mobile picker operable and preserves its pair across 699/700', async ({
  page,
}) => {
  const runtimeFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeFailures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => runtimeFailures.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => {
    runtimeFailures.push(`request: ${request.url()} (${request.failure()?.errorText})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      runtimeFailures.push(`response: ${response.status()} ${response.url()}`);
    }
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const matrix = page.getByRole('region', { name: 'Planner and implementer pairing' });
  const plannerGroup = matrix.getByRole('radiogroup', { name: 'Planner' });
  const implementerGroup = matrix.getByRole('radiogroup', { name: 'Implementer' });
  const groups = matrix.getByRole('radiogroup');
  const status = matrix.getByRole('status');
  const output = matrix.getByRole('figure', { name: 'Generated config' });

  await expect(matrix.locator('.matrix__controls')).not.toHaveAttribute('inert', '');
  await expect(groups).toHaveCount(2);
  await expect(matrix.getByRole('grid')).toHaveCount(0);
  await expect(matrix.locator('[data-matrix-layout="mobile"]')).toHaveCount(1);
  await expect(matrix.locator('[data-matrix-layout="desktop"]')).toHaveCount(0);
  await expect(matrix.locator('[data-matrix-prerender]')).toHaveCount(0);
  await expectRadioGroupContract(plannerGroup);
  await expectRadioGroupContract(implementerGroup);

  const claudeCode = plannerGroup.getByRole('radio', { name: 'Claude Code' });
  const codex = plannerGroup.getByRole('radio', { name: 'Codex' });
  const ollama = implementerGroup.getByRole('radio', { name: 'Ollama' });
  const together = implementerGroup.getByRole('radio', { name: 'Together AI' });
  await expect(claudeCode).toBeChecked();
  await expect(ollama).toBeChecked();

  await claudeCode.focus();
  await page.keyboard.press('ArrowRight');
  await expect(codex).toBeFocused();
  await expect(codex).toBeChecked();
  await expect(ollama).toBeChecked();
  await expect(status).toHaveText('Config updated: codex × ollama');

  await ollama.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(together).toBeFocused();
  await expect(together).toBeChecked();
  await expect(codex).toBeChecked();
  await expect(status).toHaveText('Config updated: codex × together');
  await expectRadioGroupContract(plannerGroup);
  await expectRadioGroupContract(implementerGroup);

  const focusAppearance = await together.evaluate((input) => {
    const option = input.closest('label');
    if (!option) throw new Error('Radio has no visible label target');
    const style = getComputedStyle(option);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusAppearance.outlineStyle).not.toBe('none');
  expect(focusAppearance.outlineWidth).toBe('2px');

  const targetSizes = await groups.getByRole('radio').evaluateAll((radios) =>
    radios.map((radio) => {
      const option = radio.closest('label');
      if (!option) throw new Error('Radio has no visible label target');
      const bounds = option.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    }),
  );
  for (const size of targetSizes) {
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }

  await expect(status).toHaveCount(1);
  expect(await output.getAttribute('aria-live')).toBeNull();
  await expect(output.locator('[aria-live]')).toHaveCount(0);
  await expect(output.locator('code')).toContainText('tool: codex');
  await expect(output.locator('code')).toContainText('provider: together');
  await expectNoPageOverflow(page);

  const axeResults = await new AxeBuilder({ page }).analyze();
  expect(
    [...axeResults.passes, ...axeResults.incomplete, ...axeResults.violations].some(
      (result) => result.id === 'color-contrast',
    ),
  ).toBe(true);
  expect(axeResults.violations.map((violation) => violation.id)).toEqual([]);

  await page.setViewportSize({ width: 699, height: 844 });
  await expect(matrix.getByRole('radiogroup')).toHaveCount(2);
  await expect(matrix.getByRole('grid')).toHaveCount(0);
  await expect(matrix.locator('[data-matrix-layout="mobile"]')).toHaveCount(1);
  await expect(plannerGroup.getByRole('radio', { name: 'Codex' })).toBeChecked();
  await expect(implementerGroup.getByRole('radio', { name: 'Together AI' })).toBeChecked();
  await expect(implementerGroup.getByRole('radio', { name: 'Together AI' })).toBeFocused();
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 700, height: 844 });
  const grid = matrix.getByRole('grid', { name: 'Planner × implementer pairings' });
  const selectedCell = grid.getByRole('gridcell', { selected: true });
  await expect(grid).toBeVisible();
  await expect(matrix.getByRole('radiogroup')).toHaveCount(0);
  await expect(matrix.locator('[data-matrix-layout="desktop"]')).toHaveCount(1);
  await expect(matrix.locator('[data-matrix-layout="mobile"]')).toHaveCount(0);
  await expect(selectedCell).toHaveCount(1);
  await expect(selectedCell).toHaveAccessibleName('Codex Together AI');
  await expect(selectedCell).toBeFocused();
  await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 699, height: 844 });
  await expect(matrix.getByRole('radiogroup')).toHaveCount(2);
  await expect(matrix.getByRole('grid')).toHaveCount(0);
  await expect(matrix.locator('[data-matrix-layout="mobile"]')).toHaveCount(1);
  await expect(matrix.locator('[data-matrix-layout="desktop"]')).toHaveCount(0);
  await expect(plannerGroup.getByRole('radio', { name: 'Codex' })).toBeChecked();
  await expect(implementerGroup.getByRole('radio', { name: 'Together AI' })).toBeChecked();
  await expect(implementerGroup.getByRole('radio', { name: 'Together AI' })).toBeFocused();
  await expectNoPageOverflow(page);

  const docsLink = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: '[ docs ]' });
  await docsLink.focus();
  await page.setViewportSize({ width: 700, height: 844 });
  await expect(grid).toBeVisible();
  await expect(docsLink).toBeFocused();

  await selectedCell.focus();
  await page.keyboard.press('ArrowLeft');
  const unselectedCell = grid.getByRole('gridcell', { name: 'Codex OpenRouter' });
  await expect(unselectedCell).toBeFocused();
  await expect(unselectedCell).toHaveAttribute('aria-selected', 'false');

  await page.setViewportSize({ width: 699, height: 844 });
  await expect(implementerGroup.getByRole('radio', { name: 'Together AI' })).toBeChecked();
  await expect(implementerGroup.getByRole('radio', { name: 'Together AI' })).toBeFocused();
  expect(runtimeFailures).toEqual([]);
});

test('hands focus off immediately after the responsive picker hydrates', async ({ page }) => {
  await page.setViewportSize({ width: 699, height: 844 });
  await page.goto('/');

  const matrix = page.getByRole('region', { name: 'Planner and implementer pairing' });
  await expect(matrix.locator('.matrix__controls')).not.toHaveAttribute('inert', '');
  const ollama = matrix.getByRole('radio', { name: 'Ollama' });
  await ollama.focus();

  await page.setViewportSize({ width: 700, height: 844 });
  const selectedCell = matrix.getByRole('gridcell', {
    name: 'Claude Code Ollama',
    selected: true,
  });
  await expect(selectedCell).toBeFocused();

  await page.setViewportSize({ width: 699, height: 844 });
  await expect(matrix.getByRole('radio', { name: 'Ollama' })).toBeFocused();
});

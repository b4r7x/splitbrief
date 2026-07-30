import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { parse } from 'yaml';

async function readCrosshair(grid: Locator) {
  return grid.evaluate((element) => {
    const rows = Array.from(element.querySelectorAll<HTMLElement>('.matrix-grid__row-header'))
      .filter(
        (header) => getComputedStyle(header, '::before').backgroundColor !== 'rgba(0, 0, 0, 0)',
      )
      .map((header) => header.dataset.planner);
    const columns = Array.from(element.querySelectorAll<HTMLElement>('.matrix-grid__column-header'))
      .filter(
        (header) => getComputedStyle(header, '::before').backgroundColor !== 'rgba(0, 0, 0, 0)',
      )
      .map((header) => header.dataset.implementer);
    const focused = element.querySelector<HTMLElement>('.matrix-grid__cell:focus-visible');
    const focusStyle = focused ? getComputedStyle(focused) : null;

    return {
      columns,
      focused: focused ? `${focused.dataset.planner}:${focused.dataset.implementer}` : null,
      focusOutlineStyle: focusStyle?.outlineStyle ?? null,
      focusOutlineWidth: focusStyle?.outlineWidth ?? null,
      rows,
    };
  });
}

test('operates the complete desktop patch field and emits a runnable config', async ({
  context,
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

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const matrix = page.getByRole('region', { name: 'Planner and implementer pairing' });
  const grid = matrix.getByRole('grid', { name: 'Planner × implementer pairings' });
  const cells = grid.getByRole('gridcell');
  const status = matrix.getByRole('status');
  const output = matrix.getByRole('figure', { name: 'Generated config' });
  const controls = matrix.locator('.matrix__controls');

  await expect(controls).not.toHaveAttribute('inert', '');
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('columnheader')).toHaveCount(6);
  await expect(grid.getByRole('rowheader')).toHaveCount(6);
  await expect(cells).toHaveCount(36);
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveCount(1);
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveAccessibleName(
    'Claude Code Ollama',
  );
  await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText('');
  expect(await output.getAttribute('aria-live')).toBeNull();
  await expect(output.locator('[aria-live]')).toHaveCount(0);

  const defaultCell = grid.getByRole('gridcell', { name: 'Claude Code Ollama' });
  const codexLmStudio = grid.getByRole('gridcell', { name: 'Codex LM Studio' });
  await defaultCell.focus();
  await expect
    .poll(() => readCrosshair(grid))
    .toEqual({
      columns: ['ollama'],
      focused: 'claude-code:ollama',
      focusOutlineStyle: 'solid',
      focusOutlineWidth: '2px',
      rows: ['claude-code'],
    });

  await grid.getByRole('gridcell', { name: 'Anthropic OpenRouter' }).hover();
  await expect
    .poll(() => readCrosshair(grid))
    .toEqual({
      columns: ['openrouter'],
      focused: 'claude-code:ollama',
      focusOutlineStyle: 'solid',
      focusOutlineWidth: '2px',
      rows: ['anthropic'],
    });

  await page.mouse.move(0, 0);
  await expect
    .poll(() => readCrosshair(grid))
    .toEqual({
      columns: ['ollama'],
      focused: 'claude-code:ollama',
      focusOutlineStyle: 'solid',
      focusOutlineWidth: '2px',
      rows: ['claude-code'],
    });

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(codexLmStudio).toBeFocused();
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveAccessibleName(
    'Claude Code Ollama',
  );
  await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
  await expect(status).toHaveText('');

  await page.keyboard.press('Enter');
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveAccessibleName(
    'Codex LM Studio',
  );
  await expect(status).toHaveText('Config updated: codex × lm-studio');

  await page.keyboard.press('End');
  await expect(grid.getByRole('gridcell', { name: 'Codex Together AI' })).toBeFocused();
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveAccessibleName(
    'Codex LM Studio',
  );
  await page.keyboard.press('Home');
  await expect(grid.getByRole('gridcell', { name: 'Codex Ollama' })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveAccessibleName('Codex Ollama');

  await grid.getByRole('gridcell', { name: 'Aider Groq' }).click();
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveAccessibleName('Aider Groq');
  await expect(status).toHaveText('Config updated: aider × groq');

  const yaml = await output.locator('code').textContent();
  if (yaml === null) throw new Error('Generated config has no text');
  expect(parse(yaml)).toMatchObject({
    version: 3,
    planner: { kind: 'cli', tool: 'aider' },
    implementer: {
      kind: 'api',
      provider: 'groq',
      apiBase: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
    },
    validation: { typecheck: true, lint: true, test: true },
    workflow: { mode: 'standard', maxRetries: 3 },
  });
  expect(yaml).not.toContain('baseUrl');
  await output.getByRole('button', { name: 'Copy generated configuration' }).click();
  await expect(output.getByRole('button', { name: 'Configuration copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(yaml);

  const targetSizes = await cells.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    }),
  );
  for (const size of targetSizes) {
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  const copyBounds = await output.getByRole('button').boundingBox();
  if (!copyBounds) throw new Error('Copy action has no rendered hit target');
  expect(copyBounds.width).toBeGreaterThanOrEqual(44);
  expect(copyBounds.height).toBeGreaterThanOrEqual(44);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const pulseControls = matrix.locator('[data-active-row-index]');
  const previousYaml = await output.locator('code').textContent();
  await grid.getByRole('gridcell', { name: 'Agent SDK Together AI' }).click();
  await expect(pulseControls).toHaveAttribute('data-pulse', 'active');
  expect(await output.locator('code').textContent()).toBe(previousYaml);
  await expect(pulseControls).not.toHaveAttribute('data-pulse', 'active', { timeout: 1_500 });
  await expect(status).toHaveText('Config updated: agent-sdk × together');
  await expect(output.locator('code')).toContainText('model: zai-org/GLM-5.1');

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const axeResults = await new AxeBuilder({ page }).analyze();
  expect(
    [...axeResults.passes, ...axeResults.incomplete, ...axeResults.violations].some(
      (result) => result.id === 'color-contrast',
    ),
  ).toBe(true);
  expect(axeResults.violations.map((violation) => violation.id)).toEqual([]);
  expect(runtimeFailures).toEqual([]);
});

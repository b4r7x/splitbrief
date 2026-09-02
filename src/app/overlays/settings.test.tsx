import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { buildSettingsItems, settingsItemDescription } from '../../features/settings/items.js';
import { SettingsOverlay } from './settings.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ENTER = String.fromCharCode(13);
const RAW_TEST_COMMAND = `safe${ESC}]8;;http://evil${BEL}${ESC}[31mcmd`;

const PLANNER_WITH_EFFORT = { kind: 'cli', tool: 'claude-code', effort: 'high' } as const;
const API_REVIEWER = {
  kind: 'api',
  provider: 'custom-endpoint',
  service: 'custom-endpoint',
  offering: 'payg',
  model: 'qwen3-coder',
  apiBase: 'https://api.example.test/v1',
  apiKey: 'test-key',
} as const;

let projectDir = '';

function seed(overrides?: Parameters<typeof makeConfig>[0]): void {
  configStore.__testReset({ projectDir, config: makeConfig(overrides) });
}

function renderAt(cols: number, rows: number) {
  terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 120 });
  return renderFeature(<SettingsOverlay />, { cols, rows });
}

function frameLines(ui: { lastFrame: () => string }): string[] {
  return stripAnsiStyles(ui.lastFrame())
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function topBorderRow(lines: string[]): number {
  return lines.findIndex((line) => /^\s*[╭+]/.test(line));
}

function lineWith(lines: string[], needle: string): string | undefined {
  return lines.find((line) => line.includes(needle));
}

function indexOfLine(lines: string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

describe('SettingsOverlay', () => {
  beforeEach(() => {
    projectDir = createTempDir('settings-overlay');
    seed({ validation: { testCommand: RAW_TEST_COMMAND } });
    overlayStore.reset();
    feedbackStore.reset();
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('opens on the crew rail, above every tuning row', async () => {
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);

    const rail = [
      indexOfLine(lines, 'PLAN'),
      indexOfLine(lines, 'effort'),
      indexOfLine(lines, 'BUILD'),
      indexOfLine(lines, 'REVIEW'),
    ];
    expect(rail).toEqual([...rail].toSorted((a, b) => a - b));
    expect(rail[0]).toBeGreaterThan(indexOfLine(lines, 'Crew'));
    for (const index of rail) expect(index).toBeLessThan(indexOfLine(lines, 'Temperature'));

    ui.unmount();
  });

  it('renders the Workflow section above the Validation section', async () => {
    overlayStore.open('settings', 'validation.lint');
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);

    const workflowRowIndex = indexOfLine(lines, 'Commit strategy');
    const validationRowIndex = indexOfLine(lines, 'Lint');

    expect(workflowRowIndex).toBeGreaterThan(-1);
    expect(validationRowIndex).toBeGreaterThan(-1);
    expect(workflowRowIndex).toBeLessThan(validationRowIndex);

    ui.unmount();
  });

  it.each(['seat:plan', 'effort:plan', 'seat:build', 'seat:review'])(
    'keeps all three seat rows on screen at 60x18 with the cursor on %s',
    async (focus) => {
      seed({ planner: PLANNER_WITH_EFFORT });
      overlayStore.open('settings', focus);
      const ui = renderAt(60, 18);
      await flushEffects();
      const lines = frameLines(ui);

      expect(lineWith(lines, 'PLAN')).toBeDefined();
      expect(lineWith(lines, 'BUILD')).toBeDefined();
      expect(lineWith(lines, 'REVIEW')).toBeDefined();

      ui.unmount();
    },
  );

  it('keeps the effort rows while hiding the YAML-only escalation tier at 60x18', async () => {
    seed({
      planner: PLANNER_WITH_EFFORT,
      reviewer: API_REVIEWER,
      escalation: {
        intermediateProvider: 'ollama',
        intermediateModel: 'llama3.1',
      },
    });
    const ui = renderAt(60, 18);
    await flushEffects();
    const lines = frameLines(ui);

    expect(lines.filter((line) => line.includes('effort'))).toHaveLength(3);
    expect(lineWith(lines, 'escalate')).toBeUndefined();
    expect(lineWith(lines, 'REVIEW')).toBeDefined();

    ui.unmount();
  });

  it('renders 6 crew rows and cycling effort changes only that row with zero geometry jumps', async () => {
    seed({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' },
      reviewer: API_REVIEWER,
    });
    overlayStore.open('settings', 'effort:plan');
    const ui = renderAt(120, 40);
    await flushEffects();

    const beforeLines = stripAnsiStyles(ui.lastFrame()).split('\n');
    const crewLinesBefore = beforeLines.filter(
      (line) =>
        line.includes('PLAN') ||
        line.includes('BUILD') ||
        line.includes('REVIEW') ||
        line.includes('effort'),
    );
    expect(crewLinesBefore).toHaveLength(6);

    ui.stdin.write(' ');
    await vi.waitFor(() => {
      const p = configStore.get().config?.planner;
      expect(p && 'effort' in p ? p.effort : undefined).toBe('low');
    });
    await flushEffects();

    const afterLines = stripAnsiStyles(ui.lastFrame()).split('\n');
    expect(afterLines).toHaveLength(beforeLines.length);

    const changedIndices: number[] = [];
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i] !== afterLines[i]) {
        changedIndices.push(i);
      }
    }
    expect(changedIndices).toHaveLength(1);
    const changedIndex = changedIndices[0] ?? -1;
    expect(changedIndex).toBeGreaterThanOrEqual(0);
    expect(beforeLines[changedIndex]).toContain('effort');
    expect(afterLines[changedIndex]).toContain('effort');
    expect(beforeLines[changedIndex]).toContain('auto');
    expect(afterLines[changedIndex]).toContain('low');

    ui.unmount();
  });

  it('hides the crew rail behind a filter that only matches a tuning row', async () => {
    const ui = renderAt(120, 40);
    await flushEffects();
    ui.stdin.write('temp');
    await tick(20);
    const lines = frameLines(ui);

    expect(lineWith(lines, 'Temperature')).toBeDefined();
    for (const seat of ['PLAN', 'BUILD', 'REVIEW']) expect(lineWith(lines, seat)).toBeUndefined();

    ui.unmount();
  });

  it('keeps one seat and its effort row under a seat filter', async () => {
    seed({ planner: PLANNER_WITH_EFFORT });
    const ui = renderAt(120, 40);
    await flushEffects();
    ui.stdin.write('plan');
    await tick(20);
    const lines = frameLines(ui);

    expect(lineWith(lines, 'PLAN')).toBeDefined();
    expect(lineWith(lines, 'effort')).toBeDefined();
    expect(lineWith(lines, 'BUILD')).toBeUndefined();
    expect(lineWith(lines, 'REVIEW')).toBeUndefined();

    ui.unmount();
  });

  it('does not offer an escalation row or picker', async () => {
    const ui = renderAt(120, 40);
    await flushEffects();

    expect(lineWith(frameLines(ui), 'escalate')).toBeUndefined();

    ui.unmount();
  });

  it('lands the cursor on the seat the caller named', async () => {
    overlayStore.open('settings', 'seat:build');
    const ui = renderAt(120, 40);
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(overlayStore.get().active).toBe('implementer-picker');

    ui.unmount();
  });

  it('reproduces a typed filter from a filter focus', async () => {
    overlayStore.open('settings', 'filter:temp');
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);

    expect(lineWith(lines, 'Temperature')).toBeDefined();
    expect(lineWith(lines, 'PLAN')).toBeUndefined();

    ui.unmount();
  });

  // The description body is clamped to `height={2}` while the chrome budget reserves
  // DESCRIPTION_ROWS = 4 for it, so a description that wraps must not grow the panel by a row.
  it('keeps the frame height identical between a 1-line and a 2-line description row', async () => {
    // Inner width at 100 cols / roomy density is 70 cells (76 - OVERLAY_FRAME_COLS).
    const shortDef = SETTINGS_DEFS.find((def) => def.id === 'validation.lint');
    const longDef = SETTINGS_DEFS.find((def) => def.id === 'workflow.approve');
    expect(shortDef?.description.length).toBeLessThanOrEqual(70);
    expect(longDef?.description.length).toBeGreaterThan(70);

    overlayStore.open('settings', 'validation.lint');
    const shortUi = renderAt(100, 40);
    await flushEffects();
    const shortFrame = stripAnsiStyles(shortUi.lastFrame()).split('\n');
    shortUi.unmount();

    overlayStore.open('settings', 'workflow.approve');
    const longUi = renderAt(100, 40);
    await flushEffects();
    const longFrame = stripAnsiStyles(longUi.lastFrame()).split('\n');
    longUi.unmount();

    expect(shortFrame.some((line) => line.includes('Run linter'))).toBe(true);
    const wrapStart = longFrame.findIndex((line) => line.includes('"default"'));
    expect(wrapStart).toBeGreaterThan(-1);
    expect(longFrame[wrapStart + 1]).toContain('mode)');
    expect(longFrame).toHaveLength(shortFrame.length);
    expect(topBorderRow(shortFrame)).toBeGreaterThanOrEqual(0);
    expect(topBorderRow(longFrame)).toBe(topBorderRow(shortFrame));
  });

  it.each([
    [120, 40],
    [80, 24],
    [60, 18],
  ])('closes the panel border at %ix%i', async (cols, rows) => {
    const ui = renderAt(cols, rows);
    await flushEffects();
    const lines = frameLines(ui);

    // A corner opens the line on both glyph tiers: `╭`/`╰` on unicode, `+` on the ascii tier a
    // non-TTY test host resolves. Two of them, with the last line one, means nothing spilled.
    const cornerLine = /^\s*[╭╰+]/;
    expect(lines.filter((line) => cornerLine.test(line))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(cornerLine);

    ui.unmount();
  });

  it('never points a description at a command the merge deleted', () => {
    const config = makeConfig();
    for (const item of buildSettingsItems({ config, defs: SETTINGS_DEFS })) {
      expect(settingsItemDescription({ item, config })).not.toContain('/planner');
    }
  });

  it('strips terminal controls from the edit-buffer view while preserving the saved value', async () => {
    overlayStore.open('settings', 'validation.testCommand');
    const ui = renderAt(100, 40);
    await flushEffects();

    ui.stdin.write(ENTER);
    await tick(20);

    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('safecmd');
    expect(frame).not.toContain('evil');
    expect(frame).not.toContain(`${ESC}]`);
    expect(frame).not.toContain(BEL);
    expect(configStore.get().config?.validation?.testCommand).toBe(RAW_TEST_COMMAND);

    ui.unmount();
  });

  it('does not toggle a setting with Space when no setting row is visible', async () => {
    overlayStore.open('settings', 'validation.typecheck');
    expect(configStore.get().config?.validation.typecheck).toBe(true);

    const ui = renderAt(100, 8);
    await flushEffects();

    ui.stdin.write(' ');
    await tick(20);

    expect(configStore.get().config?.validation.typecheck).toBe(true);
    ui.unmount();
  });

  it('names the context-length row after the implementer kind', async () => {
    const cliImplementer = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet' },
    });
    const def = SETTINGS_DEFS.find((entry) => entry.id === 'implementer.contextLength');
    const kindLabel = def?.readLabel?.(cliImplementer);
    expect(kindLabel).toBeDefined();
    expect(kindLabel).not.toBe(def?.label);

    configStore.__testReset({ projectDir: '/tmp/project', config: cliImplementer });
    overlayStore.open('settings', 'implementer.contextLength');
    const ui = renderAt(100, 40);
    await tick(20);

    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain(kindLabel);
    expect(frame).not.toContain(def?.label);

    ui.unmount();
  });

  it('renders the title through OverlayPanel chrome', async () => {
    const ui = renderAt(100, 40);
    await tick(20);

    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('Settings');
    expect(frame).toContain('esc close');

    ui.unmount();
  });
});

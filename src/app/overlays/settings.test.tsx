import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
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

/** The rule above the help block carries the seat word too, and it is not a seat row. */
const RULE_ROW = / [─-]{3,}/;

/** The panel paints a border on both ends of every row; a row's own text is what lies between. */
function panelText(line: string): string {
  return line
    .replace(/^[^|│]*[|│]/, '')
    .replace(/[|│][^|│]*$/, '')
    .trimEnd();
}

function seatRowLines(lines: string[]): string[] {
  return lines.filter((line) => /\b(PLAN|BUILD|REVIEW)\b/.test(line) && !RULE_ROW.test(line));
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

  it('opens on the crew block, above every tuning row', async () => {
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);

    const crew = [
      indexOfLine(lines, 'PLAN'),
      indexOfLine(lines, 'BUILD'),
      indexOfLine(lines, 'REVIEW'),
    ];
    expect(crew).toEqual([...crew].toSorted((a, b) => a - b));
    expect(crew[0]).toBeGreaterThan(indexOfLine(lines, 'Crew'));
    for (const index of crew) expect(index).toBeLessThan(indexOfLine(lines, 'Temperature'));

    ui.unmount();
  });

  it('renders the Workflow section above the Validation section', async () => {
    overlayStore.open('settings', 'validation.lint');
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);

    const workflowRowIndex = indexOfLine(lines, 'Create branch');
    const validationRowIndex = indexOfLine(lines, 'Lint');

    expect(workflowRowIndex).toBeGreaterThan(-1);
    expect(validationRowIndex).toBeGreaterThan(-1);
    expect(workflowRowIndex).toBeLessThan(validationRowIndex);

    ui.unmount();
  });

  it.each(['seat:plan', 'seat:build', 'seat:review'])(
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

  it('hides the YAML-only escalation tier at 60x18', async () => {
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

    expect(lineWith(lines, 'escalate')).toBeUndefined();
    expect(lineWith(lines, 'REVIEW')).toBeDefined();

    ui.unmount();
  });

  it('renders 3 crew rows and Enter opens the seat picker with no geometry jump', async () => {
    seed({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' },
      reviewer: API_REVIEWER,
    });
    overlayStore.open('settings', 'seat:plan');
    const ui = renderAt(120, 40);
    await flushEffects();

    const beforeLines = stripAnsiStyles(ui.lastFrame()).split('\n');
    const crewLinesBefore = seatRowLines(beforeLines);
    expect(crewLinesBefore).toHaveLength(3);

    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(overlayStore.get().active).toBe('planner-picker');
      expect(overlayStore.get().focus).toBe('seat:plan:effort');
    });
    await flushEffects();

    const afterLines = stripAnsiStyles(ui.lastFrame()).split('\n');
    expect(afterLines).toHaveLength(beforeLines.length);
    expect(seatRowLines(afterLines)).toEqual(crewLinesBefore);

    ui.unmount();
  });

  it('hides the crew block behind a filter that only matches a tuning row', async () => {
    const ui = renderAt(120, 40);
    await flushEffects();
    ui.stdin.write('temp');
    await tick(20);
    const lines = frameLines(ui);

    expect(lineWith(lines, 'Temperature')).toBeDefined();
    for (const seat of ['PLAN', 'BUILD', 'REVIEW']) expect(lineWith(lines, seat)).toBeUndefined();

    ui.unmount();
  });

  it('keeps one seat under a seat filter', async () => {
    seed({ planner: PLANNER_WITH_EFFORT });
    const ui = renderAt(120, 40);
    await flushEffects();
    ui.stdin.write('plan');
    await tick(20);
    const lines = frameLines(ui);

    expect(lineWith(lines, 'PLAN')).toBeDefined();
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

  // The help block is a fixed DESCRIPTION_ROWS = 5 tall and pays for a wrapped description out of
  // the spacer above its rule, so a description that wraps must not grow the panel by a row.
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

  it('runs the filter straight under the title, with no row between them', async () => {
    const ui = renderAt(100, 40);
    await tick(20);
    const lines = stripAnsiStyles(ui.lastFrame()).split('\n');

    expect(indexOfLine(lines, 'Type to filter…')).toBe(indexOfLine(lines, 'Settings') + 1);

    ui.unmount();
  });

  it('heads the help block with a rule carrying the highlighted row label', async () => {
    overlayStore.open('settings', 'workflow.mode');
    const ui = renderAt(100, 40);
    await tick(20);
    const lines = frameLines(ui);
    const rule = lines.find((line) => RULE_ROW.test(line));

    expect(rule).toMatch(/Mode [─-]{3,}/);
    expect(indexOfLine(lines, 'quick')).toBe(lines.indexOf(rule ?? '') + 1);

    ui.unmount();
  });

  it('names the seat, not the row key, on the rule above a crew help block', async () => {
    overlayStore.open('settings', 'seat:build');
    const ui = renderAt(100, 40);
    await tick(20);

    expect(frameLines(ui).find((line) => RULE_ROW.test(line))).toMatch(/BUILD [─-]{3,}/);

    ui.unmount();
  });

  it('prices every mode and marks the configured one on the right edge', async () => {
    seed({ workflow: { mode: 'speckit' } });
    overlayStore.open('settings', 'workflow.mode');
    const ui = renderAt(100, 40);
    await tick(20);
    const lines = frameLines(ui);

    const modeLine = (mode: string) => panelText(lineWith(lines, mode) ?? '');

    expect(modeLine('quick     1 planning call · 0 gates')).not.toMatch(/current$/);
    expect(modeLine('speckit   6-7 planning calls · 3 gates')).toMatch(/current$/);
    expect(lines.filter((line) => panelText(line).endsWith('current'))).toHaveLength(1);

    ui.unmount();
  });

  it.each([
    ['workflow.mode', 'space cycle'],
    ['validation.lint', 'space toggle'],
    ['validation.testCommand', '⏎ edit'],
  ])('advertises %s as %s in the legend', async (focus, hint) => {
    overlayStore.open('settings', focus);
    const ui = renderAt(100, 40);
    await tick(20);

    expect(stripAnsiStyles(ui.lastFrame())).toContain(`↑↓ navigate · ${hint} · esc close`);

    ui.unmount();
  });

  it('reads an unset test command as auto', async () => {
    seed({ validation: { testCommand: undefined } });
    overlayStore.open('settings', 'validation.testCommand');
    const ui = renderAt(100, 40);
    await tick(20);

    const row = frameLines(ui).find(
      (line) => line.includes('Test command') && !RULE_ROW.test(line),
    );

    expect(panelText(row ?? '')).toMatch(/auto$/);

    ui.unmount();
  });

  // The commit strategy is no longer a value the config accepts, and spend is read in `/usage`
  // rather than switched on for a main screen that shows no figure. Neither has a row to land on,
  // by cursor or by click; the seats the user still chooses are untouched.
  it('offers no row for the retired commit strategy or spend toggle', async () => {
    _resetMouseZones();
    overlayStore.open('settings', 'filter:workflow');
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);
    const zones = [...collectClickableZones({ cols: 120, rows: 40 }).keys()];

    expect(lineWith(lines, 'Commit strategy')).toBeUndefined();
    expect(lineWith(lines, 'Show spend')).toBeUndefined();
    expect(zones).not.toContain('list-row:workflow.git.commitStrategy');
    expect(zones).not.toContain('list-row:workflow.showSpend');

    expect(lineWith(lines, 'Create branch')).toBeDefined();
    expect(zones).toContain('list-row:workflow.git.createBranch');

    ui.unmount();
  });

  it('keeps the build and review seats selectable beside the retired rows', async () => {
    _resetMouseZones();
    overlayStore.open('settings', 'seat:build');
    const ui = renderAt(120, 40);
    await flushEffects();
    const zones = [...collectClickableZones({ cols: 120, rows: 40 }).keys()];

    expect(zones).toContain('list-row:seat:build');
    expect(zones).toContain('list-row:seat:review');

    ui.unmount();
  });

  it('keeps the list rows clickable', async () => {
    _resetMouseZones();
    overlayStore.open('settings', 'validation.typecheck');
    const ui = renderAt(120, 40);
    await flushEffects();

    expect([...collectClickableZones({ cols: 120, rows: 40 }).keys()]).toContain(
      'list-row:validation.typecheck',
    );

    ui.unmount();
  });

  it.each([
    ['seat:plan', 'a one-line help'],
    ['workflow.mode', 'the mode table'],
  ])('leaves a blank row above the rule for %s (%s)', async (focus) => {
    overlayStore.open('settings', focus);
    const ui = renderAt(100, 40);
    await tick(20);
    const lines = stripAnsiStyles(ui.lastFrame()).split('\n');
    const rule = lines.findIndex((line) => RULE_ROW.test(line));

    expect(rule).toBeGreaterThan(0);
    expect(panelText(lines[rule - 1] ?? '')).toBe('');

    ui.unmount();
  });

  it('closes the mode table one blank row above the legend', async () => {
    overlayStore.open('settings', 'workflow.mode');
    const ui = renderAt(100, 40);
    await tick(20);
    const lines = stripAnsiStyles(ui.lastFrame()).split('\n');
    const speckit = indexOfLine(lines, 'speckit');

    expect(speckit).toBeGreaterThan(indexOfLine(lines, 'quick'));
    expect(panelText(lines[speckit + 1] ?? '')).toBe('');
    expect(lines[speckit + 2]).toContain('↑↓ navigate');

    ui.unmount();
  });

  it('spends a blank row between sections only where the list has rows to spare', async () => {
    const roomy = renderAt(120, 40);
    await tick(20);
    const roomyLines = stripAnsiStyles(roomy.lastFrame()).split('\n');
    const roomyHeader = indexOfLine(roomyLines, 'Tuning');
    expect(panelText(roomyLines[roomyHeader - 1] ?? '')).toBe('');
    roomy.unmount();

    const tight = renderAt(80, 24);
    await tick(20);
    const tightLines = stripAnsiStyles(tight.lastFrame()).split('\n');
    const tightHeader = indexOfLine(tightLines, 'Tuning');
    expect(tightLines[tightHeader - 1]).toContain('REVIEW');
    tight.unmount();
  });
});

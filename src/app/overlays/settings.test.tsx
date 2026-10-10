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
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { detectionStore } from '../../stores/project/detection.js';
import { CREW_SEAT_LABELS, PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { glyph } from '../../lib/glyphs.js';
import { listRowLead } from '../../components/list-row.js';
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
  return lines
    .slice(indexOfLine(lines, 'Crew') + 1, indexOfLine(lines, 'Fallback'))
    .filter((line) => /\b(PLAN|BUILD|REVIEW)\b/.test(line) && !RULE_ROW.test(line));
}

describe('SettingsOverlay', () => {
  beforeEach(() => {
    projectDir = createTempDir('settings-overlay');
    seed({ validation: { testCommand: RAW_TEST_COMMAND } });
    overlayStore.reset();
    feedbackStore.reset();
    detectionStore.reset();
  });

  afterEach(() => {
    detectionStore.reset();
    cleanupTempDir(projectDir);
  });

  it('paints the Fallback section after Crew with one row per seat', async () => {
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);
    const fallbackHeader = indexOfLine(lines, 'Fallback');
    const tuningHeader = indexOfLine(lines, 'Tuning');
    const fallbackRows = lines
      .slice(fallbackHeader + 1, tuningHeader)
      .filter((line) => /\b(PLAN|BUILD|REVIEW)\b/.test(line));

    expect(fallbackHeader).toBeGreaterThan(indexOfLine(lines, 'REVIEW'));
    expect(fallbackHeader).toBeLessThan(tuningHeader);
    expect(fallbackRows).toHaveLength(3);
    for (const [index, label] of Object.values(CREW_SEAT_LABELS).entries()) {
      expect(fallbackRows[index]).toContain(label);
      expect(fallbackRows[index]).toContain('none · pause and ask');
    }

    ui.unmount();
  });

  it('paints a BUILD fallback with the same identity as a seat', async () => {
    seed({
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
      },
    });
    detectionStore.setDetection({ providers: [], cliTools: [cliDetectionFor('ready', 'codex')] });
    overlayStore.open('settings', 'fallback:build');
    const ui = renderAt(120, 40);
    await flushEffects();

    expect(stripAnsiStyles(ui.lastFrame())).toContain('Codex CLI · GPT-5 Codex · high');

    ui.unmount();
  });

  it('marks an inherited REVIEW fallback with the planner it follows', async () => {
    seed({ planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } } });
    detectionStore.setDetection({ providers: [], cliTools: [cliDetectionFor('ready', 'codex')] });
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);
    const fallbackRows = lines.slice(indexOfLine(lines, 'Fallback') + 1);

    expect(lineWith(fallbackRows, 'REVIEW')).toContain(
      `${PLANNER_INHERITANCE.mark} · OpenAI Codex CLI · auto`,
    );

    ui.unmount();
  });

  it('opens the BUILD fallback picker on Enter', async () => {
    overlayStore.open('settings', 'fallback:build');
    const ui = renderAt(120, 40);
    await flushEffects();

    ui.stdin.write(ENTER);
    await tick(20);

    expect(overlayStore.get().active).toBe('implementer-fallback-picker');
    ui.unmount();
  });

  it.each([undefined, 'seat:plan'])(
    'restores the BUILD fallback cursor after the picker closes from Settings focus %s',
    async (focus) => {
      overlayStore.open('settings', focus);
      const ui = renderAt(120, 40);
      await flushEffects();
      for (let index = 0; index < 4; index += 1) {
        ui.stdin.write('\u001b[B');
        await flushEffects();
      }
      expect(frameLines(ui).find((line) => RULE_ROW.test(line))).toMatch(/BUILD fallback [─-]{3,}/);

      ui.stdin.write(ENTER);
      await tick(20);
      expect(overlayStore.get().active).toBe('implementer-fallback-picker');
      ui.unmount();

      overlayStore.close();
      const returned = renderAt(120, 40);
      await flushEffects();
      const lines = frameLines(returned);
      const fallbackRows = lines.slice(
        indexOfLine(lines, 'Fallback') + 1,
        indexOfLine(lines, 'Tuning'),
      );
      returned.unmount();

      expect(lineWith(fallbackRows, 'BUILD')).toContain(`${glyph('liveBar')} BUILD`);
      expect(lines.find((line) => RULE_ROW.test(line))).toMatch(/BUILD fallback [─-]{3,}/);
    },
  );

  it('labels the selected BUILD fallback help and advertises its action', async () => {
    overlayStore.open('settings', 'fallback:build');
    const ui = renderAt(70, 40);
    await flushEffects();

    expect(frameLines(ui).find((line) => RULE_ROW.test(line))).toMatch(/BUILD fallback [─-]{3,}/);
    expect(stripAnsiStyles(ui.lastFrame())).toContain('⏎ change fallback');
    expect(stripAnsiStyles(ui.lastFrame())).toContain('None pauses the run and asks.');

    ui.unmount();
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
    overlayStore.open('settings', 'validation.endChecks');
    const ui = renderAt(120, 40);
    await flushEffects();
    const lines = frameLines(ui);

    const workflowRowIndex = indexOfLine(lines, 'Create branch');
    const validationRowIndex = indexOfLine(lines, 'End-of-run checks');

    expect(workflowRowIndex).toBeGreaterThan(-1);
    expect(validationRowIndex).toBeGreaterThan(-1);
    expect(workflowRowIndex).toBeLessThan(validationRowIndex);

    ui.unmount();
  });

  it('moves the mounted cursor and filter when the active overlay opens with a new focus', async () => {
    overlayStore.open('settings', 'seat:plan');
    const ui = renderAt(120, 40);
    await flushEffects();
    expect(lineWith(frameLines(ui), 'PLAN')).toContain(`${glyph('liveBar')} PLAN`);

    ui.stdin.write('temp');
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain(`${listRowLead('active')}Temperature`);
    overlayStore.setExclusive(true);

    overlayStore.open('settings', 'seat:build');
    await flushEffects();
    expect(lineWith(frameLines(ui), 'BUILD')).toContain(`${glyph('liveBar')} BUILD`);
    expect(lineWith(frameLines(ui), 'PLAN')).not.toContain(`${glyph('liveBar')} PLAN`);
    expect(overlayStore.get()).toEqual({
      active: 'settings',
      focus: 'seat:build',
      exclusive: true,
      stack: [],
    });

    ui.stdin.write('temp');
    await flushEffects();
    overlayStore.open('settings', 'seat:build');
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain(`${listRowLead('active')}Temperature`);
    expect(lineWith(frameLines(ui), 'PLAN')).toBeUndefined();

    overlayStore.open('settings', 'filter:workflow');
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('workflow');
    expect(lineWith(frameLines(ui), 'Create branch')).toBeDefined();
    expect(lineWith(frameLines(ui), 'Temperature')).toBeUndefined();

    overlayStore.open('settings');
    await flushEffects();
    expect(lineWith(frameLines(ui), 'PLAN')).toContain(`${glyph('liveBar')} PLAN`);
    expect(overlayStore.get()).toEqual({
      active: 'settings',
      focus: undefined,
      exclusive: true,
      stack: [],
    });
    ui.stdin.write(ESC);
    await flushEffects();
    expect(overlayStore.get().active).toBe('none');
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
    // Inner width at 70 cols / roomy density is 60 cells (70 - 4 - OVERLAY_FRAME_COLS).
    const shortDef = SETTINGS_DEFS.find((def) => def.id === 'workflow.git.createBranch');
    const longDef = SETTINGS_DEFS.find((def) => def.id === 'workflow.approve');
    expect(shortDef?.description.length).toBeLessThanOrEqual(60);
    expect(longDef?.description.length).toBeGreaterThan(60);

    overlayStore.open('settings', 'workflow.git.createBranch');
    const shortUi = renderAt(70, 40);
    await flushEffects();
    const shortFrame = stripAnsiStyles(shortUi.lastFrame()).split('\n');
    shortUi.unmount();

    overlayStore.open('settings', 'workflow.approve');
    const longUi = renderAt(70, 40);
    await flushEffects();
    const longFrame = stripAnsiStyles(longUi.lastFrame()).split('\n');
    longUi.unmount();

    expect(shortFrame.some((line) => line.includes('Auto-create a splitbrief/<slug> branch'))).toBe(
      true,
    );
    const wrapStart = longFrame.findIndex((line) => line.includes('Whether the plan waits'));
    expect(wrapStart).toBeGreaterThan(-1);
    expect(longFrame[wrapStart]).not.toContain('starts');
    expect(longFrame[wrapStart + 1]).toContain('starts');
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
    seed({ validation: { endChecks: true } });
    overlayStore.open('settings', 'validation.endChecks');
    expect(configStore.get().config?.validation.endChecks).toBe(true);

    const ui = renderAt(100, 8);
    await flushEffects();

    ui.stdin.write(' ');
    await tick(20);

    expect(configStore.get().config?.validation.endChecks).toBe(true);
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
    overlayStore.open('settings', 'workflow.approve');
    const ui = renderAt(100, 40);
    await tick(20);
    const lines = frameLines(ui);
    const rule = lines.find((line) => RULE_ROW.test(line));

    expect(rule).toMatch(/Plan approval [─-]{3,}/);
    expect(indexOfLine(lines, 'Whether the plan waits')).toBe(lines.indexOf(rule ?? '') + 1);

    ui.unmount();
  });

  it('names the seat, not the row key, on the rule above a crew help block', async () => {
    overlayStore.open('settings', 'seat:build');
    const ui = renderAt(100, 40);
    await tick(20);

    expect(frameLines(ui).find((line) => RULE_ROW.test(line))).toMatch(/BUILD [─-]{3,}/);

    ui.unmount();
  });

  it('offers no mode row, whatever mode the config still names', async () => {
    seed({ workflow: { mode: 'speckit' } });
    overlayStore.open('settings', 'filter:workflow');
    const ui = renderAt(100, 40);
    await tick(20);
    const frame = stripAnsiStyles(ui.lastFrame());

    expect(frame).toContain('Plan approval');
    expect(frame).not.toMatch(/\bMode\b/);
    expect(frame).not.toContain('speckit');

    ui.unmount();
  });

  it.each([
    ['workflow.approve', 'space cycle'],
    ['validation.endChecks', 'space toggle'],
    ['validation.testCommand', '⏎ edit'],
  ])('advertises %s as %s in the legend', async (focus, hint) => {
    overlayStore.open('settings', focus);
    const ui = renderAt(100, 40);
    await tick(20);

    expect(stripAnsiStyles(ui.lastFrame())).toContain(`↑↓ select · ${hint} · esc close`);

    ui.unmount();
  });

  it('sheds whole legend keys instead of cutting one at 40 columns', async () => {
    overlayStore.open('settings');
    const ui = renderAt(40, 30);
    await tick(20);

    expect(panelText(lineWith(frameLines(ui), '↑↓ select') ?? '').trim()).toBe(
      '↑↓ select · ⏎ change seat',
    );

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
    overlayStore.open('settings', 'validation.endChecks');
    const ui = renderAt(120, 40);
    await flushEffects();

    expect([...collectClickableZones({ cols: 120, rows: 40 }).keys()]).toContain(
      'list-row:validation.endChecks',
    );

    ui.unmount();
  });

  it.each([
    ['seat:plan', 'a one-line help'],
    ['workflow.compactionFormat', 'a two-line help'],
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

  it('closes the help block one blank row above the legend', async () => {
    overlayStore.open('settings', 'workflow.compactionFormat');
    const ui = renderAt(100, 40);
    await tick(20);
    const lines = stripAnsiStyles(ui.lastFrame()).split('\n');
    const options = indexOfLine(lines, 'auto · freeform · structured');

    expect(options).toBeGreaterThan(indexOfLine(lines, 'Summary format for transcript compaction'));
    expect(panelText(lines[options + 1] ?? '')).toBe('');
    expect(lines[options + 2]).toContain('↑↓ select');

    ui.unmount();
  });

  it('spends a blank row between sections only where the list has rows to spare', async () => {
    const roomy = renderAt(120, 40);
    await tick(20);
    const roomyLines = stripAnsiStyles(roomy.lastFrame()).split('\n');
    const roomyHeader = indexOfLine(roomyLines, 'Fallback');
    expect(roomyHeader).toBeGreaterThan(-1);
    // The list scrolls at this size, so the row may carry the scrollbar's own glyph.
    expect(
      panelText(roomyLines[roomyHeader - 1] ?? '')
        .replace(/[#█│]$/, '')
        .trimEnd(),
    ).toBe('');
    roomy.unmount();

    const tight = renderAt(80, 24);
    await tick(20);
    const tightLines = stripAnsiStyles(tight.lastFrame()).split('\n');
    const tightHeader = indexOfLine(tightLines, 'Fallback');
    expect(tightHeader).toBeGreaterThan(-1);
    expect(tightLines[tightHeader - 1]).toContain('REVIEW');
    tight.unmount();
  });
});

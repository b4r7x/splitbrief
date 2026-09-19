import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { RunCheckpoint } from '../../core/sessions/run-record.js';
import { taskId } from '../../core/schemas/task.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { configStore } from '../../stores/project/config.js';
import { routerStore } from '../../stores/navigation/router.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { COMMANDS_ONLY_NOTICE } from '../../components/composer/composer.js';
import { WORKFLOW_FRAME_X } from '../../features/workflow/layout/chrome-rows.js';
import { WorkflowScreen } from './workflow.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const PAGE_DOWN = '\u001b[6~';
const HOME = '\u001b[H';
const END = '\u001b[F';

/** A closed run on the workflow screen, at rest: the presentation this file is about. */
function showClosedRun(opts: {
  summary: Summary;
  sessionId?: string | undefined;
  as?: 'complete' | 'ended' | undefined;
  ledger?: EvidenceLedger | null | undefined;
  phase?: Phase | undefined;
  checkpoint?: RunCheckpoint | undefined;
}) {
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({
      ref: {
        projectDir: '/tmp/workflow-closed-test',
        sessionId: opts.sessionId ?? '2026-09-14-test-feature',
      },
      status: { kind: 'closed', as: opts.as ?? 'complete' },
      summary: opts.summary,
      ledger: opts.ledger ?? null,
      ...(opts.phase !== undefined && {
        hydration: { kind: 'loaded', state: makeWorkflowState({ phase: opts.phase }) },
      }),
      ...(opts.checkpoint !== undefined && { checkpoint: opts.checkpoint }),
    }),
    execution: { kind: 'at-rest' },
  });
}

function mount(cols: number, rows: number, onRuntimeCommand: (command: string) => void = () => {}) {
  terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 120 });
  return renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />, {
    cols,
    rows,
  });
}

function visibleTaskIds(frame: string): string[] {
  return frame.split('\n').flatMap((line) => line.match(/\bT\d{3}\b/g) ?? []);
}

function maxLineLength(frame: string): number {
  return stripAnsiStyles(frame)
    .split('\n')
    .reduce((max, line) => Math.max(max, line.length), 0);
}

/** The screen's whole body sits inside its frame, inset WORKFLOW_FRAME_X each side; anchored
 *  assertions read the transcript from its own column 0, not the terminal's. */
function withoutFrameInset(frame: string): string {
  return frame
    .split('\n')
    .map((line) => line.slice(WORKFLOW_FRAME_X))
    .join('\n');
}

function briefBreakdown(count: number): NonNullable<Summary['taskBreakdown']> {
  return Array.from({ length: count }, (_, index) => {
    const id = `T${String(index + 1).padStart(3, '0')}`;
    return {
      taskId: taskId(id),
      taskTitle: `Task ${id}`,
      method: 'local' as const,
      implementerTokens: 10,
      escalationTokens: 0,
      retryCount: 0,
    };
  });
}

describe('the workflow screen showing a closed run', () => {
  beforeEach(() => {
    resetAllStores();
    // The run screen paints the sidebar and the composer byline, and both read the project
    // config; a screen test that never loaded one renders the error box instead of the run.
    configStore.__testReset({ config: makeConfig() });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('exits to home when Enter is pressed on the empty composer', async () => {
    showClosedRun({ summary: makeSummary() });

    const ui = mount(120, 40);
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(routerStore.get().screen).toBe('home');

    ui.unmount();
  });

  it('refuses a typed letter and says the composer takes commands', async () => {
    showClosedRun({ summary: makeSummary() });

    const ui = mount(120, 40);
    await flushEffects();
    ui.stdin.write('z');
    await tick(20);

    expect(routerStore.get().screen).toBe('workflow');
    expect(feedbackStore.get().message).toBe(COMMANDS_ONLY_NOTICE);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain(COMMANDS_ONLY_NOTICE);
    expect(frame).not.toContain('z');

    ui.unmount();
  });

  it('hands a typed command to the runtime', async () => {
    showClosedRun({ summary: makeSummary() });
    const onRuntimeCommand = vi.fn();

    const ui = mount(120, 40, onRuntimeCommand);
    await flushEffects();
    ui.stdin.write('/sessions');
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);

    expect(onRuntimeCommand).toHaveBeenCalledWith('/sessions');
    expect(routerStore.get().screen).toBe('workflow');

    ui.unmount();
  });

  it('ignores Enter on the composer while an overlay is open', async () => {
    showClosedRun({ summary: makeSummary() });
    overlayStore.open('command-palette');

    const ui = mount(120, 40);
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(routerStore.get().screen).toBe('workflow');

    ui.unmount();
  });

  it('pages through every brief id and ends on the run block', async () => {
    showClosedRun({
      summary: makeSummary({
        totalTasks: 20,
        completedByLocal: 20,
        taskBreakdown: briefBreakdown(20),
      }),
    });

    const ui = mount(160, 24);
    await flushEffects();
    ui.stdin.write(HOME);
    await tick(20);
    expect(visibleTaskIds(ui.lastFrame() ?? '')).toContain('T001');

    const seen = new Set<string>();
    for (let page = 0; page < 25; page++) {
      for (const id of visibleTaskIds(ui.lastFrame() ?? '')) seen.add(id);
      await flushEffects();
      ui.stdin.write(PAGE_DOWN);
      await tick(20);
    }

    await flushEffects();
    ui.stdin.write(END);
    await tick(20);
    const last = stripAnsiStyles(ui.lastFrame() ?? '');
    for (const id of visibleTaskIds(last)) seen.add(id);

    expect(seen).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => `T${String(i + 1).padStart(3, '0')}`)),
    );
    expect(last).toContain('Session');
    expect(last).toContain('2026-09-14-test-feature');

    ui.unmount();
  });

  it('offers scrolling in the legend only when the body overflows', async () => {
    showClosedRun({
      summary: makeSummary({
        totalTasks: 20,
        completedByLocal: 20,
        taskBreakdown: briefBreakdown(20),
      }),
    });
    const tall = mount(160, 60);
    await flushEffects();
    expect(stripAnsiStyles(tall.lastFrame() ?? '')).not.toContain('scroll');
    tall.unmount();

    const short = mount(160, 24);
    await flushEffects();
    expect(stripAnsiStyles(short.lastFrame() ?? '')).toContain('scroll');
    short.unmount();
  });

  it('keeps the whole screen inside a 48x28 terminal', () => {
    showClosedRun({
      summary: makeSummary({
        feature: 'a narrow summary with enough text to overflow if the screen is not bounded',
        plannerTool: 'codex',
        implementerTool: 'codex',
        mode: 'quick',
        totalTasks: 2,
        completedByLocal: 1,
        escalatedToPlanner: 1,
        changedFiles: ['src/a/very/deeply/nested/path/that/will/not/fit/here.ts'],
        taskBreakdown: briefBreakdown(2),
      }),
      as: 'ended',
    });

    const ui = mount(48, 28);
    const frame = ui.lastFrame() ?? '';

    expect(maxLineLength(frame)).toBeLessThanOrEqual(48);
    expect(stripAnsiStyles(frame).split('\n').length).toBeLessThanOrEqual(28);

    ui.unmount();
  });

  it('states the whole crew on exactly one surface, at 160 and at 80', () => {
    for (const cols of [160, 80]) {
      showClosedRun({
        summary: makeSummary({
          plannerTool: 'codex',
          implementerTool: 'ollama',
          implementerModel: 'qwen-small',
        }),
      });

      const ui = mount(cols, 40);
      const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
      const wholeCrew = lines.filter(
        (line) => line.includes('PLAN') && line.includes('BUILD') && line.includes('REVIEW'),
      );

      expect(wholeCrew.length, `at ${cols}`).toBe(1);
      expect(wholeCrew[0], `at ${cols}`).toContain('qwen-small');
      expect(wholeCrew[0], `at ${cols}`).toContain(PLANNER_INHERITANCE.mark);

      ui.unmount();
      resetAllStores();
      configStore.__testReset({ config: makeConfig() });
    }
  });

  it('leaves the crew out of the run block when the header already seated it', () => {
    showClosedRun({
      summary: makeSummary({
        plannerTool: 'codex',
        implementerTool: 'ollama',
        implementerModel: 'qwen-small',
      }),
    });

    const ui = mount(160, 40);
    const lines = withoutFrameInset(stripAnsiStyles(ui.lastFrame() ?? '')).split('\n');

    expect(lines.filter((line) => line.startsWith('Crew'))).toEqual([]);
    expect(lines[0]).toContain('qwen-small');

    ui.unmount();
  });

  it('states the crew in the run block when the header could not seat it', () => {
    showClosedRun({
      summary: makeSummary({
        plannerTool: 'codex',
        implementerTool: 'ollama',
        implementerModel: 'qwen-small',
      }),
    });

    const ui = mount(80, 40);
    const lines = withoutFrameInset(stripAnsiStyles(ui.lastFrame() ?? '')).split('\n');
    const crewRow = lines.find((line) => line.startsWith('Crew')) ?? '';

    expect(crewRow).toContain('OpenAI Codex CLI');
    expect(crewRow).toContain('qwen-small');
    expect(crewRow).toContain(PLANNER_INHERITANCE.mark);

    ui.unmount();
  });

  it('names a run whose briefs went to more than one seat by its profiles', () => {
    showClosedRun({
      summary: makeSummary({
        plannerTool: 'codex',
        implementerTool: 'ollama',
        implementerModel: 'qwen-small',
        taskBreakdown: [
          {
            taskId: taskId('T001'),
            taskTitle: 'Local task',
            method: 'local',
            implementerTokens: 100,
            escalationTokens: 0,
            retryCount: 0,
            tool: 'ollama',
            model: 'qwen-small',
            implementerProfile: 'local-qwen',
          },
          {
            taskId: taskId('T002'),
            taskTitle: 'Cloud task',
            method: 'local',
            implementerTokens: 100,
            escalationTokens: 0,
            retryCount: 0,
            tool: 'custom-endpoint',
            model: 'remote-coder',
            implementerProfile: 'cheap-cloud',
          },
        ],
      }),
    });

    const ui = mount(160, 40);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('mixed profiles');
    expect(frame).toContain('cheap-cloud');
    expect(frame).toContain('local-qwen');

    ui.unmount();
  });

  it('gives a run that compiled no briefs no Briefs and no Files heading', () => {
    showClosedRun({
      summary: makeSummary({ totalTasks: 0, completedByLocal: 0, escalatedToPlanner: 0 }),
      as: 'ended',
      phase: 'planning',
    });

    const ui = mount(120, 40);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toMatch(/^Briefs /m);
    expect(frame).not.toMatch(/^Files /m);
    expect(frame).toContain('no briefs compiled');
    expect(frame).toContain('nothing built');
    expect(frame).toContain('esc home');

    ui.unmount();
  });

  it('states an unpriced run nowhere, neither as a figure nor as an absence word', () => {
    showClosedRun({
      summary: makeSummary({
        totalTasks: 0,
        completedByLocal: 0,
        plannerTool: 'opencode',
        implementerTool: 'opencode',
        costBreakdown: {
          actualPlannerCost: 0,
          actualImplementerCost: 0,
          totalActualCost: 0,
          hasPricedUsage: false,
          hasUnpricedUsage: true,
          isActualPlannerCostKnown: false,
          isActualImplementerCostKnown: false,
          isTotalActualCostKnown: false,
        },
      }),
      as: 'ended',
    });

    const ui = mount(120, 40);
    const frame = withoutFrameInset(stripAnsiStyles(ui.lastFrame() ?? ''));

    // The ledger paints, and the facts it does account for still spell absence as a word.
    expect(frame).toMatch(/^Run /m);
    expect(frame).toMatch(/^Review\s+not run\b/m);
    // Money is not one of those facts any more: `/usage` is where an unpriced run is reported.
    expect(frame).not.toContain('not estimated');
    expect(frame).not.toContain('$0.00');
    expect(frame).not.toContain('$');

    ui.unmount();
  });

  it('states no spend for a priced run, and nothing that used to sit beside it', () => {
    showClosedRun({
      summary: makeSummary({
        costBreakdown: {
          actualPlannerCost: 0.05,
          actualImplementerCost: 0.1,
          totalActualCost: 0.15,
          hasPricedUsage: true,
          isActualPlannerCostKnown: true,
          isActualImplementerCostKnown: true,
          isTotalActualCostKnown: true,
        },
      }),
    });

    const ui = mount(160, 40);
    const frame = withoutFrameInset(stripAnsiStyles(ui.lastFrame() ?? ''));

    // The record priced every seat; the ledger still reads, and still says nothing about money.
    expect(frame).toMatch(/^Run /m);
    expect(frame).toMatch(/^Session\s+2026-09-14-test-feature\b/m);
    expect(frame).not.toContain('$');
    expect(frame).not.toContain('0.15');
    expect(frame).not.toContain('all-planner');
    expect(frame).not.toContain('saved');

    ui.unmount();
  });

  it('reads the same with the spend display turned off as with it on', () => {
    const pricedCrew = {
      costBreakdown: {
        actualPlannerCost: 0.05,
        actualImplementerCost: 0.1,
        totalActualCost: 0.15,
        hasPricedUsage: true,
        isActualPlannerCostKnown: true,
        isActualImplementerCostKnown: true,
        isTotalActualCostKnown: true,
      },
    } as const;

    showClosedRun({ summary: makeSummary(pricedCrew) });
    const shown = mount(160, 40);
    const withSpendOn = stripAnsiStyles(shown.lastFrame() ?? '');
    shown.unmount();

    resetAllStores();
    configStore.__testReset({ config: makeConfig({ workflow: { showSpend: false } }) });
    showClosedRun({ summary: makeSummary(pricedCrew) });
    const hidden = mount(160, 40);
    const withSpendOff = stripAnsiStyles(hidden.lastFrame() ?? '');
    hidden.unmount();

    // The setting governs the surfaces that paint an amount, and this is no longer one of them,
    // so it has nothing left to turn off here.
    expect(withSpendOff).toBe(withSpendOn);
    expect(withSpendOff).not.toMatch(/^Cost/m);
    expect(withSpendOff).not.toContain('$0.15');
  });

  it('does not label an old summary with the mode the live config is set to', () => {
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'quick' } }) });
    showClosedRun({ summary: makeSummary() });

    const ui = mount(160, 40);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain('quick');

    ui.unmount();
  });

  it('renders the mode the summary itself recorded', () => {
    showClosedRun({ summary: makeSummary({ mode: 'standard' }) });

    const ui = mount(160, 40);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('standard');

    ui.unmount();
  });

  it('strips terminal-control bytes from persisted feature and model fields', () => {
    showClosedRun({
      summary: makeSummary({
        feature: `Ship ${ESC}]52;c;clip-feature${BEL}dashboard${ESC}[31m`,
        plannerTool: 'codex',
        plannerModel: `gpt${ESC}]52;c;clip-planner${BEL}-5`,
        implementerTool: 'ollama',
        implementerModel: `qwen${ESC}]52;c;clip-impl${BEL}-small`,
      }),
    });

    const ui = mount(160, 40);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Ship');
    expect(frame).toContain('dashboard');
    expect(frame).not.toContain('clip-feature');
    expect(frame).not.toContain('clip-planner');
    expect(frame).not.toContain('clip-impl');
    expect(frame).not.toContain('52;c');

    ui.unmount();
  });
});

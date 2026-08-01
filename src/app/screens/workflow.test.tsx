import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { readyReadiness } from '#testing/helpers/workflow-screen.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { getContentTopRow } from '../../features/workflow/layout/chrome-rows.js';
import { getWorkflowContentRect } from '../../features/workflow/layout/rect.js';
import { glyph } from '../../lib/glyphs.js';
import { WorkflowScreen } from './workflow.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { configStore } = await import('../../stores/project/config.js');
const { terminalSizeStore } = await import('../../stores/ui/terminal-size.js');
const { routerStore } = await import('../../stores/navigation/router.js');
const { inputHeightStore } = await import('../../stores/ui/input-height.js');
const { inputHistoryStore } = await import('../../stores/ui/input-history.js');
const { focusStore } = await import('../../stores/ui/focus.js');
const { lifecycleStore } = await import('../../stores/workflow/lifecycle.js');

const FIXED_TS = 1_783_958_400_000;
const SHIFT_ENTER = '\x1b[13;2u';
const SHIFT_DOWN = '\x1b[1;2B';

function pendingWorkflow(): Promise<never> {
  return new Promise<never>(() => {});
}

function publishEvent(opts: RunWorkflowOptions, event: EngineEvent): void {
  const sink = opts.tuiSink;
  if (sink === undefined) throw new Error('Workflow screen did not provide its TUI event sink');
  sink(event);
}

describe('WorkflowScreen chrome calibration', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('workflow-chrome-calibration');
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
  });

  afterEach(() => {
    resetAllStores();
    if (projectDir) cleanupTempDir(projectDir);
  });

  it('paints the body on the same row getWorkflowContentRect uses for pointer top', async () => {
    const cols = 120;
    const rows = 40;
    const inputRows = 2;
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols, rows, isSmall: false });
    inputHeightStore.__testReset({ rows: inputRows });
    routerStore.navigate({
      to: 'workflow',
      feature: 'chrome calibration',
      readiness: readyReadiness(projectDir),
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await tick();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const paintedBodyRow = lines.findIndex((line) => line.includes('no events yet'));
    expect(paintedBodyRow).toBeGreaterThanOrEqual(0);

    const contentRect = getWorkflowContentRect({
      cols,
      rows,
      inputRows,
      sidebarVisible: true,
      isSmall: false,
    });
    expect(contentRect.top).toBe(getContentTopRow());
    expect(paintedBodyRow + 1).toBe(contentRect.top);

    ui.unmount();
  });

  it('keeps a keyboard review action through resize and resets it for the next review owner', async () => {
    const firstReviewPath = join(projectDir, 'first-review.md');
    const secondReviewPath = join(projectDir, 'second-review.md');
    writeFileSync(firstReviewPath, '# First review\n\nFirst approval.', 'utf8');
    writeFileSync(secondReviewPath, '# Second review\n\nSecond approval.', 'utf8');
    const outcomes: ApprovalReviewResult[] = [];

    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    routerStore.navigate({
      to: 'workflow',
      feature: 'review action lifecycle',
      readiness: readyReadiness(projectDir),
    });
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'reviewing-plan',
        feature: 'review action lifecycle',
      });
      outcomes.push(await opts.callbacks.onApprovalNeeded('plan', firstReviewPath));
      publishEvent(opts, {
        type: 'planner_text',
        ts: FIXED_TS + 1,
        phase: 'reviewing-spec',
        role: 'planner',
        content: 'plain',
        text: 'Second review opened',
      });
      outcomes.push(await opts.callbacks.onApprovalNeeded('spec', secondReviewPath));
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('First review');
    });

    ui.stdin.write('\x1b[B');
    ui.stdin.write('\x1b[B');
    await tick();
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    await tick();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Second review');
    });
    expect(outcomes).toEqual([{ approved: false }]);

    ui.stdin.write('\r');
    await tick();
    expect(outcomes).toHaveLength(1);
    ui.stdin.write('\x1b[B');
    ui.stdin.write('\x1b[A');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(outcomes).toEqual([{ approved: false }, { approved: true }]);
    });
    ui.unmount();
  });

  it('keeps multiline review arrows in the draft without loading command history', async () => {
    const reviewPath = join(projectDir, 'multiline-review.md');
    writeFileSync(reviewPath, '# Multiline review\n\nReview body.', 'utf8');
    inputHistoryStore.hydrate(['HISTORY_SENTINEL']);
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    routerStore.navigate({
      to: 'workflow',
      feature: 'multiline review ownership',
      readiness: readyReadiness(projectDir),
    });
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'reviewing-plan',
        feature: 'multiline review ownership',
      });
      await opts.callbacks.onApprovalNeeded('plan', reviewPath);
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Multiline review');
    });

    ui.stdin.write('top');
    await flushEffects();
    ui.stdin.write(SHIFT_ENTER);
    await flushEffects();
    ui.stdin.write('bottom');
    await flushEffects();
    ui.stdin.write('\x1b[A');
    await flushEffects();
    ui.stdin.write('X');
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('topX');
    expect(frame).toContain('bottom');
    expect(frame).not.toContain('HISTORY_SENTINEL');
    ui.unmount();
  });

  it('invalidates a keyboard review action as soon as the draft is edited', async () => {
    const reviewPath = join(projectDir, 'stale-action-review.md');
    writeFileSync(reviewPath, '# Stale action review\n\nReview body.', 'utf8');
    let outcome: ApprovalReviewResult | undefined;
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    routerStore.navigate({
      to: 'workflow',
      feature: 'stale review action',
      readiness: readyReadiness(projectDir),
    });
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'reviewing-plan',
        feature: 'stale review action',
      });
      outcome = await opts.callbacks.onApprovalNeeded('plan', reviewPath);
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Stale action review');
    });
    ui.stdin.write('\x1b[B');
    ui.stdin.write('\x1b[B');
    await tick();
    ui.stdin.write('x');
    ui.stdin.write('\x7f');
    ui.stdin.write('\r');
    await tick();
    expect(outcome).toBeUndefined();

    ui.stdin.write('\x1b[B');
    ui.stdin.write('\x1b[B');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(outcome).toEqual({ approved: false });
    });
    ui.unmount();
  });

  it('transfers brief focus without history and keeps yank and text ownership exclusive', async () => {
    const tasksPath = join(projectDir, 'tasks.md');
    writeFileSync(
      tasksPath,
      formatTasks(
        ['First brief', 'Second brief', 'Third brief'].map((title, index) =>
          makeTask({
            id: `T00${index + 1}`,
            title,
            file: `src/task-${index + 1}.ts`,
          }),
        ),
      ),
      'utf8',
    );
    inputHistoryStore.hydrate(['HISTORY_SENTINEL']);
    const copyTarget = vi.fn(async () => 'empty' as const);
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    routerStore.navigate({
      to: 'workflow',
      feature: 'brief key ownership',
      readiness: readyReadiness(projectDir),
    });
    runWorkflow.mockImplementation(async (opts) => {
      lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
      await opts.callbacks.onApprovalNeeded('briefs', tasksPath);
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen
        commands={[]}
        onRuntimeCommand={vi.fn()}
        copyTarget={copyTarget}
        canCopyFocused={(focus) => focus?.region === 'brief' && focus.index === 1}
        deps={workflowDeps}
      />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('First brief');
    });

    await flushEffects();
    ui.stdin.write('\x1b[B');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('HISTORY_SENTINEL');

    ui.stdin.write('ab');
    await tick();
    expect(focusStore.get()).toBeNull();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} ab`);

    focusStore.set('brief', 1);
    await tick();
    ui.stdin.write('y');
    await tick();
    await Promise.resolve();
    await tick();
    expect(copyTarget).toHaveBeenCalledWith('brief');
    expect(copyTarget).toHaveBeenCalledTimes(1);
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} ab`);

    ui.stdin.write(SHIFT_DOWN);
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });

    focusStore.set('brief', 0);
    await tick();
    ui.stdin.write('y');
    await tick();
    expect(copyTarget).toHaveBeenCalledTimes(1);
    expect(focusStore.get()).toBeNull();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} aby`);
    ui.unmount();
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { STATE_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { createBriefRecoveryState } from '../../engine/orchestrator/planning/brief-recovery.js';
import { createInitialState } from '../../core/state/machine.js';
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
const { reviewStore } = await import('../../stores/workflow/review.js');

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

function preparedExecution(projectDir: string, feature: string): PreparedExecution {
  const sessionId = 'workflow-screen-session';
  const active = {
    version: 1 as const,
    sessionId,
    generation: '44444444-4444-4444-8444-444444444444',
  };
  return {
    purpose: 'new-workflow',
    config: parsePreparedConfig(makeConfig()),
    preparationId: 'workflow-screen-preparation',
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir,
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: [],
    session: {
      kind: 'new',
      ref: { projectDir, sessionId },
      ownership: active,
      active,
    },
    runtime: {
      feature,
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

function navigatePreparedWorkflow(projectDir: string, feature: string): void {
  routerStore.navigate({
    to: 'workflow',
    execution: { kind: 'local', prepared: preparedExecution(projectDir, feature) },
  });
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
    navigatePreparedWorkflow(projectDir, 'chrome calibration');

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
    });
    expect(contentRect.top).toBe(getContentTopRow());
    expect(paintedBodyRow + 1).toBe(contentRect.top);

    ui.unmount();
  });

  it('passes persisted Brief recovery through the production screen mount', async () => {
    const sessionId = 'workflow-screen-session';
    const sessionPath = sessionDir(projectDir, sessionId);
    const tasksPath = join(sessionPath, TASKS_FILE);
    mkdirSync(sessionPath, { recursive: true });
    writeFileSync(
      tasksPath,
      formatTasks([makeTask({ id: 'T001', title: 'Persisted recovery task' })]),
      'utf8',
    );
    const activeBrief = { revision: 1, hash: 'persisted-brief-hash', path: TASKS_FILE };
    const report = {
      briefHash: activeBrief.hash,
      report: { revision: 1, hash: 'persisted-report-hash', path: 'brief-quality.json' },
      ruleVersion: 'brief-quality-v1',
      issues: [],
      errorCount: 0,
    };
    const state = {
      ...createInitialState('persisted recovery mount'),
      stateRevision: 7,
      stateFence: { token: 1, ownerId: 'workflow-screen-test' },
      phase: 'reviewing-briefs' as const,
      briefRecovery: createBriefRecoveryState(
        {
          sessionId,
          origin: { mode: 'standard', entry: 'initial' },
          continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
          activeBrief,
          report,
          qualityPolicyVersion: 'brief-quality-v1',
        },
        { epochId: 'persisted-recovery-epoch', recoveryRevision: 3 },
      ),
    };
    writeFileSync(join(sessionPath, STATE_FILE), JSON.stringify(state), 'utf8');
    reviewStore.setReviewFile(tasksPath);
    lifecycleStore.__testReset({ phase: 'reviewing-briefs', status: 'running' });
    runWorkflow.mockImplementation(async (opts) => {
      lifecycleStore.__testReset({ phase: 'reviewing-briefs', status: 'running' });
      await opts.callbacks.onApprovalNeeded('briefs', tasksPath);
      return pendingWorkflow();
    });
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    navigatePreparedWorkflow(projectDir, 'persisted recovery mount');

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('CONTRACT READY');
      expect(frame).toContain('Persisted recovery task');
    });

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
    navigatePreparedWorkflow(projectDir, 'review action lifecycle');
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

    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await tick();
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Second review');
    });
    expect(outcomes).toEqual([{ approved: false }]);

    await flushEffects();
    ui.stdin.write('\r');
    await tick();
    expect(outcomes).toHaveLength(1);
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\x1b[A');
    await flushEffects();
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
    navigatePreparedWorkflow(projectDir, 'multiline review ownership');
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

    await flushEffects();
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
    navigatePreparedWorkflow(projectDir, 'stale review action');
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
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('x');
    await flushEffects();
    ui.stdin.write('\x7f');
    await flushEffects();
    ui.stdin.write('\r');
    await tick();
    expect(outcome).toBeUndefined();

    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
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
    navigatePreparedWorkflow(projectDir, 'brief key ownership');
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

    await flushEffects();
    ui.stdin.write('ab');
    await tick();
    expect(focusStore.get()).toBeNull();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} ab`);

    focusStore.set('brief', 1);
    await flushEffects();
    ui.stdin.write('y');
    await tick();
    await Promise.resolve();
    await tick();
    expect(copyTarget).toHaveBeenCalledWith('brief');
    expect(copyTarget).toHaveBeenCalledTimes(1);
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} ab`);

    await flushEffects();
    ui.stdin.write(SHIFT_DOWN);
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });

    focusStore.set('brief', 0);
    await flushEffects();
    ui.stdin.write('y');
    await tick();
    expect(copyTarget).toHaveBeenCalledTimes(1);
    expect(focusStore.get()).toBeNull();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('prompt')} aby`);
    ui.unmount();
  });
});

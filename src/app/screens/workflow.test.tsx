import { readFileSync, writeFileSync } from 'node:fs';
import { REVIEW_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { buildReviewFailedRecoveryIssue } from '../../engine/orchestrator/recovery/builders/task.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { taskId } from '../../core/schemas/task.js';
import { saveState } from '../../core/state/persistence.js';
import { addEvent } from '../../stores/workflow/actions/event.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { getContentTopRow } from '../../features/workflow/layout/chrome-rows.js';
import { getWorkflowContentRect } from '../../features/workflow/layout/rect.js';
import { WorkflowScreen } from './workflow.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../lib/terminal/typeahead-grace.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeCtx, runCommandInTest } from '#testing/helpers/runtime-commands.js';
import { workflowCommands } from '../../core/runtime/commands/defs/workflow.js';
import { hydrateResume } from '../../features/workflow/resume-hydration.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { configStore } = await import('../../stores/project/config.js');
const { terminalSizeStore } = await import('../../stores/ui/terminal-size.js');
const { routerStore } = await import('../../stores/navigation/router.js');
const { overlayStore } = await import('../../stores/ui/overlay.js');
const { inputHeightStore } = await import('../../stores/ui/input-height.js');
const { inputHistoryStore } = await import('../../stores/ui/input-history.js');
const { feedbackStore } = await import('../../stores/ui/feedback.js');
const { stopStore } = await import('../../stores/workflow/stop.js');
const { COMMANDS_ONLY_NOTICE } = await import('../../components/composer/composer.js');

const FIXED_TS = 1_783_958_400_000;
const SHIFT_ENTER = '\x1b[13;2u';

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
  const prepared = preparedExecution(projectDir, feature);
  routerStore.navigate({
    to: 'workflow',
    run: makeRunRecord({ ref: prepared.session.ref }),
    execution: { kind: 'local', prepared },
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
      outcomes.push(await opts.callbacks.onApprovalNeeded('plan', firstReviewPath, []));
      publishEvent(opts, {
        type: 'planner_text',
        ts: FIXED_TS + 1,
        phase: 'reviewing-plan',
        role: 'planner',
        content: 'plain',
        text: 'Second review opened',
      });
      outcomes.push(await opts.callbacks.onApprovalNeeded('plan', secondReviewPath, []));
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('First review');
    });

    // The document gate lists approve · comment · edit · end run, so the third step down is the
    // end-run row this test drives.
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await tick();
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(outcomes).toEqual([{ approved: false, action: 'end-run' }]);
    });
    // The second gate's document is read from disk after its prompt opens, so the frame that
    // carries it lands a paint later than the answer that opened it.
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Second review');
    });

    // The next gate starts on its own first row again — the cursor never carries over.
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\x1b[A');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(outcomes).toEqual([{ approved: false, action: 'end-run' }, { approved: true }]);
    });
    ui.unmount();
  });

  it('wraps the document cursor from the first row up to the end-run row', async () => {
    const reviewPath = join(projectDir, 'wrapped-review.md');
    writeFileSync(reviewPath, '# Wrapped review\n\nReview body.', 'utf8');
    let outcome: ApprovalReviewResult | undefined;
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'wrapped review');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'reviewing-plan',
        feature: 'wrapped review',
      });
      outcome = await opts.callbacks.onApprovalNeeded('plan', reviewPath, []);
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Wrapped review');
    });

    await flushEffects();
    ui.stdin.write('\x1b[A');
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(outcome).toEqual({ approved: false, action: 'end-run' });
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
      await opts.callbacks.onApprovalNeeded('plan', reviewPath, []);
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
      outcome = await opts.callbacks.onApprovalNeeded('plan', reviewPath, []);
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
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(outcome).toEqual({ approved: false, action: 'end-run' });
    });
    ui.unmount();
  });

  it.each([
    ['quickly drop T003 and keep T002'],
    ['yes, but split T002 into two tasks'],
    ['edit nothing, just rename T001'],
    ['Split T002 into two tasks'],
  ])('sends "%s" typed at the plan card to the planner as a correction', async (typed) => {
    const reviewPath = join(projectDir, 'plan.md');
    writeFileSync(reviewPath, 'Greet people by name.', 'utf8');
    let outcome: ApprovalReviewResult | undefined;
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'plan card correction');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'reviewing-plan',
        feature: 'plan card correction',
      });
      outcome = await opts.callbacks.onApprovalNeeded('plan', reviewPath, []);
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Greet people by name.');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    for (const char of typed) {
      ui.stdin.write(char);
      await flushEffects();
    }
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(outcome).toEqual({ approved: false, action: 'revise', comment: typed });
    });
    ui.unmount();
  });

  it('stands the build block down while the stop ladder parks the run', async () => {
    const brief = taskId('T001');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    inputHeightStore.__testReset({ rows: 2 });
    navigatePreparedWorkflow(projectDir, 'parked stand-down');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'implementing',
        feature: 'parked stand-down',
      });
      publishEvent(opts, {
        type: 'tasks_planned',
        ts: FIXED_TS + 1,
        phase: 'implementing',
        total: 1,
        tasks: [
          { id: brief, title: 'Stand-down brief', index: 0, file: 'src/a.ts', action: 'modify' },
        ],
      });
      publishEvent(opts, {
        type: 'task_started',
        ts: FIXED_TS + 2,
        phase: 'implementing',
        taskId: brief,
        title: 'Stand-down brief',
        index: 0,
        total: 1,
        file: 'src/a.ts',
        action: 'modify',
        tool: 'opencode',
        model: 'stand-down-model',
      });
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('briefs passed');
    });

    stopStore.request('stop-now');
    stopStore.park('mid-brief', brief, null);
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    // The stop's own words keep the frame: the footer states where it parked and the legend names
    // the key that lifts it. The block's rows stand down with the attempt that is no longer in
    // flight, so neither the brief fraction nor the freshness line paints over the parked run.
    expect(frame).toContain('Paused at T001');
    expect(frame).toContain('/resume');
    expect(frame).not.toContain('briefs passed');
    expect(frame).not.toContain('no update yet');
    ui.unmount();
  });
});
describe('WorkflowScreen showing a run at rest', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('workflow-at-rest');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(pendingWorkflow());
  });

  afterEach(() => {
    resetAllStores();
    if (projectDir) cleanupTempDir(projectDir);
  });

  function openRun(overrides: Partial<Parameters<typeof makeRunRecord>[0]> = {}) {
    const record = makeRunRecord({
      ref: { projectDir, sessionId: 'at-rest-session' },
      status: {
        kind: 'open',
        stop: { kind: 'paused', at: 'mid-step' },
        resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
      },
      hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'implementing' }) },
      ...overrides,
    });
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
    return record;
  }

  function closedRun(
    as: 'complete' | 'ended',
    extra: Partial<Parameters<typeof makeRunRecord>[0]> = {},
  ) {
    return openRun({
      status: { kind: 'closed', as },
      summary: makeSummary({ feature: 'closed at rest', totalTasks: 0 }),
      ...extra,
    });
  }

  it('shows the history the replay put on the screen, with nothing running', async () => {
    openRun();
    addEvent({
      type: 'planner_text',
      ts: FIXED_TS,
      phase: 'implementing',
      text: 'The signup form posts straight to the route handler.',
    });

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('signup form posts');
    expect(runWorkflow).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('states what an open run takes and continues it on a typed correction', async () => {
    const record = openRun();
    const state = makeWorkflowState({ phase: 'implementing' });
    saveState(record.ref, state);
    const prepareResume = vi.fn(async () => ({
      kind: 'prepared' as const,
      execution: preparedExecution(projectDir, 'continued run'),
    }));

    const ui = renderFeature(
      <WorkflowScreen
        commands={[]}
        onRuntimeCommand={vi.fn()}
        deps={{
          runWorkflow,
          sessionSelect: {
            loadResumeState: () => ({ kind: 'loaded', state }),
            prepareResume,
            hydrateRun: async () => {},
          },
        }}
      />,
    );
    await flushEffects();
    const byline = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(byline).toContain('Paused at T003');
    expect(byline).toContain('type a correction or ⏎ to continue');

    ui.stdin.write('use the cached parser');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(prepareResume).toHaveBeenCalled();
    });

    const route = routerStore.get();
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.steer).toBe('use the cached parser');
    } else {
      throw new Error('expected the continuation to flip the execution in place');
    }
    ui.unmount();
  });

  /** A run at rest on a final review that failed after its repair cycles ran out. */
  function renderFailedReviewRun() {
    const issue = {
      ...buildReviewFailedRecoveryIssue({
        blocking: 1,
        phase: 'complete',
        createdAt: '2026-09-24T00:00:00.000Z',
      }),
      status: 'paused' as const,
    };
    const halted = makeWorkflowState({
      phase: 'complete',
      reviewStatus: 'failed',
      fixCycles: { used: 2, allowance: 2, notes: [] },
      tasks: [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })],
      currentTaskIndex: 1,
      pendingRecovery: issue,
    });
    const record = openRun({
      status: {
        kind: 'open',
        stop: { kind: 'halted', issue },
        resumeAt: { kind: 'review', cycle: 2 },
      },
      hydration: { kind: 'loaded', state: halted },
    });
    saveState(record.ref, halted);
    writeSpecFile(
      record.ref,
      REVIEW_FILE,
      '### Verdict\nfail\n\n### Findings\n- **Critical**: src/alpha.ts drops the error\n',
    );
    const base = preparedExecution(projectDir, 'continued run');
    const prepareResume = vi.fn(async () => ({
      kind: 'prepared' as const,
      execution: {
        ...base,
        purpose: 'resume' as const,
        session: { ...base.session, ref: record.ref },
        runtime: { ...base.runtime, resumeState: halted },
      },
    }));

    const ui = renderFeature(
      <WorkflowScreen
        commands={[]}
        onRuntimeCommand={vi.fn()}
        deps={{
          runWorkflow,
          sessionSelect: {
            loadResumeState: hydrateResume,
            prepareResume,
            hydrateRun: async () => {},
          },
        }}
      />,
    );
    return { ui, record };
  }

  it('sends a failed final review back with the correction typed into the at-rest composer', async () => {
    const { ui, record } = renderFailedReviewRun();
    await flushEffects();

    ui.stdin.write('log the error, then rethrow it');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(runWorkflow).toHaveBeenCalled();
    });

    const entered = runWorkflow.mock.calls[0]?.[0];
    expect(entered?.steer).toBeUndefined();
    expect(entered?.savedState?.phase).toBe('final-review');
    expect(entered?.savedState?.pendingRecovery).toBeUndefined();
    expect(entered?.savedState?.pendingTriage?.inputs).toContainEqual({
      id: 'U1',
      kind: 'defect',
      source: 'user',
      text: 'log the error, then rethrow it',
      file: null,
    });
    const log = readFileSync(
      join(sessionDir(projectDir, record.ref.sessionId), 'session.jsonl'),
      'utf-8',
    );
    expect(log).toContain('"type":"user_message"');
    expect(log).toContain('log the error, then rethrow it');
    expect(feedbackStore.get().isError).toBe(false);
    ui.unmount();
  });

  it('sends a failed final review back with the correction typed into the panel field', async () => {
    const { ui } = renderFailedReviewRun();
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Fix again');
    });
    ui.stdin.write('\t');
    await flushEffects();
    ui.stdin.write('log the error, then rethrow it');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(runWorkflow).toHaveBeenCalled();
    });

    const entered = runWorkflow.mock.calls[0]?.[0];
    expect(entered?.savedState?.phase).toBe('final-review');
    expect(entered?.savedState?.pendingTriage?.inputs).toContainEqual({
      id: 'U1',
      kind: 'defect',
      source: 'user',
      text: 'log the error, then rethrow it',
      file: null,
    });
    expect(feedbackStore.get().isError).toBe(false);
    ui.unmount();
  });

  it('hints at the panel alone on a halt that takes no typed correction', async () => {
    const issue = makeRecoveryIssue({
      reason: 'dependency-blocked',
      phase: 'implementing',
      availableActions: ['pause-run', 'end-run'],
      recommendedAction: 'pause-run',
    });
    const halted = makeWorkflowState({
      phase: 'implementing',
      tasks: [makeTask({ status: 'in_progress' })],
      pendingRecovery: issue,
    });
    const record = openRun({
      status: {
        kind: 'open',
        stop: { kind: 'halted', issue },
        resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
      },
      hydration: { kind: 'loaded', state: halted },
    });
    saveState(record.ref, halted);
    const base = preparedExecution(projectDir, 'continued run');
    const prepareResume = vi.fn(async () => ({
      kind: 'prepared' as const,
      execution: {
        ...base,
        purpose: 'resume' as const,
        session: { ...base.session, ref: record.ref },
        runtime: { ...base.runtime, resumeState: halted },
      },
    }));

    const ui = renderFeature(
      <WorkflowScreen
        commands={[]}
        onRuntimeCommand={vi.fn()}
        deps={{
          runWorkflow,
          sessionSelect: {
            loadResumeState: hydrateResume,
            prepareResume,
            hydrateRun: async () => {},
          },
        }}
      />,
    );
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Pause run');
    });
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Tab to choose an action…');
    expect(frame).not.toContain('Type a correction, or tab to choose an action…');
    ui.unmount();
  });

  function readyRun(override = false, findings = ['missing null check']) {
    return openRun({
      status: { kind: 'ready-to-apply', override },
      hydration: {
        kind: 'loaded',
        state: makeWorkflowState({
          phase: 'complete',
          reviewStatus: override ? 'failed' : 'passed',
          workspace: {
            kind: 'worktree',
            path: join(projectDir, 'run-workspace'),
            base: { snapshotId: 'workspace-base', head: null },
          },
          ...(override && {
            acceptedAsIs: { at: '2026-09-14T00:00:00.000Z', findings },
          }),
        }),
      },
    });
  }

  it('opens a ready run with the result menu above the composer', async () => {
    readyRun();
    const onRuntimeCommand = vi.fn();

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />);
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Ready to apply');
    expect(frame).toContain('Show diff');
    expect(frame).toContain('Discard');
    expect(frame).not.toContain('Closed');

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/run accept');
    });
    ui.unmount();
  });

  it('fits the at-rest byline inside the row past its mark slot', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    readyRun(true);

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    expect(lines.at(-1)?.trim()).toBe('Choose Apply, Show diff or Discard');
    ui.unmount();
  });

  it('takes no result-menu keys while an overlay owns the keyboard', async () => {
    readyRun();
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />);
    await flushEffects();
    overlayStore.open('help');
    await flushEffects();

    ui.stdin.write('\r');
    await tick(30);

    expect(onRuntimeCommand).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('reserves the height of the override confirmation it paints', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 40 });
    const findings = Array.from(
      { length: 8 },
      (_, index) => `Open finding ${index + 1} needs a fix`,
    );
    readyRun(true, findings);

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />, {
      cols: 60,
      rows: 40,
    });
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Apply with 8 open findings?');
    expect(frame).toContain('Open finding 8 needs a fix');
    expect(frame).toContain('Back · return to the result menu');
    expect(frame).toContain('tab type a command');
    ui.unmount();
  });

  it('resets confirmation when the menu closes or the ready session changes', async () => {
    const record = readyRun(true);
    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Apply with 1 open finding?');

    routerStore.init({
      screen: 'workflow',
      run: { ...record, ref: { ...record.ref, sessionId: 'another-ready-session' } },
      execution: { kind: 'at-rest' },
    });
    await flushEffects();
    await tick(30);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('open findings; asks once');
    ui.stdin.write('\r');
    await tick(30);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Apply with 1 open finding?');

    overlayStore.open('stop-sheet');
    await flushEffects();
    overlayStore.close();
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('open findings; asks once');
    ui.unmount();
  });

  it('moves focus to the composer with Tab, and an empty Enter there hands it back to the menu', async () => {
    readyRun();
    const onRuntimeCommand = vi.fn();

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />);
    await flushEffects();
    ui.stdin.write('\t');
    await flushEffects();
    ui.stdin.write('z');
    await flushEffects();
    expect(feedbackStore.get().message).toBe(COMMANDS_ONLY_NOTICE);

    ui.stdin.write('\r');
    await flushEffects();
    expect(onRuntimeCommand).not.toHaveBeenCalled();
    expect(runWorkflow).not.toHaveBeenCalled();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/run accept');
    });
    ui.unmount();
  });

  it('asks once before applying a run accepted as is', async () => {
    readyRun(true);
    const commands = workflowCommands(
      makeCtx({
        acceptRun: async (confirm) =>
          confirm
            ? { status: 'applied', files: ['src/form.ts'] }
            : { status: 'confirm-override', findings: ['missing null check'] },
        setFeedbackMessage: feedbackStore.setMessage,
        setFeedbackError: feedbackStore.setError,
      }),
    );
    const onRuntimeCommand = vi.fn((raw: string) =>
      runCommandInTest({ commands, raw, screen: 'workflow', onError: feedbackStore.setError }),
    );

    const ui = renderFeature(
      <WorkflowScreen commands={commands} onRuntimeCommand={onRuntimeCommand} />,
    );
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Ready to apply as is');
    ui.stdin.write('\r');
    await flushEffects();
    expect(onRuntimeCommand).not.toHaveBeenCalled();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('missing null check');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/run accept confirm');
      expect(feedbackStore.get()).toEqual({
        message: 'Applied 1 file to your checkout.',
        isError: false,
      });
    });
    ui.unmount();
  });

  it('takes only commands on a closed run and paints its ledger at the transcript tail', async () => {
    closedRun('complete');

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Closed');
    expect(frame).toContain('Session');

    ui.stdin.write('z');
    await flushEffects();
    expect(feedbackStore.get().message).toBe(COMMANDS_ONLY_NOTICE);
    ui.unmount();
  });

  it('flips the byline when the run record says the run was accepted', async () => {
    const record = closedRun('complete');

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('/run accept');

    routerStore.updateRun({ run: { ...record, checkpoint: { kind: 'accepted' } } });
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Accepted');
    expect(frame).not.toContain('Keep it with /run accept');
    ui.unmount();
  });
});

describe('WorkflowScreen stating a silent seat', () => {
  let projectDir = '';
  const brief = taskId('T001');
  const call = {
    phase: 'implementing',
    taskId: brief,
    callId: 'silent-call',
    role: 'implementer',
    backendKind: 'cli',
    runnerName: 'opencode',
    model: 'silent-model',
    attempt: 1,
  } as const;

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('workflow-silent-seat');
    runWorkflow.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAllStores();
    if (projectDir) cleanupTempDir(projectDir);
  });

  // Only the clocks are faked: React still paints on setImmediate, so a flush paints and a second
  // passes only when the test advances it.
  it('states the silence in the block, and on the byline once the block stands down', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(FIXED_TS);
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'silent seat');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS - 400_000,
        phase: 'implementing',
        feature: 'silent seat',
      });
      publishEvent(opts, {
        type: 'task_started',
        ts: FIXED_TS - 390_000,
        phase: 'implementing',
        taskId: brief,
        title: 'Silent brief',
        index: 0,
        total: 1,
        file: 'src/a.ts',
        action: 'modify',
        tool: 'opencode',
        model: 'silent-model',
      });
      publishEvent(opts, {
        type: 'runner_call_started',
        ts: FIXED_TS - 310_000,
        ...call,
        sequence: 0,
      });
      publishEvent(opts, {
        type: 'runner_call_stalled',
        ts: FIXED_TS - 10_000,
        ...call,
        sequence: 1,
        silentMs: 300_000,
      });
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      { cols: 120, rows: 40 },
    );
    await flushEffects();

    const beside = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(beside).toContain('No update for 5m 10s');
    expect(beside).toContain('Still working · tools report when done');
    expect(beside).not.toContain('silent 5m');

    vi.advanceTimersByTime(3_000);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('No update for 5m 13s');

    overlayStore.open('stop-sheet');
    await flushEffects();

    const menuOpen = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(menuOpen).toContain('Stop options');
    expect(menuOpen).not.toContain('No update');
    expect(menuOpen).toContain('Still working — silent 5m 13s · tools report when done');

    vi.advanceTimersByTime(2_000);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Still working — silent 5m 15s');

    ui.unmount();
  });
});

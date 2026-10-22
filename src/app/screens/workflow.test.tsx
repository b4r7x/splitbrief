import { readFileSync, writeFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { REVIEW_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { buildReviewFailedRecoveryIssue } from '../../engine/orchestrator/recovery/builders/task.js';
import { buildApplyConflictRecoveryIssue } from '../../engine/orchestrator/recovery/builders/apply.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { taskId } from '../../core/schemas/task.js';
import { saveState } from '../../core/state/persistence.js';
import { addEvent } from '../../stores/workflow/actions/event.js';
import { departureStore } from '../../stores/workflow/departure.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import {
  getContentTopRow,
  railConnectorString,
} from '../../features/workflow/layout/chrome-rows.js';
import { getWorkflowContentRect } from '../../features/workflow/layout/rect.js';
import { WorkflowScreen } from './workflow.js';
import { CommandPaletteOverlay } from '../overlays/palette.js';
import { useRuntimeCommands } from '../command-context.js';
import {
  activeApply,
  trackActiveApply,
} from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../lib/terminal/typeahead-grace.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeCtx, runCommandInTest } from '#testing/helpers/runtime-commands.js';
import { workflowCommands } from '../../core/runtime/commands/defs/workflow.js';
import { hydrateResume } from '../../features/workflow/resume-hydration.js';
import { listRowLead } from '../../components/list-row.js';
import { glyph } from '../../lib/glyphs.js';
import { arrowSep } from '../../core/separators.js';
import { saveFinalSession } from '../../engine/orchestrator/session-lifecycle/finalize.js';
import {
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
} from '../../features/workflow/prompt-rows/approval.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { configStore } = await import('../../stores/project/config.js');
const { terminalSizeStore } = await import('../../stores/ui/terminal-size.js');
const { routerStore } = await import('../../stores/navigation/router.js');
const { overlayStore } = await import('../../stores/ui/overlay.js');
const { inputHeightStore } = await import('../../stores/ui/input-height.js');
const { inputHistoryStore } = await import('../../stores/ui/input-history.js');
const { feedbackStore } = await import('../../stores/ui/feedback.js');
const { composerLiveStore } = await import('../../stores/ui/composer-live.js');
const { stopStore } = await import('../../stores/workflow/stop.js');
const { COMMANDS_ONLY_NOTICE } = await import('../../components/composer/composer.js');
const { lifecycleStore } = await import('../../stores/workflow/lifecycle.js');
const { openReviewChecksPrompt } = await import('../../stores/review-checks-prompt/prompt.js');

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
    sourceConfig: parsePreparedConfig(makeConfig()),
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

/** The record of a run that planned on Opus and moved its build from Haiku to auto. */
function builtOnOtherCrew(): Summary {
  const brief = {
    method: 'local',
    implementerTokens: 1,
    escalationTokens: 0,
    retryCount: 0,
  } as const;
  return makeSummary({
    feature: 'ready run',
    plannerTool: 'claude-code',
    plannerModel: 'opus',
    implementerTool: 'antigravity',
    implementerModel: 'auto',
    taskBreakdown: [
      { ...brief, taskId: taskId('T001'), taskTitle: 'First', tool: 'claude-code', model: 'haiku' },
      { ...brief, taskId: taskId('T002'), taskTitle: 'Second', tool: 'antigravity', model: 'auto' },
    ],
  });
}

/** The crew saved after that run built: BUILD on Sonnet. */
function sonnetBuildConfig() {
  return makeConfig({ implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } });
}

/** The Ctrl+K palette over the screen, fed by the real command registry, as the app root mounts it. */
function WithPalette({ children }: { children: ReactNode }) {
  const phase = lifecycleStore.use((state) => state.phase);
  const { commands, handleRuntimeCommand } = useRuntimeCommands({ exit: () => {}, phase });
  const active = overlayStore.use((state) => state.active);
  return (
    <>
      {children}
      {active === 'command-palette' && (
        <CommandPaletteOverlay
          commands={commands}
          onRuntimeCommand={(raw) => handleRuntimeCommand(raw, 'workflow')}
        />
      )}
    </>
  );
}

/** Opens the palette, finds the command by its name and picks it, then types the argument. */
async function pickInPalette(
  ui: ReturnType<typeof renderFeature>,
  name: string,
  argument: string,
): Promise<void> {
  overlayStore.open('command-palette');
  await flushEffects();
  for (const key of name) {
    ui.stdin.write(key);
    await flushEffects();
  }
  ui.stdin.write('\r');
  await flushEffects();
  for (const key of argument) {
    ui.stdin.write(key);
    await flushEffects();
  }
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
    vi.useRealTimers();
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

  it.each([
    {
      name: 'opens Request changes when ↓⏎ arrive in one read',
      before: '',
      chunk: '\x1b[B\r',
      settled: false,
    },
    {
      name: 'approves when ↑⏎ arrive in one read from Request changes',
      before: '\x1b[B',
      chunk: '\x1b[A\r',
      settled: true,
    },
  ])('$name', async ({ before, chunk, settled }) => {
    vi.useFakeTimers({ toFake: ['Date'], now: FIXED_TS });
    const reviewPath = join(projectDir, 'plan.md');
    writeFileSync(reviewPath, 'Greet people by name.', 'utf8');
    const outcomes: ApprovalReviewResult[] = [];
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'plan card burst');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'reviewing-plan',
        feature: 'plan card burst',
      });
      outcomes.push(await opts.callbacks.onApprovalNeeded('plan', reviewPath, []));
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Greet people by name.');
    });
    vi.advanceTimersByTime(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    await flushEffects();
    if (before !== '') {
      ui.stdin.write(before);
      await flushEffects();
    }
    ui.stdin.write(chunk);

    if (settled) {
      await vi.waitFor(() => {
        expect(outcomes).toEqual([{ approved: true }]);
      });
    } else {
      await flushEffects();
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain(`${listRowLead('active')}Request changes`);
      expect(frame).toContain(REVIEW_COMMENT_HINTS);
      await tick();
      expect(outcomes).toEqual([]);
    }
    ui.unmount();
  });

  it('keeps Request changes marked while its composer draft owns the keys', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: FIXED_TS });
    const reviewPath = join(projectDir, 'plan.md');
    writeFileSync(reviewPath, 'Greet people by name.', 'utf8');
    let outcome: ApprovalReviewResult | undefined;
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'plan change request');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'reviewing-plan',
        feature: 'plan change request',
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
    vi.advanceTimersByTime(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('Split the CLI change into a separate task.');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain(`${listRowLead('active')}Request changes`);
    expect(frame).not.toContain(`${listRowLead('active')}Edit plan.json`);
    expect(frame).toContain('Split the CLI change into a separate task.');
    expect(frame).not.toContain('comment Split');
    expect(frame).toContain(REVIEW_COMMENT_HINTS);
    expect(frame).not.toContain(REVIEW_DOCUMENT_HINTS);
    expect(outcome).toBeUndefined();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(outcome).toMatchObject({
        approved: false,
        action: 'revise',
        message: { text: 'Split the CLI change into a separate task.' },
      });
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
    const commentingFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(commentingFrame).toContain(`${listRowLead('active')}Request changes`);
    expect(commentingFrame).not.toContain(`${listRowLead('active')}Edit plan.json`);
    ui.stdin.write('\b');
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      `${listRowLead('active')}Edit plan.json`,
    );
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

  it('opens an empty change request on Request changes and sends what follows as the correction', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: FIXED_TS });
    const reviewPath = join(projectDir, 'plan.md');
    writeFileSync(reviewPath, 'Greet people by name.', 'utf8');
    let outcome: ApprovalReviewResult | undefined;
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'plan card request changes');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'reviewing-plan',
        feature: 'plan card request changes',
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
    vi.advanceTimersByTime(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    const requested = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(composerLiveStore.get().empty).toBe(true);
    expect(requested).toContain(`${listRowLead('active')}Request changes`);
    expect(requested).toContain(REVIEW_COMMENT_HINTS);
    // An empty ⏎ sends nothing and settles nothing: the keys belong to the change request.
    ui.stdin.write('\r');
    await tick();
    expect(outcome).toBeUndefined();

    // A word the card reads as a command is part of the change request once it was chosen.
    ui.stdin.write('n');
    await flushEffects();
    ui.stdin.write('o');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(outcome).toEqual({
        approved: false,
        action: 'revise',
        message: { text: 'no', displayText: 'no', images: [], attachedInputs: [] },
      });
    });
    ui.unmount();
  });

  it.each([
    ['quickly drop T003 and keep T002'],
    ['yes, but split T002 into two tasks'],
    ['edit nothing, just rename T001'],
    ['Split T002 into two tasks'],
  ])('sends "%s" typed at the plan card to the planner as a correction', async (typed) => {
    vi.useFakeTimers({ toFake: ['Date'], now: FIXED_TS });
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
    vi.advanceTimersByTime(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    await flushEffects();
    for (const char of typed) {
      ui.stdin.write(char);
      await flushEffects();
    }
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain(`${listRowLead('active')}Request changes`);
    expect(frame).not.toContain(`${listRowLead('active')}Approve plan`);
    expect(frame).toContain(REVIEW_COMMENT_HINTS);
    expect(frame).not.toContain(REVIEW_DOCUMENT_HINTS);
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(outcome).toEqual({
        approved: false,
        action: 'revise',
        message: { text: typed, displayText: typed, images: [], attachedInputs: [] },
      });
    });
    ui.unmount();
  });

  it('keeps queue copy on the running brief, then stands down while stopping', async () => {
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
      publishEvent(opts, {
        type: 'message_queued',
        ts: FIXED_TS + 3,
        phase: 'implementing',
        id: 'queued-build-message',
        seat: 'build',
        taskId: brief,
        preview: 'Keep every word',
      });
      return pendingWorkflow();
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('briefs passed');
    });

    const runningFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(runningFrame.match(/Message BUILD on T001 · read when its call ends…/g)).toHaveLength(1);
    expect(runningFrame).toContain('1 queued for BUILD on T001');

    stopStore.request('stop-now');
    stopStore.park('mid-brief', brief, null);
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    // The stop's own words keep the frame: the footer states where it parked and the legend names
    // the key that lifts it. The block's rows stand down with the attempt that is no longer in
    // flight, so neither the brief fraction nor the freshness line paints over the parked run.
    expect(frame).toContain('Stopped at T001');
    expect(frame).toContain('⏎ resume');
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
        stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
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
    const state = makeWorkflowState({
      phase: 'implementing',
      tasks: [makeTask({ id: 'T003', status: 'in_progress' })],
      interruptedStep: {
        step: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
        source: 'user',
        at: '2026-10-13T08:00:00.000Z',
        cut: 'mid-step',
      },
    });
    const record = openRun({ hydration: { kind: 'loaded', state } });
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
            applying: () => false,
            loadResumeState: () => ({ kind: 'loaded', state }),
            prepareResume,
            hydrateRun: async () => {},
          },
        }}
      />,
    );
    await flushEffects();
    const byline = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(byline).toContain('Stopped at T003');
    expect(byline).toContain('type a correction or ⏎ to continue');
    // The focused composer keeps its hint; only the byline names what ⏎ does.
    expect(byline).toContain('Type a correction…');
    expect(byline.match(/⏎/g)).toHaveLength(1);

    ui.stdin.write('use the cached parser');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(prepareResume).toHaveBeenCalled();
    });

    const route = routerStore.get();
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.steer).toEqual({
        text: 'use the cached parser',
        displayText: 'use the cached parser',
        images: [],
        attachedInputs: [],
      });
    } else {
      throw new Error('expected the continuation to flip the execution in place');
    }
    ui.unmount();
  });

  /** A run at rest on a final review that failed after its repair cycles ran out. */
  function renderFailedReviewRun() {
    const issue = buildReviewFailedRecoveryIssue({
      blocking: 1,
      phase: 'complete',
      createdAt: '2026-09-24T00:00:00.000Z',
    });
    const halted = makeWorkflowState({
      phase: 'complete',
      reviewStatus: 'failed',
      fixCycles: { used: 2, allowance: 2, notes: [] },
      tasks: [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })],
      currentTaskIndex: 1,
      pendingRecovery: issue,
    });
    const record = openRun({
      status: {
        kind: 'open',
        stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
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
            applying: () => false,
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

  it('names the panel actions in the placeholder while the panel holds the keys', async () => {
    const { ui } = renderFailedReviewRun();
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Fix again');
    });
    const panelFocused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(panelFocused).toContain('Choose an action above, or tab to type a correction…');
    expect(panelFocused).not.toContain('tab to choose an action');

    ui.stdin.write('\t');
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      'Type a correction, or tab to choose an action…',
    );
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

  function renderDependencyBlockedHalt(onRuntimeCommand = vi.fn()) {
    const issue = makeRecoveryIssue({
      reason: 'dependency-blocked',
      phase: 'implementing',
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    });
    const halted = makeWorkflowState({
      phase: 'implementing',
      tasks: [makeTask({ status: 'in_progress' })],
      pendingRecovery: issue,
    });
    const record = openRun({
      status: {
        kind: 'open',
        stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
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

    return renderFeature(
      <WithPalette>
        <WorkflowScreen
          commands={[]}
          onRuntimeCommand={onRuntimeCommand}
          deps={{
            runWorkflow,
            sessionSelect: {
              applying: () => false,
              loadResumeState: hydrateResume,
              prepareResume,
              hydrateRun: async () => {},
            },
          }}
        />
      </WithPalette>,
    );
  }

  it('hints at the panel alone on a halt that takes no typed correction', async () => {
    const ui = renderDependencyBlockedHalt();
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip task');
    });
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Choose an action above…');
    expect(frame).not.toContain('Tab to choose an action…');
    expect(frame).not.toContain('type a correction');

    ui.stdin.write('\t');
    await flushEffects();
    const composerFocused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(composerFocused).toContain('Tab to choose an action…');
    expect(composerFocused).not.toContain('Type a correction, or tab to choose an action…');
    ui.unmount();
  });

  it('runs a slash command typed over a halt menu without taking its letter keys', async () => {
    const onRuntimeCommand = vi.fn();
    const ui = renderDependencyBlockedHalt(onRuntimeCommand);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip task');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    for (const key of '/settings') {
      ui.stdin.write(key);
      await flushEffects();
    }
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip task');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('tab back to the actions');
    ui.unmount();
  });

  it('hands the keys to the composer for a command picked in the palette over a halt menu', async () => {
    const onRuntimeCommand = vi.fn();
    const ui = renderDependencyBlockedHalt(onRuntimeCommand);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip task');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    await pickInPalette(ui, 'scroll', 'top');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('/scroll top');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/scroll top');
    });
    expect(onRuntimeCommand.mock.calls).toEqual([['/scroll top']]);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Skip task');
    expect(frame).toContain('tab back to the actions');
    ui.unmount();
  });

  it('takes no halt letter typed into the palette over it', async () => {
    const ui = renderDependencyBlockedHalt();
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip task');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    overlayStore.open('command-palette');
    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    await tick(30);
    overlayStore.close();
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain('-> skipped');
    expect(frame).toContain('Choose an action above…');
    ui.unmount();
  });

  it('takes no halt letter read in the same stdin dispatch as the slash', async () => {
    const onRuntimeCommand = vi.fn();
    const ui = renderDependencyBlockedHalt(onRuntimeCommand);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip task');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    ui.stdin.write('/');
    ui.stdin.write('s');
    await flushEffects();
    await tick(30);
    ui.stdin.write('\b');
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Skip task');
    expect(frame).toContain('tab back to the actions');
    ui.unmount();
  });

  it('runs only the slash command typed over the stop sheet above a halt menu', async () => {
    const onRuntimeCommand = vi.fn();
    const ui = renderDependencyBlockedHalt(onRuntimeCommand);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip task');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    overlayStore.open('stop-sheet');
    await flushEffects();

    for (const key of '/settings') {
      ui.stdin.write(key);
      await flushEffects();
    }
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    await flushEffects();
    expect(onRuntimeCommand.mock.calls).toEqual([['/settings']]);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Skip task');
    expect(frame).toContain('tab back to the actions');
    ui.unmount();
  });

  function holdApply(): void {
    const apply = Promise.withResolvers<void>();
    void trackActiveApply(apply.promise);
    onTestFinished(async () => {
      apply.resolve();
      await activeApply();
    });
  }

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

  it('hands the keys to the composer for a command picked in the palette over the result menu', async () => {
    readyRun();
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WithPalette>
        <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />
      </WithPalette>,
    );
    await flushEffects();

    await pickInPalette(ui, 'scroll', 'top');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('/scroll top');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/scroll top');
    });
    expect(onRuntimeCommand.mock.calls).toEqual([['/scroll top']]);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Show diff');
    expect(frame).toContain('tab back to the actions');
    ui.unmount();
  });

  it('names the crew that built a ready run, not the crew saved since', async () => {
    configStore.__testReset({ config: sonnetBuildConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 160, rows: 40 });
    const ready = readyRun();
    routerStore.init({
      screen: 'workflow',
      run: { ...ready, summary: builtOnOtherCrew() },
      execution: { kind: 'at-rest' },
    });

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />, {
      cols: 160,
      rows: 40,
    });
    await flushEffects();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const build = `Haiku 5.5${arrowSep()}auto`;
    expect(lines[0]).toContain(`PLAN Opus 5.5 · BUILD ${build}`);
    // The header and the sidebar crew both name it.
    expect(lines.filter((line) => line.includes(build))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('Sonnet');
    ui.unmount();
  });

  it('names the crew a stopped run will build on when it continues', async () => {
    configStore.__testReset({ config: sonnetBuildConfig(), projectDir });
    openRun({ summary: builtOnOtherCrew() });

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    const header = stripAnsiStyles(ui.lastFrame() ?? '').split('\n')[0] ?? '';
    expect(header).toContain('BUILD Sonnet 5.5');
    expect(header).not.toContain('Haiku');
    ui.unmount();
  });

  /**
   * A worktree run whose Apply halted on a binary conflict, built on another crew than the one
   * saved today, on the screen at rest. The at-rest watcher reads the record back from disk, so
   * the run's summary is there too.
   */
  function applyHaltRun() {
    configStore.__testReset({ config: sonnetBuildConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 160, rows: 40 });
    const workspacePath = join(projectDir, 'run-workspace');
    const workspace = {
      kind: 'worktree' as const,
      path: workspacePath,
      base: { snapshotId: 'b', head: null },
    };
    const halt = () =>
      makeWorkflowState({
        phase: 'complete',
        reviewStatus: 'passed',
        workspace,
        pendingRecovery: buildApplyConflictRecoveryIssue({
          conflicts: [{ path: 'assets/logo.png', kind: 'binary' }],
          workspacePath,
          createdAt: '2026-10-21T00:00:00.000Z',
        }),
      });
    const halted = halt();
    const issue = halted.pendingRecovery;
    if (issue === undefined) throw new Error('expected the Apply halt');
    const record = openRun({
      status: {
        kind: 'open',
        stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
        resumeAt: { kind: 'apply' },
      },
      hydration: { kind: 'loaded', state: halted },
      summary: builtOnOtherCrew(),
    });
    const save = (state: typeof halted) => {
      saveState(record.ref, state);
      saveFinalSession({
        ...record.ref,
        feature: 'ready run',
        startTime: FIXED_TS,
        summary: builtOnOtherCrew(),
        state,
      });
    };
    save(halted);
    const base = preparedExecution(projectDir, 'ready run');
    const prepareResume = vi.fn(async () => ({
      kind: 'prepared' as const,
      execution: {
        ...base,
        purpose: 'resume' as const,
        config: parsePreparedConfig(sonnetBuildConfig()),
        sourceConfig: parsePreparedConfig(sonnetBuildConfig()),
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
            applying: () => false,
            loadResumeState: hydrateResume,
            prepareResume,
            hydrateRun: async () => {},
          },
        }}
      />,
      { cols: 160, rows: 40 },
    );
    return { ui, workspace, halt, save };
  }

  /** ⏎ on the at-rest byline continues the run onto its halt panel; ⏎ again takes Re-run Apply. */
  async function rerunApply(ui: ReturnType<typeof applyHaltRun>['ui']) {
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Re-run Apply');
    });
    await flushEffects();
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.execution.kind).toBe('local');
    return () => {
      ui.stdin.write('\r');
    };
  }

  it('names the crew that built a run while you decide its Apply halt, and when Re-run Apply halts again', async () => {
    const reApply = Promise.withResolvers<void>();
    const { ui, halt, save } = applyHaltRun();
    runWorkflow.mockImplementation(async () => {
      await reApply.promise;
      save(halt());
      return builtOnOtherCrew();
    });
    const build = `Haiku 5.5${arrowSep()}auto`;
    const expectRecordedCrew = () => {
      const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
      expect(lines[0]).toContain(`PLAN Opus 5.5 · BUILD ${build}`);
      // The header and the sidebar crew both name it.
      expect(lines.filter((line) => line.includes(build))).toHaveLength(2);
      expect(lines.join('\n')).not.toContain('Sonnet');
    };
    await flushEffects();
    expectRecordedCrew();

    const takeRerun = await rerunApply(ui);
    expectRecordedCrew();

    takeRerun();
    await vi.waitFor(() => {
      expect(runWorkflow).toHaveBeenCalledTimes(1);
    });
    reApply.resolve();
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Re-run Apply');
    });
    await flushEffects();
    expectRecordedCrew();
    for (const frame of ui.frames) expect(stripAnsiStyles(frame)).not.toContain('Sonnet');
    ui.unmount();
  });

  it('names the crew it builds on once Re-run Apply sends the merged result back to review', async () => {
    const reviewing = Promise.withResolvers<void>();
    const stop = Promise.withResolvers<void>();
    const { ui, workspace, save } = applyHaltRun();
    const review = makeWorkflowState({
      phase: 'final-review',
      workspace,
      applyReview: { merged: [], failures: [] },
    });
    // The engine as Apply drives it when the resolved workspace no longer matches the reviewed one.
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_resumed',
        ts: FIXED_TS,
        phase: 'complete',
        inProcess: true,
      });
      save(review);
      publishEvent(opts, {
        type: 'planner_text',
        ts: FIXED_TS,
        phase: 'final-review',
        text: 'The merged result goes through its checks and the review again before Apply.',
      });
      reviewing.resolve();
      await stop.promise;
      return builtOnOtherCrew();
    });
    // The crew the header names, and the BUILD seat of the sidebar crew.
    const crew = () => {
      const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
      const header = lines[0] ?? '';
      const sidebar = lines.slice(1).find((line) => line.includes('BUILD')) ?? '';
      return {
        header: header.slice(header.indexOf('PLAN ')).trim(),
        build: /BUILD\s+(.+?)\s*[|│]/.exec(sidebar)?.[1],
      };
    };
    await flushEffects();
    (await rerunApply(ui))();
    await reviewing.promise;
    await flushEffects();
    const live = crew();
    expect(live).toEqual({
      header: 'PLAN auto · BUILD Sonnet 5.5 · REVIEW = PLAN',
      build: 'Claude Code CLI · Sonnet 5.5',
    });
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('Haiku');

    stop.resolve();
    await vi.waitFor(() => {
      const route = routerStore.get();
      expect(route.screen === 'workflow' && route.execution.kind).toBe('at-rest');
    });
    await flushEffects();
    // The same review state at rest names the same crew.
    expect(crew()).toEqual(live);
    ui.unmount();
  });

  it('says Apply is writing and queues home behind it on a bare Enter', async () => {
    const ready = readyRun();
    routerStore.init({
      screen: 'workflow',
      run: { ...ready, status: { kind: 'running' } },
      execution: { kind: 'at-rest' },
    });
    holdApply();

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('* Review -> * Apply');
    expect(frame).toContain('Applying to your checkout · 0:00');
    expect(frame).not.toContain('Show diff');

    ui.stdin.write('\r');
    await tick(30);

    expect(routerStore.get().screen).toBe('workflow');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      'Applying to your checkout · Returns home when Apply finishes · 0:00',
    );
    ui.unmount();
  });

  it('goes home at once from a run another process applies, and says that process runs it', async () => {
    const ready = readyRun();
    routerStore.init({
      screen: 'workflow',
      run: { ...ready, status: { kind: 'running' } },
      execution: { kind: 'at-rest' },
    });

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Running in another process');
    expect(frame).toContain('/ for a command · ⏎ for home…');
    expect(frame).not.toContain('Applying to your checkout');
    expect(frame).not.toContain('when Apply finishes');

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('home');
    });
    ui.unmount();
  });

  it('queues home behind Apply on a typed /home and says so', async () => {
    const ready = readyRun();
    routerStore.init({
      screen: 'workflow',
      run: { ...ready, status: { kind: 'running' } },
      execution: { kind: 'at-rest' },
    });
    holdApply();
    function ScreenWithCommands() {
      const model = useRuntimeCommands({ exit: () => {}, phase: 'complete' });
      return (
        <WorkflowScreen
          commands={model.commands}
          onRuntimeCommand={(raw) => model.handleRuntimeCommand(raw, 'workflow')}
        />
      );
    }

    const ui = renderFeature(<ScreenWithCommands />);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      '/ for a command · ⏎ for home when Apply finishes…',
    );
    ui.stdin.write('/home');
    await tick(20);
    ui.stdin.write('\r');
    await tick(30);

    expect(routerStore.get().screen).toBe('workflow');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      'Applying to your checkout · Returns home when Apply finishes · 0:00',
    );
    ui.unmount();
  });

  it('promises neither Esc nor Enter for home once a quit waits behind Apply', async () => {
    const ready = readyRun();
    routerStore.init({
      screen: 'workflow',
      run: { ...ready, status: { kind: 'running' } },
      execution: { kind: 'at-rest' },
    });
    holdApply();
    departureStore.__testReset({ kind: 'quit', run: () => {} });

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Applying to your checkout · Quits when Apply finishes · 0:00');
    expect(frame).toContain('/ for a command…');
    expect(frame).not.toContain('for home');
    expect(frame).not.toContain('esc home');
    ui.unmount();
  });

  it('fits the at-rest byline inside the row past its mark slot', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    readyRun(true);

    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    expect(lines.at(-1)?.trim()).toBe('Pick Apply as is, Show diff or Discard');
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
          confirm ? { status: 'applied', files: ['src/form.ts'] } : { status: 'confirm-override' },
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

  it('runs a slash command typed while the result menu holds the keys, never Apply', async () => {
    readyRun();
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />);
    await flushEffects();

    ui.stdin.write('/settings');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    expect(onRuntimeCommand).not.toHaveBeenCalledWith('/run accept');
    ui.unmount();
  });

  it('gives the composer each key of a slash command typed one by one over the result menu', async () => {
    readyRun();
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />);
    await flushEffects();

    for (const key of '/settings') {
      ui.stdin.write(key);
      await flushEffects();
    }
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('/settings');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    expect(onRuntimeCommand).not.toHaveBeenCalledWith('/run accept');
    ui.unmount();
  });

  it('does not confirm the result menu on an Enter read in the same stdin dispatch as the slash', async () => {
    readyRun();
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />);
    await flushEffects();

    ui.stdin.write('/');
    ui.stdin.write('\r');
    await flushEffects();
    await tick(30);
    ui.stdin.write('\b');
    await flushEffects();

    expect(onRuntimeCommand).not.toHaveBeenCalled();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('tab back to the actions');
    ui.unmount();
  });

  it('runs a slash command typed over Apply as is without asking to apply', async () => {
    readyRun(true);
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />);
    await flushEffects();

    ui.stdin.write('/settings');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('Apply with 1 open finding?');
    expect(onRuntimeCommand).not.toHaveBeenCalledWith('/run accept confirm');
    ui.unmount();
  });

  it('runs only the slash command typed over the stop sheet above the result menu, never Apply', async () => {
    readyRun();
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} />);
    await flushEffects();
    overlayStore.open('stop-sheet');
    await flushEffects();

    for (const key of '/settings') {
      ui.stdin.write(key);
      await flushEffects();
    }
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    await flushEffects();
    expect(onRuntimeCommand.mock.calls).toEqual([['/settings']]);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('tab back to the actions');
    ui.unmount();
  });

  it('names the result menu in the placeholder while it holds the keys, and the composer after Tab', async () => {
    readyRun();
    const ui = renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} />);
    await flushEffects();
    const menuFocused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(menuFocused).toContain('Choose an action above, or tab to type a command…');
    expect(menuFocused).not.toContain('tab for the result menu');

    ui.stdin.write('\t');
    await flushEffects();
    const composerFocused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(composerFocused).toContain('/ for a command · tab for the result menu…');
    expect(composerFocused).not.toContain('Choose an action above');
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
    const before = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(before).toContain('esc home');
    expect(before).not.toContain('/run accept');
    expect(before).not.toContain('Accepted');

    routerStore.updateRun({ run: { ...record, checkpoint: { kind: 'accepted' } } });
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Accepted · nothing left to do');
    expect(frame).not.toContain('/run accept');
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
    expect(beside).toContain('No output for 5:10 · tools report when done');
    expect(beside).toContain('Implementing…');
    expect(beside.match(/No output for/g)).toHaveLength(1);
    expect(beside).not.toContain('silent 5m');

    vi.advanceTimersByTime(3_000);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      'No output for 5:13 · tools report when done',
    );

    overlayStore.open('stop-sheet');
    await flushEffects();

    const menuOpen = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(menuOpen).toContain('Stop options');
    expect(menuOpen.match(/No output for 5:13/g)).toHaveLength(1);
    expect(menuOpen).toContain('No output for 5:13 · tools report when done');

    vi.advanceTimersByTime(2_000);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('No output for 5:15');

    ui.unmount();
  });
});

describe('WorkflowScreen when the final review passes', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('workflow-review-passed');
    runWorkflow.mockReset();
  });

  afterEach(() => {
    resetAllStores();
    if (projectDir) cleanupTempDir(projectDir);
  });

  // The engine tears the run down between its passing review and the at-rest hand-off. The run is
  // ready to apply then, not done, so no header of that window reads done.
  it('keeps the stages on the header until the ready run opens its result menu', async () => {
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'ready run');
    const brief = taskId('T001');
    let finishTeardown = () => {};
    const teardown = new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'implementing',
        feature: 'ready run',
      });
      publishEvent(opts, {
        type: 'tasks_planned',
        ts: FIXED_TS + 1,
        phase: 'implementing',
        total: 1,
        tasks: [{ id: brief, title: 'Ready brief', index: 0, file: 'src/a.ts', action: 'modify' }],
      });
      publishEvent(opts, {
        type: 'task_started',
        ts: FIXED_TS + 2,
        phase: 'implementing',
        taskId: brief,
        title: 'Ready brief',
        index: 0,
        total: 1,
        file: 'src/a.ts',
        action: 'modify',
        tool: 'opencode',
        model: 'ready-model',
      });
      publishEvent(opts, {
        type: 'task_completed',
        ts: FIXED_TS + 3,
        phase: 'implementing',
        taskId: brief,
        title: 'Ready brief',
        method: 'local',
        retries: 0,
        duration: 1_000,
        tool: 'opencode',
        model: 'ready-model',
      });
      publishEvent(opts, {
        type: 'workflow_complete',
        ts: FIXED_TS + 4,
        phase: 'complete',
        review: 'passed',
        completedTasks: 1,
      });
      await teardown;
      saveState(
        opts.prepared.session.ref,
        makeWorkflowState({
          phase: 'complete',
          reviewStatus: 'passed',
          tasks: [makeTask({ id: 'T001', title: 'Ready brief', status: 'done' })],
          workspace: {
            kind: 'worktree',
            path: join(projectDir, 'run-workspace'),
            base: { snapshotId: 'workspace-base', head: null },
          },
        }),
      );
      return makeSummary({ feature: 'ready run', totalTasks: 1, completedByLocal: 1 });
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      { cols: 120, rows: 40 },
    );
    const header = (frame: string) => stripAnsiStyles(frame).split('\n')[0] ?? '';
    const done = glyph('stageDone');
    await vi.waitFor(() => {
      expect(lifecycleStore.get().phase).toBe('complete');
    });
    await flushEffects();

    const live = header(ui.lastFrame());
    for (const stage of ['Plan', 'Build', 'Review']) expect(live).toContain(`${done} ${stage}`);
    expect(live).not.toContain('done');
    expect(live).not.toContain('Apply');
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.execution.kind).toBe('local');

    finishTeardown();
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).toContain('Ready to apply');
    });
    const rail = live.trim().split('  ')[0] ?? '';
    expect(header(ui.lastFrame())).toContain(
      `${rail}${railConnectorString()}${glyph('stagePending')} Apply`,
    );
    for (const frame of ui.frames) expect(header(frame)).not.toContain('done');
    ui.unmount();
  });

  it('names the crew that built the run once it is ready to apply, not the crew saved since', async () => {
    configStore.__testReset({ config: sonnetBuildConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'ready run');
    runWorkflow.mockImplementation(async (opts) => {
      const state = makeWorkflowState({
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'worktree',
          path: join(projectDir, 'run-workspace'),
          base: { snapshotId: 'workspace-base', head: null },
        },
      });
      saveState(opts.prepared.session.ref, state);
      const summary = builtOnOtherCrew();
      saveFinalSession({
        ...opts.prepared.session.ref,
        feature: 'ready run',
        startTime: FIXED_TS,
        summary,
        state,
      });
      return summary;
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      { cols: 120, rows: 40 },
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).toContain('Ready to apply');
    });
    const header = stripAnsiStyles(ui.lastFrame()).split('\n')[0] ?? '';
    expect(header).toContain(`BUILD Haiku 5.5${arrowSep()}auto`);
    expect(header).not.toContain('Sonnet');
    ui.unmount();
  });

  it('says Apply is writing while Re-run Apply writes live after an Apply halt', async () => {
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    navigatePreparedWorkflow(projectDir, 'live apply');
    const apply = Promise.withResolvers<void>();
    onTestFinished(async () => {
      apply.resolve();
      await activeApply();
    });
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_resumed',
        ts: FIXED_TS,
        phase: 'complete',
        inProcess: true,
      });
      await trackActiveApply(apply.promise);
      return makeSummary({ feature: 'live apply' });
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
      { cols: 120, rows: 40 },
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).toContain('Applying to your checkout · 0:00');
    });
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('/ for a command · ⏎ for home when Apply finishes…');
    expect(frame).toContain('esc home');
    expect(frame).not.toContain('esc stop options');
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.execution.kind).toBe('local');

    apply.resolve();
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).not.toContain('Applying to your checkout');
    });
    ui.unmount();
  });
});

describe('WorkflowScreen handing a slash command from a live panel to the composer', () => {
  let projectDir = '';
  const brief = taskId('T001');

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('workflow-panel-slash');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    runWorkflow.mockReset();
  });

  afterEach(() => {
    resetAllStores();
    if (projectDir) cleanupTempDir(projectDir);
  });

  function startBrief(opts: RunWorkflowOptions): void {
    publishEvent(opts, {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'implementing',
      feature: 'panel slash',
    });
    publishEvent(opts, {
      type: 'task_started',
      ts: FIXED_TS + 1,
      phase: 'implementing',
      taskId: brief,
      title: 'Panel brief',
      index: 0,
      total: 1,
      file: 'src/a.ts',
      action: 'modify',
      tool: 'opencode',
      model: 'panel-model',
    });
  }

  function openChecksCard(answers: unknown[]): void {
    navigatePreparedWorkflow(projectDir, 'panel slash');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'final-review',
        feature: 'panel slash',
      });
      void openReviewChecksPrompt({
        scope: 'final',
        commands: [{ id: 'V1', command: 'npm test', reason: 'The tests cover the change.' }],
      }).then((answer) => answers.push(answer));
      return pendingWorkflow();
    });
  }

  function askPlannerQuestion(
    replies: unknown[],
    question: ClarificationQuestion = {
      id: 'scope',
      type: 'choice',
      text: 'Which module should change?',
      options: ['src/auth.ts', 'src/session.ts'],
      default: 'src/auth.ts',
    },
  ): void {
    navigatePreparedWorkflow(projectDir, 'panel slash');
    runWorkflow.mockImplementation(async (opts) => {
      publishEvent(opts, {
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: 'researching',
        feature: 'panel slash',
      });
      void opts.callbacks
        .onPlannerReply?.({
          call: 'research',
          text: '',
          questions: [question],
          answers: [],
          answered: false,
        })
        .then((reply) => replies.push(reply));
      return pendingWorkflow();
    });
  }

  async function typeSlashSettings(ui: ReturnType<typeof renderFeature>): Promise<void> {
    for (const key of '/settings') {
      ui.stdin.write(key);
      await flushEffects();
    }
    ui.stdin.write('\r');
  }

  it('runs a slash command typed over the stop sheet and names the sheet in the placeholder', async () => {
    navigatePreparedWorkflow(projectDir, 'panel slash');
    runWorkflow.mockImplementation(async (opts) => {
      startBrief(opts);
      return pendingWorkflow();
    });
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Message BUILD on T001');
    });

    overlayStore.open('stop-sheet');
    await flushEffects();
    const sheetOpen = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(sheetOpen).toContain('Stop options');
    expect(sheetOpen).toContain('Choose an action above…');
    expect(sheetOpen).not.toContain('Message BUILD on T001');

    await typeSlashSettings(ui);
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    expect(stopStore.get().intent).toBe('none');
    ui.unmount();
  });

  it('does not stop on an Enter read in the same stdin dispatch as a slash typed over the stop sheet', async () => {
    navigatePreparedWorkflow(projectDir, 'panel slash');
    runWorkflow.mockImplementation(async (opts) => {
      startBrief(opts);
      return pendingWorkflow();
    });
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Message BUILD on T001');
    });
    overlayStore.open('stop-sheet');
    await flushEffects();

    ui.stdin.write('/');
    ui.stdin.write('\r');
    await flushEffects();
    await tick(30);

    expect(stopStore.get().intent).toBe('none');
    expect(overlayStore.get().active).not.toBe('stop-sheet');
    ui.unmount();
  });

  it('runs a slash command typed over the reviewer checks card and names the card in the placeholder', async () => {
    const answers: unknown[] = [];
    openChecksCard(answers);
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip all');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    const cardFocused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(cardFocused).toContain('Choose an action above, or tab to type a message…');
    expect(cardFocused).not.toContain('Message REVIEW');

    await typeSlashSettings(ui);
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    await flushEffects();
    expect(answers).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip all');
    ui.unmount();
  });

  it('does not run the reviewer checks on an Enter read in the same stdin dispatch as the slash', async () => {
    const answers: unknown[] = [];
    openChecksCard(answers);
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip all');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    ui.stdin.write('/');
    ui.stdin.write('\r');
    await flushEffects();
    await tick(30);
    ui.stdin.write('\b');
    await flushEffects();

    expect(answers).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip all');
    ui.unmount();
  });

  it('runs a slash command typed over the planner question without answering it', async () => {
    const replies: unknown[] = [];
    askPlannerQuestion(replies);
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Question 1 of 1');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    await typeSlashSettings(ui);
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    await flushEffects();
    expect(replies).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Question 1 of 1');
    ui.unmount();
  });

  it('runs a slash command typed into the answer field of a free-text question without answering it', async () => {
    const replies: unknown[] = [];
    askPlannerQuestion(replies, {
      id: 'name',
      type: 'input',
      text: 'What should the flag be called?',
    });
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Question 1 of 1');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    for (const key of '/usage') {
      ui.stdin.write(key);
      await flushEffects();
    }
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('› /usage');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/usage');
    });
    await flushEffects();
    expect(onRuntimeCommand.mock.calls).toEqual([['/usage']]);
    expect(replies).toEqual([]);
    expect(feedbackStore.get().isError).toBe(false);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Question 1 of 1');
    expect(frame).not.toContain('› /usage');
    ui.unmount();
  });

  it('hands the keys to the composer for a command picked in the palette over the reviewer checks card', async () => {
    const answers: unknown[] = [];
    openChecksCard(answers);
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WithPalette>
        <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} deps={workflowDeps} />
      </WithPalette>,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip all');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    await pickInPalette(ui, 'scroll', 'top');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('/scroll top');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/scroll top');
    });
    await flushEffects();
    expect(onRuntimeCommand.mock.calls).toEqual([['/scroll top']]);
    expect(answers).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip all');
    ui.unmount();
  });

  it('hands the keys to the composer for a command picked in the palette over the planner question', async () => {
    const replies: unknown[] = [];
    askPlannerQuestion(replies);
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WithPalette>
        <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} deps={workflowDeps} />
      </WithPalette>,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Question 1 of 1');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);

    await pickInPalette(ui, 'scroll', 'top');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('/scroll top');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/scroll top');
    });
    await flushEffects();
    expect(onRuntimeCommand.mock.calls).toEqual([['/scroll top']]);
    expect(replies).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Question 1 of 1');
    ui.unmount();
  });

  it('names the planner question in the placeholder while it holds the keys, and the instruction past its last row', async () => {
    askPlannerQuestion([]);
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Question 1 of 1');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    const panelFocused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(panelFocused).toContain('Answer the question above…');
    expect(panelFocused).not.toContain('New instruction');

    for (const key of ['\x1b[B', '\x1b[B', '\x1b[B']) {
      ui.stdin.write(key);
      await flushEffects();
    }
    const composerFocused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(composerFocused).toContain('New instruction — replaces these questions…');
    expect(composerFocused).not.toContain('Answer the question above…');
    ui.unmount();
  });

  it('runs only the slash command typed over the stop sheet above the reviewer checks card', async () => {
    const answers: unknown[] = [];
    openChecksCard(answers);
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip all');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    overlayStore.open('stop-sheet');
    await flushEffects();

    await typeSlashSettings(ui);
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    await flushEffects();
    expect(onRuntimeCommand.mock.calls).toEqual([['/settings']]);
    expect(answers).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Skip all');
    ui.unmount();
  });

  it('runs only the slash command typed over the stop sheet above the planner question', async () => {
    const replies: unknown[] = [];
    askPlannerQuestion(replies);
    const onRuntimeCommand = vi.fn();
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={onRuntimeCommand} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Question 1 of 1');
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    overlayStore.open('stop-sheet');
    await flushEffects();

    await typeSlashSettings(ui);
    await vi.waitFor(() => {
      expect(onRuntimeCommand).toHaveBeenCalledWith('/settings');
    });
    await flushEffects();
    expect(onRuntimeCommand.mock.calls).toEqual([['/settings']]);
    expect(replies).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Question 1 of 1');
    ui.unmount();
  });
});

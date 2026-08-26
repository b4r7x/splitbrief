import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import { useInputMode } from './use-input-mode.js';
import { useWorkflowRunner, type RunWorkflowFn } from './use-runner.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { configStore } from '../../../stores/project/config.js';
import { clearAllHandlers, requestRewind } from '../handlers.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../core/paths-io.js';
import {
  clearActiveReceipt,
  reactivateExistingSession,
} from '../../../core/sessions/active-pointer.js';
import { saveState } from '../../../core/state/persistence.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';

const FIRST_FEATURE = 'first run';
const SECOND_FEATURE = 'second run';
const MISSING_PLANNER_COMMAND = 'splitbrief-non-existent-planner-x7q9';
const REWIND_COMMENT = 'restart the first feature';

const LONG_RUNNING_PLANNER: PlannerConfig = { kind: 'shell', command: 'sleep', args: ['10'] };
const MISSING_PLANNER: PlannerConfig = {
  kind: 'shell',
  command: MISSING_PLANNER_COMMAND,
};

function workflowStartedForFeature(events: readonly EngineEvent[], feature: string): boolean {
  return events.some((e) => e.type === 'workflow_started' && e.feature === feature);
}

function Harness({
  prepared,
  runWorkflow,
}: {
  prepared: PreparedExecution;
  runWorkflow?: RunWorkflowFn | undefined;
}) {
  const inputMode = useInputMode();
  const runner = useWorkflowRunner({
    prepared,
    onComplete: () => {},
    inputMode,
    runWorkflow,
  });
  return <Text>{`${prepared.runtime.feature}:${runner.startedAt}`}</Text>;
}

function preparedExecution(input: {
  projectDir: string;
  feature: string;
  sessionId: string;
  planner: PlannerConfig;
}): PreparedExecution {
  const ref = { projectDir: input.projectDir, sessionId: input.sessionId };
  ensureSessionDir(input.projectDir, input.sessionId);
  return makePreparedExecution({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    feature: input.feature,
    config: makeConfig({
      planner: input.planner,
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { mode: 'quick', approve: 'none' },
    }),
    preparationId: `abort-race-${input.sessionId}`,
    active: reactivateExistingSession(ref),
  });
}

let projectDir: string;

describe('useWorkflowRunner abort race', () => {
  beforeEach(() => {
    projectDir = createTempDir('workflow-abort-race-test');
    createTestGitRepo(projectDir);
    ensureSplitbriefDir(projectDir);
    resetWorkflow();
    controlsStore.reset();
    feedbackStore.reset();
    configStore.__testReset();
    clearAllHandlers();
  });

  afterEach(() => {
    clearAllHandlers();
    resetWorkflow();
    controlsStore.reset();
    feedbackStore.reset();
    configStore.__testReset();
    cleanupTempDir(projectDir);
  });

  it('store changes after admission do not restart or abort the run', async () => {
    const prepared = preparedExecution({
      projectDir,
      feature: FIRST_FEATURE,
      sessionId: 'store-change-stability',
      planner: MISSING_PLANNER,
    });
    const { promise: releaseRun, resolve: finishRun } = Promise.withResolvers<void>();
    const attempts: PreparedExecution[] = [];
    let runSignal: AbortSignal | undefined;
    const runWorkflowStub: RunWorkflowFn = async (options) => {
      attempts.push(options.prepared);
      runSignal = options.signal;
      await releaseRun;
      return makeSummary();
    };
    const ui = render(<Harness prepared={prepared} runWorkflow={runWorkflowStub} />);

    await vi.waitFor(() => {
      expect(attempts).toHaveLength(1);
    });
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        planner: { kind: 'agent', command: '/changed/after/admission' },
      }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    expect(attempts).toEqual([prepared]);
    expect(attempts[0]?.config).toBe(prepared.config);
    expect(attempts[0]?.gates).toBe(prepared.gates);
    expect(attempts[0]?.report).toBe(prepared.report);
    expect(attempts[0]?.session).toBe(prepared.session);
    expect(runSignal?.aborted).toBe(false);
    expect(Object.isFrozen(prepared.config)).toBe(true);

    finishRun();
    await releaseRun;
    ui.unmount();
  });

  it('rerender with a new feature aborts the pending first run without leaking its error', async () => {
    const { promise: firstRunFinished, resolve: finishFirstRun } = Promise.withResolvers<void>();
    const { promise: secondRunFinished, resolve: finishSecondRun } = Promise.withResolvers<void>();
    let runCount = 0;
    const runWorkflowWithCompletions: RunWorkflowFn = async (options) => {
      const finishRun = runCount === 0 ? finishFirstRun : finishSecondRun;
      runCount += 1;
      try {
        return await runWorkflow(options);
      } finally {
        finishRun();
      }
    };
    const firstPrepared = preparedExecution({
      projectDir,
      feature: FIRST_FEATURE,
      sessionId: 'first-abort-race',
      planner: LONG_RUNNING_PLANNER,
    });
    const ui = render(
      <Harness prepared={firstPrepared} runWorkflow={runWorkflowWithCompletions} />,
    );

    await vi.waitFor(
      () => {
        expect(workflowStartedForFeature(eventsStore.get().events, FIRST_FEATURE)).toBe(true);
      },
      { timeout: 15_000 },
    );
    await vi.waitFor(
      () => {
        expect(operationsStore.get().active?.status).toBe('running');
      },
      { timeout: 15_000 },
    );

    clearActiveReceipt(firstPrepared.session.ref, firstPrepared.session.active);
    const secondPrepared = preparedExecution({
      projectDir,
      feature: SECOND_FEATURE,
      sessionId: 'second-abort-race',
      planner: MISSING_PLANNER,
    });
    ui.rerender(<Harness prepared={secondPrepared} runWorkflow={runWorkflowWithCompletions} />);

    await vi.waitFor(
      () => {
        const errors = eventsStore.get().events.filter((e) => e.type === 'error');
        expect(errors.some((e) => /Planner 'shell' is not available/i.test(e.message))).toBe(true);
      },
      { timeout: 15_000 },
    );

    const errors = eventsStore.get().events.filter((e) => e.type === 'error');
    const hasSleepKilledError = errors.some(
      (e) => e.message.includes('sleep') || e.message.includes('SIGTERM'),
    );
    expect(hasSleepKilledError).toBe(false);
    expect(workflowStartedForFeature(eventsStore.get().events, FIRST_FEATURE)).toBe(false);
    await firstRunFinished;
    await secondRunFinished;
    ui.unmount();
  }, 30_000);

  it('keeps an immediate rewind scoped to its originating feature', async () => {
    const calls: Array<{
      feature: string;
      savedState: WorkflowState | undefined;
      rewindFeedback: string | undefined;
      sessionId: string;
    }> = [];
    const runWorkflow: RunWorkflowFn = async (opts) => {
      const { signal } = opts;
      if (signal === undefined) throw new Error('expected the runner to provide an abort signal');
      const sessionId = opts.prepared.session.ref.sessionId;
      calls.push({
        feature: opts.prepared.runtime.feature,
        savedState: opts.savedState,
        rewindFeedback: opts.rewindFeedback,
        sessionId,
      });
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return makeSummary();
    };
    const firstPrepared = preparedExecution({
      projectDir,
      feature: FIRST_FEATURE,
      sessionId: 'first-rewind-race',
      planner: MISSING_PLANNER,
    });
    const ui = render(<Harness prepared={firstPrepared} runWorkflow={runWorkflow} />);

    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    const firstCall = calls[0];
    if (firstCall === undefined) throw new Error('expected the first workflow call');
    const savedState: WorkflowState = {
      ...createInitialState(FIRST_FEATURE),
      phase: 'reviewing-spec',
    };
    ensureSessionDir(projectDir, firstCall.sessionId);
    saveState({ projectDir, sessionId: firstCall.sessionId }, savedState);

    expect(requestRewind({ target: 'spec', comment: REWIND_COMMENT })).toBe(true);

    clearActiveReceipt(firstPrepared.session.ref, firstPrepared.session.active);
    const secondPrepared = preparedExecution({
      projectDir,
      feature: SECOND_FEATURE,
      sessionId: 'second-rewind-race',
      planner: MISSING_PLANNER,
    });
    ui.rerender(<Harness prepared={secondPrepared} runWorkflow={runWorkflow} />);

    await vi.waitFor(() => {
      expect(calls.some((call) => call.feature === SECOND_FEATURE)).toBe(true);
    });
    const secondCall = calls.find((call) => call.feature === SECOND_FEATURE);
    if (secondCall === undefined)
      throw new Error('expected a workflow invocation for the second feature');
    expect(secondCall.savedState).toBeUndefined();
    expect(secondCall.rewindFeedback).toBeUndefined();
    expect(
      eventsStore
        .get()
        .events.some(
          (event) => event.type === 'rewind_to_spec' && event.comment === REWIND_COMMENT,
        ),
    ).toBe(false);
    ui.unmount();
  });
});

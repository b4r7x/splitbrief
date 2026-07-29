import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import { useInputMode } from './use-input-mode.js';
import { useWorkflowRunner, type RunWorkflowFn } from './use-runner.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { clearAllHandlers, requestRewind } from '../handlers.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../core/paths-io.js';
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
  feature,
  projectDir,
  planner,
  runWorkflow,
}: {
  feature: string;
  projectDir: string;
  planner: PlannerConfig;
  runWorkflow?: RunWorkflowFn | undefined;
}) {
  const inputMode = useInputMode();
  const config = makeConfig({
    planner,
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: {
      mode: 'quick',
      commitStrategy: 'none',
      autoApproveSpec: true,
      autoApprovePlan: true,
    },
  });
  const runner = useWorkflowRunner({
    feature,
    projectDir,
    config,
    onComplete: () => {},
    inputMode,
    runWorkflow,
  });
  return <Text>{`${feature}:${runner.startedAt}`}</Text>;
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
    clearAllHandlers();
  });

  afterEach(() => {
    clearAllHandlers();
    resetWorkflow();
    controlsStore.reset();
    feedbackStore.reset();
    cleanupTempDir(projectDir);
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
    const ui = render(
      <Harness
        feature={FIRST_FEATURE}
        projectDir={projectDir}
        planner={LONG_RUNNING_PLANNER}
        runWorkflow={runWorkflowWithCompletions}
      />,
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

    ui.rerender(
      <Harness
        feature={SECOND_FEATURE}
        projectDir={projectDir}
        planner={MISSING_PLANNER}
        runWorkflow={runWorkflowWithCompletions}
      />,
    );

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
      const { sessionId, signal } = opts;
      if (sessionId === undefined || signal === undefined) {
        throw new Error('expected the runner to provide a session ID and abort signal');
      }
      calls.push({
        feature: opts.feature,
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
    const ui = render(
      <Harness
        feature={FIRST_FEATURE}
        projectDir={projectDir}
        planner={MISSING_PLANNER}
        runWorkflow={runWorkflow}
      />,
    );

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

    ui.rerender(
      <Harness
        feature={SECOND_FEATURE}
        projectDir={projectDir}
        planner={MISSING_PLANNER}
        runWorkflow={runWorkflow}
      />,
    );

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

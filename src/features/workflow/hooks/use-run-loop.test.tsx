import { useEffect } from 'react';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { execFileSync } from 'node:child_process';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from '../../../engine/orchestrator/changed-files-baseline.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { questionsText } from '../../../core/state/planning-conversation.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import { buildContextOverflowRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import { readRunEvents } from '../../../engine/events/replay.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import { useInputMode } from './use-input-mode.js';
import { useRunContinue } from './use-run-continue.js';
import { useRunLoop } from './use-run-loop.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { configStore } from '../../../stores/project/config.js';
import {
  abortTurn,
  requestBoundaryPause,
  requestStopNow,
  requestCancel,
  requestRewind,
  requestEndRun,
  clearAllHandlers,
} from '../handlers.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import {
  clearActiveReceipt,
  reactivateExistingSession,
  readActive,
  readActiveRecord,
  writeActive,
} from '../../../core/sessions/active-pointer.js';
import { inspectSessionLiveness } from '../../../core/sessions/liveness.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../core/paths-io.js';
import { saveState, loadState } from '../../../core/state/persistence.js';
import { saveSummary } from '../../../core/sessions/io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { sessionDir } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PrepareExecutionFn, RunWorkflowFn } from './use-run-loop.js';

// Harness mounts the run loop with a bogus planner command so that
// runWorkflow exits fast via the "planner not available" branch in
// initializeWorkflow. That keeps the hook's React-side lifecycle observable
// (reset, resume, rewind, cancel) without requiring a full engine spin-up.
// A run started here is admitted again before it re-enters the engine; the
// harness admits the same session, since admitting real tools is the
// preparation suite's concern.

interface RunnerHandle {
  startedAt: string;
  handleResume: (injectedText?: string) => void;
  /** Answers the question the recovery panel is asking, as the composer would. */
  answer: (text: string) => void;
}

interface HarnessProps {
  prepared: PreparedExecution;
  steer?: string | undefined;
  captureRunner?: { current: RunnerHandle | null };
  runWorkflow?: RunWorkflowFn | undefined;
  prepareExecution?: PrepareExecutionFn | undefined;
  continueAtRest?: ((record: RunRecord) => void) | undefined;
}

function Harness({
  prepared,
  steer,
  captureRunner,
  runWorkflow,
  prepareExecution = reprepareSameSession(),
  continueAtRest,
}: HarnessProps) {
  const inputMode = useInputMode();
  const continuation = useRunContinue({ prepared, inputMode });
  const runner = useRunLoop({
    prepared,
    steer,
    inputMode,
    continuation,
    runWorkflow,
    prepareExecution,
    continueAtRest,
  });
  useEffect(() => {
    if (captureRunner)
      captureRunner.current = {
        ...runner,
        handleResume: continuation.handleResume,
        answer: inputMode.resolve,
      };
  });
  return (
    <Box>
      <Text>{inputMode.mode === 'normal' ? 'idle' : inputMode.hint}</Text>
    </Box>
  );
}

function renderHarness(props: HarnessProps) {
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({ ref: props.prepared.session.ref }),
    execution: { kind: 'local', prepared: props.prepared },
  });
  return render(<Harness {...props} />);
}

/** The run the loop handed back to the screen: the same route, at rest, with a fresh record. */
function settledRun(): RunRecord | null {
  const route = routerStore.get();
  if (route.screen !== 'workflow' || route.execution.kind !== 'at-rest') return null;
  return route.run;
}

function preparedExecution(input: {
  projectDir: string;
  feature: string;
  sessionId?: string | undefined;
  resumeState?: WorkflowState | undefined;
  planner?: PlannerConfig | undefined;
  workflow?: Partial<Config['workflow']> | undefined;
}): PreparedExecution {
  const sessionId = input.sessionId ?? 'prepared-workflow-session';
  const ref = { projectDir: input.projectDir, sessionId };
  ensureSessionDir(input.projectDir, sessionId);
  return makePreparedExecution({
    projectDir: input.projectDir,
    sessionId,
    feature: input.feature,
    config: makeConfig({
      planner: input.planner ?? {
        kind: 'agent',
        command: 'splitbrief-non-existent-planner-x7q9',
      },
      ...(input.workflow !== undefined && { workflow: input.workflow }),
    }),
    preparationId: `workflow-hook-${sessionId}`,
    active: reactivateExistingSession(ref),
    ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
  });
}

/** Admits the same session again under the policy asked for, recording each request. */
function reprepareSameSession(requests: PrepareExecutionInput[] = []): PrepareExecutionFn {
  return async (input) => {
    requests.push(input);
    const ref = input.existingSession;
    if (ref === undefined) throw new Error('expected a preparation of an existing session');
    return {
      kind: 'prepared',
      execution: makePreparedExecution({
        projectDir: ref.projectDir,
        sessionId: ref.sessionId,
        feature: input.feature,
        config: input.effectiveConfig,
        purpose: input.policy.purpose,
        resumeState: input.resumeState,
        active: reactivateExistingSession(ref, { inspectOwner: inspectSessionLiveness }),
      }),
    };
  };
}

/**
 * The engine the loop enters, recorded pass by pass. A scripted pass stands for the engine
 * reaching a halt or a gate; every other pass is the real `runWorkflow`.
 */
function recordedEngine(script: Partial<Record<number, RunWorkflowFn>> = {}) {
  const entered: PreparedExecution[] = [];
  let returned = 0;
  const engine: RunWorkflowFn = async (options) => {
    const pass = entered.push(options.prepared);
    try {
      return await (script[pass] ?? runWorkflow)(options);
    } finally {
      returned += 1;
    }
  };
  return { engine, entered, returned: () => returned };
}

/** A pass that saves the run at `state` and waits there until the loop aborts it. */
function parkAt(state: WorkflowState, transcript?: string): RunWorkflowFn {
  return async (options) => {
    saveState(options.prepared.session.ref, state);
    if (transcript !== undefined) {
      options.tuiSink?.({
        type: 'user_message',
        ts: Date.now(),
        phase: state.phase,
        text: transcript,
      });
    }
    if (options.signal?.aborted !== true) {
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    return makeSummary();
  };
}

function errorMessages(): string[] {
  return eventsStore
    .get()
    .events.flatMap((event) => (event.type === 'error' ? [event.message] : []));
}

async function flush(ms = 60) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** A run halted on a brief whose panel offers a retry, saved where the loop reads it back. */
function saveHaltedRun(sessionId: string): WorkflowState {
  const halted = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
    pendingRecovery: makeRecoveryIssue(),
  });
  saveState({ projectDir, sessionId }, halted);
  return halted;
}

async function answerRecoveryPanel(
  captureRunner: NonNullable<HarnessProps['captureRunner']>,
  text: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(controlsStore.get().inputMode).toBe('question');
  });
  await flush();
  const runner = captureRunner.current;
  if (!runner) throw new Error('expected captureRunner.current to be populated');
  runner.answer(text);
}

function userMessageEvents() {
  return eventsStore.get().events.filter((event) => event.type === 'user_message');
}

function loggedMessageRows(log: string, text: string): number {
  return log
    .split('\n')
    .filter((line) => line.includes('"kind":"message"') && line.includes(JSON.stringify(text)))
    .length;
}

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('workflow-runner-test');
  execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
  ensureSplitbriefDir(projectDir);
  resetWorkflow();
  controlsStore.reset();
  feedbackStore.reset();
  configStore.__testReset();
  overlayStore.reset();
  clearAllHandlers();
});

afterEach(() => {
  clearAllHandlers();
  stopStore.__testReset();
  resetWorkflow();
  controlsStore.reset();
  feedbackStore.reset();
  configStore.__testReset();
  overlayStore.reset();
  cleanupTempDir(projectDir);
});

describe('useRunLoop', () => {
  it('runs once from prepared config session report and gates', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'prepared authority' });
    const received: PreparedExecution[] = [];
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      received.push(options.prepared);
      return makeSummary();
    });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    await flush();

    const authority = received[0];
    expect(authority).toBe(prepared);
    expect(Object.isFrozen(authority?.config)).toBe(true);
    expect(runWorkflowStub).toHaveBeenCalledTimes(1);

    inst.unmount();
  });

  it('resets workflow stores on mount and produces a valid startedAt timestamp', async () => {
    // Seed the stores so the test proves they were reset on mount.
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 5 });
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });

    const inst = renderHarness({ prepared, captureRunner });
    await flush();

    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    expect(runner.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    inst.unmount();
  });

  it("clears stale store state and applies the resume phase from startWorkflow's authoritative reset", async () => {
    // Seed the lifecycle store with stale data; startWorkflow's own reset is the
    // single authoritative reset.
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 7, phase: 'final-review' });
    const sessionId = '2026-08-14-resume-reset';
    const resume: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: resume,
    });
    saveState({ projectDir, sessionId }, resume);

    const inst = renderHarness({ prepared });

    // Stale fields are cleared (the reset ran) and the resume phase is applied
    // (the reset received the resume state) — one reset carries both.
    await vi.waitFor(() => {
      const lifecycle = lifecycleStore.get();
      expect(lifecycle.cancelled).toBe(false);
      expect(lifecycle.queueDepth).toBe(0);
      expect(lifecycle.phase).toBe('reviewing-spec');
    });
    inst.unmount();
  });

  it('clears session state before a missing persisted resume exits', async () => {
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 7, phase: 'final-review' });
    eventsStore.__testReset({
      events: [
        {
          type: 'workflow_started',
          ts: Date.now(),
          phase: 'final-review',
          feature: 'old session',
        },
      ],
    });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());
    const prepared = preparedExecution({
      projectDir,
      feature: 'new session',
      sessionId: '2026-08-14-missing-resume',
      resumeState: createInitialState('new session'),
    });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(lifecycleStore.get().phase).toBe('idle');
      expect(lifecycleStore.get().cancelled).toBe(false);
    });

    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(eventsStore.get().events).toEqual([]);
    expect(runWorkflowStub).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('clears session state before an invalid persisted resume exits', async () => {
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 9, phase: 'implementing' });
    const sessionId = '2026-08-14-invalid-resume';
    const prepared = preparedExecution({
      projectDir,
      feature: 'invalid session',
      sessionId,
      resumeState: createInitialState('invalid session'),
    });
    writeFileSync(
      join(sessionDir(projectDir, sessionId), 'state.json'),
      JSON.stringify({ stateVersion: 999 }),
      'utf8',
    );
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(lifecycleStore.get().phase).toBe('idle');
      expect(eventsStore.get().events).toEqual([
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('Cannot resume'),
        }),
      ]);
    });

    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(runWorkflowStub).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('settles the run at rest on the screen it is already on when the loop returns', async () => {
    const sessionId = '2026-06-18-settled-session';
    ensureSessionDir(projectDir, sessionId);
    saveSummary({ projectDir, sessionId }, makeSession({ id: sessionId, status: 'open' }));
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });

    await vi.waitFor(() => {
      expect(settledRun()?.ref.sessionId).toBe(sessionId);
    });
    expect(routerStore.get().screen).toBe('workflow');

    inst.unmount();
  });

  it('settles a run the user stopped without parking, instead of leaving a dead screen', async () => {
    const sessionId = '2026-07-10-stopped-regen';
    ensureSessionDir(projectDir, sessionId);
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (opts) => {
      // Stop now during an approval-gate regeneration: an abort handler is live
      // (runLiveRegenerate), the stop aborts the regen, and the engine run returns
      // without parking a continuation prompt or publishing a cancellation event.
      addEvent({
        type: 'workflow_started',
        ts: Date.now(),
        phase: 'reviewing-spec',
        feature: 'add auth',
      });
      opts.sinks.setAbortHandler(() => {});
      requestStopNow();
      opts.sinks.setAbortHandler(null);
      return makeSummary();
    });
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });

    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });

    inst.unmount();
  });

  it('stops at a paused recovery on resume without re-entering runWorkflow (F-510)', async () => {
    const sessionId = '2024-01-01-paused';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T001' });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: 'implementing',
      createdAt: '2026-04-28T12:00:00.000Z',
    });
    const paused: WorkflowState = {
      ...makeImplState([task]),
      pendingRecovery: { ...issue, status: 'paused' },
    };
    saveState({ projectDir, sessionId }, paused);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: paused,
    });

    const inst = renderHarness({ prepared });
    await flush();

    // The paused issue is carried, not resolved: the host never resumes the run,
    // so the recovery stays on disk for an explicit `splitbrief resume` later.
    const persisted = loadState({ projectDir, sessionId });
    if (!persisted) throw new Error('expected persisted state on disk');
    expect(persisted.pendingRecovery?.status).toBe('paused');

    // The host did not re-enter runWorkflow: no resume event was published, so the
    // budget-pause answer cannot drive an infinite runWorkflow loop.
    const resumedEvents = eventsStore.get().events.filter((e) => e.type === 'workflow_resumed');
    expect(resumedEvents).toHaveLength(0);

    inst.unmount();
  });

  it('writes the session record when a halt is answered with End run', async () => {
    const sessionId = '2024-01-01-end-run';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T001' });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: 'implementing',
      createdAt: '2026-04-28T12:00:00.000Z',
    });
    const closed: WorkflowState = {
      ...makeImplState([task]),
      pendingRecovery: { ...issue, status: 'applying', selectedAction: 'end-run' },
    };
    saveState({ projectDir, sessionId }, closed);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: closed,
    });
    const inst = renderHarness({ prepared });
    await flush();

    expect(existsSync(join(sessionDir(projectDir, sessionId), 'summary.json'))).toBe(true);
    expect(settledRun()?.status).toEqual({ kind: 'closed', as: 'ended' });

    inst.unmount();
  });

  it('keeps the halt and records no cut step when the run is stopped at the recovery panel', async () => {
    const sessionId = '2026-09-24-stop-at-halt';
    const halted = saveHaltedRun(sessionId);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(controlsStore.get().inputMode).toBe('question');
    });
    await flush();
    expect(requestStopNow()).toBe(true);
    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.pendingRecovery).toEqual(halted.pendingRecovery);
    expect(persisted?.interruptedStep).toBeUndefined();
    expect(runWorkflowStub).not.toHaveBeenCalled();

    inst.unmount();
  });

  it('requestCancel marks the workflow cancelled and clears the review input mode', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const inst = renderHarness({
      prepared,
      runWorkflow: async (options) => {
        await options.callbacks?.onApprovalNeeded?.('plan', 'plan.md', []);
        return makeSummary();
      },
    });
    await flush();

    // Simulate a pending review mode (as if the engine had called onApprovalNeeded).
    controlsStore.setInputMode('review');

    const cancelled = requestCancel();
    expect(cancelled).toBe(true);
    await flush();

    expect(lifecycleStore.get().cancelled).toBe(true);
    // Cancel handler registered by the runner calls inputMode.resetMode(),
    // which clears controls.inputMode back to 'normal'.
    expect(controlsStore.get().inputMode).toBe('normal');

    // A second cancel is a no-op (cancelled gate).
    const before = eventsStore.get().events.length;
    expect(requestCancel()).toBe(false);
    expect(eventsStore.get().events.length).toBe(before);

    inst.unmount();
  });

  it('requestCancel aborts the engine signal with the canonical user_cancelled reason', async () => {
    const sessionId = '2026-06-18-cancel-reason';
    const { promise: runFinished, resolve: finishRun } = Promise.withResolvers<void>();
    const runWorkflowWithCompletion: RunWorkflowFn = async (options) => {
      try {
        return await runWorkflow(options);
      } finally {
        finishRun();
      }
    };
    const prepared = preparedExecution({
      projectDir,
      feature: 'cancel reason',
      sessionId,
      planner: { kind: 'shell', command: 'sleep', args: ['10'] },
      workflow: {},
    });
    const inst = renderHarness({ prepared, runWorkflow: runWorkflowWithCompletion });
    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    await vi.waitFor(
      () => {
        expect(existsSync(logPath)).toBe(true);
      },
      { timeout: 5_000 },
    );

    expect(requestCancel()).toBe(true);

    await vi.waitFor(
      () => {
        const log = readFileSync(logPath, 'utf-8');
        expect(log).toContain('"type":"workflow_cancelled"');
        expect(log).toContain('"reason":"user_cancelled"');
      },
      { timeout: 5_000 },
    );

    await runFinished;
    inst.unmount();
  });

  it('persists a task-reset event when the user rewinds to a task', async () => {
    const sessionId = '2024-01-01-rewind-task';
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const ref = prepared.session.ref;
    const run = recordedEngine({
      1: parkAt(makeImplState([makeTask({ id: 'T001', status: 'done' })])),
    });

    const inst = renderHarness({ prepared, runWorkflow: run.engine });
    await vi.waitFor(() => {
      expect(loadState(ref)?.phase).toBe('implementing');
    });

    const didRewind = requestRewind({ target: 'task', taskId: 'T001' });
    expect(didRewind).toBe(true);
    await vi.waitFor(() => {
      expect(run.returned()).toBe(2);
    });

    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('task_reset');
    expect(log).toContain('T001');
    expect(run.entered.map((entry) => entry.purpose)).toEqual(['new-workflow', 'resume']);
    expect(loadState(ref)?.tasks.map((task) => task.status)).toEqual(['pending']);
    expect(errorMessages()).toEqual([expect.stringContaining('is not available')]);

    inst.unmount();
  });

  it('rewind retry reuses prepared runner authority after store changes', async () => {
    const sessionId = '2024-01-01-prepared-rewind';
    const saved = makeImplState([makeTask({ id: 'T001', status: 'done' })]);
    ensureSessionDir(projectDir, sessionId);
    saveState({ projectDir, sessionId }, saved);
    const prepared = preparedExecution({
      projectDir,
      feature: 'prepared rewind',
      sessionId,
      resumeState: saved,
    });
    const attempts: PreparedExecution[] = [];
    const runWorkflowStub: RunWorkflowFn = async (options) => {
      attempts.push(options.prepared);
      if (attempts.length === 1 && !options.signal?.aborted) {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return makeSummary();
    };
    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });

    await vi.waitFor(() => {
      expect(attempts).toHaveLength(1);
    });
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        planner: { kind: 'agent', command: '/changed/after/admission' },
      }),
    });

    expect(requestRewind({ target: 'task', taskId: 'T001' })).toBe(true);

    await vi.waitFor(() => {
      expect(attempts).toHaveLength(2);
    });
    expect(attempts).toEqual([prepared, prepared]);
    expect(attempts[1]?.config).toBe(prepared.config);
    expect(attempts[1]?.gates).toBe(prepared.gates);
    expect(attempts[1]?.report).toBe(prepared.report);
    expect(attempts[1]?.session).toBe(prepared.session);
    expect(attempts[1]?.session.active).toBe(prepared.session.active);
    expect(Object.isFrozen(attempts[1]?.config)).toBe(true);

    inst.unmount();
  });

  it('rewinds the in-scope session even when .splitbrief/active names a different session', async () => {
    // pointer=A (a foreign interrupted session) while the screen is scoped to sessionId=B.
    // The rewind handler must use the in-scope id (B) and never touch A.
    const foreignSessionId = '2024-01-01-foreign';
    const scopedSessionId = '2024-01-01-scoped';
    ensureSessionDir(projectDir, foreignSessionId);
    ensureSessionDir(projectDir, scopedSessionId);
    const foreignState = makeImplState([makeTask({ id: 'T001', status: 'done' })]);
    const scopedState = makeImplState([makeTask({ id: 'T001', status: 'done' })]);
    saveState({ projectDir, sessionId: foreignSessionId }, foreignState);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId: scopedSessionId,
    });
    const run = recordedEngine({ 1: parkAt(scopedState) });

    const inst = renderHarness({ prepared, runWorkflow: run.engine });
    await vi.waitFor(() => {
      expect(loadState(prepared.session.ref)?.phase).toBe('implementing');
    });
    // The pointer now names a FOREIGN interrupted session while the screen stays scoped to B.
    // A pointer-keyed rewind would corrupt the foreign session; the in-scope id (B) must win.
    clearActiveReceipt(prepared.session.ref, prepared.session.active);
    writeActive({ projectDir, sessionId: foreignSessionId });

    const didRewind = requestRewind({ target: 'task', taskId: 'T001' });
    expect(didRewind).toBe(true);
    await vi.waitFor(() => {
      expect(run.returned()).toBe(2);
    });

    const scopedLog = readFileSync(
      join(sessionDir(projectDir, scopedSessionId), 'session.jsonl'),
      'utf-8',
    );
    expect(scopedLog).toContain('task_reset');
    expect(scopedLog).toContain('T001');

    expect(existsSync(join(sessionDir(projectDir, foreignSessionId), 'session.jsonl'))).toBe(false);

    inst.unmount();
  });

  it('handleResume shows a feedback error when there is no saved state on disk', async () => {
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowStub });
    await flush();

    // No active session was written — handleResume should surface a feedback
    // error instead of trying to resume.
    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 4, phase: 'final-review' });
    eventsStore.__testReset({
      events: [
        {
          type: 'workflow_started',
          ts: Date.now(),
          phase: 'final-review',
          feature: 'stale session',
        },
      ],
    });
    runner.handleResume();
    await flush();

    expect(feedbackStore.get().message).toMatch(/no saved state/i);
    expect(feedbackStore.get().isError).toBe(true);
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(eventsStore.get().events).toEqual([]);

    inst.unmount();
  });

  it.each([
    { phase: 'planning', sessionId: '2024-01-01-inject', text: 'what about edge case X?' },
    {
      phase: 'implementing',
      sessionId: '2024-01-01-implementing-inject',
      text: 'carry this into implementation',
    },
  ] as const)(
    'carries the typed continuation into the re-entered run as a steer and records it as a user message',
    async ({ phase, sessionId, text }) => {
      const resume: WorkflowState = { ...createInitialState('add auth'), phase };
      saveState({ projectDir, sessionId }, resume);

      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({
        projectDir,
        feature: 'add auth',
        sessionId,
        resumeState: resume,
      });
      const seen: (string | undefined)[] = [];
      const runWorkflowSpy: RunWorkflowFn = async (options) => {
        seen.push(options.steer);
        return runWorkflow(options);
      };
      const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowSpy });
      await flush();
      expect(userMessageEvents()).toHaveLength(0);

      const runner = captureRunner.current;
      if (!runner) throw new Error('expected captureRunner.current to be populated');
      runner.handleResume(text);
      await flush();

      expect(seen.at(-1)).toBe(text);
      const userMessages = userMessageEvents();
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({ type: 'user_message', phase, text });
      const log = readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
      expect(loggedMessageRows(log, text)).toBe(1);
      const persisted = loadState({ projectDir, sessionId });
      if (!persisted) throw new Error('expected persisted state on disk');
      expect(persisted.messageQueue).toHaveLength(0);
      expect(feedbackStore.get().isError).toBe(false);

      inst.unmount();
    },
  );

  it('re-enters with no steer and no new row when no text was typed', async () => {
    const sessionId = '2024-01-01-empty-continue';
    const resume: WorkflowState = { ...createInitialState('add auth'), phase: 'planning' };
    saveState({ projectDir, sessionId }, resume);

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: resume,
    });
    const seen: (string | undefined)[] = [];
    const runWorkflowSpy: RunWorkflowFn = async (options) => {
      seen.push(options.steer);
      return runWorkflow(options);
    };
    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowSpy });
    await flush();
    expect(userMessageEvents()).toHaveLength(0);

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    runner.handleResume();
    await flush();

    expect(seen.at(-1)).toBeUndefined();
    expect(userMessageEvents()).toHaveLength(0);
    const persisted = loadState({ projectDir, sessionId });
    if (!persisted) throw new Error('expected persisted state on disk');
    expect(persisted.messageQueue).toHaveLength(0);

    inst.unmount();
  });

  it('leaves the steer unrecorded when it answers a planner question still pending', async () => {
    const sessionId = '2024-01-01-pending-answer';
    const answer = 'change src/auth.ts instead';
    const questions: ClarificationQuestion[] = [
      { id: 'module', type: 'input', text: 'Which module should change?', default: 'src/app.ts' },
    ];
    const resume: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'planning',
      pendingPlannerConversation: {
        call: 'plan',
        text: questionsText(questions),
        questions,
        answers: [],
        answered: false,
      },
    };
    saveState({ projectDir, sessionId }, resume);

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: resume,
    });
    const inst = renderHarness({
      prepared,
      captureRunner,
      runWorkflow: async (options) => runWorkflow(options),
    });
    await flush();

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    runner.handleResume(answer);
    await flush();

    // The planning session's pending question owns the answer: the session records it when it
    // consumes the seed, so the re-entry itself publishes nothing.
    expect(userMessageEvents()).toHaveLength(0);
    const log = readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
    expect(log).not.toContain(answer);

    inst.unmount();
  });

  it('seeds the correction typed at a halt into the next call, and only that call', async () => {
    const sessionId = '2026-09-21-recovery-steer';
    const halted = saveHaltedRun(sessionId);
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    const seen: (string | undefined)[] = [];
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      seen.push(options.steer);
      // The first call halts again on the same brief; the second is answered with the keyword.
      if (seen.length === 1) {
        const current = loadState({ projectDir, sessionId });
        if (!current) throw new Error('expected persisted state on disk');
        saveState({ projectDir, sessionId }, { ...current, pendingRecovery: makeRecoveryIssue() });
      }
      return makeSummary();
    });

    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowStub });
    await answerRecoveryPanel(captureRunner, 'add a default');
    await vi.waitFor(() => {
      expect(seen).toEqual(['add a default']);
    });

    await answerRecoveryPanel(captureRunner, 'retry');
    await vi.waitFor(() => {
      expect(seen).toEqual(['add a default', undefined]);
    });
    expect(runWorkflowStub).toHaveBeenCalledTimes(2);

    inst.unmount();
  });

  it('keeps the re-entry steer when the panel answer carries none', async () => {
    const sessionId = '2026-09-21-recovery-keeps-steer';
    const halted = saveHaltedRun(sessionId);
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    const seen: (string | undefined)[] = [];
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      seen.push(options.steer);
      return makeSummary();
    });

    const inst = renderHarness({
      prepared,
      steer: 'original',
      captureRunner,
      runWorkflow: runWorkflowStub,
    });
    await answerRecoveryPanel(captureRunner, 'retry');
    await vi.waitFor(() => {
      expect(seen).toEqual(['original']);
    });

    inst.unmount();
  });

  it('settles the run without re-entering when the panel pauses it', async () => {
    const sessionId = '2026-09-21-recovery-pauses';
    const halted = saveHaltedRun(sessionId);
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowStub });
    await answerRecoveryPanel(captureRunner, 'pause');
    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });
    expect(runWorkflowStub).not.toHaveBeenCalled();
    expect(loadState({ projectDir, sessionId })?.pendingRecovery?.status).toBe('paused');

    inst.unmount();
  });

  it('stops at the brief boundary and continues at rest when a seat changed under the run', async () => {
    const sessionId = '2026-09-21-seat-change';
    ensureSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('add auth'), phase: 'implementing' },
    );
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const continueAtRest = vi.fn();
    const { promise: seatChanged, resolve: seatChangedNow } = Promise.withResolvers<void>();
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      // The engine's side of a boundary pause: consume it and ask how to continue.
      await seatChanged;
      options.sinks.consumeBoundaryPause?.();
      await options.callbacks.onContinuationNeeded?.('', 'boundary');
      return makeSummary();
    });

    const inst = renderHarness({ prepared, continueAtRest, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(runWorkflowStub).toHaveBeenCalledTimes(1);
    });
    lifecycleStore.__testReset({ phase: 'implementing' });
    configStore.__testReset({
      projectDir,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
    });
    expect(stopStore.get().intent).toBe('pause-after-brief');

    seatChangedNow();
    await vi.waitFor(() => {
      expect(continueAtRest).toHaveBeenCalledTimes(1);
    });
    expect(continueAtRest).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { projectDir, sessionId } }),
    );
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
    expect(overlayStore.get().active).toBe('none');

    inst.unmount();
  });

  it('settles a boundary pause as today when no seat changed', async () => {
    const sessionId = '2026-09-21-boundary-pause';
    ensureSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('add auth'), phase: 'implementing' },
    );
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const continueAtRest = vi.fn();
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      requestBoundaryPause();
      options.sinks.consumeBoundaryPause?.();
      return makeSummary();
    });

    const inst = renderHarness({ prepared, continueAtRest, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });

    expect(continueAtRest).not.toHaveBeenCalled();
    expect(stopStore.get().phase).toBe('parked');

    inst.unmount();
  });

  it('settles a park in place instead of re-entering the run', async () => {
    const sessionId = '2024-01-01-parked-continue';
    ensureSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      { ...createInitialState('add auth'), phase: 'implementing' },
    );

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());
    const inst = renderHarness({ prepared, captureRunner, runWorkflow: runWorkflowStub });
    await flush();
    const runsBefore = (runWorkflowStub as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    const settled = vi.fn();
    stopStore.park('mid-brief', 'T001', settled);
    runner.handleResume('use the other adapter');
    await flush();

    expect(settled).toHaveBeenCalledWith('use the other adapter');
    expect((runWorkflowStub as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      runsBefore,
    );

    inst.unmount();
  });

  it('cleans up all handlers on unmount so later events do not leak into the suite', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const inst = renderHarness({ prepared });
    await flush();

    inst.unmount();
    await flush();

    expect(abortTurn()).toBe(false);
    expect(requestRewind({ target: 'task', taskId: 'T001' })).toBe(false);
  });

  it('asks nothing about a file halt whose files are back at the baseline', async () => {
    const sessionId = '2026-09-21-stale-file-halt';
    ensureSessionDir(projectDir, sessionId);
    const halted = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
      changedFilesBaseline: serializeChangedFilesBaseline(
        await captureChangedFilesBaseline(projectDir),
      ),
      pendingRecovery: makeRecoveryIssue({
        reason: 'user-edit-conflict',
        files: ['src/reverted.ts'],
        availableActions: ['continue', 'pause-run', 'end-run'],
        recommendedAction: 'continue',
      }),
    });
    saveState({ projectDir, sessionId }, halted);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    // The engine's side of the same rule: init resolves the halt and the run proceeds.
    const runWorkflowStub = vi.fn<RunWorkflowFn>(async () => {
      const current = loadState({ projectDir, sessionId });
      if (current) saveState({ projectDir, sessionId }, { ...current, pendingRecovery: undefined });
      return makeSummary();
    });

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(settledRun()).not.toBeNull();
    });

    expect(runWorkflowStub).toHaveBeenCalledTimes(1);
    expect(controlsStore.get().inputMode).not.toBe('question');
    expect(runWorkflowStub.mock.calls[0]?.[0]?.savedState?.pendingRecovery).toBeDefined();

    inst.unmount();
  });

  it('asks a standing file halt as the files read now, not as it was saved', async () => {
    const sessionId = '2026-10-03-standing-file-halt';
    ensureSessionDir(projectDir, sessionId);
    recoveryNoticeStore.clear();
    writeFileSync(join(projectDir, 'edited.ts'), 'original');
    const baseline = serializeChangedFilesBaseline(await captureChangedFilesBaseline(projectDir));
    writeFileSync(join(projectDir, 'edited.ts'), 'operator');
    const halted = makeImplState(
      [
        makeTask({ id: 'T001', status: 'failed', file: 'edited.ts' }),
        makeTask({ id: 'T002', status: 'pending', file: 'other.ts', dependsOn: ['T001'] }),
      ],
      {
        currentTaskIndex: 1,
        changedFilesBaseline: baseline,
        pendingRecovery: makeRecoveryIssue({
          reason: 'user-edit-conflict',
          phase: 'implementing',
          files: ['edited.ts'],
          availableActions: ['continue', 'pause-run', 'end-run'],
          recommendedAction: 'continue',
        }),
      },
    );
    saveState({ projectDir, sessionId }, halted);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: halted,
    });
    const runWorkflowStub = vi.fn<RunWorkflowFn>(async () => makeSummary());

    const inst = renderHarness({ prepared, runWorkflow: runWorkflowStub });
    await vi.waitFor(() => {
      expect(recoveryNoticeStore.get().issue?.id).toBe(
        loadState({ projectDir, sessionId })?.pendingRecovery?.id,
      );
    });

    const shown = recoveryNoticeStore.get().issue;
    expect(shown?.facts).toMatchObject({
      conflictKind: 'dependency-file-conflict',
      safeToContinue: false,
    });
    expect(shown?.availableActions).not.toContain('continue');
    expect(loadState({ projectDir, sessionId })?.pendingRecovery?.id).toBe(shown?.id);
    expect(runWorkflowStub).not.toHaveBeenCalled();

    inst.unmount();
  });

  describe('a run started on this screen', () => {
    it('re-enters the engine as the same session when a planning halt is retried', async () => {
      const sessionId = '2026-09-23-start-retry';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({
        projectDir,
        feature: 'add auth',
        sessionId,
        planner: {
          kind: 'shell',
          command: 'sh',
          args: ['-c', `cat >/dev/null; echo "You've hit your usage limit." >&2; exit 1`],
        },
        workflow: {},
      });
      const ref = prepared.session.ref;
      const requests: PrepareExecutionInput[] = [];
      const run = recordedEngine();

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: reprepareSameSession(requests),
      });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered.map((entry) => entry.purpose)).toEqual(['new-workflow', 'resume']);
      expect(run.entered[1]?.session.ref).toEqual(ref);
      expect(run.entered[1]?.config).toEqual(prepared.config);
      expect(requests).toEqual([
        expect.objectContaining({
          existingSession: ref,
          effectiveConfig: prepared.config,
          policy: expect.objectContaining({ purpose: 'resume', interaction: 'interactive' }),
        }),
      ]);
      // The retried call ran and hit the same limit, so the run halts on it again.
      expect(eventsStore.get().events.map((event) => event.type)).toContain('workflow_resumed');
      expect(loadState(ref)?.pendingRecovery?.reason).toBe('runner-usage-limit');
      expect(errorMessages()).not.toContainEqual(
        expect.stringContaining('already holds workflow state'),
      );

      inst.unmount();
    });

    it('re-enters the engine as the same session when a brief halt is skipped', async () => {
      const sessionId = '2026-09-23-start-skip';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const run = recordedEngine({
        1: async () => {
          saveHaltedRun(sessionId);
          return makeSummary();
        },
      });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await answerRecoveryPanel(captureRunner, 'skip');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered.map((entry) => entry.purpose)).toEqual(['new-workflow', 'resume']);
      expect(run.entered[1]?.session.ref).toEqual(prepared.session.ref);
      expect(loadState(prepared.session.ref)?.tasks.map((task) => task.status)).toEqual([
        'skipped',
      ]);
      expect(errorMessages()).toEqual([expect.stringContaining('is not available')]);

      inst.unmount();
    });

    it('moves a halted seat that can no longer be admitted without admitting it again', async () => {
      const sessionId = '2026-09-23-start-switch-seat';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const ref = prepared.session.ref;
      const requests: PrepareExecutionInput[] = [];
      const admit = reprepareSameSession();
      // The halted build seat is signed out: a preparation that still names it is refused.
      const haltedSeatSignedOut: PrepareExecutionFn = async (input) => {
        requests.push(input);
        const { implementer } = input.effectiveConfig;
        if (implementer.kind === 'cli' && implementer.tool === 'claude-code') return admit(input);
        return { kind: 'blocked', report: { ...prepared.report, status: 'blocked' } };
      };
      const run = recordedEngine({
        1: async () => {
          saveState(
            ref,
            makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
              mode: 'speckit',
              pendingRecovery: makeRecoveryIssue({
                reason: 'runner-usage-limit',
                availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
                recommendedAction: 'switch-seat',
                switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
              }),
            }),
          );
          return makeSummary();
        },
      });

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: haltedSeatSignedOut,
      });
      await answerRecoveryPanel(captureRunner, 'switch');
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('implementer-picker');
      });
      configStore.__testReset({
        projectDir,
        config: makeConfig({
          planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
          implementer: { kind: 'cli', tool: 'claude-code' },
        }),
      });
      overlayStore.close();
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(requests).toEqual([
        expect.objectContaining({
          existingSession: ref,
          effectiveConfig: expect.objectContaining({
            implementer: expect.objectContaining({ kind: 'cli', tool: 'claude-code' }),
          }),
          policy: expect.objectContaining({ purpose: 'resume', interaction: 'interactive' }),
        }),
      ]);
      expect(run.entered.map((entry) => entry.purpose)).toEqual(['new-workflow', 'resume']);
      expect(run.entered[1]?.config.implementer).toMatchObject({
        kind: 'cli',
        tool: 'claude-code',
      });
      // The seat change resumes the same run: its saved speckit mode survives and recovery clears.
      expect(loadState(ref)?.mode).toBe('speckit');
      expect(loadState(ref)?.pendingRecovery).toBeUndefined();
      expect(errorMessages()).toEqual([expect.stringContaining('is not available')]);

      inst.unmount();
    });

    it('releases the receipt its re-entry took when a later halt is answered by ending the run', async () => {
      const sessionId = '2026-09-23-start-end-after-retry';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const halt: RunWorkflowFn = async () => {
        saveHaltedRun(sessionId);
        return makeSummary();
      };
      const run = recordedEngine({ 1: halt, 2: halt });

      const inst = renderHarness({ prepared, captureRunner, runWorkflow: run.engine });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });
      await vi.waitFor(() => {
        expect(controlsStore.get().inputMode).toBe('question');
      });
      // The retry re-prepared the session, so the receipt on disk is no longer the first one.
      const reprepared = readActiveRecord(projectDir);
      expect(reprepared).toEqual({ kind: 'v1', receipt: expect.objectContaining({ sessionId }) });
      expect(reprepared).not.toEqual({ kind: 'v1', receipt: prepared.session.active });

      expect(requestEndRun()).toBe(true);
      await vi.waitFor(() => {
        expect(settledRun()?.status).toEqual({ kind: 'closed', as: 'ended' });
      });

      expect(readActive(projectDir)).toBeNull();

      inst.unmount();
    });

    it('re-enters the engine as the same session after a rewind and keeps its transcript', async () => {
      const sessionId = '2026-09-23-start-rewind';
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const ref = prepared.session.ref;
      const run = recordedEngine({
        1: parkAt(makeImplState([makeTask({ id: 'T001', status: 'done' })]), 'the build so far'),
      });

      const inst = renderHarness({ prepared, runWorkflow: run.engine });
      await vi.waitFor(() => {
        expect(userMessageEvents()).toHaveLength(1);
      });

      expect(requestRewind({ target: 'task', taskId: 'T001' })).toBe(true);
      await vi.waitFor(() => {
        expect(run.returned()).toBe(2);
      });

      expect(run.entered.map((entry) => entry.purpose)).toEqual(['new-workflow', 'resume']);
      expect(run.entered[1]?.session.ref).toEqual(ref);
      expect(userMessageEvents()).toEqual([expect.objectContaining({ text: 'the build so far' })]);
      expect(eventsStore.get().events.map((event) => event.type)).toContain('task_reset');
      expect(errorMessages()).toEqual([expect.stringContaining('is not available')]);

      inst.unmount();
    });

    it('leaves the run open at rest when its tools are not admitted again', async () => {
      const sessionId = '2026-09-23-start-blocked';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const run = recordedEngine({
        1: async () => {
          saveHaltedRun(sessionId);
          return makeSummary();
        },
      });
      const blocked: PrepareExecutionFn = async () => ({
        kind: 'blocked',
        report: { ...prepared.report, status: 'blocked' },
      });

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: blocked,
      });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(settledRun()?.status.kind).toBe('open');
      });

      expect(run.entered).toHaveLength(1);
      expect(errorMessages()).toEqual(['Cannot resume: Readiness blocked.']);

      inst.unmount();
    });

    it('records the stop when the operator stops the run while it is admitted again', async () => {
      const sessionId = '2026-09-23-start-stopped';
      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const run = recordedEngine({
        1: async () => {
          saveHaltedRun(sessionId);
          return makeSummary();
        },
      });
      let preparing = false;
      const waitForStop: PrepareExecutionFn = async (input) => {
        preparing = true;
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { kind: 'aborted' };
      };

      const inst = renderHarness({
        prepared,
        captureRunner,
        runWorkflow: run.engine,
        prepareExecution: waitForStop,
      });
      await answerRecoveryPanel(captureRunner, 'retry');
      await vi.waitFor(() => {
        expect(preparing).toBe(true);
      });
      expect(requestStopNow()).toBe(true);
      await vi.waitFor(() => {
        expect(stopStore.get().phase).toBe('parked');
      });

      expect(run.entered).toHaveLength(1);
      const saved = loadState(prepared.session.ref);
      expect(saved?.interruptedStep?.cut).toBe('mid-step');
      expect(saved?.pendingRecovery).toBeUndefined();
      expect(settledRun()?.status.kind).toBe('open');
      expect(
        (await readRunEvents(prepared.session.ref)).events.filter(
          (event) => event.type === 'turn_interrupted',
        ),
      ).toMatchObject([
        {
          source: 'user',
          at: 'mid-step',
          step: saved?.interruptedStep?.step,
        },
      ]);

      inst.unmount();
    });
  });
});

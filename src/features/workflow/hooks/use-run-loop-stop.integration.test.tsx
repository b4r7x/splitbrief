import { plainUserMessage } from '../../../core/types/user-input.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir } from '../../../core/paths.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readSession } from '../../../core/sessions/io.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import { transitionAndSave } from '../../../engine/orchestrator/state-ops.js';
import { finalizeEndedRun } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { buildReviewFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import { readRunEvents } from '../../../engine/events/replay.js';
import {
  WORKFLOW_CANCEL_REASON_USER,
  workflowCancelledReasonFromSignal,
} from '../../../engine/events/workflow-cancel.js';
import { closeRunIfOpen } from '../../../engine/orchestrator/run/close.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { continueRun } from '../../../engine/orchestrator/run/continue.js';
import { hydrateResume } from '../resume-hydration.js';
import { buildContextOverflowRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import { killAllProcesses, registeredProcessCount } from '../../../lib/process/registry.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import {
  clearAllHandlers,
  requestEndRun,
  requestLeaveSession,
  requestQuit,
  requestSeatChangeAtBoundary,
  requestStopNow,
  resumeParkedRun,
} from '../handlers.js';
import { useStopByline } from '../stop/use-stop-byline.js';
import { useInputMode } from './use-input-mode.js';
import { useRunContinue } from './use-run-continue.js';
import { useRunLoop, type RunWorkflowFn } from './use-run-loop.js';

function Harness({
  prepared,
  engine,
}: {
  prepared: PreparedExecution;
  engine?: RunWorkflowFn | undefined;
}) {
  const inputMode = useInputMode();
  const continuation = useRunContinue({ prepared, inputMode });
  useRunLoop({ prepared, inputMode, continuation, runWorkflow: engine });
  const stopped = useStopByline();
  return <Text>{stopped?.parts.map((part) => part.text).join('') ?? inputMode.mode}</Text>;
}

type EngineOptions = Parameters<RunWorkflowFn>[0];

/** The harness that also hands the test the input mode, so it can type what the composer would. */
function AnsweringHarness({
  prepared,
  engine,
  onInputMode,
}: {
  prepared: PreparedExecution;
  engine: RunWorkflowFn;
  onInputMode: (inputMode: ReturnType<typeof useInputMode>) => void;
}) {
  const inputMode = useInputMode();
  onInputMode(inputMode);
  const continuation = useRunContinue({ prepared, inputMode });
  useRunLoop({ prepared, inputMode, continuation, runWorkflow: engine });
  return <Text>{inputMode.mode}</Text>;
}

function saveInterrupted(options: EngineOptions) {
  const { ref, active } = options.prepared.session;
  const state = loadState(ref);
  if (state === null) throw new Error('missing fixture state');
  const saved = transitionAndSave(ref, state, {
    type: 'INTERRUPT_STEP',
    step: resumeStep(state),
    source: 'user',
    cut: 'mid-step',
  });
  return finalizeEndedRun({ ref, active, state: saved });
}

function waitingEngine(
  wait: (options: EngineOptions) => Promise<unknown>,
  cleanup?: Promise<void>,
) {
  return vi.fn<RunWorkflowFn>(async (options) => {
    try {
      await wait(options);
    } catch (error) {
      if (!options.signal?.aborted) throw error;
    }
    if (!options.signal?.aborted) throw new Error('fixture wait ended without stopping');
    await cleanup;
    return saveInterrupted(options);
  });
}

function awaitAbort(options: EngineOptions): Promise<void> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) resolve();
    else options.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

function stopAsked(): Promise<void> {
  return new Promise((resolve) => {
    const off = stopStore.subscribe(() => {
      const { intent, seatChange } = stopStore.get();
      if (intent === 'none' && !seatChange) return;
      off();
      resolve();
    });
  });
}

/** The final review passed before the stop reached the engine, so the run closes complete. */
function passFinalReview(options: EngineOptions) {
  const { ref, active } = options.prepared.session;
  const state = loadState(ref);
  if (state === null) throw new Error('missing fixture state');
  const passed = transitionAndSave(ref, state, { type: 'REVIEW_DONE', reviewStatus: 'passed' });
  options.tuiSink?.({
    type: 'workflow_complete',
    ts: Date.now(),
    phase: passed.phase,
    review: 'passed',
  });
  return finalizeEndedRun({ ref, active, state: passed });
}

function finalReviewState(): WorkflowState {
  return makeImplState([makeTask({ id: 'T001', status: 'done' })], {
    ...RUN_CREW,
    phase: 'final-review',
    currentTaskIndex: 1,
  });
}

describe('run-loop stop completion', () => {
  let projectDir: string;
  let mounted: ReturnType<typeof renderFeature> | undefined;

  beforeEach(() => {
    projectDir = createTempDir('run-loop-stop-');
    execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
    resetAllStores();
    clearAllHandlers();
  });

  afterEach(async () => {
    mounted?.unmount();
    mounted = undefined;
    await killAllProcesses();
    clearAllHandlers();
    resetAllStores();
    cleanupTempDir(projectDir);
  });

  function prepare(
    state = transition({ ...createInitialState('stop fixture'), ...RUN_CREW }, { type: 'START' }),
  ) {
    const sessionId = 'stop-session';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    saveState(ref, state);
    return makePreparedExecution({
      projectDir,
      sessionId,
      feature: state.feature,
      resumeState: state,
      active: reactivateExistingSession(ref),
      config: makeConfig({
        planner: {
          kind: 'shell',
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(join(projectDir, 'planner-started'))}, 'ready'); setInterval(() => {}, 1000)`,
          ],
          outputFormat: 'text',
        },
        implementer: {
          kind: 'shell',
          model: 'fixture',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          outputFormat: 'text',
        },
      }),
    });
  }

  function mount(prepared: PreparedExecution, engine?: RunWorkflowFn) {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: prepared.session.ref }),
      execution: { kind: 'local', prepared },
    });
    mounted = renderFeature(<Harness prepared={prepared} engine={engine} />);
  }

  async function expectParked(prepared: PreparedExecution) {
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('parked'), { timeout: 3000 });
    expect(registeredProcessCount()).toBe(0);
    const saved = loadState(prepared.session.ref);
    expect(saved?.closed).toBeUndefined();
    expect(saved).toMatchObject({ interruptedStep: expect.anything() });
    expect(readSession(prepared.session.ref)?.status).toBe('open');
  }

  it('keeps an unfinished Apply recovery active when live End run is refused', async () => {
    const prepared = prepare({
      ...createInitialState('Partial Apply'),
      ...RUN_CREW,
      applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
      pendingRecovery: makeRecoveryIssue({
        reason: 'apply-partial',
        availableActions: ['retry-same-worker', 'restore-backup'],
      }),
    });
    const before = loadState(prepared.session.ref);
    const engine = vi.fn<RunWorkflowFn>();
    mount(prepared, engine);
    await vi.waitFor(() => expect(controlsStore.get().inputMode).toBe('question'));

    expect(requestEndRun()).toBe(true);

    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: expect.stringContaining('Restore or retry Apply first'),
    });
    expect(controlsStore.get().inputMode).toBe('question');
    expect(stopStore.get().intent).toBe('none');
    expect(loadState(prepared.session.ref)).toEqual(before);
    expect(engine).not.toHaveBeenCalled();
  });

  it.each(['stay', 'home', 'quit'] as const)(
    'keeps Apply recoverable after End run with %s queued',
    async (destination) => {
      const cleanup = Promise.withResolvers<void>();
      let quit = false;
      const prepared = prepare();
      let signal: AbortSignal | undefined;
      const engine = vi.fn<RunWorkflowFn>(async (options) => {
        signal = options.signal;
        await awaitAbort(options);
        await cleanup.promise;
        const state: WorkflowState = {
          ...createInitialState('Apply starts during stop'),
          ...RUN_CREW,
          applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
          pendingRecovery: makeRecoveryIssue({
            reason: 'apply-partial',
            availableActions: ['retry-same-worker', 'restore-backup'],
          }),
        };
        saveState(prepared.session.ref, state);
        await closeRunIfOpen(
          {
            ...prepared.session.ref,
            bus: createRecoveryBus({ ...prepared.session.ref, sink: () => {} }),
          },
          state,
        );
        throw new Error('End run closed a run with an unfinished Apply');
      });
      mount(prepared, engine);
      await vi.waitFor(() => expect(signal).toBeDefined());

      expect(requestEndRun()).toBe(true);

      expect(signal?.aborted).toBe(true);
      expect(workflowCancelledReasonFromSignal(signal)).toBe(WORKFLOW_CANCEL_REASON_USER);
      if (destination === 'home') requestLeaveSession();
      else if (destination === 'quit')
        requestQuit(() => {
          quit = true;
        });
      await tick(30);
      expect(routerStore.get().screen).toBe('workflow');
      expect(quit).toBe(false);
      cleanup.resolve();
      await vi.waitFor(() => expect(stopStore.get().phase).toBe('parked'));
      expect(routerStore.get().screen).toBe(destination === 'home' ? 'home' : 'workflow');
      expect(quit).toBe(destination === 'quit');
      expect(feedbackStore.get().message).toContain('Restore or retry Apply first');
      expect(stopStore.get().intent).toBe('end-run');
      expect(loadState(prepared.session.ref)?.applying?.backupId).toBe('apply-backup');
      expect(loadState(prepared.session.ref)?.pendingRecovery?.reason).toBe('apply-partial');
      expect(loadState(prepared.session.ref)?.closed).toBeUndefined();
      expect(readRunRecord(prepared.session.ref)?.status.kind).toBe('open');
      expect(
        (await readRunEvents(prepared.session.ref)).events.filter(
          (event) => event.type === 'workflow_cancelled',
        ),
      ).toEqual([]);
    },
  );

  it.each(['planner question', 'review approval', 'permission approval'] as const)(
    'stops a %s with no registered process and persists before parking',
    async (wait) => {
      const prepared = prepare();
      const answered = vi.fn();
      const engine = waitingEngine(async (options) => {
        if (wait === 'planner question') {
          answered(
            await options.callbacks.onPlannerReply?.({
              call: 'research',
              text: 'Which module?',
              questions: [],
              answers: [],
              answered: false,
            }),
          );
        } else if (wait === 'review approval') {
          await options.callbacks.onApprovalNeeded('plan', 'plan.md', []);
        } else {
          await options.callbacks.onTieredApproval?.({
            tier: 'confirm',
            actionClass: 'package_change',
            actionDescription: 'package.json',
            phase: 'researching',
          });
        }
      });
      mount(prepared, engine);
      await vi.waitFor(() => {
        if (wait === 'permission approval')
          expect(approvalPromptStore.get().status).toBe('pending');
        else
          expect(controlsStore.get().inputMode).toBe(
            wait === 'planner question' ? 'question' : 'review',
          );
      });
      expect(registeredProcessCount()).toBe(0);
      expect(requestStopNow()).toBe(true);
      await expectParked(prepared);
      expect(controlsStore.get().inputMode).toBe('normal');
      expect(approvalPromptStore.get().status).not.toBe('pending');
      expect(answered).not.toHaveBeenCalled();
      expect(engine).toHaveBeenCalledTimes(1);
    },
  );

  it('stops a real runWorkflow waiting on its persisted planner question without answering it', async () => {
    const state: WorkflowState = {
      ...transition({ ...createInitialState('question fixture'), ...RUN_CREW }, { type: 'START' }),
      pendingPlannerConversation: {
        call: 'plan',
        text: '1. Which module? (default: src/a.ts)',
        questions: [{ id: 'module', type: 'input', text: 'Which module?', default: 'src/a.ts' }],
        answers: [],
        answered: false,
      },
    };
    const prepared = prepare(state);
    mount(prepared);
    await vi.waitFor(() => expect(controlsStore.get().inputMode).toBe('question'), {
      timeout: 5000,
    });
    expect(requestStopNow()).toBe(true);
    await expectParked(prepared);
    expect(loadState(prepared.session.ref)?.pendingPlannerConversation).toMatchObject({
      answered: false,
      answers: [],
    });
  });

  it('aborts a real shell planner, waits for its process to exit, and keeps the run open', async () => {
    const prepared = prepare();
    mount(prepared);
    await vi.waitFor(
      () => {
        expect(existsSync(join(projectDir, 'planner-started'))).toBe(true);
        expect(registeredProcessCount()).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
    requestStopNow();
    await expectParked(prepared);
  });

  it('ends a real run during planning without a stop row or a cut step', async () => {
    const prepared = prepare();
    mount(prepared);
    await vi.waitFor(
      () => {
        expect(existsSync(join(projectDir, 'planner-started'))).toBe(true);
        expect(registeredProcessCount()).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
    expect(requestEndRun()).toBe(true);
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('ended'), { timeout: 5000 });
    expect(registeredProcessCount()).toBe(0);
    const saved = loadState(prepared.session.ref);
    expect(saved?.closed?.as).toBe('ended');
    expect(saved?.interruptedStep).toBeUndefined();
    const events = (await readRunEvents(prepared.session.ref)).events;
    expect(events.filter((event) => event.type === 'turn_interrupted')).toEqual([]);
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
  });

  // Stop, then continue the run at rest in place: the re-entry is live again, so the stop is armed
  // afresh and what the operator types answers the run rather than settling a park it no longer has.
  it('re-arms the stop when a stopped run is continued in place', async () => {
    const answers: unknown[] = [];
    const engine = vi.fn<RunWorkflowFn>(async (options) => {
      if (engine.mock.calls.length > 1) {
        answers.push(
          await options.callbacks.onPlannerReply?.({
            call: 'research',
            text: 'Which module?',
            questions: [],
            answers: [],
            answered: false,
          }),
        );
      }
      await awaitAbort(options);
      return saveInterrupted(options);
    });
    let inputMode: ReturnType<typeof useInputMode> | undefined;
    const first = prepare();
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: first.session.ref }),
      execution: { kind: 'local', prepared: first },
    });
    mounted = renderFeature(
      <AnsweringHarness
        prepared={first}
        engine={engine}
        onInputMode={(next) => {
          inputMode = next;
        }}
      />,
    );
    await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1));
    expect(requestStopNow()).toBe(true);
    await vi.waitFor(
      () => expect(routerStore.get()).toMatchObject({ execution: { kind: 'at-rest' } }),
      {
        timeout: 3000,
      },
    );
    expect(stopStore.get().phase).toBe('parked');

    const stopped = loadState(first.session.ref);
    if (stopped === null) throw new Error('missing stopped state');
    const second = prepare(stopped);
    routerStore.updateRun({
      run: readRunRecord(first.session.ref),
      execution: { kind: 'local', prepared: second },
    });
    mounted.rerender(
      <AnsweringHarness
        prepared={second}
        engine={engine}
        onInputMode={(next) => {
          inputMode = next;
        }}
      />,
    );
    await vi.waitFor(() => expect(mounted?.lastFrame()).toBe('question'));

    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', parked: null });
    expect(resumeParkedRun(plainUserMessage('src/core'))).toBe(false);
    inputMode?.resolve(plainUserMessage('src/core'));
    await vi.waitFor(() => expect(answers).toEqual([plainUserMessage('src/core')]));
    expect(requestStopNow()).toBe(true);
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('parked'), { timeout: 3000 });
    expect(engine).toHaveBeenCalledTimes(2);
  });

  it('stops the recovery prompt without entering the engine', async () => {
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task], {
      ...RUN_CREW,
      pendingRecovery: buildContextOverflowRecoveryIssue({
        task,
        phase: 'implementing',
        createdAt: new Date().toISOString(),
      }),
    });
    const prepared = prepare(state);
    const engine = vi.fn<RunWorkflowFn>();
    mount(prepared, engine);
    await vi.waitFor(() => expect(controlsStore.get().inputMode).toBe('question'));
    requestStopNow();
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('parked'), { timeout: 3000 });
    expect(registeredProcessCount()).toBe(0);
    const saved = loadState(prepared.session.ref);
    expect(saved?.closed).toBeUndefined();
    expect(saved?.interruptedStep).toBeUndefined();
    expect(readSession(prepared.session.ref)?.status).toBe('open');
    expect(engine).not.toHaveBeenCalled();
    expect(saved?.pendingRecovery?.id).toBe(state.pendingRecovery?.id);
  });

  it.each(['Stop now', 'End run'] as const)(
    '%s at a failed-review recovery preserves the review and saves the requested status',
    async (action) => {
      const state = transition(finalReviewState(), { type: 'REVIEW_DONE', reviewStatus: 'failed' });
      state.pendingRecovery = buildReviewFailedRecoveryIssue({
        blocking: 1,
        phase: state.phase,
        createdAt: new Date().toISOString(),
      });
      const prepared = prepare(state);
      const engine = vi.fn<RunWorkflowFn>();
      mount(prepared, engine);
      await vi.waitFor(() => expect(controlsStore.get().inputMode).toBe('question'));
      expect(action === 'End run' ? requestEndRun() : requestStopNow()).toBe(true);
      await vi.waitFor(() =>
        expect(routerStore.get()).toMatchObject({
          execution: { kind: 'at-rest' },
        }),
      );
      const ended = action === 'End run';
      expect(readRunRecord(prepared.session.ref)?.status).toMatchObject(
        ended
          ? { kind: 'closed', as: 'ended' }
          : { kind: 'open', stop: { kind: 'waiting-for-you', on: { kind: 'halt' } } },
      );
      const saved = loadState(prepared.session.ref);
      expect(saved?.reviewStatus).toBe('failed');
      expect(saved?.completedAt).toBe(state.completedAt);
      expect(saved?.pendingRecovery).toEqual(ended ? undefined : state.pendingRecovery);
      expect(stopStore.get().phase).toBe(ended ? 'ended' : 'parked');
      // A run End run closed has no stop line: the closed run's own byline speaks for it, so the
      // harness shows the input mode where a stop line would stand.
      expect(mounted?.lastFrame()).toBe(ended ? 'normal' : 'Stopped at the review');
      const cancellations = (await readRunEvents(prepared.session.ref)).events.filter(
        (event) => event.type === 'workflow_cancelled',
      );
      expect(cancellations).toHaveLength(ended ? 1 : 0);
      expect(engine).not.toHaveBeenCalled();
      const restart = vi.fn();
      expect(
        continueRun({
          ref: prepared.session.ref,
          deps: { resumeParked: () => false, loadState: hydrateResume, restart },
        }).kind,
      ).toBe(ended ? 'refused' : 'restarted');
      expect(restart).toHaveBeenCalledTimes(ended ? 0 : 1);
    },
  );

  it('keeps one closure and one cancellation when End run retries finalization', async () => {
    const state = transition(finalReviewState(), { type: 'REVIEW_DONE', reviewStatus: 'failed' });
    state.pendingRecovery = buildReviewFailedRecoveryIssue({
      blocking: 1,
      phase: state.phase,
      createdAt: new Date().toISOString(),
    });
    const prepared = prepare(state);
    const engine = vi.fn<RunWorkflowFn>();
    mount(prepared, engine);
    await vi.waitFor(() => expect(controlsStore.get().inputMode).toBe('question'));
    const summaryPath = join(
      sessionDir(projectDir, prepared.session.ref.sessionId),
      'summary.json',
    );
    mkdirSync(summaryPath);
    expect(requestEndRun()).toBe(true);
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('failed'));
    const first = loadState(prepared.session.ref);
    expect(first?.closed?.as).toBe('ended');
    rmdirSync(summaryPath);
    expect(requestStopNow()).toBe(true);
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('ended'));
    expect(loadState(prepared.session.ref)).toEqual(first);
    expect(
      (await readRunEvents(prepared.session.ref)).events.filter(
        (event) => event.type === 'workflow_cancelled',
      ),
    ).toHaveLength(1);
    expect(engine).not.toHaveBeenCalled();
  });

  it.each(['home', 'quit'] as const)(
    'holds queued %s until engine cleanup and persistence finish',
    async (destination) => {
      const cleanup = Promise.withResolvers<void>();
      const prepared = prepare();
      const engine = waitingEngine(awaitAbort, cleanup.promise);
      const exit = vi.fn();
      mount(prepared, engine);
      await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1));
      requestStopNow();
      if (destination === 'home') requestLeaveSession();
      else requestQuit(exit);
      await tick(30);
      expect(stopStore.get().phase).toBe('settling');
      expect(routerStore.get().screen).toBe('workflow');
      expect(exit).not.toHaveBeenCalled();
      cleanup.resolve();
      await expectParked(prepared);
      expect(routerStore.get().screen).toBe(destination === 'home' ? 'home' : 'workflow');
      expect(exit).toHaveBeenCalledTimes(destination === 'quit' ? 1 : 0);
    },
  );

  it('drains a boundary park before quitting, without resuming engine work', async () => {
    const cleanup = Promise.withResolvers<void>();
    const prepared = prepare();
    const engine = waitingEngine(
      (options) =>
        options.callbacks.onContinuationNeeded?.('', 'boundary', []) ?? Promise.resolve(),
      cleanup.promise,
    );
    const exit = vi.fn();
    mount(prepared, engine);
    await vi.waitFor(() => expect(stopStore.get().parked?.kind).toBe('boundary'));
    requestQuit(exit);
    await tick(30);
    expect(exit).not.toHaveBeenCalled();
    cleanup.resolve();
    await expectParked(prepared);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it('reports persistence failure and retries saving without rerunning the engine', async () => {
    const prepared = prepare();
    const engine = waitingEngine(awaitAbort);
    mount(prepared, engine);
    await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1));
    const summary = join(sessionDir(projectDir, prepared.session.ref.sessionId), 'summary.json');
    mkdirSync(summary);
    requestStopNow();
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('failed'));
    expect(stopStore.get().error).toBeTruthy();
    expect(routerStore.get()).toMatchObject({ screen: 'workflow', execution: { kind: 'local' } });
    rmdirSync(summary);
    expect(requestStopNow()).toBe(true);
    await expectParked(prepared);
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Stop now', requestStopNow],
    ['End run', requestEndRun],
    ['a seat change', () => requestSeatChangeAtBoundary()],
  ] as const)('shows no stop when the final review passes as %s lands', async (_stop, request) => {
    const prepared = prepare(finalReviewState());
    const engine = vi.fn<RunWorkflowFn>(async (options) => {
      await stopAsked();
      return passFinalReview(options);
    });
    mount(prepared, engine);
    await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1));
    request();
    await vi.waitFor(() =>
      expect(routerStore.get()).toMatchObject({
        execution: { kind: 'at-rest' },
        run: { status: { kind: 'closed', as: 'complete' } },
      }),
    );
    await vi.waitFor(() => expect(mounted?.lastFrame()).toBe('normal'));
    expect(overlayStore.get().active).toBe('none');
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
    expect(lifecycleStore.get()).toMatchObject({
      phase: 'complete',
      status: 'complete',
      cancelled: false,
    });
  });

  it.each([
    ['Stop now', requestStopNow],
    ['a seat change', () => requestSeatChangeAtBoundary()],
  ] as const)(
    'stands the stop down for the result menu when the review passes as %s lands on a workspace run',
    async (_stop, request) => {
      const prepared = prepare({
        ...finalReviewState(),
        workspace: {
          kind: 'worktree',
          path: join(projectDir, 'run-workspace'),
          base: { snapshotId: 'workspace-base', head: null },
        },
      });
      const engine = vi.fn<RunWorkflowFn>(async (options) => {
        await stopAsked();
        return passFinalReview(options);
      });
      mount(prepared, engine);
      await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1));
      request();
      await vi.waitFor(() =>
        expect(routerStore.get()).toMatchObject({
          execution: { kind: 'at-rest' },
          run: { status: { kind: 'ready-to-apply', override: false } },
        }),
      );
      await vi.waitFor(() => expect(mounted?.lastFrame()).toBe('normal'));
      expect(overlayStore.get().active).toBe('none');
      expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
    },
  );

  it.each(['home', 'quit'] as const)(
    'delivers a queued %s when the final review passes before the stop lands',
    async (destination) => {
      const cleanup = Promise.withResolvers<void>();
      const prepared = prepare(finalReviewState());
      const engine = vi.fn<RunWorkflowFn>(async (options) => {
        await stopAsked();
        await cleanup.promise;
        return passFinalReview(options);
      });
      const exit = vi.fn();
      mount(prepared, engine);
      await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1));
      requestStopNow();
      if (destination === 'home') requestLeaveSession();
      else requestQuit(exit);
      await tick(30);
      expect(routerStore.get().screen).toBe('workflow');
      expect(exit).not.toHaveBeenCalled();
      cleanup.resolve();
      if (destination === 'home')
        await vi.waitFor(() => expect(routerStore.get().screen).toBe('home'));
      else await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
      expect(readRunRecord(prepared.session.ref).status).toEqual({
        kind: 'closed',
        as: 'complete',
      });
    },
  );
});

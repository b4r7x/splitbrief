import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
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
import { artifactPresence } from '../../../core/sessions/run-record-io.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import { transitionAndSave } from '../../../engine/orchestrator/state-ops.js';
import { finalizeEndedRun } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { buildContextOverflowRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import { killAllProcesses, registeredProcessCount } from '../../../lib/process/registry.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { clearAllHandlers, requestLeaveSession, requestQuit, requestStopNow } from '../handlers.js';
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
  return <Text>{inputMode.mode}</Text>;
}

type EngineOptions = Parameters<RunWorkflowFn>[0];

function saveInterrupted(options: EngineOptions) {
  const { ref, active } = options.prepared.session;
  const state = loadState(ref);
  if (state === null) throw new Error('missing fixture state');
  const saved = transitionAndSave(ref, state, {
    type: 'INTERRUPT_STEP',
    step: resumeStep(state, artifactPresence(ref)),
    source: 'user',
    cut: 'mid-step',
  });
  return finalizeEndedRun({ ref, active, config: options.prepared.config, state: saved });
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

  function prepare(state = transition(createInitialState('stop fixture'), { type: 'START' })) {
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
          await options.callbacks.onApprovalNeeded('spec', 'spec.md');
        } else {
          await options.callbacks.onTieredApproval?.({
            tier: 'sticky',
            actionClass: 'network',
            actionDescription: 'connect',
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
      ...transition(createInitialState('question fixture'), { type: 'START' }),
      pendingPlannerConversation: {
        call: 'research',
        text: 'Which module?',
        questions: [],
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

  it('stops the recovery prompt without entering the engine', async () => {
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task], {
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
      (options) => options.callbacks.onContinuationNeeded?.('', 'boundary') ?? Promise.resolve(),
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
});

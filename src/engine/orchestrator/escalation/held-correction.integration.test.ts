import { plainUserMessage } from '../../../core/types/user-input.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Config } from '../../../core/schemas/config.js';
import { lineageAttemptsOf, type WorkflowState } from '../../../core/schemas/workflow/state.js';
import { transition } from '../../../core/state/machine.js';
import { briefCorrections } from '../../../core/state/lineage.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { Implementer } from '../../implementers/types.js';
import { createSteeringPort } from '../../calls/steering.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { clearPendingQueue } from '../queue/clear.js';
import { CORRECTION_AFTER_CHECKS } from '../task/brief-gate.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import { runHeldCorrection } from './held-correction.js';
import { handleRetryAndEscalation } from './handle.js';
import type { EscalationContext } from './types.js';

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'held-correction-test',
    sessionId: 'sess-held-correction',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  return transition(makeImplState([task]), { type: 'TASK_SENT' });
}

/** The state a held correction starts from: the first call booked, the brief back in implementing. */
function makeHeldState(task = makeTask()): WorkflowState {
  const sent = transition(makeImplState([task]), { type: 'TASK_SENT' });
  const counted = transition(sent, { type: 'COUNT_ATTEMPT', taskId: task.id });
  return transition(counted, { type: 'RESUME_TASK' });
}

function makeHeldCtx(opts: {
  projectDir: string;
  sessionId: string;
  implementer: ReturnType<typeof makeImplementer>;
  bus: ReturnType<typeof makeBusRecorder>['bus'];
  signal?: AbortSignal | undefined;
  config?: Config | undefined;
}): EscalationContext {
  return {
    ...makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      config: opts.config ?? makeNoValidationConfig(),
      planner: makePlanner(),
      implementer: opts.implementer,
      bus: opts.bus,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    }),
    taskStartSnapshot: { head: '', files: [], dirtyFileContents: {} },
    dependsOnFiles: [],
  };
}

describe('runHeldCorrection — corrections during checks', () => {
  it('keeps steering attached through a held correction and its correction pass', async () => {
    const ref = setupProject();
    const task = makeTask();
    const state = makeHeldState(task);
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    const received: string[] = [];
    const retry: Implementer['retry'] = async (opts) => {
      const detach = opts.steering?.attach({
        callId: 'local-retry',
        role: 'implementer',
        taskId: task.id,
        send: async ({ text }) => {
          received.push(text);
          return 'delivered';
        },
      });
      try {
        await steering.current()?.send({ id: 'live-retry', text: 'keep the alias' });
        const current = loadState(ref);
        if (current === null) throw new Error('missing state during retry');
        enqueueUserMessage({
          ...ref,
          state: current,
          message: plainUserMessage('keep the export too'),
          phase: current.phase,
          bus,
          reviewNone: false,
        });
        return { success: true, output: 'fixed' };
      } finally {
        detach?.();
      }
    };
    const implement: Implementer['implement'] = async (opts) => {
      const detach = opts.steering?.attach({
        callId: 'local-correction',
        role: 'implementer',
        taskId: task.id,
        send: async ({ text }) => {
          received.push(text);
          return 'delivered';
        },
      });
      try {
        await steering.current()?.send({ id: 'live-correction', text: 'keep the type too' });
        return { success: true, output: 'corrected' };
      } finally {
        detach?.();
      }
    };

    const outcome = await runHeldCorrection({
      ctx: {
        ...makeHeldCtx({ ...ref, implementer: makeImplementer({ retry, implement }), bus }),
        steering,
        taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      },
      task,
      state,
      answer: 'Use the existing helper.',
    });

    expect(outcome.result).toMatchObject({ completed: true, method: 'local' });
    expect(received).toEqual(['keep the alias', 'keep the type too']);
    expect(steering.current()).toBeNull();
    expect(briefCorrections(outcome.state, task.id)).toEqual([
      expect.stringContaining('keep the export too'),
    ]);
  });

  it('completes the held correction without another attempt when its correction is cleared after recorded checks', async () => {
    const ref = setupProject();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version' }],
    });
    const state = makeHeldState(task);
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    bus.subscribe((event) => {
      if (event.type !== 'checks_run') return;
      const checked = loadState(ref);
      if (checked === null) throw new Error('missing recorded checks');
      clearPendingQueue({ ...ref, state: checked, bus });
    });
    const retry = vi.fn<Implementer['retry']>(async () => ({ success: true, output: 'fixed' }));
    const runCommand = vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      const current = loadState(ref);
      if (current === null) throw new Error('missing state during checks');
      enqueueUserMessage({
        ...ref,
        state: current,
        message: plainUserMessage('cleared correction'),
        phase: current.phase,
        bus,
        reviewNone: false,
      });
      return { stdout: 'ok', stderr: '', code: 0 };
    });

    const outcome = await runHeldCorrection({
      ctx: {
        ...makeHeldCtx({
          ...ref,
          implementer: makeImplementer({ retry }),
          bus,
          config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        }),
        taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      },
      task,
      state,
      answer: 'Use the existing helper.',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({ completed: true, method: 'local', attempts: 0 });
    expect(outcome.state.tasks[0]?.status).toBe('done');
    expect(outcome.state.currentTaskIndex).toBe(1);
    expect(outcome.state.lineages?.T001).toMatchObject({ attempts: 2, consultRecords: [] });
    expect(briefCorrections(outcome.state, task.id)).toEqual([]);
    expect(outcome.state.messageQueue).toEqual([]);
    expect(loadState(ref)?.messageQueue).toEqual([]);
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([]);
  });

  it('runs one more answer attempt after green held-correction checks receive a message', async () => {
    const ref = setupProject();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version' }],
    });
    const state = makeHeldState(task);
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const retry = vi.fn<Implementer['retry']>(async () => {
      return { success: true, output: 'fixed' };
    });
    let checks = 0;
    const runCommand = vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      checks += 1;
      if (checks === 1) {
        const current = loadState(ref);
        if (current === null) throw new Error('missing state during checks');
        enqueueUserMessage({
          ...ref,
          state: current,
          message: plainUserMessage('keep the alias'),
          phase: current.phase,
          bus,
          reviewNone: false,
        });
      }
      return { stdout: 'ok', stderr: '', code: 0 };
    });

    const outcome = await runHeldCorrection({
      ctx: {
        ...makeHeldCtx({
          ...ref,
          implementer: makeImplementer({ retry }),
          bus,
          config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        }),
        taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      },
      task,
      state,
      answer: 'Use the existing helper.',
    });

    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry.mock.calls[1]?.[0]).toMatchObject({ error: CORRECTION_AFTER_CHECKS, attempt: 0 });
    expect(retry.mock.calls[1]?.[0].continuation?.steer).toContain('keep the alias');
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(outcome.result).toMatchObject({ completed: true, method: 'local', attempts: 0 });
    expect(outcome.state.tasks[0]?.status).toBe('done');
    expect(outcome.state.lineages?.T001).toMatchObject({ attempts: 3, consultRecords: [] });
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(outcome.state.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
  });
});

describe('runHeldCorrection — aborted outcomes', () => {
  it('returns a failed result when the held correction is stopped during its attempt', async () => {
    const { projectDir, sessionId } = setupProject();
    const controller = new AbortController();
    let retryEntered: () => void = () => {};
    const retryEnteredPromise = new Promise<void>((resolve) => {
      retryEntered = resolve;
    });
    const retry = vi.fn().mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      retryEntered();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        success: false,
        output: '',
        error: ABORTED_OUTCOME_TEXT,
        usage: { inputTokens: 5, outputTokens: 5 },
      };
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const run = runHeldCorrection({
      ctx: makeHeldCtx({
        projectDir,
        sessionId,
        implementer,
        bus,
        signal: controller.signal,
      }),
      task: makeTask(),
      state: makeHeldState(),
      answer: 'Use the existing helper.',
    });

    await retryEnteredPromise;
    controller.abort();
    const outcome = await run;

    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 0 });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('runHeldCorrection — attempt that throws', () => {
  it('propagates the error of an attempt that throws', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockRejectedValue(new Error('implementer crashed'));
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    await expect(
      runHeldCorrection({
        ctx: makeHeldCtx({ projectDir, sessionId, implementer, bus }),
        task: makeTask(),
        state: makeHeldState(),
        answer: 'Use the existing helper.',
      }),
    ).rejects.toThrow('implementer crashed');
  });
});

describe('handleRetryAndEscalation — aborted implementer call', () => {
  it('does not escalate after an aborted implementer call', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn();
    const implementer = makeImplementer({ retry });
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: ABORTED_OUTCOME_TEXT,
      currentState: state,
    });

    expect(result).toEqual({ completed: false, method: 'failed', attempts: 0 });
    expect(retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'escalate')).toEqual([]);
  });
});

describe('runHeldCorrection — outcomes no further attempt can fix', () => {
  it('a timed-out held correction returns its outcome intact', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'implementer timed out',
      outcome: 'timeout',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runHeldCorrection({
      ctx: makeHeldCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeHeldState(),
      answer: 'Use the existing helper.',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('timeout');
    expect(outcome.result).toBeUndefined();
  });

  it.each([
    ['implementer-recipe-invalid', "error: unknown option '--nope'"],
    ['implementer-left-isolation', 'searched ~ with run_command: find ~ -name "app.ts"'],
    ['checkout-changed', 'branch escaped'],
    ['missing-model', 'model not found: gpt-nope'],
  ] as const)('%s stops the held correction without booking the attempt', async (kind, error) => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({ success: false, output: '', error, outcome: kind });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();
    const task = makeTask();

    const outcome = await runHeldCorrection({
      ctx: makeHeldCtx({ projectDir, sessionId, implementer, bus }),
      task,
      state: makeHeldState(task),
      answer: 'Use the existing helper.',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe(kind);
    expect(lineageAttemptsOf(outcome.state, task)).toBe(1);
  });

  it('a no-change held correction returns its failure intact', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: 'I could not find the prop.',
      error: 'agy exited without changing any files',
      outcome: 'no-staged-change',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runHeldCorrection({
      ctx: makeHeldCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeHeldState(),
      answer: 'Use the existing helper.',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeUndefined();
    expect(outcome.attempts).toBe(0);
    expect(outcome.lastError).toBe('agy exited without changing any files');
    expect(outcome.lastFailure).toMatchObject({
      outcome: 'no-staged-change',
      handBack: 'I could not find the prop.',
    });
  });
});

describe('handleRetryAndEscalation — cuts and timeouts in the consult loop', () => {
  function cutConfig(idleKillMs: number): Config {
    return makeNoValidationConfig({ implementer: { kind: 'cli', tool: 'opencode', idleKillMs } });
  }

  function cutResult(minutes: string) {
    return {
      success: false,
      output: '',
      error: `opencode sent no output for ${minutes}; SPLITBRIEF stopped it`,
      outcome: 'no-progress-cut',
    };
  }

  it('records the first attempt cut, then consults the planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: null });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) });
    const config = cutConfig(1_200_000);

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({ projectDir, sessionId, config, planner, implementer, bus }),
      task: makeTask(),
      initialError: 'opencode sent no output for 20:00; SPLITBRIEF stopped it',
      currentState: makeValidatingState(),
      initialFailure: { outcome: 'no-progress-cut', runner: config.implementer },
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0]?.[0]).toMatchObject({ kind: 'consult' });
    expect(events.filter((e) => e.type === 'no_progress_cut')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'task_escalating')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(1);
    expect(result).toMatchObject({ completed: true, method: 'consulted' });
  });

  it('records the cut of a consult-guided attempt and consults again', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi
      .fn()
      .mockResolvedValueOnce(cutResult('20:00'))
      .mockResolvedValueOnce({ success: true, output: 'fixed', usage: null });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: cutConfig(1_200_000),
        planner,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(retry).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'no_progress_cut')).toEqual([
      expect.objectContaining({
        type: 'no_progress_cut',
        taskId: 'T001',
        seat: 'build',
        silentMs: 1_200_000,
      }),
    ]);
    expect(result).toMatchObject({ completed: true, method: 'consulted' });
  });

  it("two consecutive cuts halt as repeated and record the runner's own idle limit", async () => {
    const { projectDir, sessionId } = setupProject();
    const config = cutConfig(600_000);
    const retry = vi.fn().mockResolvedValue(cutResult('10:00'));
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) });

    const { result, state } = await handleRetryAndEscalation({
      wctx: makeWctx({ projectDir, sessionId, config, planner, implementer, bus }),
      task: makeTask(),
      initialError: 'opencode sent no output for 10:00; SPLITBRIEF stopped it',
      currentState: makeValidatingState(),
      initialFailure: { outcome: 'no-progress-cut', runner: config.implementer },
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(false);
    expect(state.pendingRecovery).toMatchObject({ reason: 'runner-timeout-repeated' });
    expect(events.filter((e) => e.type === 'no_progress_cut')).toEqual([
      expect.objectContaining({ silentMs: 600_000 }),
      expect.objectContaining({ silentMs: 600_000 }),
    ]);
  });

  it('a cut followed by an ordinary failure resets the repeated count', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = cutConfig(600_000);
    const retry = vi
      .fn()
      .mockResolvedValueOnce({ success: false, output: '', error: 'still broken' })
      .mockResolvedValueOnce(cutResult('10:00'))
      .mockResolvedValueOnce({ success: true, output: 'fixed', usage: null });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();
    const planner = makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) });

    const { result, state } = await handleRetryAndEscalation({
      wctx: makeWctx({ projectDir, sessionId, config, planner, implementer, bus }),
      task: makeTask(),
      initialError: 'opencode sent no output for 10:00; SPLITBRIEF stopped it',
      currentState: makeValidatingState(),
      initialFailure: { outcome: 'no-progress-cut', runner: config.implementer },
    });

    expect(retry).toHaveBeenCalledTimes(3);
    expect(state.pendingRecovery).toBeUndefined();
    expect(result).toMatchObject({ completed: true, method: 'consulted' });
  });
});

import { plainUserMessage } from '../../../core/types/user-input.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { briefCorrections, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import type { Implementer } from '../../implementers/types.js';
import { createSteeringPort } from '../../calls/steering.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { clearPendingQueue } from '../queue/clear.js';
import { CORRECTION_AFTER_CHECKS } from '../task/brief-gate.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { DEFAULT_LOCAL_RETRIES } from '../../../core/pipeline-spec/retries.js';
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
import { runLocalRetries } from './local-retries.js';
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
    prefix: 'local-retries-test',
    sessionId: 'sess-local-retries',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  return transition(makeImplState([task]), { type: 'TASK_SENT' });
}

function makeLocalRetriesCtx(opts: {
  projectDir: string;
  sessionId: string;
  implementer: ReturnType<typeof makeImplementer>;
  bus: ReturnType<typeof makeBusRecorder>['bus'];
  signal?: AbortSignal | undefined;
  config?: Config | undefined;
}): EscalationContext {
  return {
    taskStartTime: Date.now(),
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

describe('runLocalRetries — corrections during checks', () => {
  it('keeps steering attached through a local retry and its correction pass', async () => {
    const ref = setupProject();
    const task = makeTask();
    const state = makeValidatingState();
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

    const outcome = await runLocalRetries({
      ctx: {
        ...makeLocalRetriesCtx({ ...ref, implementer: makeImplementer({ retry, implement }), bus }),
        steering,
        taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      },
      task,
      state,
      lastError: 'failed check',
      lastDiagnosis: 'failed check',
    });

    expect(outcome.result).toMatchObject({ completed: true, method: 'local' });
    expect(received).toEqual(['keep the alias', 'keep the type too']);
    expect(steering.current()).toBeNull();
    expect(briefCorrections(outcome.state, task.id)).toEqual([
      expect.stringContaining('keep the export too'),
    ]);
  });

  it('delivers a second message queued during correction profile preparation without spending another rung', async () => {
    const ref = setupProject();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = transition(transition(makeImplState([task]), { type: 'TASK_SENT' }), {
      type: 'COUNT_ATTEMPT',
      taskId: task.id,
    });
    const { bus, events } = makeBusRecorder();
    const retry = vi.fn<Implementer['retry']>(async () => ({ success: true, output: 'fixed' }));
    const implementer = makeImplementer({ retry });
    const createImplementer = vi.fn(async () => {
      await Promise.resolve();
      if (retry.mock.calls.length === 1) {
        const current = loadState(ref);
        if (current === null) throw new Error('missing state during profile preparation');
        enqueueUserMessage({
          ...ref,
          state: current,
          message: plainUserMessage('also keep the export'),
          phase: current.phase,
          bus,
        });
      }
      return implementer;
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
        });
      }
      return { stdout: 'ok', stderr: '', code: 0 };
    });

    const outcome = await runLocalRetries({
      ctx: {
        ...makeLocalRetriesCtx({
          ...ref,
          implementer,
          bus,
          config: makeNoValidationConfig({
            workflow: { review: 'task' },
            implementerProfiles: {
              default: 'correction',
              profiles: { correction: { kind: 'cli', tool: 'codex' } },
            },
          }),
        }),
        createImplementer,
        retryProfileOverride: 'correction',
        taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      },
      task,
      state,
      lastError: 'check K1 failed',
      lastDiagnosis: 'check K1 failed',
    });

    expect(createImplementer).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledTimes(2);
    const correctionCall = retry.mock.calls[1]?.[0];
    expect(retry.mock.calls[0]?.[0].allowNoChange).toBe(false);
    expect(correctionCall).toMatchObject({
      error: CORRECTION_AFTER_CHECKS,
      attempt: 1,
      allowNoChange: true,
    });
    expect(correctionCall?.continuation?.steer).toContain('keep the alias');
    expect(correctionCall?.continuation?.steer).toContain('also keep the export');
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(outcome.result).toMatchObject({ completed: true, method: 'local', attempts: 1 });
    expect(outcome.state.tasks[0]?.status).toBe('done');
    expect(outcome.state.lineages?.T001).toMatchObject({
      attempts: 3,
      attemptAllowance: 8,
      consults: 0,
    });
    expect(events.filter((event) => event.type === 'task_retry')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ count: 2, seat: 'build', taskId: 'T001' }),
    ]);
    expect(loadState(ref)).toMatchObject({
      implementerTool: 'codex',
      messageQueue: [
        expect.objectContaining({ deliveredTo: { implementer: expect.any(String) } }),
        expect.objectContaining({ deliveredTo: { implementer: expect.any(String) } }),
      ],
    });
  });

  it('completes the retry without an answer attempt when its correction is cleared after recorded checks', async () => {
    const ref = setupProject();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = transition(transition(makeImplState([task]), { type: 'TASK_SENT' }), {
      type: 'COUNT_ATTEMPT',
      taskId: task.id,
    });
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
      });
      return { stdout: 'ok', stderr: '', code: 0 };
    });

    const outcome = await runLocalRetries({
      ctx: {
        ...makeLocalRetriesCtx({
          ...ref,
          implementer: makeImplementer({ retry }),
          bus,
          config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        }),
        taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      },
      task,
      state,
      lastError: 'check K1 failed',
      lastDiagnosis: 'check K1 failed',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({ completed: true, method: 'local', attempts: 1 });
    expect(outcome.state.tasks[0]?.status).toBe('done');
    expect(outcome.state.currentTaskIndex).toBe(1);
    expect(outcome.state.lineages?.T001).toMatchObject({
      attempts: 2,
      attemptAllowance: 8,
      consults: 0,
    });
    expect(briefCorrections(outcome.state, task.id)).toEqual([]);
    expect(outcome.state.messageQueue).toEqual([]);
    expect(loadState(ref)?.messageQueue).toEqual([]);
    expect(events.filter((event) => event.type === 'task_retry')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([]);
  });

  it('runs one more answer attempt after green retry checks receive a message', async () => {
    const ref = setupProject();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = transition(transition(makeImplState([task]), { type: 'TASK_SENT' }), {
      type: 'COUNT_ATTEMPT',
      taskId: task.id,
    });
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
        });
      }
      return { stdout: 'ok', stderr: '', code: 0 };
    });

    const outcome = await runLocalRetries({
      ctx: {
        ...makeLocalRetriesCtx({
          ...ref,
          implementer: makeImplementer({ retry }),
          bus,
          config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        }),
        taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      },
      task,
      state,
      lastError: 'check K1 failed',
      lastDiagnosis: 'check K1 failed',
    });

    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry.mock.calls[1]?.[0]).toMatchObject({ error: CORRECTION_AFTER_CHECKS, attempt: 1 });
    expect(retry.mock.calls[1]?.[0].continuation?.steer).toContain('keep the alias');
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(outcome.result).toMatchObject({ completed: true, method: 'local', attempts: 1 });
    expect(outcome.state.tasks[0]?.status).toBe('done');
    expect(outcome.state.lineages?.T001).toMatchObject({
      attempts: 3,
      attemptAllowance: 8,
      consults: 0,
    });
    expect(events.filter((event) => event.type === 'task_retry')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(outcome.state.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
  });
});

describe('runLocalRetries — aborted outcomes', () => {
  it('consumes zero retries when the initial implementer call was aborted', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn();
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: ABORTED_OUTCOME_TEXT,
      lastDiagnosis: ABORTED_OUTCOME_TEXT,
    });

    expect(outcome.attempts).toBe(0);
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 0 });
    expect(retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
  });

  it('announces the aborted attempt on a retry row and keeps its persisted attempt for the stopped retry', async () => {
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
    const { bus, events } = makeBusRecorder();

    const run = runLocalRetries({
      ctx: makeLocalRetriesCtx({
        projectDir,
        sessionId,
        implementer,
        bus,
        signal: controller.signal,
      }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    await retryEnteredPromise;
    controller.abort();
    const outcome = await run;

    // The aborted attempt is the stopped retry a continuation re-enters at the
    // same attempt (docs/WORKFLOW.md), so its persisted counter is not rolled back.
    expect(outcome.attempts).toBe(1);
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
    expect(retry).toHaveBeenCalledTimes(1);
    const retryAttempts = events
      .filter((e) => e.type === 'task_retry')
      .map((e) => (e.type === 'task_retry' ? e.attempt : -1));
    expect(retryAttempts).toEqual([1]);
    expect(loadState({ projectDir, sessionId })?.attempt).toBe(1);
  });

  it('the retry row precedes the attempt it announces', async () => {
    const { projectDir, sessionId } = setupProject();
    const order: string[] = [];
    const retry = vi.fn().mockImplementation(async () => {
      order.push('call');
      return { success: false, output: '', error: 'still broken' };
    });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();
    bus.subscribe((event) => {
      if (event.type === 'task_retry') order.push(`row ${event.attempt}`);
    });

    await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    expect(order).toEqual(['row 1', 'call']);
    const firstRow = events.find((e) => e.type === 'task_retry');
    expect(firstRow?.type === 'task_retry' && firstRow.error).toBe('type error');
    expect(firstRow).toMatchObject({ lineageAttempt: 1, attemptAllowance: 8 });
  });

  it('ordinary failures still consume exactly the local retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'still broken',
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    expect(outcome.attempts).toBe(DEFAULT_LOCAL_RETRIES);
    expect(outcome.result).toBeUndefined();
    expect(retry).toHaveBeenCalledTimes(DEFAULT_LOCAL_RETRIES);
    const retryAttempts = events
      .filter((e) => e.type === 'task_retry')
      .map((e) => (e.type === 'task_retry' ? e.attempt : -1));
    expect(retryAttempts).toEqual([1]);
    expect(loadState({ projectDir, sessionId })?.attempt).toBe(DEFAULT_LOCAL_RETRIES);
  });
});

describe('runLocalRetries — attempt that throws', () => {
  it('publishes the retry row for the attempt the persisted counter already charged', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockRejectedValue(new Error('implementer crashed'));
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();

    await expect(
      runLocalRetries({
        ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
        task: makeTask(),
        state: makeValidatingState(),
        lastError: 'type error',
        lastDiagnosis: 'type error',
      }),
    ).rejects.toThrow('implementer crashed');

    const retryAttempts = events
      .filter((e) => e.type === 'task_retry')
      .map((e) => (e.type === 'task_retry' ? e.attempt : -1));
    expect({
      rows: retryAttempts,
      persisted: loadState({ projectDir, sessionId })?.attempt,
    }).toEqual({ rows: [1], persisted: 1 });
  });
});

describe('handleRetryAndEscalation — aborted implementer call', () => {
  it('does not escalate after an aborted implementer call', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn();
    const implementer = makeImplementer({ retry });
    const escalateFull = vi.fn();
    const planner = makePlanner({ escalateFull });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const { result } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
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
    expect(escalateFull).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'escalate')).toEqual([]);
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
  });
});

describe('runLocalRetries — outcomes no further attempt can fix', () => {
  it('a timeout ends the single local retry with its outcome intact', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'implementer timed out',
      outcome: 'timeout',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('timeout');
    expect(outcome.result).toBeUndefined();
  });

  it('an attempt before the retry that timed out and a timed-out retry halt as repeated', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'implementer timed out',
      outcome: 'timeout',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();
    const ctx = makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus });

    const outcome = await runLocalRetries({
      ctx,
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'implementer timed out',
      lastDiagnosis: 'implementer timed out',
      initialFailure: { outcome: 'timeout', runner: ctx.config.implementer },
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('runner-timeout-repeated');
    expect(outcome.result).toBeUndefined();
  });

  it('implementer-recipe-invalid does not consume a retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: "error: unknown option '--nope'",
      outcome: 'implementer-recipe-invalid',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    // The local rung stops here; no further retry is spent.
    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('implementer-recipe-invalid');
  });

  it('an initial input-too-large failure halts without a retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn();
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();
    const ctx = makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus });

    const outcome = await runLocalRetries({
      ctx,
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'Input exceeds the maximum length of 1048576 characters.',
      lastDiagnosis: 'Input exceeds the maximum length of 1048576 characters.',
      initialFailure: { outcome: 'input-too-large', runner: ctx.config.implementer },
    });

    expect(retry).not.toHaveBeenCalled();
    expect(outcome.attempts).toBe(0);
    expect(outcome.lastFailure?.outcome).toBe('input-too-large');
  });

  it('an implementer that left its isolation directory spends no further retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'searched ~ with run_command: find ~ -name "app.ts"',
      outcome: 'implementer-left-isolation',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('implementer-left-isolation');
  });

  it('a checkout whose git state changed during the attempt spends no further retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'branch escaped',
      outcome: 'checkout-changed',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('checkout-changed');
  });

  it('a no-change attempt after feedback ends the local rung with its failure intact', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: 'I could not find the prop.',
      error: 'agy exited without changing any files',
      outcome: 'no-staged-change',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeUndefined();
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toBe('agy exited without changing any files');
    expect(outcome.lastFailure).toMatchObject({
      outcome: 'no-staged-change',
      handBack: 'I could not find the prop.',
    });
  });

  it('a no-progress cut spends the ordinary retry and records the cut in the session log', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = makeNoValidationConfig({
      implementer: { kind: 'cli', tool: 'opencode', idleKillMs: 1_200_000 },
    });
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'opencode sent no output for 20:00; SPLITBRIEF stopped it',
      outcome: 'no-progress-cut',
    });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus, config }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(DEFAULT_LOCAL_RETRIES);
    expect(outcome.result).toBeUndefined();
    expect(outcome.lastFailure?.outcome).toBe('no-progress-cut');
    expect(events.filter((e) => e.type === 'task_retry')).toHaveLength(DEFAULT_LOCAL_RETRIES);
    expect(events.filter((e) => e.type === 'no_progress_cut')).toEqual([
      expect.objectContaining({
        type: 'no_progress_cut',
        taskId: 'T001',
        seat: 'build',
        silentMs: 1_200_000,
      }),
    ]);
  });

  it("two consecutive cuts halt as repeated and record the runner's own idle limit", async () => {
    const { projectDir, sessionId } = setupProject();
    const config = makeNoValidationConfig({
      implementer: { kind: 'cli', tool: 'opencode', idleKillMs: 600_000 },
    });
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'opencode sent no output for 10:00; SPLITBRIEF stopped it',
      outcome: 'no-progress-cut',
    });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus, config }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
      initialFailure: { outcome: 'no-progress-cut', runner: config.implementer },
    });

    expect(retry).toHaveBeenCalledTimes(DEFAULT_LOCAL_RETRIES);
    expect(outcome.lastFailure?.outcome).toBe('runner-timeout-repeated');
    expect(outcome.result).toBeUndefined();
    expect(events.filter((e) => e.type === 'no_progress_cut')).toEqual([
      expect.objectContaining({ silentMs: 600_000 }),
      expect.objectContaining({ silentMs: 600_000 }),
    ]);
  });

  it('a cut followed by an ordinary failure resets the repeated count', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = makeNoValidationConfig({
      implementer: { kind: 'cli', tool: 'opencode', idleKillMs: 600_000 },
    });
    const cut = 'opencode sent no output for 10:00; SPLITBRIEF stopped it';
    // The answer attempt spends no retry, so the ordinary failure sits between
    // the initial cut and the retry's cut; only the reset keeps them apart.
    const retry = vi
      .fn()
      .mockResolvedValueOnce({ success: false, output: '', error: 'still broken' })
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: cut,
        outcome: 'no-progress-cut',
      });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus, config }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: cut,
      lastDiagnosis: cut,
      initialFailure: { outcome: 'no-progress-cut', runner: config.implementer },
      answer: 'use the existing helper',
    });

    expect(retry).toHaveBeenCalledTimes(2);
    expect(outcome.lastFailure?.outcome).toBe('no-progress-cut');
    expect(outcome.lastError).toBe(cut);
  });

  it('records the first attempt cut, retries once, then consults the planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi
      .fn()
      .mockResolvedValueOnce({ success: false, output: '', error: 'still broken' })
      .mockResolvedValueOnce({ success: true, output: 'fixed', usage: null });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) });
    const config = makeNoValidationConfig({
      implementer: { kind: 'cli', tool: 'opencode', idleKillMs: 1_200_000 },
    });

    const { result } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        planner,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'opencode sent no output for 20:00; SPLITBRIEF stopped it',
      currentState: makeValidatingState(),
      initialFailure: { outcome: 'no-progress-cut', runner: config.implementer },
    });

    expect(retry).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'no_progress_cut')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'task_escalating')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(1);
    expect(result).toMatchObject({ completed: true, method: 'consulted' });
  });

  it('missing-model stops the local retries', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'model not found: gpt-nope',
      outcome: 'missing-model',
    });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      lastDiagnosis: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('missing-model');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { TIMEOUTS } from '../../../core/pipeline-spec/timeouts.js';
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
import { runLocalRetries } from './local-retries.js';
import { handleRetryAndEscalation } from './handle.js';
import type { EscalationContext } from './types.js';

let dirs: string[] = [];
afterEach(() => {
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

const defaultWorkflow = { maxRetries: 3 as const };

function makeLocalRetriesCtx(opts: {
  projectDir: string;
  sessionId: string;
  implementer: ReturnType<typeof makeImplementer>;
  bus: ReturnType<typeof makeBusRecorder>['bus'];
  signal?: AbortSignal | undefined;
  maxRetries?: number | undefined;
}): EscalationContext {
  return {
    ...makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      config: makeNoValidationConfig({
        workflow: { maxRetries: opts.maxRetries ?? defaultWorkflow.maxRetries },
      }),
      planner: makePlanner(),
      implementer: opts.implementer,
      bus: opts.bus,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    }),
    taskStartSnapshot: { head: '', files: [], dirtyFileContents: {} },
    dependsOnFiles: [],
  };
}

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
    });

    expect(outcome.attempts).toBe(0);
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 0 });
    expect(retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
  });

  it('announces the aborted attempt on a retry row but rolls its persisted attempt back', async () => {
    const { projectDir, sessionId } = setupProject();
    const controller = new AbortController();
    let secondRetryEntered: () => void = () => {};
    const secondRetryEnteredPromise = new Promise<void>((resolve) => {
      secondRetryEntered = resolve;
    });
    const retry = vi
      .fn()
      .mockImplementationOnce(async () => ({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 5 },
      }))
      .mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
        secondRetryEntered();
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
    });

    await secondRetryEnteredPromise;
    controller.abort();
    const outcome = await run;

    expect(outcome.attempts).toBe(1);
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
    expect(retry).toHaveBeenCalledTimes(2);
    const retryAttempts = events
      .filter((e) => e.type === 'task_retry')
      .map((e) => (e.type === 'task_retry' ? e.attempt : -1));
    expect(retryAttempts).toEqual([1, 2]);
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
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus, maxRetries: 2 }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
    });

    expect(order).toEqual(['row 1', 'call', 'row 2', 'call']);
    const firstRow = events.find((e) => e.type === 'task_retry');
    expect(firstRow?.type === 'task_retry' && firstRow.error).toBe('type error');
  });

  it('ordinary failures still consume exactly maxRetries retries', async () => {
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
    });

    expect(outcome.attempts).toBe(3);
    expect(outcome.result).toBeUndefined();
    expect(retry).toHaveBeenCalledTimes(3);
    const retryAttempts = events
      .filter((e) => e.type === 'task_retry')
      .map((e) => (e.type === 'task_retry' ? e.attempt : -1));
    expect(retryAttempts).toEqual([1, 2, 3]);
    expect(loadState({ projectDir, sessionId })?.attempt).toBe(3);
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
    const escalateHint = vi.fn();
    const escalateFull = vi.fn();
    const planner = makePlanner({ escalateHint, escalateFull });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
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
    expect(escalateHint).not.toHaveBeenCalled();
    expect(escalateFull).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'escalate')).toEqual([]);
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
  });
});

describe('runLocalRetries — outcomes no further attempt can fix', () => {
  it('two consecutive timeouts halt', async () => {
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
    });

    expect(retry).toHaveBeenCalledTimes(TIMEOUTS.consecutiveTimeoutsHalt);
    expect(outcome.lastFailure?.outcome).toBe('runner-timeout-repeated');
    expect(outcome.result).toBeUndefined();
  });

  it('a timeout followed by an ordinary failure resets the consecutive counter', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'implementer timed out',
        outcome: 'timeout',
      })
      .mockResolvedValue({ success: false, output: '', error: 'still broken' });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(3);
    expect(outcome.lastFailure?.outcome).toBeUndefined();
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
    });

    // The remaining two of the three configured retries are left unspent.
    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('implementer-recipe-invalid');
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
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus, maxRetries: 2 }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeUndefined();
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toBe('type error');
    expect(outcome.lastFailure).toMatchObject({
      outcome: 'no-staged-change',
      handBack: 'I could not find the prop.',
    });
  });

  it('ordinary failures still spend every local retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus, maxRetries: 2 }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(2);
    expect(outcome.attempts).toBe(2);
  });

  it('a timeout followed by a no-change attempt ends on the no-change outcome', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'implementer timed out',
        outcome: 'timeout',
      })
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'exited without changing any files',
        outcome: 'no-staged-change',
      });
    const implementer = makeImplementer({ retry });
    const { bus } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
    });

    expect(retry).toHaveBeenCalledTimes(2);
    expect(outcome.lastFailure?.outcome).toBe('no-staged-change');
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
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('missing-model');
  });
});

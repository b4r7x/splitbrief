import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
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
    });

    expect(order).toEqual(['row 1', 'call']);
    const firstRow = events.find((e) => e.type === 'task_retry');
    expect(firstRow?.type === 'task_retry' && firstRow.error).toBe('type error');
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
    });

    // The local rung stops here; no further retry is spent.
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
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
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

  it('a no-progress cut spends the ordinary retry and records the cut in the session log', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'opencode produced no output for 1200s and was terminated',
      outcome: 'no-progress-cut',
    });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
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
        silentMs: BOUNDS.noProgressCutMs,
      }),
    ]);
  });

  it("records the failing runner's own idle limit when it is not the default", async () => {
    const { projectDir, sessionId } = setupProject();
    const config = makeNoValidationConfig({
      implementer: { kind: 'cli', tool: 'opencode', idleKillMs: 600_000 },
    });
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'opencode produced no output for 600s and was terminated',
      outcome: 'no-progress-cut',
    });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();

    const outcome = await runLocalRetries({
      ctx: makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus, config }),
      task: makeTask(),
      state: makeValidatingState(),
      lastError: 'type error',
      initialFailure: { outcome: 'no-progress-cut', runner: config.implementer },
    });

    expect(retry).toHaveBeenCalledTimes(DEFAULT_LOCAL_RETRIES);
    expect(outcome.lastFailure?.outcome).toBe('no-progress-cut');
    expect(events.filter((e) => e.type === 'no_progress_cut')).toEqual([
      expect.objectContaining({ silentMs: 600_000 }),
      expect.objectContaining({ silentMs: 600_000 }),
    ]);
  });

  it('records the first attempt cut, retries once, then consults the planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const retry = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'opencode produced no output for 1200s and was terminated',
        outcome: 'no-progress-cut',
      })
      .mockResolvedValueOnce({ success: true, output: 'fixed', usage: null });
    const implementer = makeImplementer({ retry });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'opencode produced no output for 1200s and was terminated',
      currentState: makeValidatingState(),
      initialFailure: { outcome: 'no-progress-cut', runner: makeNoValidationConfig().implementer },
    });

    expect(retry).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'no_progress_cut')).toHaveLength(2);
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
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.lastFailure?.outcome).toBe('missing-model');
  });
});

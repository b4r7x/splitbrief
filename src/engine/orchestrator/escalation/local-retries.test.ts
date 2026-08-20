import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
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
}): EscalationContext {
  return {
    ...makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      config: makeNoValidationConfig({ workflow: defaultWorkflow }),
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

    const outcome = await runLocalRetries(
      makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      makeTask(),
      makeValidatingState(),
      ABORTED_OUTCOME_TEXT,
    );

    expect(outcome.attempts).toBe(0);
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 0 });
    expect(retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
  });

  it('charges neither the persisted attempt nor a retry row to an attempt the workflow aborted', async () => {
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

    const run = runLocalRetries(
      makeLocalRetriesCtx({
        projectDir,
        sessionId,
        implementer,
        bus,
        signal: controller.signal,
      }),
      makeTask(),
      makeValidatingState(),
      'type error',
    );

    await secondRetryEnteredPromise;
    controller.abort();
    const outcome = await run;

    expect(outcome.attempts).toBe(1);
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
    expect(retry).toHaveBeenCalledTimes(2);
    const retryAttempts = events
      .filter((e) => e.type === 'task_retry')
      .map((e) => (e.type === 'task_retry' ? e.attempt : -1));
    expect(retryAttempts).toEqual([1]);
    expect(loadState({ projectDir, sessionId })?.attempt).toBe(1);
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

    const outcome = await runLocalRetries(
      makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
      makeTask(),
      makeValidatingState(),
      'type error',
    );

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
      runLocalRetries(
        makeLocalRetriesCtx({ projectDir, sessionId, implementer, bus }),
        makeTask(),
        makeValidatingState(),
        'type error',
      ),
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

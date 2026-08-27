import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../src/core/state/machine.js';
import { ensureSessionDir, writeSpecFile } from '../../../src/core/paths-io.js';
import { PLAN_FILE, SPEC_FILE } from '../../../src/core/paths.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import {
  withContinuationLoop,
  type ContinuationLoopCtx,
} from '../../../src/engine/orchestrator/continuation.js';
import { regenerateTasks } from '../../../src/engine/orchestrator/planning/regen.js';
import type { WorkflowSinks } from '../../../src/engine/orchestrator/types.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { processError } from '../../../src/lib/process/errors.js';

type TestSinks = WorkflowSinks & { trigger: () => boolean };

function makeSinks(): TestSinks {
  let abortHandler: (() => void) | null = null;
  return {
    setAbortHandler: (handler) => {
      abortHandler = handler;
    },
    setQueueHandler: () => {},
    trigger: () => {
      if (abortHandler === null) return false;
      abortHandler();
      return true;
    },
  };
}

function recoveryContext(
  projectDir: string,
  sessionId: string,
  sinks: WorkflowSinks,
  callbacks: ReturnType<typeof makeCallbacks>['callbacks'],
  operationId: string,
): ContinuationLoopCtx {
  return {
    projectDir,
    sessionId,
    callbacks,
    bus: createEventBus(),
    sinks,
    briefRecovery: true,
    operationId,
    noAutomaticContinuation: true,
  };
}

let tempDirs: string[] = [];

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('recovery-continuation-test');
  tempDirs.push(projectDir);
  const sessionId = 'recovery-continuation';
  ensureSessionDir(projectDir, sessionId);
  writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n', TEST_METADATA);
  writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n', TEST_METADATA);
  return { projectDir, sessionId };
}

afterEach(() => {
  for (const dir of tempDirs) cleanupTempDir(dir);
  tempDirs = [];
});

describe('recovery continuation fence', () => {
  it.each([
    ['an untyped throw', () => new Error('aborted')],
    ['idle timeout', () => processError.idleTimeout({ command: 'fixture', idleMs: 1 })],
    ['hard timeout', () => processError.timeout({ command: 'fixture', timeoutMs: 1, output: '' })],
    [
      'non-zero exit',
      () => processError.exitCode({ command: 'fixture', code: 137, stderr: 'process died' }),
    ],
  ])('does not retry the same operation after %s following dispatch', async (_label, failure) => {
    const { projectDir, sessionId } = setupProject();
    const sinks = makeSinks();
    const onContinuationNeeded = vi.fn().mockResolvedValue('retry');
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    let calls = 0;

    await expect(
      withContinuationLoop({
        ctx: recoveryContext(projectDir, sessionId, sinks, callbacks, 'operation-1'),
        state: createInitialState('feature'),
        body: async ({ signal }) => {
          calls += 1;
          expect(sinks.trigger()).toBe(true);
          expect(signal.aborted).toBe(true);
          throw failure();
        },
      }),
    ).rejects.toThrow();

    expect(calls).toBe(1);
    expect(onContinuationNeeded).not.toHaveBeenCalled();
  });

  it('returns a pre-dispatch definite result without prompting for continuation', async () => {
    const { projectDir, sessionId } = setupProject();
    const controller = new AbortController();
    controller.abort(new Error('cancelled before dispatch'));
    const sinks = makeSinks();
    const onContinuationNeeded = vi.fn().mockResolvedValue('retry');
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    let calls = 0;

    const result = await withContinuationLoop({
      ctx: {
        ...recoveryContext(projectDir, sessionId, sinks, callbacks, 'operation-1'),
        signal: controller.signal,
      },
      state: createInitialState('feature'),
      body: async ({ signal }) => {
        calls += 1;
        return { kind: signal.aborted ? 'definite-failure' : 'completed' };
      },
    });

    expect(result.value).toEqual({ kind: 'definite-failure' });
    expect(calls).toBe(1);
    expect(onContinuationNeeded).not.toHaveBeenCalled();
  });

  it('allows a later explicit operation to use ordinary continuation', async () => {
    const { projectDir, sessionId } = setupProject();
    const sinks = makeSinks();
    const onContinuationNeeded = vi.fn().mockResolvedValue('continue operation-2');
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    let calls = 0;

    const result = await withContinuationLoop({
      ctx: { projectDir, sessionId, callbacks, bus: createEventBus(), sinks },
      state: createInitialState('feature'),
      body: async ({ signal }) => {
        calls += 1;
        if (calls === 1) {
          sinks.trigger();
          if (signal.aborted) throw new Error('operation-2 interrupted');
        }
        return 'completed-operation-2';
      },
    });

    expect(result.value).toBe('completed-operation-2');
    expect(calls).toBe(2);
    expect(onContinuationNeeded).toHaveBeenCalledTimes(1);
  });

  it('routes recovery regeneration through the one-shot provider option', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner();
    const dispatch = vi.fn().mockResolvedValue({
      kind: 'completed',
      requestId: 'request-1',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      text: REAL_TASKS_MD,
      providerCode: null,
      usage: null,
    });

    const result = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus: createEventBus(),
      state: createInitialState('feature'),
      metadata: TEST_METADATA,
      briefRecovery: {
        epochId: 'epoch-1',
        operationId: 'operation-1',
        requestId: 'request-1',
        provider: { dispatch },
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(planner.review).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        epochId: 'epoch-1',
        operationId: 'operation-1',
        requestId: 'request-1',
      }),
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makePlanner,
  makeBusRecorder,
  makeCallbacks,
} from '#testing/helpers/orchestrator-factories.js';
import { createTestSinks } from '#testing/helpers/planning-phase.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { PlannerCallbacks } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { HEARTBEAT_THRESHOLD_MS } from './heartbeat.js';
import { HEARTBEAT_INTERVAL_MS } from '../../constants.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import type { PlannerCallbacksContext } from '../types.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('shared-planning-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-shared-test';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function planningState() {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START' });
  return state;
}

function makeWctx(
  projectDir: string,
  sessionId: string,
  overrides?: Partial<PlannerCallbacksContext>,
): PlannerCallbacksContext {
  const { bus } = makeBusRecorder();
  const config = makeConfig({
    workflow: { mode: 'quick', persistTranscript: false },
  });
  return {
    projectDir,
    sessionId,
    config,
    callbacks: {
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
      onComplete: vi.fn(),
    },
    bus,
    metadata: { plannerTool: 'test', implementerTool: 'test', mode: 'quick' },
    sinks: {
      setAbortHandler: vi.fn(),
      setQueueHandler: vi.fn(),
    },
    ...overrides,
  };
}

describe('runPlannerCallInContinuationLoop — heartbeat cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops heartbeat timers even when the planner throws', async () => {
    const { projectDir, sessionId } = setupSession();
    const planner = makePlanner({
      plan: vi.fn().mockRejectedValue(new Error('planner crashed')),
      quickPlan: vi.fn().mockRejectedValue(new Error('planner crashed')),
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, { bus });

    const caught = runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    }).catch((err: Error) => err);

    await vi.advanceTimersByTimeAsync(0);
    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('planner crashed');

    const heartbeatsAfterError = events.filter((e) => e.type === 'planner_heartbeat').length;

    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS + HEARTBEAT_INTERVAL_MS * 3);

    const heartbeatsAfterDelay = events.filter((e) => e.type === 'planner_heartbeat').length;
    expect(heartbeatsAfterDelay).toBe(heartbeatsAfterError);
  });

  it('tags heartbeat events with the active planner runner call id', async () => {
    const { projectDir, sessionId } = setupSession();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      quickPlan: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callbacks.onCallEvent?.({
            type: 'call_started',
            ts: Date.now(),
            callId: 'planner-call-1',
            role: 'planner',
            backendKind: 'cli',
          });
          await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_THRESHOLD_MS));
          return {
            spec: '',
            plan: '',
            tasks: [makeTask()],
            usage: null,
          };
        }),
    });
    const wctx = makeWctx(projectDir, sessionId, { bus });

    const run = runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_THRESHOLD_MS);
    await run;

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'planner_heartbeat',
        callId: 'planner-call-1',
      }),
    );
  });
});

describe('runPlannerCallInContinuationLoop — signal propagation', () => {
  it('aborts the in-flight planner call when the turn is aborted', async () => {
    const { projectDir, sessionId } = setupSession();
    const sinks = createTestSinks();
    let capturedSignal: AbortSignal | undefined;
    let resolveActive: () => void = () => {};
    const active = new Promise<void>((resolve) => {
      resolveActive = resolve;
    });
    const planner = makePlanner({
      quickPlan: vi.fn().mockImplementation(({ callbacks }: { callbacks: PlannerCallbacks }) => {
        capturedSignal = callbacks.signal;
        resolveActive();
        return new Promise((_resolve, reject) => {
          const signal = callbacks.signal;
          if (!signal) {
            reject(new Error('expected planner abort signal'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new DOMException('The user aborted a request.', 'AbortError'));
          });
        });
      }),
    });
    const wctx = makeWctx(projectDir, sessionId, { sinks });

    const run = runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    await active;
    expect(sinks.abortTurn()).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('runPlannerCallInContinuationLoop — question markers', () => {
  it('publishes marker-free planner text', async () => {
    const { projectDir, sessionId } = setupSession();
    const planner = makePlanner({
      quickPlan: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callbacks.onOutput('before ');
          callbacks.onOutput('<!-- Q:{"id":"q1","type"');
          callbacks.onOutput(':"choice","text":"Pick","options":["a","b"]} -->');
          callbacks.onOutput(' after');
          return { spec: '', plan: '', tasks: [makeTask()], usage: null };
        }),
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, { bus });

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    const publishedText = events
      .filter((e) => e.type === 'planner_text')
      .map((e) => e.text)
      .join('');
    expect(publishedText).not.toContain('<!--');
    expect(publishedText).toContain('before');
    expect(publishedText).toContain('after');
  });

  it.each([
    { mode: 'quick' as const },
    { mode: 'speckit' as const },
  ])('collects questions for mode $mode via planner callback', async ({ mode }) => {
    const { projectDir, sessionId } = setupSession();
    const question: ClarificationQuestion = {
      id: 'q1',
      type: 'choice',
      text: 'Pick',
      options: ['a', 'b'],
    };
    const emitQuestions = vi
      .fn()
      .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onQuestion?.([question]);
        return { spec: '', plan: '', tasks: [makeTask()], usage: null };
      });
    const planner = makePlanner({
      plan: emitQuestions,
      quickPlan: emitQuestions,
    });
    const wctx = makeWctx(projectDir, sessionId);
    const collectedQuestions: ClarificationQuestion[] = [];

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode,
      collectedQuestions,
    });

    expect(collectedQuestions).toEqual([
      { id: 'q1', type: 'choice', text: 'Pick', options: ['a', 'b'] },
    ]);
  });

  it('records raw marker text for continuation while publishing stripped text', async () => {
    const { projectDir, sessionId } = setupSession();
    const marker = '<!-- Q:{"id":"q1","type":"input","text":"Name?"} -->';
    const sinks = createTestSinks();
    let callCount = 0;
    const planner = makePlanner({
      quickPlan: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callCount++;
          if (callCount === 1) {
            callbacks.onOutput(marker);
            sinks.abortTurn();
            throw new DOMException('The user aborted a request.', 'AbortError');
          }
          return { spec: '', plan: '', tasks: [makeTask()], usage: null };
        }),
    });
    const continuationPrompts: string[] = [];
    const wctx = makeWctx(projectDir, sessionId, {
      sinks,
      callbacks: makeCallbacks({
        onContinuationNeeded: async (partial: string) => {
          continuationPrompts.push(partial);
          return 'continue';
        },
      }).callbacks,
    });

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    expect(continuationPrompts).toEqual([marker]);
    expect(callCount).toBe(2);
  });
});

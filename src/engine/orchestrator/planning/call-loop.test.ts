import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import {
  capturePlanningMutationBaseline,
  findUnexpectedPlanningMutations,
} from './mutation-guard.js';
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

describe('planning mutation guard', () => {
  it('flags project mutations outside the active session directory', async () => {
    const projectDir = createTempDir('cli-planning-mutation-guard');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-shared-test';
    ensureSessionDir(projectDir, sessionId);

    const baseline = await capturePlanningMutationBaseline(projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'leak.ts'), 'export const leak = true;\n');

    const unexpected = await findUnexpectedPlanningMutations({
      projectDir,
      sessionId,
      baseline,
    });
    expect(unexpected).toContain('src/leak.ts');
  });
});

describe('runPlannerCallInContinuationLoop — signal propagation', () => {
  it('passes call-level abort signal to planner callbacks', async () => {
    const { projectDir, sessionId } = setupSession();
    let capturedCallbacks: PlannerCallbacks | undefined;
    const planner = makePlanner({
      quickPlan: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          capturedCallbacks = callbacks;
          return {
            spec: '',
            plan: '',
            tasks: [makeTask()],
            usage: null,
          };
        }),
    });
    const wctx = makeWctx(projectDir, sessionId);

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    expect(capturedCallbacks).toBeDefined();
    expect(capturedCallbacks!.signal).toBeDefined();
    expect(capturedCallbacks!.signal).toBeInstanceOf(AbortSignal);
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
    { mode: 'quick' as const, conversational: false },
    { mode: 'speckit' as const, conversational: false },
    { mode: 'speckit' as const, conversational: true },
  ])('collects questions for mode $mode with conversational=$conversational', async ({
    mode,
    conversational,
  }) => {
    const { projectDir, sessionId } = setupSession();
    const question: ClarificationQuestion = {
      id: 'q1',
      type: 'choice',
      text: 'Pick',
      options: ['a', 'b'],
    };
    const callFn = vi
      .fn()
      .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onQuestion?.([question]);
        return { spec: '', plan: '', tasks: [makeTask()], usage: null };
      });
    const planner = makePlanner({
      plan: callFn,
      quickPlan: callFn,
      capabilities: {
        supportsConversationalPlanning: conversational,
        supportsHintEscalation: true,
        supportsSessionResume: false,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
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
import { SANDBOX_DIR } from '../../../core/paths.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { PlannerCallbacks } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { HEARTBEAT_THRESHOLD_MS } from './heartbeat.js';
import { HEARTBEAT_INTERVAL_MS } from '../../constants.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../core/schemas/task-compilation.js';
import type { PhaseResult, PlannerArtifactLogicalName } from '../../planners/types.js';
import { sha256Hex } from '../../../utils/sha256.js';

let dirs: string[] = [];

function phaseResult(logicalName: PlannerArtifactLogicalName, text: string): PhaseResult {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: { status: 'completed', recordId: `test-${logicalName}`, protocolDigest: digest },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

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
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, {
      bus,
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'test',
        },
      }),
    });

    const caught = runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
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
      plan: vi.fn().mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
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
    const wctx = makeWctx(projectDir, sessionId, {
      bus,
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'test',
        },
      }),
    });

    const run = runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
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

  it('heartbeat accumulatedTokens is non-zero after a planner call reports usage', async () => {
    const { projectDir, sessionId } = setupSession();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      plan: vi.fn().mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onCallEvent?.({
          type: 'call_started',
          ts: Date.now(),
          callId: 'planner-call-1',
          role: 'planner',
          backendKind: 'cli',
        });
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_THRESHOLD_MS + 100));
        return {
          spec: '',
          plan: '',
          tasks: [makeTask()],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }),
    });
    const wctx = makeWctx(projectDir, sessionId, {
      bus,
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'test',
        },
      }),
    });

    const run = runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_THRESHOLD_MS);
    await vi.advanceTimersByTimeAsync(100);
    await run;

    const heartbeat = events.findLast(
      (e) => e.type === 'planner_heartbeat' && e.callId === 'planner-call-1',
    );
    expect(heartbeat).toBeDefined();
    if (heartbeat?.type === 'planner_heartbeat') {
      expect(heartbeat.accumulatedTokens).toBe(150);
    }
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
      plan: vi.fn().mockImplementation(({ callbacks }: { callbacks: PlannerCallbacks }) => {
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
    });

    await active;
    expect(sinks.abortTurn()).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('runPlannerCallInContinuationLoop — zero-task result', () => {
  it('makes one call and leaves the zero-task warning to the caller', async () => {
    const { projectDir, sessionId } = setupSession();
    const plan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [],
      usage: null,
      phases: [phaseResult('tasks.md', '# empty')],
    });
    const planner = makePlanner({ plan });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, { bus });

    const { result } = await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
    });

    expect(plan).toHaveBeenCalledTimes(1);
    expect(result.tasks).toHaveLength(0);
    expect(
      events.find(
        (e) => e.type === 'warning' && 'code' in e && e.code === 'planner_returned_zero_tasks',
      ),
    ).toBeUndefined();
  });
});

describe('runPlannerCallInContinuationLoop — runner auth', () => {
  it('runs a legacy CLI planner config on its descriptor default auth channel', async () => {
    const { projectDir, sessionId } = setupSession();
    const plan = vi
      .fn()
      .mockResolvedValue({ spec: '', plan: '', tasks: [makeTask()], usage: null });
    const planner = makePlanner({ plan });
    const current = makeConfig();
    const config = {
      ...current,
      planner: { kind: 'cli', tool: 'codex' },
    } as Config;
    const wctx = makeWctx(projectDir, sessionId, { config });

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
    });

    expect(plan).toHaveBeenCalled();
    // The default channel is the non-bridging one, so no host login state is
    // copied into the sandbox for a configuration that selected nothing.
    expect(existsSync(join(projectDir, SANDBOX_DIR, 'home', '.codex'))).toBe(false);
  });
});

describe('runPlannerCallInContinuationLoop — question markers', () => {
  it('publishes marker-free planner text', async () => {
    const { projectDir, sessionId } = setupSession();
    const planner = makePlanner({
      plan: vi.fn().mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
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
    });

    const publishedText = events
      .filter((e) => e.type === 'planner_text')
      .map((e) => e.text)
      .join('');
    expect(publishedText).not.toContain('<!--');
    expect(publishedText).toContain('before');
    expect(publishedText).toContain('after');
  });

  it('collects questions via the planner callback', async () => {
    const { projectDir, sessionId } = setupSession();
    const question: ClarificationQuestion = {
      id: 'q1',
      type: 'choice',
      text: 'Pick',
      options: ['a', 'b'],
    };
    const planner = makePlanner({
      plan: vi.fn().mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onQuestion?.([question]);
        return { spec: '', plan: '', tasks: [makeTask()], usage: null };
      }),
    });
    const wctx = makeWctx(projectDir, sessionId);
    const collectedQuestions: ClarificationQuestion[] = [];

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      collectedQuestions,
    });

    expect(collectedQuestions).toEqual([
      { id: 'q1', type: 'choice', text: 'Pick', options: ['a', 'b'] },
    ]);
  });

  it('deduplicates IDs across callbacks before applying the question cap', async () => {
    const { projectDir, sessionId } = setupSession();
    const firstQuestion: ClarificationQuestion = {
      id: 'q1',
      type: 'input',
      text: 'First wording',
    };
    const duplicateQuestion: ClarificationQuestion = {
      id: 'q1',
      type: 'input',
      text: 'Later wording must not replace the first question',
    };
    const distinctQuestions: ClarificationQuestion[] = ['q2', 'q3', 'q4', 'q5', 'q6'].map((id) => ({
      id,
      type: 'input',
      text: id,
    }));
    const planner = makePlanner({
      plan: vi.fn().mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onQuestion?.([firstQuestion, firstQuestion]);
        callbacks.onQuestion?.([duplicateQuestion, ...distinctQuestions]);
        return { spec: '', plan: '', tasks: [makeTask()], usage: null };
      }),
    });
    const wctx = makeWctx(projectDir, sessionId);
    const collectedQuestions: ClarificationQuestion[] = [];

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      collectedQuestions,
    });

    expect(collectedQuestions).toEqual([firstQuestion, ...distinctQuestions.slice(0, 4)]);
  });

  it('records raw marker text for continuation while publishing stripped text', async () => {
    const { projectDir, sessionId } = setupSession();
    const marker = '<!-- Q:{"id":"q1","type":"input","text":"Name?"} -->';
    const sinks = createTestSinks();
    let callCount = 0;
    const planner = makePlanner({
      plan: vi.fn().mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
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
    });

    expect(continuationPrompts).toEqual([marker]);
    expect(callCount).toBe(2);
  });

  it('releases held planner text when the planner call throws', async () => {
    const { projectDir, sessionId } = setupSession();
    const planner = makePlanner({
      plan: vi.fn().mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onOutput('Findings so far. <!-- Q:{"id":"q1","text":"Which file');
        throw new Error('planner crashed');
      }),
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, { bus });

    await expect(
      runPlannerCallInContinuationLoop({
        wctx,
        state: planningState(),
        planner,
        feature: 'test feature',
      }),
    ).rejects.toThrow('planner crashed');

    const publishedText = events
      .filter((e) => e.type === 'planner_text')
      .map((e) => e.text)
      .join('');
    expect(publishedText).toContain('Findings so far.');
    expect(publishedText).toContain('Which file');
  });

  it('releases held planner text when the turn is interrupted', async () => {
    const { projectDir, sessionId } = setupSession();
    const sinks = createTestSinks();
    let callCount = 0;
    const planner = makePlanner({
      plan: vi.fn().mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callCount++;
        if (callCount === 1) {
          callbacks.onOutput('Partial findings. <!-- Q:{"id":"q1","text":"Which file');
          sinks.abortTurn();
          throw new DOMException('The user aborted a request.', 'AbortError');
        }
        return { spec: '', plan: '', tasks: [makeTask()], usage: null };
      }),
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, {
      bus,
      sinks,
      callbacks: makeCallbacks({ onContinuationNeeded: async () => 'continue' }).callbacks,
    });

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
    });

    const publishedText = events
      .filter((e) => e.type === 'planner_text')
      .map((e) => e.text)
      .join('');
    expect(publishedText).toContain('Partial findings.');
    expect(publishedText).toContain('Which file');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makePlanner,
  makeBusRecorder,
  makeCallbacks,
} from '#testing/helpers/orchestrator-factories.js';
import { createTestSinks } from '#testing/helpers/planning-phase.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import { phaseInputs } from '#testing/helpers/planner-call.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { SANDBOX_DIR, SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { emptyReplyContinuation } from '../../../core/pipeline-spec/planner-documents.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { PhaseCallResult, PhaseInputs, PlannerCallbacks } from '../../planners/types.js';
import { HEARTBEAT_THRESHOLD_MS, PLANNER_KEEPALIVE_INTERVAL_MS } from './heartbeat.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import { createContinuationHolder } from '../continuation.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { error } from '../../../utils/error.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { Config } from '../../../core/schemas/config.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('shared-planning-test');
  dirs.push(projectDir);
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
    workflow: { mode: 'quick' },
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

  it.each(['question', 'pause'] as const)(
    'stops heartbeats during a %s wait and restarts them with the next call',
    async (waitKind) => {
      const ref = setupSession();
      const sinks = createTestSinks();
      const { bus, events } = makeBusRecorder();
      const answer = Promise.withResolvers<string>();
      const waiting = vi.fn(() => answer.promise);
      let calls = 0;
      const planner = makePlanner({
        runPhase: vi.fn(async (): Promise<PhaseCallResult> => {
          if (++calls === 1) {
            if (waitKind === 'pause') {
              sinks.abortTurn();
              throw new DOMException('Stopped', 'AbortError');
            }
            return { kind: 'conversation', text: 'Which module?', questions: [], usage: null };
          }
          await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_THRESHOLD_MS + 100));
          return makePhaseCallResult({ call: 'tasks', tasks: [makeTask()] });
        }),
      });
      const wctx = makeWctx(ref.projectDir, ref.sessionId, {
        bus,
        sinks,
        callbacks: makeCallbacks({ onPlannerReply: waiting, onContinuationNeeded: waiting })
          .callbacks,
      });
      const run = runPlannerCallInContinuationLoop({
        wctx,
        planner,
        state: planningState(),
        call: 'tasks',
        inputs: phaseInputs({ feature: 'test' }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(waiting).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_THRESHOLD_MS + PLANNER_KEEPALIVE_INTERVAL_MS * 3);
      expect(events.filter((event) => event.type === 'planner_heartbeat')).toHaveLength(0);
      answer.resolve('Refactor src/auth.ts.');
      await vi.advanceTimersByTimeAsync(HEARTBEAT_THRESHOLD_MS + 100);
      await run;
      const afterRun = events.filter((event) => event.type === 'planner_heartbeat').length;
      expect(afterRun).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(PLANNER_KEEPALIVE_INTERVAL_MS * 3);
      expect(events.filter((event) => event.type === 'planner_heartbeat')).toHaveLength(afterRun);
    },
  );

  it('stops heartbeat timers even when the planner throws', async () => {
    const { projectDir, sessionId } = setupSession();
    const planner = makePlanner({
      runPhase: vi.fn().mockRejectedValue(new Error('planner crashed')),
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
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
    }).catch((err: Error) => err);

    await vi.advanceTimersByTimeAsync(0);
    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('planner crashed');

    const heartbeatsAfterError = events.filter((e) => e.type === 'planner_heartbeat').length;

    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS + PLANNER_KEEPALIVE_INTERVAL_MS * 3);

    const heartbeatsAfterDelay = events.filter((e) => e.type === 'planner_heartbeat').length;
    expect(heartbeatsAfterDelay).toBe(heartbeatsAfterError);
  });

  it('tags heartbeat events with the active planner runner call id', async () => {
    const { projectDir, sessionId } = setupSession();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      runPhase: vi
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
          return makePhaseCallResult({ call: 'tasks', tasks: [makeTask()] });
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
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
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
      runPhase: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callbacks.onCallEvent?.({
            type: 'call_started',
            ts: Date.now(),
            callId: 'planner-call-1',
            role: 'planner',
            backendKind: 'cli',
          });
          await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_THRESHOLD_MS + 100));
          return makePhaseCallResult({
            call: 'tasks',
            tasks: [makeTask()],
            usage: { inputTokens: 100, outputTokens: 50 },
          });
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
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
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
      runPhase: vi.fn().mockImplementation(({ callbacks }: { callbacks: PlannerCallbacks }) => {
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
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
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
    const runPhase = vi.fn().mockResolvedValue(makePhaseCallResult({ call: 'tasks', tasks: [] }));
    const planner = makePlanner({ runPhase });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, { bus });

    const { result } = await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    expect(runPhase).toHaveBeenCalledTimes(1);
    if (result.kind !== 'artifact') throw new Error('Expected a completed planner artifact');
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
    const runPhase = vi
      .fn()
      .mockResolvedValue(makePhaseCallResult({ call: 'tasks', tasks: [makeTask()] }));
    const planner = makePlanner({ runPhase });
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
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    expect(runPhase).toHaveBeenCalled();
    // The default channel is the non-bridging one, so no host login state is
    // copied into the sandbox for a configuration that selected nothing.
    expect(existsSync(join(projectDir, SANDBOX_DIR, 'home', '.codex'))).toBe(false);
  });
});

describe('runPlannerCallInContinuationLoop — question markers', () => {
  it('publishes marker-free planner text', async () => {
    const { projectDir, sessionId } = setupSession();
    const planner = makePlanner({
      runPhase: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callbacks.onOutput('before ');
          callbacks.onOutput('<!-- Q:{"id":"q1","type"');
          callbacks.onOutput(':"choice","text":"Pick","options":["a","b"]} -->');
          callbacks.onOutput(' after');
          return makePhaseCallResult({ call: 'tasks', tasks: [makeTask()] });
        }),
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, { bus });

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    const publishedText = events
      .filter((e) => e.type === 'planner_text')
      .map((e) => e.text)
      .join('');
    expect(publishedText).not.toContain('<!--');
    expect(publishedText).toContain('before');
    expect(publishedText).toContain('after');
  });

  it('records raw marker text for continuation while publishing stripped text', async () => {
    const { projectDir, sessionId } = setupSession();
    const marker = '<!-- Q:{"id":"q1","type":"input","text":"Name?"} -->';
    const sinks = createTestSinks();
    let callCount = 0;
    const planner = makePlanner({
      runPhase: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callCount++;
          if (callCount === 1) {
            callbacks.onOutput(marker);
            sinks.abortTurn();
            throw new DOMException('The user aborted a request.', 'AbortError');
          }
          return makePhaseCallResult({ call: 'tasks', tasks: [makeTask()] });
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
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    expect(continuationPrompts).toEqual([marker]);
    expect(callCount).toBe(2);
  });

  it('continues a native session with one user turn, never the step prompt again', async () => {
    const { projectDir, sessionId } = setupSession();
    const sinks = createTestSinks();
    const prompts: (string | undefined)[] = [];
    const turns: (string | undefined)[] = [];
    let callCount = 0;
    const planner = makePlanner({
      capabilities: { ...makePlanner().capabilities, supportsSessionResume: true },
      runPhase: vi.fn().mockImplementation(async ({ callbacks, inputs }) => {
        callCount++;
        prompts.push(inputs.promptSuffix);
        turns.push(inputs.continuationTurn);
        if (callCount === 1) {
          callbacks.onOutput('half a spec');
          sinks.abortTurn();
          throw new DOMException('The user aborted a request.', 'AbortError');
        }
        return makePhaseCallResult({ call: 'spec' });
      }),
    });
    const wctx = makeWctx(projectDir, sessionId, {
      sinks,
      callbacks: makeCallbacks({ onContinuationNeeded: async () => 'shorter, please' }).callbacks,
    });

    await runPlannerCallInContinuationLoop({
      wctx,
      state: { ...planningState(), plannerSessionId: 'native-1' },
      planner,
      call: 'spec',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    expect(callCount).toBe(2);
    expect(turns[0]).toBeUndefined();
    expect(turns[1]).toContain('shorter, please');
    expect(turns[1]).toContain('spec.md');
    // The session already holds the step's prompt, so nothing trails a rebuilt one.
    expect(prompts[1]).toBeUndefined();
  });

  it('continues a stateless seat by re-issuing the step prompt with the partial on the end', async () => {
    const { projectDir, sessionId } = setupSession();
    const sinks = createTestSinks();
    const suffixes: (string | undefined)[] = [];
    const turns: (string | undefined)[] = [];
    let callCount = 0;
    const planner = makePlanner({
      runPhase: vi.fn().mockImplementation(async ({ callbacks, inputs }) => {
        callCount++;
        suffixes.push(inputs.promptSuffix);
        turns.push(inputs.continuationTurn);
        if (callCount === 1) {
          callbacks.onOutput('half a spec');
          sinks.abortTurn();
          throw new DOMException('The user aborted a request.', 'AbortError');
        }
        return makePhaseCallResult({ call: 'spec' });
      }),
    });
    const wctx = makeWctx(projectDir, sessionId, {
      sinks,
      callbacks: makeCallbacks({ onContinuationNeeded: async () => 'shorter, please' }).callbacks,
    });

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      call: 'spec',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    expect(turns).toEqual([undefined, undefined]);
    expect(suffixes[0]).toBeUndefined();
    expect(suffixes[1]).toContain('half a spec');
    expect(suffixes[1]).toContain('shorter, please');
  });

  it('seeds the first call from the continuation the run was restarted with', async () => {
    const { projectDir, sessionId } = setupSession();
    const suffixes: (string | undefined)[] = [];
    const planner = makePlanner({
      runPhase: vi.fn().mockImplementation(async ({ inputs }) => {
        suffixes.push(inputs.promptSuffix);
        return makePhaseCallResult({ call: 'spec' });
      }),
    });
    const wctx = makeWctx(projectDir, sessionId, {
      continuation: createContinuationHolder({
        step: { kind: 'planner', call: 'spec' },
        partial: 'what the killed process wrote',
        steer: 'drop the migration section',
      }),
    });

    await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      call: 'spec',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    expect(suffixes[0]).toContain('what the killed process wrote');
    expect(suffixes[0]).toContain('drop the migration section');
  });

  it('releases held planner text when the planner call throws', async () => {
    const { projectDir, sessionId } = setupSession();
    const planner = makePlanner({
      runPhase: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
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
        call: 'tasks',
        inputs: phaseInputs({ feature: 'test feature' }),
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
      runPhase: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callCount++;
          if (callCount === 1) {
            callbacks.onOutput('Partial findings. <!-- Q:{"id":"q1","text":"Which file');
            sinks.abortTurn();
            throw new DOMException('The user aborted a request.', 'AbortError');
          }
          return makePhaseCallResult({ call: 'tasks', tasks: [makeTask()] });
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
      call: 'tasks',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    const publishedText = events
      .filter((e) => e.type === 'planner_text')
      .map((e) => e.text)
      .join('');
    expect(publishedText).toContain('Partial findings.');
    expect(publishedText).toContain('Which file');
  });
});

describe('runPlannerCallInContinuationLoop — an empty reply', () => {
  const pendingText =
    '## Project Overview\nA CLI.\n\n## Architecture (the parts it touches)\nModules.\n';

  function pendingState() {
    return {
      ...planningState(),
      plannerSessionId: 'native-1',
      pendingPlannerConversation: {
        call: 'research' as const,
        text: pendingText,
        questions: [],
        answers: [],
        answered: false,
      },
    };
  }

  it('sends the default continuation, naming the sections the reply lacks', async () => {
    const { projectDir, sessionId } = setupSession();
    const turns: (string | undefined)[] = [];
    const planner = makePlanner({
      capabilities: { ...makePlanner().capabilities, supportsSessionResume: true },
      runPhase: vi.fn().mockImplementation(async ({ inputs }) => {
        turns.push(inputs.continuationTurn);
        return makePhaseCallResult({ call: 'research' });
      }),
    });
    const wctx = makeWctx(projectDir, sessionId, {
      callbacks: makeCallbacks({ onPlannerReply: async () => '' }).callbacks,
    });

    const run = await runPlannerCallInContinuationLoop({
      wctx,
      state: pendingState(),
      planner,
      call: 'research',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    const continuation = emptyReplyContinuation('research', pendingText);
    expect(continuation).toContain('Validation Tools');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain(continuation);
    expect(run.state.pendingPlannerConversation).toMatchObject({ answered: true });
    const log = readFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), 'utf-8');
    expect(log).toContain('"role":"user"');
    expect(log).toContain('No further input');
  });

  it('keeps the reply a conversation when the wait was aborted', async () => {
    const { projectDir, sessionId } = setupSession();
    const runPhase = vi.fn();
    const planner = makePlanner({ runPhase });
    const wctx = makeWctx(projectDir, sessionId, {
      callbacks: makeCallbacks({ onPlannerReply: async () => undefined }).callbacks,
    });

    const run = await runPlannerCallInContinuationLoop({
      wctx,
      state: pendingState(),
      planner,
      call: 'research',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    expect(run.result.kind).toBe('conversation');
    expect(runPhase).not.toHaveBeenCalled();
  });
});

describe('runPlannerCallInContinuationLoop — expired planner session', () => {
  function expiringPlanner(second: () => PhaseCallResult) {
    const calls: PhaseInputs[] = [];
    const planner = makePlanner({
      capabilities: { ...makePlanner().capabilities, supportsSessionResume: true },
      runPhase: vi
        .fn()
        .mockImplementation(
          async ({ callbacks, inputs }: { callbacks: PlannerCallbacks; inputs: PhaseInputs }) => {
            calls.push(inputs);
            if (calls.length > 1) return second();
            callbacks.onSessionExpired?.('native-gone');
            throw error('session-resume-expired', 'could not resume session native-gone');
          },
        ),
    });
    return { planner, calls };
  }

  it('re-issues the call once on a fresh session with the transcript when the seat drops its thread', async () => {
    const { projectDir, sessionId } = setupSession();
    appendMessage(
      { projectDir, sessionId },
      { role: 'user', phase: 'specifying', text: 'The export must be named PERIWINKLE-42.' },
    );
    const { planner, calls } = expiringPlanner(() => makePhaseCallResult({ call: 'spec' }));
    const { bus, events } = makeBusRecorder();

    const run = await runPlannerCallInContinuationLoop({
      wctx: makeWctx(projectDir, sessionId, {
        bus,
        continuation: createContinuationHolder({
          step: { kind: 'planner', call: 'spec' },
          steer: 'drop the migration section',
        }),
      }),
      state: { ...planningState(), plannerSessionId: 'native-gone' },
      planner,
      call: 'spec',
      inputs: phaseInputs({ feature: 'test feature' }),
    });

    expect(run.result.kind).toBe('artifact');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.continuationTurn).toContain('drop the migration section');
    expect(calls[0]?.priorMessages).toBeUndefined();
    // The fresh session holds nothing: the step's prompt goes out again, the continuation after it.
    expect(calls[1]?.continuationTurn).toBeUndefined();
    expect(calls[1]?.promptSuffix).toContain('drop the migration section');
    expect(calls[1]?.priorMessages).toEqual([
      { role: 'user', content: 'The export must be named PERIWINKLE-42.' },
    ]);
    expect(readWorkflowStateHead({ projectDir, sessionId })?.state.plannerSessionId).toBeNull();
    expect(events.filter((event) => event.type === 'warning' || event.type === 'error')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'planner_session_expired' }),
    ]);
  });

  it('issues a call that resumed no thread once, whatever its error says', async () => {
    const { projectDir, sessionId } = setupSession();
    const { planner, calls } = expiringPlanner(() => makePhaseCallResult({ call: 'spec' }));

    await expect(
      runPlannerCallInContinuationLoop({
        wctx: makeWctx(projectDir, sessionId),
        state: planningState(),
        planner,
        call: 'spec',
        inputs: phaseInputs({ feature: 'test feature' }),
      }),
    ).rejects.toMatchObject({ kind: 'session-resume-expired' });
    expect(calls).toHaveLength(1);
  });

  it('hands the failure of the re-issued call to the halt, and issues no third call', async () => {
    const { projectDir, sessionId } = setupSession();
    const { planner, calls } = expiringPlanner(() => {
      throw new Error('stream disconnected before completion');
    });

    await expect(
      runPlannerCallInContinuationLoop({
        wctx: makeWctx(projectDir, sessionId),
        state: { ...planningState(), plannerSessionId: 'native-gone' },
        planner,
        call: 'spec',
        inputs: phaseInputs({ feature: 'test feature' }),
      }),
    ).rejects.toThrow('stream disconnected before completion');
    expect(calls).toHaveLength(2);
  });
});

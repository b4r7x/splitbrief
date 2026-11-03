import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { planFromTasks } from '#testing/helpers/typed-planner.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { createPlannerBase } from '../../planners/base.js';
import type { Planner } from '../../planners/types.js';
import { streamCompletion } from '../../providers/openai-stream/completion.js';
import type { PlannerCallbacksContext } from '../types.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { runPlanningSession } from './session.js';

const API_PLANNER = {
  kind: 'api',
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://localhost:11434/v1',
} as const;

let dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function nextEvent(bus: EventBus, type: EngineEvent['type']): Promise<EngineEvent> {
  return new Promise((resolve) => {
    const stop = bus.subscribe((event) => {
      if (event.type !== type) return;
      stop();
      resolve(event);
    });
  });
}

// An `api` planner on the real `streamCompletion`: the endpoint's first request
// fails with `failure`, every later one streams a plan.
function apiPlanner(failure: () => Error): { planner: Planner; calls: () => number } {
  let calls = 0;
  const answer = JSON.stringify({ result: planFromTasks([makeTask({ id: 'T001' })]) });
  const base = createPlannerBase({
    invokePlan: (input) => {
      const client: Parameters<typeof streamCompletion>[0] = {
        chat: {
          completions: {
            create: async () => {
              calls += 1;
              if (calls === 1) throw failure();
              let sent = false;
              return {
                [Symbol.asyncIterator]: () => ({
                  next: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return {
                      done: false,
                      value: { choices: [{ delta: { content: answer }, finish_reason: 'stop' }] },
                    };
                  },
                }),
              };
            },
          },
        },
      };
      return streamCompletion(client, 'planner-model', [{ role: 'user', content: input.prompt }], {
        temperature: 0,
        onProgress: input.callbacks.onOutput,
        ...(input.signal !== undefined && { signal: input.signal }),
      });
    },
    invokeOneShot: () => Promise.reject(new Error('the planning session escalates nothing')),
    isAvailable: async () => true,
    capabilities: makePlanner().capabilities,
  });
  return { planner: makePlanner({ typedCall: base.typedCall }), calls: () => calls };
}

function startPlanning() {
  const projectDir = createTempDir('planning-seat-retry');
  dirs.push(projectDir);
  const sessionId = 'sess-planning-seat-retry';
  ensureSessionDir(projectDir, sessionId);
  const state: WorkflowState = {
    ...transition(createInitialState('feature'), { type: 'START' }),
    mode: 'standard',
    approve: 'none',
  };
  saveState({ projectDir, sessionId }, state);
  const { bus, events } = makeBusRecorder();
  const wctx: PlannerCallbacksContext = {
    projectDir,
    sessionId,
    config: makeConfig({ planner: API_PLANNER }),
    callbacks: makeCallbacks().callbacks,
    bus,
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    signal: new AbortController().signal,
  };
  return { ref: { projectDir, sessionId }, bus, events, wctx, state };
}

describe('a planning call on an api seat', () => {
  it.each([
    ['a 503', () => Object.assign(new Error('503 Service Unavailable'), { status: 503 })],
    [
      'a connection reset',
      () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    ],
  ])('retries %s once and plans', async (_name, failure) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { planner, calls } = apiPlanner(failure);
    const { ref, bus, events, wctx, state } = startPlanning();
    const retried = nextEvent(bus, 'seat_retry');

    const running = runPlanningSession({ wctx, state, planner, feature: state.feature });
    expect(await Promise.race([retried, running])).toMatchObject({
      type: 'seat_retry',
      seat: 'plan',
      attempt: 1,
      delayMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await running;

    expect(result).toMatchObject({ disposition: 'tasks-ready' });
    expect(calls()).toBe(2);
    expect(events.filter((event) => event.type === 'seat_retry')).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(loadState(ref)?.pendingRecovery).toBeUndefined();
  });

  it('waits for a named usage-limit reset with no fallback, then plans', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { planner, calls } = apiPlanner(() =>
      Object.assign(new Error("You've hit your usage limit. Try again in 40 minutes."), {
        status: 429,
      }),
    );
    const { ref, bus, events, wctx, state } = startPlanning();
    const waiting = nextEvent(bus, 'seat_wait_started');

    const running = runPlanningSession({ wctx, state, planner, feature: state.feature });
    expect(await Promise.race([waiting, running])).toMatchObject({
      type: 'seat_wait_started',
      phase: 'planning',
      seat: 'plan',
      resetAt: '2026-01-01T00:40:00.000Z',
    });
    expect(loadState(ref)?.seatWait?.resetAt).toBe('2026-01-01T00:40:00.000Z');
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    const result = await running;

    expect(result).toMatchObject({ disposition: 'tasks-ready' });
    expect(calls()).toBe(2);
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(loadState(ref)?.pendingRecovery).toBeUndefined();
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  it('drops the wait a /steer cut once the steered call plans', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { planner, calls } = apiPlanner(() =>
      Object.assign(new Error("You've hit your usage limit. Try again in 3 hours."), {
        status: 429,
      }),
    );
    const { ref, bus, events, wctx, state } = startPlanning();
    const abortHandlers: (() => void)[] = [];
    const steered: PlannerCallbacksContext = {
      ...wctx,
      sinks: {
        ...TEST_SINKS,
        setAbortHandler: (handler) => {
          if (handler === null) abortHandlers.pop();
          else abortHandlers.push(handler);
        },
      },
      callbacks: makeCallbacks({
        onContinuationNeeded: async () => plainUserMessage('keep it small'),
      }).callbacks,
    };
    const waiting = nextEvent(bus, 'seat_wait_started');

    const running = runPlanningSession({ wctx: steered, state, planner, feature: state.feature });
    await Promise.race([waiting, running]);
    expect(loadState(ref)?.seatWait?.resetAt).toBe('2026-01-01T03:00:00.000Z');
    // `/steer` aborts the call through the per-call abort handler.
    abortHandlers.at(-1)?.();
    const result = await running;

    expect(result).toMatchObject({ disposition: 'tasks-ready' });
    expect(calls()).toBe(2);
    expect(loadState(ref)?.seatWait).toBeUndefined();
    expect(events.filter((event) => event.type === 'seat_wait_ended').at(-1)).not.toHaveProperty(
      'kept',
    );
  });
});

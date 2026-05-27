import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makePlanner, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { PlannerCallbacks } from '../../planners/types.js';
import { HEARTBEAT_THRESHOLD_MS } from './heartbeat.js';
import { HEARTBEAT_INTERVAL_MS } from '../../constants.js';
import { runPlannerCallInContinuationLoop } from './shared.js';
import type { PlannerCallbacksContext } from '../types.js';

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
  state = transition(state, { type: 'START', feature: 'feat' });
  return state;
}

function makeWctx(projectDir: string, sessionId: string, overrides?: Partial<PlannerCallbacksContext>): PlannerCallbacksContext {
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
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

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

    const heartbeatsAfterError = events.filter(e => e.type === 'planner_heartbeat').length;

    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS + HEARTBEAT_INTERVAL_MS * 3);

    const heartbeatsAfterDelay = events.filter(e => e.type === 'planner_heartbeat').length;
    expect(heartbeatsAfterDelay).toBe(heartbeatsAfterError);
  });
});

describe('runPlannerCallInContinuationLoop — signal propagation', () => {
  it('passes call-level abort signal to planner callbacks', async () => {
    const { projectDir, sessionId } = setupSession();
    let capturedCallbacks: PlannerCallbacks | undefined;
    const planner = makePlanner({
      quickPlan: vi.fn().mockImplementation(
        async (_prompt: string, _dir: string, callbacks: PlannerCallbacks) => {
          capturedCallbacks = callbacks;
          return {
            spec: '',
            plan: '',
            tasks: [makeTask()],
            usage: null,
          };
        },
      ),
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

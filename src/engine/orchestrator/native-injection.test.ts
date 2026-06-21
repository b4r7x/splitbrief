import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchNativeInjection } from './native-injection.js';
import { createEventBus } from '../events/bus.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import type { EngineEvent } from '../events/types.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import { fauxPlanner } from '#testing/helpers/faux/planner.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';

const message: QueuedMessage = {
  id: 'msg-1',
  text: 'please continue',
  queuedAt: new Date().toISOString(),
  phase: 'implementing',
  deliveredViaNative: false,
  nativeDeliveryState: 'pending',
};

describe('dispatchNativeInjection', () => {
  it('publishes a warning instead of silently swallowing an injection failure', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => {
      throw new Error('socket closed');
    };

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const projectDir = mkdtempSync(join(tmpdir(), 'native-inject-failure-'));
    try {
      ensureSessionDir(projectDir, 'sess-1');
      let state = makeImplState([]);

      await expect(
        dispatchNativeInjection({
          message,
          planner,
          projectDir,
          sessionId: 'sess-1',
          getState: () => state,
          setState: (next) => {
            state = next;
          },
          bus,
        }),
      ).resolves.toEqual({ status: 'not-delivered', reason: 'failed' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }

    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(events.some((e) => e.type === 'message_injected_native')).toBe(false);
  });

  it('books the injected turn token usage into planner accumulators and emits a cost update', async () => {
    const { planner } = fauxPlanner();
    const startedAt = Date.now();
    const call: RunnerCallContext = {
      callId: 'native-injection-call',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'native-planner',
    };
    planner.injectUserTurn = async (injection) => {
      injection.callbacks?.onCallEvent?.({ type: 'call_started', ts: startedAt, ...call });
      injection.callbacks?.onCallEvent?.({
        type: 'call_completed',
        ts: startedAt + 1,
        ...call,
        status: 'completed',
        error: null,
        partial: false,
        startedAt,
        endedAt: startedAt + 1,
        durationMs: 1,
        usage: { inputTokens: 120, outputTokens: 40 },
        nativeSessionId: null,
      });
      return { inputTokens: 120, outputTokens: 40 };
    };

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    const projectDir = mkdtempSync(join(tmpdir(), 'native-inject-usage-'));
    try {
      ensureSessionDir(projectDir, 'sess-usage');
      let state: WorkflowState = makeImplState([]);
      const before = state.tokenUsage.plannerInput;

      const result = await dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId: 'sess-usage',
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus,
      });

      expect(result).toEqual({ status: 'delivered' });
      expect(state.tokenUsage.plannerInput).toBe(before + 120);
      expect(state.tokenUsage.plannerOutput).toBe(40);
      expect(events.some((e) => e.type === 'cost_update')).toBe(true);
      expect(events.some((e) => e.type === 'message_injected_native')).toBe(true);
      expect(
        events.filter((event) => event.type.startsWith('runner_call_')).map((event) => event.type),
      ).toEqual(['runner_call_started', 'runner_call_completed', 'runner_call_activity']);
      expect(events.find((event) => event.type === 'runner_call_activity')).toMatchObject({
        callId: 'native-injection-call',
        role: 'planner',
        stage: 'completed',
        kind: 'text',
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('publishes a redacted preview for injected messages', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => null;

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    const projectDir = mkdtempSync(join(tmpdir(), 'native-inject-preview-'));
    try {
      ensureSessionDir(projectDir, 'sess-preview');
      let state: WorkflowState = makeImplState([]);

      const result = await dispatchNativeInjection({
        message: {
          ...message,
          text: `secret sk-proj-abcdefghijklmnopqrstuvwxyz\n${'x'.repeat(100)}`,
        },
        planner,
        projectDir,
        sessionId: 'sess-preview',
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus,
      });

      expect(result).toEqual({ status: 'delivered' });
      const injected = events.find((event) => event.type === 'message_injected_native');
      if (!injected || injected.type !== 'message_injected_native')
        throw new Error('message_injected_native event missing');
      expect(injected.preview).toContain('sk-***REDACTED***');
      expect(injected.preview).not.toContain('abcdefghijklmnopqrstuvwxyz');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not inject when the workflow signal is already aborted', async () => {
    const { planner } = fauxPlanner();
    let injected = false;
    planner.injectUserTurn = async () => {
      injected = true;
      return null;
    };

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const state = makeImplState([]);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const result = await dispatchNativeInjection({
      message,
      planner,
      projectDir: '/tmp/does-not-matter',
      sessionId: 'sess-1',
      getState: () => state,
      setState: () => {},
      bus,
      signal: controller.signal,
    });

    expect(result).toEqual({ status: 'not-delivered', reason: 'aborted' });
    expect(injected).toBe(false);
    expect(events.find((event) => event.type === 'message_injected_native')).toBeUndefined();
    expect(events.find((event) => event.type === 'warning')).toBeUndefined();
  });
});

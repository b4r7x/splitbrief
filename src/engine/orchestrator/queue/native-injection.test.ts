import { plainUserMessage } from '../../../core/types/user-input.js';

import { afterEach, describe, it, expect } from 'vitest';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchNativeInjection } from './native-injection.js';
import { createEventBus } from '../../events/bus.js';
import { saveState, loadState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import type { EngineEvent } from '../../events/types.js';
import type { RunnerCallContext } from '../../calls/types.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { fauxPlanner } from '#testing/helpers/faux/planner.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { readQueueForPrompt, releaseQueueMessagesForPrompt } from './drain.js';
import { addUsageAndSave } from '../state-ops.js';
import { makeResearchingState, setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { trustedShimGate } from '#testing/helpers/command-shim.js';
import { createClaudeCodePlanner } from '../../planners/claude-code.js';
import { withPlannerCallPublishing } from '../run/call-publishing.js';
import { drainAndFormat } from '../planning/queue-drain.js';

const message: QueuedMessage = {
  id: 'msg-1',
  ...plainUserMessage('please continue'),
  queuedAt: new Date().toISOString(),
  phase: 'implementing',
  deliveredViaNative: false,
  nativeDeliveryState: 'pending',
};

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('dispatchNativeInjection', () => {
  it('keeps a correction pending for the next prompt when a fresh Claude seat has no native session', async () => {
    const shimDir = createTempDir('native-injection-claude-shim');
    dirs.push(shimDir);
    const marker = join(shimDir, 'spawned');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(shimPath, ['#!/bin/bash', `touch '${marker}'`, ''].join('\n'), 'utf8');
    chmodSync(shimPath, 0o755);

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const { projectDir, sessionId } = setupProject(dirs);
    const correction: QueuedMessage = {
      ...message,
      ...plainUserMessage('use JWT instead'),
      phase: 'researching',
    };
    let state: WorkflowState = { ...makeResearchingState(), messageQueue: [correction] };
    const planner = withPlannerCallPublishing(
      createClaudeCodePlanner({
        authChannel: 'session',
        trustedCli: trustedShimGate({ dir: shimDir, tool: 'claude-code' }),
      }),
      { bus, getPhase: () => state.phase },
    );

    const result = await dispatchNativeInjection({
      message: correction,
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
    });

    expect(result).toEqual({ status: 'not-delivered', reason: 'not-ready' });
    expect(existsSync(marker)).toBe(false);
    expect(loadState({ projectDir, sessionId })?.messageQueue).toEqual([correction]);
    expect(events.some((event) => event.type.startsWith('runner_call_'))).toBe(false);
    expect(events.some((event) => event.type === 'message_injected_native')).toBe(false);
    expect(events.some((event) => event.type === 'cost_update')).toBe(false);

    const next = drainAndFormat(projectDir, sessionId, state, bus);
    expect(next.prefix).toContain('use JWT instead');
    expect(next.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
  });

  it('acknowledges a delivered turn without usage exactly once and books nothing', async () => {
    const { planner: faux } = fauxPlanner();
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
    const planner = withPlannerCallPublishing(faux, { bus, getPhase: () => state.phase });
    const dispatch = () =>
      dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus,
      });

    await expect(dispatch()).resolves.toEqual({ status: 'delivered' });
    await expect(dispatch()).resolves.toEqual({ status: 'not-delivered', reason: 'already-owned' });

    expect(state.tokenUsage.plannerInput).toBe(0);
    expect(state.tokenUsage.plannerOutput).toBe(0);
    expect(loadState({ projectDir, sessionId })?.messageQueue[0]?.nativeDeliveryState).toBe(
      'delivered',
    );
    expect(events.filter((event) => event.type === 'message_injected_native')).toHaveLength(1);
    expect(events.some((event) => event.type === 'cost_update')).toBe(false);
    expect(readQueueForPrompt({ projectDir, sessionId, state }).messages).toEqual([]);
  });

  it('does not resurrect a message cleared while the seat reported not ready', async () => {
    const { planner } = fauxPlanner();
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
    planner.injectUserTurn = async () => {
      saveState({ projectDir, sessionId }, { ...state, messageQueue: [] });
      return { status: 'not-delivered', reason: 'not-ready' };
    };

    const result = await dispatchNativeInjection({
      message,
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
    });

    expect(result).toEqual({ status: 'not-delivered', reason: 'cleared' });
    expect(loadState({ projectDir, sessionId })?.messageQueue).toEqual([]);
    expect(readQueueForPrompt({ projectDir, sessionId, state }).messages).toEqual([]);
    expect(events.some((event) => event.type === 'message_injected_native')).toBe(false);
  });

  it('publishes a warning instead of silently swallowing an injection failure', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => {
      throw new Error('socket closed');
    };

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };

    await expect(
      dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus,
      }),
    ).resolves.toEqual({ status: 'not-delivered', reason: 'failed' });

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
      return { status: 'delivered', usage: { inputTokens: 120, outputTokens: 40 } };
    };

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
    const before = state.tokenUsage.plannerInput;

    const result = await dispatchNativeInjection({
      message,
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
    });

    expect(result).toEqual({ status: 'delivered' });
    await expect(
      dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId,
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus,
      }),
    ).resolves.toEqual({ status: 'not-delivered', reason: 'already-owned' });
    expect(state.tokenUsage.plannerInput).toBe(before + 120);
    expect(state.tokenUsage.plannerOutput).toBe(40);
    expect(events.filter((e) => e.type === 'cost_update')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'message_injected_native')).toHaveLength(1);
    expect(
      events.filter((event) => event.type.startsWith('runner_call_')).map((event) => event.type),
    ).toEqual(['runner_call_started', 'runner_call_completed']);
    expect(events.find((event) => event.type === 'runner_call_completed')).toMatchObject({
      callId: 'native-injection-call',
      role: 'planner',
    });
  });

  it('publishes a redacted preview for injected messages', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => ({ status: 'delivered', usage: null });

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };

    const result = await dispatchNativeInjection({
      message: {
        ...message,
        ...plainUserMessage(`secret sk-proj-abcdefghijklmnopqrstuvwxyz\n${'x'.repeat(100)}`),
      },
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
    });

    expect(result).toEqual({ status: 'delivered' });
    const injected = events.find((event) => event.type === 'message_injected_native');
    if (injected?.type !== 'message_injected_native')
      throw new Error('message_injected_native event missing');
    expect(injected.preview).toContain('sk-***REDACTED***');
    expect(injected.preview).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('does not inject when the workflow signal is already aborted', async () => {
    const { planner } = fauxPlanner();
    let injected = false;
    planner.injectUserTurn = async () => {
      injected = true;
      return { status: 'delivered', usage: null };
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

  it('does not book usage or mark delivered when aborted after injectUserTurn resolves', async () => {
    const { planner } = fauxPlanner();
    const controller = new AbortController();
    planner.injectUserTurn = async () => {
      controller.abort(new Error('cancelled'));
      return { status: 'delivered', usage: { inputTokens: 500, outputTokens: 100 } };
    };

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
    const beforeInput = state.tokenUsage.plannerInput;

    const result = await dispatchNativeInjection({
      message,
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      signal: controller.signal,
    });

    expect(result).toEqual({ status: 'not-delivered', reason: 'aborted' });
    expect(state.tokenUsage.plannerInput).toBe(beforeInput);
    expect(events.some((event) => event.type === 'cost_update')).toBe(false);
    expect(events.some((event) => event.type === 'message_injected_native')).toBe(false);
  });

  it('does not mark delivery when the queued message was cleared during injection', async () => {
    const { planner } = fauxPlanner();
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
    const beforeInput = state.tokenUsage.plannerInput;
    planner.injectUserTurn = async () => {
      saveState({ projectDir, sessionId }, { ...state, messageQueue: [] });
      return { status: 'delivered', usage: { inputTokens: 25, outputTokens: 5 } };
    };

    const result = await dispatchNativeInjection({
      message,
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
    });

    expect(result).toEqual({ status: 'not-delivered', reason: 'cleared' });
    expect(state.tokenUsage.plannerInput).toBe(beforeInput);
    expect(events.some((event) => event.type === 'message_injected_native')).toBe(false);
    expect(events.some((event) => event.type === 'cost_update')).toBe(false);
  });

  it('does not erase persisted rewindPending or rewind phase when injection completes after a rewind', async () => {
    const { planner } = fauxPlanner();

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
    saveState({ projectDir, sessionId }, state);
    planner.injectUserTurn = async () => {
      saveState(
        { projectDir, sessionId },
        transition(
          { ...state, phase: 'reviewing-plan' },
          { type: 'CORRECT_PLAN', comment: 'change architecture' },
        ),
      );
      return { status: 'delivered', usage: null };
    };

    const result = await dispatchNativeInjection({
      message,
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
    });

    expect(result).toEqual({ status: 'delivered' });
    expect(state.phase).toBe('reviewing-plan');
    expect(state.rewindPending).toEqual({ target: 'plan', comment: 'change architecture' });
    expect(loadState({ projectDir, sessionId })?.rewindPending).toEqual({
      target: 'plan',
      comment: 'change architecture',
    });
    expect(loadState({ projectDir, sessionId })?.phase).toBe('reviewing-plan');
    expect(events.some((event) => event.type === 'message_injected_native')).toBe(true);
  });

  it('keeps a live native owner out of prompt drain while both usage deltas persist', async () => {
    const { planner } = fauxPlanner();
    let finishInjection: (usage: TokenDelta) => void = () => {
      throw new Error('native injection was not started');
    };
    planner.injectUserTurn = async () =>
      new Promise((resolve) => {
        finishInjection = (usage) => resolve({ status: 'delivered', usage });
      });

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
    const native = dispatchNativeInjection({
      message,
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
    });

    await Promise.resolve();
    const prompt = readQueueForPrompt({ projectDir, sessionId, state });
    expect(prompt.messages).toEqual([]);

    const bookedByPrompt = addUsageAndSave({ projectDir, sessionId, bus }, state, 'planner', {
      inputTokens: 13,
      outputTokens: 5,
    });
    state = bookedByPrompt;
    finishInjection({ inputTokens: 11, outputTokens: 7 });

    await expect(native).resolves.toEqual({ status: 'delivered' });
    expect(state.tokenUsage.plannerInput).toBe(24);
    expect(state.tokenUsage.plannerOutput).toBe(12);
    expect(state.messageQueue[0]?.nativeDeliveryState).toBe('delivered');
    expect(events.filter((event) => event.type === 'message_injected_native')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'queue_drained')).toHaveLength(0);
  });

  it('does not inject a message after a prompt reader has claimed it', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => ({
      status: 'delivered',
      usage: { inputTokens: 99, outputTokens: 9 },
    });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
    const prompt = readQueueForPrompt({ projectDir, sessionId, state });

    expect(prompt.messages).toEqual([expect.objectContaining({ id: message.id })]);
    await expect(
      dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus,
      }),
    ).resolves.toEqual({ status: 'not-delivered', reason: 'already-owned' });
    expect(events.filter((event) => event.type === 'message_injected_native')).toHaveLength(0);
    expect(state.tokenUsage.plannerInput).toBe(0);
    releaseQueueMessagesForPrompt({ projectDir, sessionId }, [message]);
  });
});

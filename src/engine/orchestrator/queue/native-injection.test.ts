import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchNativeInjection } from './native-injection.js';
import { createEventBus } from '../../events/bus.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { saveState, loadState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import type { EngineEvent } from '../../events/types.js';
import type { RunnerCallContext } from '../../calls/types.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryController,
  BriefRecoveryV1,
  InputReceipt,
  QueueBriefInput,
  QueueResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import {
  createBriefRecoveryState,
  inspectBriefRecovery,
  queueRecoveryInput,
} from '../planning/brief-recovery.js';
import { fauxPlanner } from '#testing/helpers/faux/planner.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { readQueueForPrompt, releaseQueueMessagesForPrompt } from './drain.js';
import { addUsageAndSave } from '../state-ops.js';

const message: QueuedMessage = {
  id: 'msg-1',
  text: 'please continue',
  queuedAt: new Date().toISOString(),
  phase: 'implementing',
  deliveredViaNative: false,
  nativeDeliveryState: 'pending',
};

const recoveryBrief = { revision: 1, hash: 'brief-native', path: 'tasks.md' } as const;

function recoveryFor(sessionId: string, epochId = 'epoch-native') {
  const input: BriefAdmissionInput = {
    sessionId,
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: recoveryBrief,
    report: {
      briefHash: recoveryBrief.hash,
      report: { revision: 1, hash: 'report-native', path: 'brief-quality.json' },
      ruleVersion: 'quality-v1',
      issues: [],
      errorCount: 0,
    },
    qualityPolicyVersion: 'quality-v1',
  };
  return createBriefRecoveryState(input, { epochId });
}

function authority(sessionId: string): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: 'owner-native',
    pid: 1,
    processStart: 'process-native',
    runId: 'run-native',
    acquisitionId: 'acquisition-native',
    fence: 1,
    stateRevision: 0,
    stateDigest: 'digest-native',
  };
}

function recoveryState(sessionId: string): WorkflowState {
  return {
    ...makeImplState([]),
    phase: 'reviewing-briefs',
    messageQueue: [message],
    briefRecovery: recoveryFor(sessionId),
  };
}

function projection(sessionId: string, state: BriefRecoveryV1) {
  return inspectBriefRecovery({ sessionId, stateRevision: state.recoveryRevision, state });
}

function replayedInput(input: InputReceipt): InputReceipt {
  return {
    ...input,
    state: 'applied',
    appliedRevision: 1,
    history: [
      ...input.history,
      {
        state: 'applied',
        at: '2026-08-13T00:00:01.000Z',
        operationId: input.operationId,
        remoteObservation: null,
      },
    ],
  };
}

function controllerReturning(
  sessionId: string,
  result: (input: QueueBriefInput) => QueueResultV1,
): { controller: BriefRecoveryController; queueBriefInput: ReturnType<typeof vi.fn> } {
  const head = recoveryFor(sessionId);
  const queueBriefInput = vi.fn(async (input: QueueBriefInput) => result(input));
  const controller: BriefRecoveryController = {
    inspectBriefRecovery: () => projection(sessionId, head),
    enterBriefAdmission: async () => {
      throw new Error('unused in native queue adapter');
    },
    dispatchBriefAction: async () => {
      throw new Error('unused in native queue adapter');
    },
    queueBriefInput,
    settlePlannerAttempt: async () => {
      throw new Error('unused in native queue adapter');
    },
    migrateBriefRecovery: async () => {
      throw new Error('unused in native queue adapter');
    },
  };
  return { controller, queueBriefInput };
}

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
      let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };

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
      let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
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
      let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };

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
      if (injected?.type !== 'message_injected_native')
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

  it('does not book usage or mark delivered when aborted after injectUserTurn resolves', async () => {
    const { planner } = fauxPlanner();
    const controller = new AbortController();
    planner.injectUserTurn = async () => {
      controller.abort(new Error('cancelled'));
      return { inputTokens: 500, outputTokens: 100 };
    };

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const projectDir = mkdtempSync(join(tmpdir(), 'native-inject-abort-after-'));
    try {
      ensureSessionDir(projectDir, 'sess-abort');
      let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
      const beforeInput = state.tokenUsage.plannerInput;

      const result = await dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId: 'sess-abort',
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
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not mark delivery when the queued message was cleared during injection', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => null;

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const projectDir = mkdtempSync(join(tmpdir(), 'native-inject-cleared-'));
    try {
      ensureSessionDir(projectDir, 'sess-cleared');
      let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
      const beforeInput = state.tokenUsage.plannerInput;
      planner.injectUserTurn = async () => {
        saveState({ projectDir, sessionId: 'sess-cleared' }, { ...state, messageQueue: [] });
        return { inputTokens: 25, outputTokens: 5 };
      };

      const result = await dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId: 'sess-cleared',
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
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not erase persisted rewindPending or rewind phase when injection completes after a rewind', async () => {
    const { planner } = fauxPlanner();

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const projectDir = mkdtempSync(join(tmpdir(), 'native-inject-rewind-'));
    try {
      ensureSessionDir(projectDir, 'sess-rewind');
      let state: WorkflowState = { ...makeImplState([]), messageQueue: [message] };
      saveState({ projectDir, sessionId: 'sess-rewind' }, state);
      planner.injectUserTurn = async () => {
        saveState(
          { projectDir, sessionId: 'sess-rewind' },
          transition(state, { type: 'REWIND_TO_PLAN', comment: 'change architecture' }),
        );
        return null;
      };

      const result = await dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId: 'sess-rewind',
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus,
      });

      expect(result).toEqual({ status: 'delivered' });
      expect(state.phase).toBe('planning');
      expect(state.rewindPending).toEqual({ target: 'plan', comment: 'change architecture' });
      expect(loadState({ projectDir, sessionId: 'sess-rewind' })?.rewindPending).toEqual({
        target: 'plan',
        comment: 'change architecture',
      });
      expect(loadState({ projectDir, sessionId: 'sess-rewind' })?.phase).toBe('planning');
      expect(events.some((event) => event.type === 'message_injected_native')).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps a live native owner out of prompt drain while both usage deltas persist', async () => {
    const { planner } = fauxPlanner();
    let finishInjection: (usage: TokenDelta) => void = () => {
      throw new Error('native injection was not started');
    };
    planner.injectUserTurn = async () =>
      new Promise<TokenDelta>((resolve) => {
        finishInjection = resolve;
      });

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const projectDir = mkdtempSync(join(tmpdir(), 'native-inject-ownership-'));
    try {
      const sessionId = 'sess-ownership';
      ensureSessionDir(projectDir, sessionId);
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
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not inject a message after a prompt reader has claimed it', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => ({ inputTokens: 99, outputTokens: 9 });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const projectDir = mkdtempSync(join(tmpdir(), 'prompt-owns-before-native-'));
    const sessionId = 'sess-prompt-owner';
    try {
      ensureSessionDir(projectDir, sessionId);
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
    } finally {
      releaseQueueMessagesForPrompt({ projectDir, sessionId }, [message]);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('refuses a recovery input before provider dispatch and releases the native claim', async () => {
    const { planner } = fauxPlanner();
    const sessionId = 'sess-recovery-conflict';
    const projectDir = mkdtempSync(join(tmpdir(), 'native-recovery-conflict-'));
    try {
      ensureSessionDir(projectDir, sessionId);
      let state = recoveryState(sessionId);
      saveState({ projectDir, sessionId }, state);
      const binding = controllerReturning(sessionId, (input) => ({
        version: 1,
        sessionId,
        epochId: input.epochId,
        kind: 'conflict',
        code: 'brief_intent_conflict',
        inputId: input.inputId,
        reason: 'input was superseded before dispatch',
        projection: projection(sessionId, recoveryFor(sessionId)),
      }));

      planner.injectUserTurn = vi.fn(async () => ({ inputTokens: 99, outputTokens: 9 }));
      const result = await dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus: createEventBus(),
        recovery: { controller: binding.controller, authority: authority(sessionId) },
      });

      expect(result).toEqual({ status: 'not-delivered', reason: 'already-owned' });
      expect(planner.injectUserTurn).not.toHaveBeenCalled();
      const prompt = readQueueForPrompt({ projectDir, sessionId, state });
      expect(prompt.messages).toEqual([expect.objectContaining({ id: message.id })]);
      releaseQueueMessagesForPrompt({ projectDir, sessionId }, prompt.messages);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('replays an already-applied recovery input without a second provider call', async () => {
    const { planner } = fauxPlanner();
    const sessionId = 'sess-recovery-replay';
    const projectDir = mkdtempSync(join(tmpdir(), 'native-recovery-replay-'));
    try {
      ensureSessionDir(projectDir, sessionId);
      let state = recoveryState(sessionId);
      saveState({ projectDir, sessionId }, state);
      const queued = queueRecoveryInput(
        recoveryFor(sessionId),
        {
          inputId: message.id,
          epochId: 'epoch-native',
          sequence: 1,
          kind: 'native-injection',
          source: 'native-injection',
          payload: message.text,
          base: recoveryBrief,
          operationId: null,
        },
        '2026-08-13T00:00:00.000Z',
      );
      if (queued.input === null) throw new Error('recovery input fixture was not queued');
      const applied = replayedInput(queued.input);
      const binding = controllerReturning(sessionId, (input) => ({
        version: 1,
        sessionId,
        epochId: input.epochId,
        kind: 'replayed',
        input: applied,
        projection: projection(sessionId, recoveryFor(sessionId)),
      }));

      planner.injectUserTurn = vi.fn(async () => ({ inputTokens: 99, outputTokens: 9 }));
      const result = await dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus: createEventBus(),
        recovery: { controller: binding.controller, authority: authority(sessionId) },
      });

      expect(result).toEqual({ status: 'delivered' });
      expect(planner.injectUserTurn).not.toHaveBeenCalled();
      expect(state.messageQueue[0]?.nativeDeliveryState).toBe('delivered');
      expect(state.tokenUsage.plannerInput).toBe(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

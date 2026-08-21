import { describe, it, expect, afterEach, vi } from 'vitest';
import type { WorkflowState, QueuedMessage } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryController,
  QueueBriefInput,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import { createBriefRecoveryState, inspectBriefRecovery } from '../planning/brief-recovery.js';
import type { QueueResultV1 } from '../../../core/approval/types.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { setupProject, makeResearchingState } from '#testing/helpers/queue.js';
import { createWriteSequencer } from '../serial-executor.js';
import { transitionAndSave } from '../state-ops.js';
import { createQueueHandler } from './submit.js';
import { readQueueForPrompt, releaseQueueMessagesForPrompt } from './drain.js';

let dirs: string[] = [];

const recoveryBrief = { revision: 1, hash: 'brief-submit', path: 'tasks.md' } as const;

function recoveryFor(sessionId: string) {
  const input: BriefAdmissionInput = {
    sessionId,
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: recoveryBrief,
    report: {
      briefHash: recoveryBrief.hash,
      report: { revision: 1, hash: 'report-submit', path: 'brief-quality.json' },
      ruleVersion: 'quality-v1',
      issues: [],
      errorCount: 0,
    },
    qualityPolicyVersion: 'quality-v1',
  };
  return createBriefRecoveryState(input, { epochId: 'epoch-submit' });
}

function authority(sessionId: string): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: 'owner-submit',
    pid: 1,
    processStart: 'process-submit',
    runId: 'run-submit',
    acquisitionId: 'acquisition-submit',
    fence: 1,
    stateRevision: 0,
    stateDigest: 'digest-submit',
  };
}

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('enqueue', () => {
  it('enqueues a message into state and emits message-queued event', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler('hello world', 'researching');

    expect(result.status).toBe('accepted');
    expect(state?.messageQueue).toHaveLength(1);
    expect(state?.messageQueue[0]?.text).toBe('hello world');
    expect(state?.messageQueue[0]?.phase).toBe('researching');
    expect(state?.messageQueue[0]?.deliveredViaNative).toBe(false);
    expect(events.find((e) => e.type === 'message_queued')).toBeDefined();
  });

  it('emits a redacted preview for queued messages', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler('token sk-proj-abcdefghijklmnopqrstuvwxyz', 'researching');

    expect(result.status).toBe('accepted');
    const queued = events.find((event) => event.type === 'message_queued');
    if (queued?.type !== 'message_queued') throw new Error('message_queued missing');
    expect(queued.preview).toContain('sk-***REDACTED***');
    expect(queued.preview).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('delivers queued input natively when the planner supports injection', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus } = makeBusRecorder();
    const injectedTurns: Array<{ text: string; dir: string }> = [];
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      injectUserTurn: async (injection) => {
        injectedTurns.push({ text: injection.text, dir: injection.projectDir });
        return null;
      },
    });

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler('inject me', 'researching');

    await new Promise((r) => setTimeout(r, 0));

    expect(result.status).toBe('accepted');
    expect(injectedTurns).toHaveLength(1);
    expect(injectedTurns[0]?.text).toBe('inject me');
    expect(injectedTurns[0]?.dir).toBe(projectDir);
  });

  it('passes recovery ownership to the native adapter and keeps refused input queued', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const recovery = recoveryFor(sessionId);
    let state: WorkflowState | undefined = {
      ...makeResearchingState(),
      phase: 'reviewing-briefs',
      briefRecovery: recovery,
    };
    const { bus } = makeBusRecorder();
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      injectUserTurn: vi.fn(async () => ({ inputTokens: 17, outputTokens: 3 })),
    });
    const queueBriefInput = vi.fn(
      async (input: QueueBriefInput): Promise<QueueResultV1> => ({
        version: 1,
        sessionId,
        epochId: input.epochId,
        kind: 'conflict',
        code: 'brief_intent_conflict',
        inputId: input.inputId,
        reason: 'current epoch was edited before dispatch',
        projection: inspectBriefRecovery({
          sessionId,
          stateRevision: recovery.recoveryRevision,
          state: recovery,
        }),
      }),
    );
    const controller: BriefRecoveryController = {
      inspectBriefRecovery: () =>
        inspectBriefRecovery({
          sessionId,
          stateRevision: recovery.recoveryRevision,
          state: recovery,
        }),
      enterBriefAdmission: async () => {
        throw new Error('unused in queue submission');
      },
      dispatchBriefAction: async () => {
        throw new Error('unused in queue submission');
      },
      queueBriefInput,
      settlePlannerAttempt: async () => {
        throw new Error('unused in queue submission');
      },
      migrateBriefRecovery: async () => {
        throw new Error('unused in queue submission');
      },
    };
    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
      recovery: { controller, authority: authority(sessionId) },
    });

    const result = await handler('hold me', 'researching');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe('accepted');
    expect(queueBriefInput).toHaveBeenCalledTimes(1);
    expect(queueBriefInput.mock.calls[0]?.[0]).toMatchObject({
      kind: 'native-injection',
      source: 'native-injection',
      epochId: 'epoch-submit',
      operationId: null,
    });
    expect(planner.injectUserTurn).not.toHaveBeenCalled();
    expect(state?.messageQueue[0]?.nativeDeliveryState).toBe('pending');

    const prompt = readQueueForPrompt({ projectDir, sessionId, state: state! });
    expect(prompt.messages).toHaveLength(1);
    releaseQueueMessagesForPrompt({ projectDir, sessionId }, prompt.messages);
  });

  it('does not enqueue when state getter returns undefined', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: false,
        supportsHintEscalation: false,
        supportsSessionResume: false,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      injectUserTurn: async () => null,
    });
    let writtenState: WorkflowState | undefined;
    const setState = (s: WorkflowState) => {
      writtenState = s;
    };

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => undefined,
      setState,
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler('no state', 'researching');

    expect(result.status).toBe('rejected');
    expect(writtenState).toBeUndefined();
    expect(events.find((e) => e.type === 'message_queued')).toBeUndefined();
  });

  it('emits warning and does not enqueue when queue is full', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const fakeMessages: QueuedMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      text: `message ${i}`,
      queuedAt: new Date().toISOString(),
      phase: 'researching' as const,
      deliveredViaNative: false,
      nativeDeliveryState: 'pending' as const,
    }));
    state = { ...state!, messageQueue: fakeMessages };

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler('overflow', 'researching');

    expect(result).toMatchObject({ status: 'rejected', reason: 'queue-full' });
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(state?.messageQueue).toHaveLength(50);
  });

  it('rejects input outside planner live phases at the shared queue boundary', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = {
      ...makeResearchingState(),
      phase: 'implementing',
    };
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler('should not queue', 'implementing');

    expect(result).toMatchObject({ status: 'rejected', reason: 'phase-unavailable' });
    expect(state?.messageQueue).toHaveLength(0);
    expect(events.find((event) => event.type === 'message_queued')).toBeUndefined();
    const warning = events.find((event) => event.type === 'warning');
    expect(warning).toMatchObject({
      type: 'warning',
      category: 'queue',
      code: 'phase_unavailable',
      transcriptSafe: true,
      message:
        'Queue is only available while the planner is running; current phase is implementing.',
    });
  });

  it('persists later messages before a slow native injection resolves', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus } = makeBusRecorder();
    let releaseFirst: (() => void) | undefined;
    const firstInjection = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let injectionCount = 0;
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      injectUserTurn: async () => {
        injectionCount += 1;
        if (injectionCount === 1) await firstInjection;
        return null;
      },
    });

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
    });

    const first = handler('first', 'researching');
    const second = handler('second', 'researching');
    await new Promise((r) => setTimeout(r, 0));

    await expect(first).resolves.toMatchObject({ status: 'accepted' });
    await expect(second).resolves.toMatchObject({ status: 'accepted' });
    expect(state?.messageQueue.map((m) => m.text)).toEqual(['first', 'second']);
    expect(loadState({ projectDir, sessionId })?.messageQueue.map((m) => m.text)).toEqual([
      'first',
      'second',
    ]);
    releaseFirst?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(injectionCount).toBeGreaterThanOrEqual(1);
  });

  it('serializes concurrent handler invocations so no messages are lost', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus } = makeBusRecorder();
    const planner = makePlanner();
    const serialize = createWriteSequencer();

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize,
    });

    const results = await Promise.all([
      handler('first', 'researching'),
      handler('second', 'researching'),
      handler('third', 'researching'),
    ]);

    expect(results.every((result) => result.status === 'accepted')).toBe(true);
    expect(state?.messageQueue).toHaveLength(3);
    expect(state?.messageQueue.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('preserves queued messages when a later orchestrator transition starts from stale state', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = transitionAndSave(
      { projectDir, sessionId },
      createInitialState('test-feature'),
      { type: 'START' },
    );
    const staleState = state;
    const { bus } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize: createWriteSequencer(),
    });

    await expect(handler('do not drop me', 'researching')).resolves.toMatchObject({
      status: 'accepted',
    });

    state = transitionAndSave({ projectDir, sessionId }, staleState, { type: 'RESEARCH_DONE' });

    expect(state.messageQueue.map((m) => m.text)).toEqual(['do not drop me']);
    expect(state.phase).toBe('specifying');
  });
});

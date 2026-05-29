import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkflowState, QueuedMessage } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import {
  createClearQueueHandler,
  createQueueHandler,
  drainQueue,
  formatDrainedMessages,
  formatMessage,
} from './queue.js';
import { dispatchNativeInjection } from './native-injection.js';
import { collectAndPersistClarifications } from './clarifications.js';
import { createStateSerializer } from './state-serializer.js';
import { transitionAndSave } from './state-ops.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(prefix = 'message-queue-test'): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir(prefix);
  dirs.push(projectDir);
  const sessionId = 'sess-msg-queue';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeResearchingState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  return state;
}

function makeSpecifyingState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  return state;
}

function makeStateWithQueue(messages: Omit<QueuedMessage, 'deliveredViaNative'>[]): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  const fullMessages: QueuedMessage[] = messages.map((m) => ({ ...m, deliveredViaNative: false }));
  return { ...state, messageQueue: fullMessages };
}

function makeMessage(text = 'test message'): QueuedMessage {
  return {
    id: 'msg-test',
    text,
    queuedAt: new Date().toISOString(),
    phase: 'researching',
    deliveredViaNative: false,
  };
}

describe('enqueue', () => {
  it('enqueues a message into state and emits message-queued event', async () => {
    const { projectDir, sessionId } = setupProject();
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
      serialize: createStateSerializer(),
    });

    handler('hello world', 'researching');
    await new Promise((r) => setTimeout(r, 0));

    expect(state?.messageQueue).toHaveLength(1);
    expect(state?.messageQueue[0]?.text).toBe('hello world');
    expect(state?.messageQueue[0]?.phase).toBe('researching');
    expect(state?.messageQueue[0]?.deliveredViaNative).toBe(false);
    expect(events.find((e) => e.type === 'message_queued')).toBeDefined();
  });

  it('delivers queued input natively when the planner supports injection', async () => {
    const { projectDir, sessionId } = setupProject();
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
      injectUserTurn: async (text: string, dir: string) => {
        injectedTurns.push({ text, dir });
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
      serialize: createStateSerializer(),
    });

    handler('inject me', 'researching');

    await new Promise((r) => setTimeout(r, 0));

    expect(injectedTurns).toHaveLength(1);
    expect(injectedTurns[0]?.text).toBe('inject me');
    expect(injectedTurns[0]?.dir).toBe(projectDir);
  });

  it('does not enqueue when state getter returns undefined', async () => {
    const { projectDir, sessionId } = setupProject();
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
      injectUserTurn: async () => {},
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
      serialize: createStateSerializer(),
    });

    handler('no state', 'researching');
    await new Promise((r) => setTimeout(r, 0));

    expect(writtenState).toBeUndefined();
    expect(events.find((e) => e.type === 'message_queued')).toBeUndefined();
  });

  it('emits warning and does not enqueue when queue is full', async () => {
    const { projectDir, sessionId } = setupProject();
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const fakeMessages: QueuedMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      text: `message ${i}`,
      queuedAt: new Date().toISOString(),
      phase: 'researching' as const,
      deliveredViaNative: false,
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
      serialize: createStateSerializer(),
    });

    handler('overflow', 'researching');
    await new Promise((r) => setTimeout(r, 0));

    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(state?.messageQueue).toHaveLength(50);
  });

  it('serializes concurrent handler invocations so no messages are lost', async () => {
    const { projectDir, sessionId } = setupProject();
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus } = makeBusRecorder();
    const planner = makePlanner();
    const serialize = createStateSerializer();

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

    handler('first', 'researching');
    handler('second', 'researching');
    handler('third', 'researching');

    await new Promise((r) => setTimeout(r, 10));

    expect(state?.messageQueue).toHaveLength(3);
    expect(state?.messageQueue.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('preserves queued messages when a later orchestrator transition starts from stale state', async () => {
    const { projectDir, sessionId } = setupProject();
    let state: WorkflowState | undefined = transitionAndSave(
      projectDir,
      sessionId,
      createInitialState('test-feature'),
      { type: 'START', feature: 'test-feature' },
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
      serialize: createStateSerializer(),
    });

    handler('do not drop me', 'researching');
    await new Promise((r) => setTimeout(r, 0));

    state = transitionAndSave(projectDir, sessionId, staleState, { type: 'RESEARCH_DONE' });

    expect(state.messageQueue.map((m) => m.text)).toEqual(['do not drop me']);
    expect(state.phase).toBe('specifying');
  });
});

describe('clear', () => {
  it('removes pending messages from live state and emits queue_cleared', () => {
    const { projectDir, sessionId } = setupProject();
    let state: WorkflowState | undefined = makeStateWithQueue([
      makeMessage('pending'),
      { ...makeMessage('drained'), id: 'msg-drained', drainedAt: new Date().toISOString() },
    ]);
    const { bus, events } = makeBusRecorder();

    const clear = createClearQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
    });

    const count = clear();

    expect(count).toBe(1);
    expect(state?.messageQueue).toEqual([
      expect.objectContaining({ id: 'msg-drained', text: 'drained' }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'queue_cleared',
        count: 1,
        phase: state?.phase,
      }),
    );
  });

  it('clears pending messages from persisted state when caller state is stale', () => {
    const { projectDir, sessionId } = setupProject();
    let state: WorkflowState | undefined = makeResearchingState();
    saveState(
      projectDir,
      sessionId,
      makeStateWithQueue([
        makeMessage('persisted pending'),
        {
          ...makeMessage('persisted drained'),
          id: 'msg-drained',
          drainedAt: new Date().toISOString(),
        },
      ]),
    );
    const { bus } = makeBusRecorder();

    const clear = createClearQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
    });

    const count = clear();

    expect(count).toBe(1);
    expect(state?.messageQueue).toEqual([
      expect.objectContaining({ id: 'msg-drained', text: 'persisted drained' }),
    ]);
  });
});

describe('drain', () => {
  it('returns empty messages and unchanged state when queue is empty', () => {
    const { projectDir, sessionId } = setupProject();
    let state = createInitialState('test-feature');
    state = transition(state, { type: 'START', feature: 'test-feature' });
    const { bus } = makeBusRecorder();

    const result = drainQueue(projectDir, sessionId, state, bus);

    expect(result.messages).toHaveLength(0);
    expect(result.state).toBe(state);
  });

  it('returns pending messages and marks them drained + emits queue-drained event', () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeStateWithQueue([
      {
        id: 'msg-1',
        text: 'first message',
        queuedAt: new Date().toISOString(),
        phase: 'researching',
      },
      {
        id: 'msg-2',
        text: 'second message',
        queuedAt: new Date().toISOString(),
        phase: 'researching',
      },
    ]);
    const { bus, events } = makeBusRecorder();

    const result = drainQueue(projectDir, sessionId, state, bus);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.text).toBe('first message');
    expect(result.messages[1]?.text).toBe('second message');
    expect(result.state.messageQueue.every((m) => m.drainedAt)).toBe(true);

    const drained = events.find((e) => e.type === 'queue_drained');
    expect(drained).toBeDefined();
    if (drained?.type === 'queue_drained') {
      expect(drained.count).toBe(2);
    }
  });

  it('ignores already-drained messages', () => {
    const { projectDir, sessionId } = setupProject();
    const now = new Date().toISOString();
    const state = makeStateWithQueue([
      { id: 'msg-1', text: 'already drained', queuedAt: now, phase: 'researching', drainedAt: now },
      { id: 'msg-2', text: 'pending', queuedAt: now, phase: 'researching' },
    ]);
    const { bus } = makeBusRecorder();

    const result = drainQueue(projectDir, sessionId, state, bus);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe('pending');
  });

  it('drains pending messages from persisted state when caller state is stale', () => {
    const { projectDir, sessionId } = setupProject();
    const staleState = makeResearchingState();
    saveState(projectDir, sessionId, makeStateWithQueue([makeMessage('persisted pending')]));
    const { bus } = makeBusRecorder();

    const result = drainQueue(projectDir, sessionId, staleState, bus);

    expect(result.messages).toEqual([expect.objectContaining({ text: 'persisted pending' })]);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
  });
});

describe('formatMessage', () => {
  it('formats user-input message with [user also says] wrapper', () => {
    const msg: QueuedMessage = {
      id: 'msg-1',
      text: 'add logging',
      queuedAt: new Date().toISOString(),
      phase: 'researching',
      deliveredViaNative: false,
    };
    const result = formatMessage(msg);
    expect(result).toContain('[user also says during researching]');
    expect(result).toContain('add logging');
    expect(result).toContain('[/user also says]');
  });

  it('formats clarification message with [clarification answer] wrapper', () => {
    const msg: QueuedMessage = {
      id: 'msg-2',
      text: 'Yes, JWT',
      queuedAt: new Date().toISOString(),
      phase: 'specifying',
      deliveredViaNative: false,
      origin: 'clarification',
      question: 'Use JWT?',
    };
    const result = formatMessage(msg);
    expect(result).toContain('[clarification answer during specifying]');
    expect(result).toContain('Q: Use JWT?');
    expect(result).toContain('A: Yes, JWT');
    expect(result).toContain('[/clarification answer]');
  });
});

describe('formatDrainedMessages', () => {
  it('returns empty string for empty array', () => {
    expect(formatDrainedMessages([])).toBe('');
  });

  it('formats single message', () => {
    const messages: QueuedMessage[] = [
      {
        id: 'msg-1',
        text: 'add logging',
        queuedAt: new Date().toISOString(),
        phase: 'researching',
        deliveredViaNative: false,
      },
    ];

    const result = formatDrainedMessages(messages);

    expect(result).toContain('add logging');
    expect(result).toContain('User messages received while you were working');
  });

  it('formats multiple messages with numbered list', () => {
    const messages: QueuedMessage[] = [
      {
        id: 'msg-1',
        text: 'first',
        queuedAt: new Date().toISOString(),
        phase: 'researching',
        deliveredViaNative: false,
      },
      {
        id: 'msg-2',
        text: 'second',
        queuedAt: new Date().toISOString(),
        phase: 'specifying',
        deliveredViaNative: false,
      },
    ];

    const result = formatDrainedMessages(messages);

    expect(result).toContain('first');
    expect(result).toContain('second');
    expect(result).toContain('(2)');
  });
});

describe('native injection', () => {
  it('does nothing when planner has no injectUserTurn method', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeResearchingState();
    let writtenState: WorkflowState | undefined;
    const setState = (s: WorkflowState) => {
      writtenState = s;
    };
    const { bus } = makeBusRecorder();
    const planner = makePlanner();

    await dispatchNativeInjection({
      message: makeMessage(),
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState,
      bus,
    });

    expect(writtenState).toBeUndefined();
  });

  it('marks the message delivered after native injection succeeds', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeResearchingState();
    let capturedState: WorkflowState | undefined;
    const setState = (s: WorkflowState) => {
      capturedState = s;
    };
    const { bus, events } = makeBusRecorder();
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
      injectUserTurn: async (text: string, dir: string) => {
        injectedTurns.push({ text, dir });
      },
    });
    const message = makeMessage('inject this');

    await dispatchNativeInjection({
      message,
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState,
      bus,
    });

    expect(injectedTurns).toEqual([{ text: 'inject this', dir: projectDir }]);
    expect(capturedState).toBeDefined();
    expect(events.find((e) => e.type === 'message_injected_native')).toBeDefined();
  });

  it('swallows injectUserTurn errors — state and callbacks untouched', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeResearchingState();
    let writtenState: WorkflowState | undefined;
    const setState = (s: WorkflowState) => {
      writtenState = s;
    };
    const { bus, events } = makeBusRecorder();
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
        throw new Error('injection failed');
      },
    });

    await expect(
      dispatchNativeInjection({
        message: makeMessage(),
        planner,
        projectDir,
        sessionId,
        getState: () => state,
        setState,
        bus,
      }),
    ).resolves.toBeUndefined();

    expect(writtenState).toBeUndefined();
    expect(events.find((e) => e.type === 'message_injected_native')).toBeUndefined();
  });

  it('reads fresh state via getState after awaiting injectUserTurn', async () => {
    const { projectDir, sessionId } = setupProject();
    let state = makeResearchingState();
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
      injectUserTurn: async () => {
        state = transition(state, { type: 'ENQUEUE_USER_MSG', message: makeMessage('concurrent') });
      },
    });

    let capturedState: WorkflowState | undefined;
    await dispatchNativeInjection({
      message: makeMessage('original'),
      planner,
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        capturedState = s;
      },
      bus,
    });

    expect(capturedState).toBeDefined();
    expect(capturedState!.messageQueue.some((m) => m.text === 'concurrent')).toBe(true);
  });
});

describe('clarifications', () => {
  it('enqueues answer with origin:clarification and invokes injectUserTurn for capable planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeSpecifyingState();
    const { bus, events } = makeBusRecorder();
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
      injectUserTurn: async (text: string, dir: string) => {
        injectedTurns.push({ text, dir });
      },
    });
    const questions = [{ id: 'q1', type: 'input' as const, text: 'Use JWT?' }];
    const onQuestionAsked = vi.fn().mockResolvedValue('Yes, use JWT');

    const resultState = await collectAndPersistClarifications({
      questions,
      projectDir,
      sessionId,
      state,
      onQuestionAsked,
      persistTranscript: false,
      bus,
      metadata: null,
      planner,
    });

    expect(resultState.messageQueue).toHaveLength(1);
    const msg = resultState.messageQueue[0];
    if (!msg) throw new Error('expected a queued clarification message');
    expect(msg.origin).toBe('clarification');
    expect(msg.question).toBe('Use JWT?');
    expect(msg.questionId).toBe('q1');
    expect(msg.text).toBe('Yes, use JWT');

    expect(events.find((e) => e.type === 'message_queued')).toBeDefined();

    await new Promise((r) => setTimeout(r, 0));
    expect(injectedTurns).toHaveLength(1);
    const injected = injectedTurns[0];
    if (!injected) throw new Error('expected an injected turn');
    expect(injected.text).toContain('[clarification answer]');
    expect(injected.text).toContain('Q: Use JWT?');
    expect(injected.text).toContain('A: Yes, use JWT');
    expect(injected.dir).toBe(projectDir);
  });

  it('enqueues answer and leaves queue state consistent for a stateless planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeSpecifyingState();
    const { bus } = makeBusRecorder();
    const planner = makePlanner();
    const questions = [{ id: 'q2', type: 'input' as const, text: 'Use sessions?' }];
    const onQuestionAsked = vi.fn().mockResolvedValue('No sessions');

    const resultState = await collectAndPersistClarifications({
      questions,
      projectDir,
      sessionId,
      state,
      onQuestionAsked,
      persistTranscript: false,
      bus,
      metadata: null,
      planner,
    });

    expect(resultState.messageQueue).toHaveLength(1);
    const queued = resultState.messageQueue[0];
    if (!queued) throw new Error('expected a queued message');
    expect(queued.origin).toBe('clarification');
    expect(queued.deliveredViaNative).toBe(false);
  });

  it('returns state unchanged and does not enqueue when phase is not researching/specifying', async () => {
    const { projectDir, sessionId } = setupProject();
    let state = createInitialState('test-feature');
    state = transition(state, { type: 'START', feature: 'test-feature' });
    state = transition(state, { type: 'RESEARCH_DONE' });
    state = transition(state, { type: 'SPEC_DONE' });
    const { bus } = makeBusRecorder();
    const planner = makePlanner();
    const questions = [{ id: 'q3', type: 'input' as const, text: 'Should I use Redis?' }];
    let asked = 0;
    const onQuestionAsked = async () => {
      asked++;
      return 'Yes';
    };

    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const resultState = await collectAndPersistClarifications({
        questions,
        projectDir,
        sessionId,
        state,
        onQuestionAsked,
        persistTranscript: false,
        bus,
        metadata: null,
        planner,
      });

      expect(resultState.messageQueue).toHaveLength(0);
      expect(asked).toBe(0);
      expect(stderrWrites.some((s) => s.includes('clarifications: unexpected phase'))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('publishes clarification_answered, message_queued, and clarifications_collected events when conversational planner provides answers', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeSpecifyingState();
    const { bus, events } = makeBusRecorder();
    const injectUserTurn = vi.fn().mockResolvedValue(undefined);
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      injectUserTurn,
    });
    const questions = [{ id: 'cq1', type: 'input' as const, text: 'Should we use GraphQL?' }];
    const onQuestionAsked = vi.fn().mockResolvedValue('Yes, use GraphQL');

    await collectAndPersistClarifications({
      questions,
      projectDir,
      sessionId,
      state,
      onQuestionAsked,
      persistTranscript: false,
      bus,
      metadata: null,
      planner,
    });

    expect(events.some((e) => e.type === 'clarification_answered')).toBe(true);
    expect(events.some((e) => e.type === 'message_queued')).toBe(true);
    expect(events.some((e) => e.type === 'clarifications_collected')).toBe(true);

    const answeredEvent = events.find((e) => e.type === 'clarification_answered');
    if (!answeredEvent || answeredEvent.type !== 'clarification_answered')
      throw new Error('clarification_answered event missing');
    expect(answeredEvent.questionId).toBe('cq1');
    expect(answeredEvent.answer).toBe('Yes, use GraphQL');

    const collectedEvent = events.find((e) => e.type === 'clarifications_collected');
    if (!collectedEvent || collectedEvent.type !== 'clarifications_collected')
      throw new Error('clarifications_collected event missing');
    expect(collectedEvent.count).toBe(1);
  });
});

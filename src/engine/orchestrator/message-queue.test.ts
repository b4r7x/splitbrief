import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkflowState, QueuedMessage } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createQueueHandler, drainQueue, formatDrainedMessages, formatMessage } from './queue.js';
import { dispatchNativeInjection } from './native-injection.js';
import { collectAndPersistClarifications } from './clarifications.js';

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
  state = transition(state, { type: 'RESEARCH_DONE' }); // → specifying
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
  it('enqueues a message into state and emits message-queued event', () => {
    const { projectDir, sessionId } = setupProject();
    let state: WorkflowState | undefined = makeResearchingState();
    const { callbacks, events } = makeCallbacks();
    const planner = makePlanner();

    const handler = createQueueHandler(
      projectDir,
      sessionId,
      () => state,
      (s) => { state = s; },
      callbacks,
      false,
      planner,
    );

    handler('hello world', 'researching');

    expect(state?.messageQueue).toHaveLength(1);
    expect(state?.messageQueue[0]?.text).toBe('hello world');
    expect(state?.messageQueue[0]?.phase).toBe('researching');
    expect(state?.messageQueue[0]?.deliveredViaNative).toBe(false);
    expect(events.find((e) => e.type === 'message-queued')).toBeDefined();
  });

  it('delivers queued input natively when the planner supports injection', async () => {
    const { projectDir, sessionId } = setupProject();
    let state: WorkflowState | undefined = makeResearchingState();
    const { callbacks } = makeCallbacks();
    const injectUserTurn = vi.fn().mockResolvedValue(undefined);
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
      },
      injectUserTurn,
    });

    const handler = createQueueHandler(
      projectDir,
      sessionId,
      () => state,
      (s) => { state = s; },
      callbacks,
      false,
      planner,
    );

    handler('inject me', 'researching');

    // Give the fire-and-forget dispatch a tick to run.
    await new Promise((r) => setTimeout(r, 0));

    // The planner port (subprocess/network seam) received the enqueued text.
    expect(injectUserTurn).toHaveBeenCalled();
    const [text, dir] = vi.mocked(injectUserTurn).mock.calls[0] ?? [];
    expect(text).toBe('inject me');
    expect(dir).toBe(projectDir);
  });

  it('does not enqueue when state getter returns undefined', () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks, events } = makeCallbacks();
    const injectUserTurn = vi.fn().mockResolvedValue(undefined);
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: false,
        supportsHintEscalation: false,
        supportsSessionResume: false,
      },
      injectUserTurn,
    });
    const setStateSpy = vi.fn();

    const handler = createQueueHandler(
      projectDir,
      sessionId,
      () => undefined,
      setStateSpy,
      callbacks,
      false,
      planner,
    );

    handler('no state', 'researching');

    expect(setStateSpy).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'message-queued')).toBeUndefined();
  });

  it('emits warning and does not enqueue when queue is full', () => {
    const { projectDir, sessionId } = setupProject();
    let state: WorkflowState | undefined = makeResearchingState();
    const { callbacks, events } = makeCallbacks();
    const planner = makePlanner();

    // Pre-fill the queue to MAX_QUEUE_SIZE (50).
    const fakeMessages: QueuedMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      text: `message ${i}`,
      queuedAt: new Date().toISOString(),
      phase: 'researching' as const,
      deliveredViaNative: false,
    }));
    state = { ...state!, messageQueue: fakeMessages };

    const handler = createQueueHandler(
      projectDir,
      sessionId,
      () => state,
      (s) => { state = s; },
      callbacks,
      false,
      planner,
    );

    handler('overflow', 'researching');

    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(state?.messageQueue).toHaveLength(50);
  });
});

describe('drain', () => {
  it('returns empty messages and unchanged state when queue is empty', () => {
    const { projectDir, sessionId } = setupProject();
    let state = createInitialState('test-feature');
    state = transition(state, { type: 'START', feature: 'test-feature' });
    const { callbacks } = makeCallbacks();

    const result = drainQueue(projectDir, sessionId, state, callbacks);

    expect(result.messages).toHaveLength(0);
    expect(result.state).toBe(state);
  });

  it('returns pending messages and marks them drained + emits queue-drained event', () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeStateWithQueue([
      { id: 'msg-1', text: 'first message', queuedAt: new Date().toISOString(), phase: 'researching' },
      { id: 'msg-2', text: 'second message', queuedAt: new Date().toISOString(), phase: 'researching' },
    ]);
    const { callbacks, events } = makeCallbacks();

    const result = drainQueue(projectDir, sessionId, state, callbacks);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.text).toBe('first message');
    expect(result.messages[1]?.text).toBe('second message');
    expect(result.state.messageQueue.every((m) => m.drainedAt)).toBe(true);

    const drained = events.find((e) => e.type === 'queue-drained');
    expect(drained).toBeDefined();
    expect((drained as { count: number }).count).toBe(2);
  });

  it('ignores already-drained messages', () => {
    const { projectDir, sessionId } = setupProject();
    const now = new Date().toISOString();
    const state = makeStateWithQueue([
      { id: 'msg-1', text: 'already drained', queuedAt: now, phase: 'researching', drainedAt: now },
      { id: 'msg-2', text: 'pending', queuedAt: now, phase: 'researching' },
    ]);
    const { callbacks } = makeCallbacks();

    const result = drainQueue(projectDir, sessionId, state, callbacks);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe('pending');
  });
});

describe('formatMessage', () => {
  it('formats user-input message with [user also says] wrapper', () => {
    const msg: QueuedMessage = {
      id: 'msg-1', text: 'add logging', queuedAt: new Date().toISOString(),
      phase: 'researching', deliveredViaNative: false,
    };
    const result = formatMessage(msg);
    expect(result).toContain('[user also says during researching]');
    expect(result).toContain('add logging');
    expect(result).toContain('[/user also says]');
  });

  it('formats clarification message with [clarification answer] wrapper', () => {
    const msg: QueuedMessage = {
      id: 'msg-2', text: 'Yes, JWT', queuedAt: new Date().toISOString(),
      phase: 'specifying', deliveredViaNative: false,
      origin: 'clarification', question: 'Use JWT?',
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
    const messages: QueuedMessage[] = [{
      id: 'msg-1',
      text: 'add logging',
      queuedAt: new Date().toISOString(),
      phase: 'researching',
      deliveredViaNative: false,
    }];

    const result = formatDrainedMessages(messages);

    expect(result).toContain('add logging');
    expect(result).toContain('User messages received while you were working');
  });

  it('formats multiple messages with numbered list', () => {
    const messages: QueuedMessage[] = [
      { id: 'msg-1', text: 'first', queuedAt: new Date().toISOString(), phase: 'researching', deliveredViaNative: false },
      { id: 'msg-2', text: 'second', queuedAt: new Date().toISOString(), phase: 'specifying', deliveredViaNative: false },
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
    const setState = vi.fn();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    // makePlanner() produces a planner without injectUserTurn

    await dispatchNativeInjection(makeMessage(), planner, projectDir, sessionId, state, setState, callbacks);

    expect(setState).not.toHaveBeenCalled();
  });

  it('marks the message delivered after native injection succeeds', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeResearchingState();
    let capturedState: WorkflowState | undefined;
    const setState = (s: WorkflowState) => { capturedState = s; };
    const { callbacks, events } = makeCallbacks();
    const injectUserTurn = vi.fn().mockResolvedValue(undefined);
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
      },
      injectUserTurn,
    });
    const message = makeMessage('inject this');

    await dispatchNativeInjection(message, planner, projectDir, sessionId, state, setState, callbacks);

    expect(injectUserTurn).toHaveBeenCalledWith('inject this', projectDir);
    expect(capturedState).toBeDefined();
    expect(events.find((e) => e.type === 'message-injected-native')).toBeDefined();
  });

  it('swallows injectUserTurn errors — state and callbacks untouched', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeResearchingState();
    const setState = vi.fn();
    const { callbacks, events } = makeCallbacks();
    const injectUserTurn = vi.fn().mockRejectedValue(new Error('injection failed'));
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
      },
      injectUserTurn,
    });

    await expect(
      dispatchNativeInjection(makeMessage(), planner, projectDir, sessionId, state, setState, callbacks),
    ).resolves.toBeUndefined();

    expect(setState).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'message-injected-native')).toBeUndefined();
  });
});

describe('clarifications', () => {
  it('enqueues answer with origin:clarification and invokes injectUserTurn for capable planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeSpecifyingState();
    const { callbacks, events } = makeCallbacks();
    const injectUserTurn = vi.fn().mockResolvedValue(undefined);
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
      },
      injectUserTurn,
    });
    const questions = [{ id: 'q1', type: 'input' as const, text: 'Use JWT?' }];
    const onQuestionAsked = vi.fn().mockResolvedValue('Yes, use JWT');

    const resultState = await collectAndPersistClarifications(
      questions, projectDir, sessionId, state,
      onQuestionAsked, false, null, planner, callbacks,
    );

    expect(resultState.messageQueue).toHaveLength(1);
    const msg = resultState.messageQueue[0];
    if (!msg) throw new Error('expected a queued clarification message');
    expect(msg.origin).toBe('clarification');
    expect(msg.question).toBe('Use JWT?');
    expect(msg.questionId).toBe('q1');
    expect(msg.text).toBe('Yes, use JWT');

    expect(events.find((e) => e.type === 'message-queued')).toBeDefined();

    await new Promise((r) => setTimeout(r, 0));
    expect(injectUserTurn).toHaveBeenCalled();
    const [injectedText, dir] = vi.mocked(injectUserTurn).mock.calls[0] ?? [];
    expect(injectedText).toContain('[clarification answer]');
    expect(injectedText).toContain('Q: Use JWT?');
    expect(injectedText).toContain('A: Yes, use JWT');
    expect(dir).toBe(projectDir);
  });

  it('enqueues answer and leaves queue state consistent for a stateless planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeSpecifyingState();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner(); // no injectUserTurn
    const questions = [{ id: 'q2', type: 'input' as const, text: 'Use sessions?' }];
    const onQuestionAsked = vi.fn().mockResolvedValue('No sessions');

    const resultState = await collectAndPersistClarifications(
      questions, projectDir, sessionId, state,
      onQuestionAsked, false, null, planner, callbacks,
    );

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
    state = transition(state, { type: 'SPEC_DONE' }); // → reviewing-spec (not specifying)
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const questions = [{ id: 'q3', type: 'input' as const, text: 'Should I use Redis?' }];
    const onQuestionAsked = vi.fn().mockResolvedValue('Yes');

    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const resultState = await collectAndPersistClarifications(
      questions, projectDir, sessionId, state,
      onQuestionAsked, false, null, planner, callbacks,
    );

    expect(resultState.messageQueue).toHaveLength(0);
    expect(onQuestionAsked).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

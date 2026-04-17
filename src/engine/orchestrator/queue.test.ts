import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState, QueuedMessage } from '../../core/types/state-actions.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-fixtures.js';

const TEST_PROJECT_DIR = '/mock/project';
const TEST_SESSION_ID = 'test-session';

vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
  appendMessage: vi.fn(),
}));
vi.mock('./events.js', () => ({
  emit: vi.fn(),
}));
vi.mock('./native-injection.js', () => ({
  dispatchNativeInjection: vi.fn().mockResolvedValue(undefined),
}));

import { createQueueHandler, drainQueue, formatDrainedMessages, formatMessage } from './queue.js';
import { dispatchNativeInjection } from './native-injection.js';

function makeResearchingState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  // researching phase
  return state;
}

function makeStateWithQueue(messages: Omit<QueuedMessage, 'deliveredViaNative'>[]): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  const fullMessages: QueuedMessage[] = messages.map(m => ({ ...m, deliveredViaNative: false }));
  return { ...state, messageQueue: fullMessages };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createQueueHandler', () => {
  it('enqueues a message into state', () => {
    let state: WorkflowState | undefined = makeResearchingState();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();

    const handler = createQueueHandler(
      TEST_PROJECT_DIR,
      TEST_SESSION_ID,
      () => state,
      (s) => { state = s; },
      callbacks,
      true,
      planner,
    );

    handler('hello world', 'researching');

    expect(state?.messageQueue).toHaveLength(1);
    expect(state?.messageQueue[0]?.text).toBe('hello world');
    expect(state?.messageQueue[0]?.phase).toBe('researching');
    expect(state?.messageQueue[0]?.deliveredViaNative).toBe(false);
  });

  it('emits message-queued event', () => {
    let state: WorkflowState | undefined = makeResearchingState();
    const { callbacks, events } = makeCallbacks();
    const planner = makePlanner();

    const handler = createQueueHandler(
      TEST_PROJECT_DIR,
      TEST_SESSION_ID,
      () => state,
      (s) => { state = s; },
      callbacks,
      true,
      planner,
    );

    handler('enqueue me', 'researching');

    const queued = events.find(e => e.type === 'message-queued');
    expect(queued).toBeDefined();
  });

  it('calls dispatchNativeInjection for planners with injectUserTurn', () => {
    let state: WorkflowState | undefined = makeResearchingState();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
      },
      injectUserTurn: vi.fn().mockResolvedValue(undefined),
    });

    const handler = createQueueHandler(
      TEST_PROJECT_DIR,
      TEST_SESSION_ID,
      () => state,
      (s) => { state = s; },
      callbacks,
      true,
      planner,
    );

    handler('inject me', 'researching');

    expect(dispatchNativeInjection).toHaveBeenCalledOnce();
    expect(dispatchNativeInjection).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'inject me' }),
      planner,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not call dispatchNativeInjection when state is undefined', () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: false,
        supportsHintEscalation: false,
        supportsSessionResume: false,
      },
      injectUserTurn: vi.fn().mockResolvedValue(undefined),
    });

    const handler = createQueueHandler(
      TEST_PROJECT_DIR,
      TEST_SESSION_ID,
      () => undefined,
      vi.fn(),
      callbacks,
      true,
      planner,
    );

    handler('no state', 'researching');

    expect(dispatchNativeInjection).not.toHaveBeenCalled();
  });

  it('rejects when queue is full', () => {
    let state: WorkflowState | undefined = makeResearchingState();
    const { callbacks, events } = makeCallbacks();
    const planner = makePlanner();

    // Pre-fill the queue
    const fakeMessages: QueuedMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      text: `message ${i}`,
      queuedAt: new Date().toISOString(),
      phase: 'researching' as const,
      deliveredViaNative: false,
    }));
    state = { ...state!, messageQueue: fakeMessages };

    const handler = createQueueHandler(
      TEST_PROJECT_DIR,
      TEST_SESSION_ID,
      () => state,
      (s) => { state = s; },
      callbacks,
      true,
      planner,
    );

    handler('overflow', 'researching');

    const warning = events.find(e => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(state?.messageQueue).toHaveLength(50); // not incremented
  });
});

describe('drainQueue', () => {
  it('returns empty messages and unchanged state when queue is empty', () => {
    let state = createInitialState('test-feature');
    state = transition(state, { type: 'START', feature: 'test-feature' });
    const { callbacks } = makeCallbacks();

    const result = drainQueue(TEST_PROJECT_DIR, TEST_SESSION_ID, state, callbacks);

    expect(result.messages).toHaveLength(0);
    expect(result.state).toBe(state);
  });

  it('returns pending messages and marks them drained', () => {
    const state = makeStateWithQueue([
      { id: 'msg-1', text: 'first message', queuedAt: new Date().toISOString(), phase: 'researching' },
      { id: 'msg-2', text: 'second message', queuedAt: new Date().toISOString(), phase: 'researching' },
    ]);
    const { callbacks } = makeCallbacks();

    const result = drainQueue(TEST_PROJECT_DIR, TEST_SESSION_ID, state, callbacks);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.text).toBe('first message');
    expect(result.messages[1]?.text).toBe('second message');
    // All messages should be marked drained in the new state
    expect(result.state.messageQueue.every(m => m.drainedAt)).toBe(true);
  });

  it('ignores already-drained messages', () => {
    const now = new Date().toISOString();
    const state = makeStateWithQueue([
      { id: 'msg-1', text: 'already drained', queuedAt: now, phase: 'researching', drainedAt: now },
      { id: 'msg-2', text: 'pending', queuedAt: now, phase: 'researching' },
    ]);
    const { callbacks } = makeCallbacks();

    const result = drainQueue(TEST_PROJECT_DIR, TEST_SESSION_ID, state, callbacks);

    // Only the pending message is returned
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe('pending');
  });

  it('emits queue-drained event', () => {
    const state = makeStateWithQueue([
      { id: 'msg-1', text: 'hello', queuedAt: new Date().toISOString(), phase: 'specifying' },
    ]);
    const { callbacks, events } = makeCallbacks();

    drainQueue(TEST_PROJECT_DIR, TEST_SESSION_ID, state, callbacks);

    const drained = events.find(e => e.type === 'queue-drained');
    expect(drained).toBeDefined();
    expect((drained as { count: number }).count).toBe(1);
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

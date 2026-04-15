import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState, QueuedMessage } from '../../types.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-fixtures.js';

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

import { drainQueue, formatDrainedMessages } from './queue-drain.js';

function makeStateWithQueue(messages: Omit<QueuedMessage, 'deliveredViaNative'>[]): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  const fullMessages: QueuedMessage[] = messages.map(m => ({ ...m, deliveredViaNative: false }));
  return { ...state, messageQueue: fullMessages };
}

beforeEach(() => {
  vi.clearAllMocks();
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

    expect(result).toContain('1. first');
    expect(result).toContain('2. second');
    expect(result).toContain('(2)');
  });
});

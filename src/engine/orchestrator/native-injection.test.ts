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

import { dispatchNativeInjection } from './native-injection.js';

function makeMessage(text = 'test message'): QueuedMessage {
  return {
    id: 'msg-test',
    text,
    queuedAt: new Date().toISOString(),
    phase: 'researching',
    deliveredViaNative: false,
  };
}

function makeResearchingState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatchNativeInjection', () => {
  it('does nothing when planner has no injectUserTurn method', async () => {
    const state = makeResearchingState();
    const setState = vi.fn();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    // makePlanner() produces a planner without injectUserTurn

    await dispatchNativeInjection(makeMessage(), planner, TEST_PROJECT_DIR, TEST_SESSION_ID, state, setState, callbacks);

    expect(setState).not.toHaveBeenCalled();
  });

  it('calls injectUserTurn and dispatches MARK_DELIVERED_NATIVE when injectUserTurn exists', async () => {
    const state = makeResearchingState();
    const setState = vi.fn();
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

    await dispatchNativeInjection(message, planner, TEST_PROJECT_DIR, TEST_SESSION_ID, state, setState, callbacks);

    expect(injectUserTurn).toHaveBeenCalledWith('inject this', TEST_PROJECT_DIR);
    expect(setState).toHaveBeenCalledOnce();
    const injectedEvent = events.find(e => e.type === 'message-injected-native');
    expect(injectedEvent).toBeDefined();
  });

  it('does not rethrow when injectUserTurn throws', async () => {
    const state = makeResearchingState();
    const setState = vi.fn();
    const { callbacks } = makeCallbacks();
    const injectUserTurn = vi.fn().mockRejectedValue(new Error('injection failed'));
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
      },
      injectUserTurn,
    });

    // Should not throw
    await expect(
      dispatchNativeInjection(makeMessage(), planner, TEST_PROJECT_DIR, TEST_SESSION_ID, state, setState, callbacks),
    ).resolves.toBeUndefined();

    expect(setState).not.toHaveBeenCalled();
  });

  it('formats clarification message with [clarification answer] block when injecting', async () => {
    const state = makeResearchingState();
    const setState = vi.fn();
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
    const message: QueuedMessage = {
      id: 'msg-clar',
      text: 'Yes use JWT',
      queuedAt: new Date().toISOString(),
      phase: 'specifying',
      deliveredViaNative: false,
      origin: 'clarification',
      question: 'Use JWT?',
      questionId: 'q1',
    };

    await dispatchNativeInjection(message, planner, TEST_PROJECT_DIR, TEST_SESSION_ID, state, setState, callbacks);

    const expectedText = '[clarification answer]\nQ: Use JWT?\nA: Yes use JWT\n[/clarification answer]';
    expect(injectUserTurn).toHaveBeenCalledWith(expectedText, TEST_PROJECT_DIR);
  });
});

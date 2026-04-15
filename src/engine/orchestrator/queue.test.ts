import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState, QueuedMessage } from '../../types.js';
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

import { createQueueHandler } from './queue.js';
import { dispatchNativeInjection } from './native-injection.js';

function makeResearchingState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  // researching phase
  return state;
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

  it('calls dispatchNativeInjection for planners with supportsMidStreamInjection', () => {
    let state: WorkflowState | undefined = makeResearchingState();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
        supportsMidStreamInjection: true,
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
    const [msg, receivedPlanner] = (dispatchNativeInjection as ReturnType<typeof vi.fn>).mock.calls[0] as [QueuedMessage, typeof planner];
    expect(msg.text).toBe('inject me');
    expect(receivedPlanner).toBe(planner);
  });

  it('does not call dispatchNativeInjection when state is undefined', () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: false,
        supportsHintEscalation: false,
        supportsSessionResume: false,
        supportsMidStreamInjection: true,
      },
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

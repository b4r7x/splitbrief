import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState } from '../../types.js';
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
vi.mock('../../core/paths-io.js', () => ({
  readSpecFileOrEmpty: vi.fn().mockReturnValue('# Spec'),
  writeSpecFile: vi.fn(),
}));
vi.mock('./native-injection.js', () => ({
  dispatchNativeInjection: vi.fn().mockResolvedValue(undefined),
}));

import { collectAndPersistClarifications } from './clarifications.js';
import { dispatchNativeInjection } from './native-injection.js';

function makeSpecifyingState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  state = transition(state, { type: 'RESEARCH_DONE' }); // → specifying
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('collectAndPersistClarifications', () => {
  it('enqueues answer with origin:clarification and calls native injection for capable planner', async () => {
    const state = makeSpecifyingState();
    const { callbacks } = makeCallbacks();
    const injectUserTurn = vi.fn().mockResolvedValue(undefined);
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsHintEscalation: false,
        supportsSessionResume: true,
        supportsMidStreamInjection: true,
      },
      injectUserTurn,
    });
    const questions = [
      { id: 'q1', type: 'input' as const, text: 'Use JWT?' },
    ];
    const onQuestionAsked = vi.fn().mockResolvedValue('Yes, use JWT');

    const resultState = await collectAndPersistClarifications(
      questions, TEST_PROJECT_DIR, TEST_SESSION_ID, state,
      onQuestionAsked, true, null, planner, callbacks,
    );

    expect(resultState.messageQueue).toHaveLength(1);
    const msg = resultState.messageQueue[0]!;
    expect(msg.origin).toBe('clarification');
    expect(msg.question).toBe('Use JWT?');
    expect(msg.questionId).toBe('q1');
    expect(msg.text).toBe('Yes, use JWT');

    expect(dispatchNativeInjection).toHaveBeenCalledOnce();
  });

  it('enqueues answer but does not call native injection for stateless planner', async () => {
    const state = makeSpecifyingState();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner(); // supportsMidStreamInjection: false
    const questions = [{ id: 'q2', type: 'input' as const, text: 'Use sessions?' }];
    const onQuestionAsked = vi.fn().mockResolvedValue('No sessions');

    const resultState = await collectAndPersistClarifications(
      questions, TEST_PROJECT_DIR, TEST_SESSION_ID, state,
      onQuestionAsked, true, null, planner, callbacks,
    );

    expect(resultState.messageQueue).toHaveLength(1);
    expect(resultState.messageQueue[0]!.origin).toBe('clarification');
    expect(dispatchNativeInjection).toHaveBeenCalledOnce();
  });

  it('returns state unchanged and does not enqueue when phase is not researching/specifying', async () => {
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
      questions, TEST_PROJECT_DIR, TEST_SESSION_ID, state,
      onQuestionAsked, true, null, planner, callbacks,
    );

    expect(resultState.messageQueue).toHaveLength(0);
    expect(onQuestionAsked).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

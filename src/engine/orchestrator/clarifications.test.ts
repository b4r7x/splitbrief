import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../core/paths-io.js';
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

function makeSpecifyingState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  return state;
}

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
      injectUserTurn: async (injection) => {
        injectedTurns.push({ text: injection.text, dir: injection.projectDir });
        return null;
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
    expect(msg.text).toBe('Yes, use JWT');

    const queuedEvent = events.find((e) => e.type === 'message_queued');
    if (!queuedEvent || queuedEvent.type !== 'message_queued')
      throw new Error('message_queued missing');
    expect(queuedEvent.preview).toBe('clarification: Use JWT? -> Yes, use JWT');

    await new Promise((r) => setTimeout(r, 0));
    expect(injectedTurns).toHaveLength(1);
    const injected = injectedTurns[0];
    if (!injected) throw new Error('expected an injected turn');
    expect(injected.text).toContain('[clarification answer]');
    expect(injected.text).toContain('Q: Use JWT?');
    expect(injected.text).toContain('A: Yes, use JWT');
    expect(injected.dir).toBe(projectDir);

    expect(events.some((e) => e.type === 'clarification_answered')).toBe(true);
    expect(events.some((e) => e.type === 'message_queued')).toBe(true);
    expect(events.some((e) => e.type === 'clarifications_collected')).toBe(true);

    const answeredEvent = events.find((e) => e.type === 'clarification_answered');
    if (!answeredEvent || answeredEvent.type !== 'clarification_answered')
      throw new Error('clarification_answered event missing');
    expect(answeredEvent.answer).toBe('Yes, use JWT');

    const collectedEvent = events.find((e) => e.type === 'clarifications_collected');
    if (!collectedEvent || collectedEvent.type !== 'clarifications_collected')
      throw new Error('clarifications_collected event missing');
    expect(collectedEvent.count).toBe(1);
  });

  it('enqueues answer and leaves queue state consistent for a stateless planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeSpecifyingState();
    const { bus, events } = makeBusRecorder();
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

    const queuedEvent = events.find((e) => e.type === 'message_queued');
    if (!queuedEvent || queuedEvent.type !== 'message_queued')
      throw new Error('message_queued missing');
    expect(queuedEvent.preview).toBe('clarification: Use sessions? -> No sessions');
  });

  it('returns state unchanged and does not enqueue when phase is not researching/specifying', async () => {
    const { projectDir, sessionId } = setupProject();
    let state = createInitialState('test-feature');
    state = transition(state, { type: 'START' });
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
});

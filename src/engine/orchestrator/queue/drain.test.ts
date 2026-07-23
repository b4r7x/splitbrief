import { describe, it, expect, afterEach } from 'vitest';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  setupProject,
  makeResearchingState,
  makeStateWithQueue,
  makeMessage,
} from '#testing/helpers/queue.js';
import { commitQueueMessagesDrained, drainQueue, readQueueForPrompt } from './drain.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('drain', () => {
  it('can read pending messages for a prompt without marking them drained', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = makeStateWithQueue([
      {
        id: 'msg-1',
        text: 'retryable message',
        queuedAt: new Date().toISOString(),
        phase: 'researching',
      },
    ]);

    const result = readQueueForPrompt({ projectDir, sessionId, state });

    expect(result.messages).toEqual([expect.objectContaining({ text: 'retryable message' })]);
    expect(result.state.messageQueue[0]?.drainedAt).toBeUndefined();
  });

  it('commits only successfully applied queue messages as drained', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const drainedAt = new Date().toISOString();
    const first = {
      id: 'msg-1',
      text: 'applied',
      queuedAt: new Date().toISOString(),
      phase: 'researching' as const,
    };
    const second = {
      id: 'msg-2',
      text: 'already drained',
      queuedAt: new Date().toISOString(),
      phase: 'researching' as const,
      drainedAt,
    };
    const state = makeStateWithQueue([first, second]);
    const { bus, events } = makeBusRecorder();
    const firstMessage = state.messageQueue[0];
    const secondMessage = state.messageQueue[1];
    if (firstMessage === undefined || secondMessage === undefined) {
      throw new Error('expected queued messages');
    }

    const result = commitQueueMessagesDrained({
      projectDir,
      sessionId,
      state,
      messages: [firstMessage, secondMessage],
      bus,
    });

    expect(result.count).toBe(1);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(result.state.messageQueue[1]?.drainedAt).toBe(drainedAt);
    const drained = events.find((event) => event.type === 'queue_drained');
    expect(drained).toMatchObject({ type: 'queue_drained', count: 1, ids: ['msg-1'] });
  });

  it('returns empty messages and unchanged state when queue is empty', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state = createInitialState('test-feature');
    state = transition(state, { type: 'START' });
    const { bus } = makeBusRecorder();

    const result = drainQueue({ projectDir, sessionId, state, bus });

    expect(result.messages).toHaveLength(0);
    expect(result.state).toBe(state);
  });

  it('returns pending messages and marks them drained + emits queue-drained event', () => {
    const { projectDir, sessionId } = setupProject(dirs);
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

    const result = drainQueue({ projectDir, sessionId, state, bus });

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
    const { projectDir, sessionId } = setupProject(dirs);
    const now = new Date().toISOString();
    const state = makeStateWithQueue([
      { id: 'msg-1', text: 'already drained', queuedAt: now, phase: 'researching', drainedAt: now },
      { id: 'msg-2', text: 'pending', queuedAt: now, phase: 'researching' },
    ]);
    const { bus } = makeBusRecorder();

    const result = drainQueue({ projectDir, sessionId, state, bus });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe('pending');
  });

  it('drains pending messages from persisted state when caller state is stale', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const staleState = makeResearchingState();
    saveState({ projectDir, sessionId }, makeStateWithQueue([makeMessage('persisted pending')]));
    const { bus } = makeBusRecorder();

    const result = drainQueue({ projectDir, sessionId, state: staleState, bus });

    expect(result.messages).toEqual([expect.objectContaining({ text: 'persisted pending' })]);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
  });

  it('does not drain messages while native injection is in flight', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = {
      ...makeResearchingState(),
      messageQueue: [
        { ...makeMessage('native in flight'), nativeDeliveryState: 'injecting' as const },
      ],
    };
    const { bus } = makeBusRecorder();

    const result = drainQueue({ projectDir, sessionId, state, bus });

    expect(result.messages).toEqual([]);
    expect(result.state.messageQueue[0]?.drainedAt).toBeUndefined();
  });

  it('normalizes persisted in-flight native delivery back to pending on resume', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const staleState = makeResearchingState();
    saveState(
      { projectDir, sessionId },
      {
        ...makeResearchingState(),
        messageQueue: [
          { ...makeMessage('stale in flight'), nativeDeliveryState: 'injecting' as const },
        ],
      },
    );
    const { bus } = makeBusRecorder();

    expect(loadState({ projectDir, sessionId })?.messageQueue[0]?.nativeDeliveryState).toBe(
      'pending',
    );

    const result = drainQueue({ projectDir, sessionId, state: staleState, bus });

    expect(result.messages).toEqual([expect.objectContaining({ text: 'stale in flight' })]);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
  });
});

import { plainUserMessage } from '../../../core/types/user-input.js';

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { recoverInterruptedNativeDeliveries } from '../../../core/queue-state.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  setupProject,
  makeResearchingState,
  makeStateWithQueue,
  makeMessage,
} from '#testing/helpers/queue.js';
import {
  claimQueuedMessage,
  commitQueueMessagesDrained,
  drainQueue,
  drainQueueForReview,
  releaseQueuedMessage,
  readQueueForPrompt,
} from './drain.js';
import { transitionAndSave } from '../state-ops.js';
import { clearPendingQueue } from './clear.js';
import { trackMidCallDelivery } from './mid-call.js';

const stateHead = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }));

vi.mock('../state-ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state-ops.js')>();
  return {
    ...actual,
    readWorkflowStateHead: (ref: Parameters<typeof actual.readWorkflowStateHead>[0]) => {
      const head = actual.readWorkflowStateHead(ref);
      const afterRead = stateHead.afterRead;
      stateHead.afterRead = undefined;
      afterRead?.();
      return head;
    },
  };
});

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('drain', () => {
  it.each(['implementer', 'reviewer'] as const)(
    'persists the %s delivery and mid-call provenance in one revision',
    (destination) => {
      const ref = setupProject(dirs);
      const { bus, events } = makeBusRecorder();
      const state = transitionAndSave(ref, makeResearchingState(), {
        type: 'ENQUEUE_USER_MSG',
        message: makeMessage('keep the delivery atomic'),
      });
      const read = readQueueForPrompt({ ...ref, state });
      const drained = commitQueueMessagesDrained({
        ...ref,
        state: read.state,
        messages: read.messages,
        bus,
        destination,
        via: 'mid-call',
      });

      expect(drained.state.stateRevision).toBe((state.stateRevision ?? 0) + 1);
      expect(loadState(ref)?.messageQueue[0]).toMatchObject({
        deliveredMidCall: true,
        deliveredTo: { [destination]: expect.any(String) },
      });
      expect(events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
    },
  );

  it('marks possible duplicates through the queue machine without restoring cleared messages', () => {
    const ref = setupProject(dirs);
    const { bus } = makeBusRecorder();
    const saved = transitionAndSave(ref, makeResearchingState(), {
      type: 'ENQUEUE_USER_MSG',
      message: makeMessage('possibly received'),
    });
    const marked = transitionAndSave(ref, saved, {
      type: 'MARK_POSSIBLE_DUPLICATE',
      id: 'msg-test',
    });
    expect(loadState(ref)?.messageQueue[0]?.possibleDuplicate).toBe(true);

    clearPendingQueue({ ...ref, state: marked, bus });
    const stale = transitionAndSave(ref, marked, {
      type: 'MARK_POSSIBLE_DUPLICATE',
      id: 'msg-test',
    });
    expect(stale.messageQueue).toEqual([]);
    expect(loadState(ref)?.messageQueue).toEqual([]);
  });

  it('waits for a review mid-call outcome and does not deliver it twice', async () => {
    const ref = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    const state = makeStateWithQueue([makeMessage('already sent to REVIEW')]);
    saveState(ref, state);
    const ack = Promise.withResolvers<void>();
    trackMidCallDelivery(
      ref,
      'msg-test',
      ack.promise.then(() => {
        transitionAndSave(ref, state, {
          type: 'DRAIN_QUEUE',
          ids: ['msg-test'],
          destination: 'reviewer',
        });
      }),
    );
    const pending = drainQueueForReview({ ...ref, state, bus });

    ack.resolve();
    expect((await pending).messages).toEqual([]);
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([]);
  });

  it.each([false, true])(
    'keeps unsaved same-revision workflow fields when draining a queue with messages: %s',
    (queued) => {
      const { projectDir, sessionId } = setupProject(dirs);
      const ref = { projectDir, sessionId };
      const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
      const head = queued
        ? transitionAndSave(ref, saved, {
            type: 'ENQUEUE_USER_MSG',
            message: makeMessage('preserve context'),
          })
        : saved;
      const current = {
        ...head,
        mode: 'speckit' as const,
        approve: 'plan' as const,
        plannerSessionId: 'unsaved-session',
      };
      const { bus } = makeBusRecorder();
      const result = drainQueue({ ...ref, state: current, bus });
      expect(result.state).toMatchObject({
        mode: 'speckit',
        approve: 'plan',
        plannerSessionId: 'unsaved-session',
      });
      if (queued)
        expect(loadState(ref)).toMatchObject({
          mode: 'speckit',
          approve: 'plan',
          plannerSessionId: 'unsaved-session',
        });
    },
  );

  it('keeps a newer persisted rewind when the caller has unsaved fields', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
    saveState(
      ref,
      transition(
        { ...saved, phase: 'reviewing-plan' },
        { type: 'CORRECT_PLAN', comment: 'new direction' },
      ),
    );
    const { bus } = makeBusRecorder();
    expect(
      drainQueue({ ...ref, state: { ...saved, plannerSessionId: 'stale-session' }, bus }).state,
    ).toMatchObject({
      phase: 'reviewing-plan',
      rewindPending: { target: 'plan', comment: 'new direction' },
    });
  });

  it('can read pending messages for a prompt without marking them drained', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = makeStateWithQueue([
      {
        id: 'msg-1',
        ...plainUserMessage('retryable message'),
        queuedAt: new Date().toISOString(),
        phase: 'researching',
      },
    ]);

    const result = readQueueForPrompt({ projectDir, sessionId, state });

    expect(result.messages).toEqual([expect.objectContaining({ text: 'retryable message' })]);
    expect(result.state.messageQueue[0]?.drainedAt).toBeUndefined();
  });

  it('commits only applied messages and publishes their seat and task id', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const drainedAt = new Date().toISOString();
    const first = {
      id: 'msg-1',
      ...plainUserMessage('applied'),
      queuedAt: new Date().toISOString(),
      phase: 'researching' as const,
    };
    const second = {
      id: 'msg-2',
      ...plainUserMessage('already drained'),
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
    claimQueuedMessage({ projectDir, sessionId }, firstMessage.id, 'prompt');

    const result = commitQueueMessagesDrained({
      projectDir,
      sessionId,
      state,
      messages: [firstMessage, secondMessage],
      bus,
      seat: 'build',
      taskId: 'T001',
    });

    expect(result.count).toBe(1);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(result.state.messageQueue[1]?.drainedAt).toBe(drainedAt);
    const drained = events.find((event) => event.type === 'queue_drained');
    expect(drained).toMatchObject({
      type: 'queue_drained',
      count: 1,
      ids: ['msg-1'],
      seat: 'build',
      taskId: 'T001',
    });
  });

  it('acknowledges the claimed message and leaves a message that arrived during the prompt pending', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const a = { ...makeMessage('use JWT'), id: 'msg-a' };
    const b = { ...makeMessage('also add refresh tokens'), id: 'msg-b' };
    saveState(ref, makeStateWithQueue([a]));
    const { bus, events } = makeBusRecorder();

    const read = readQueueForPrompt({ projectDir, sessionId, state: makeResearchingState() });
    expect(read.messages.map((message) => message.id)).toEqual(['msg-a']);
    transitionAndSave(ref, read.state, { type: 'ENQUEUE_USER_MSG', message: b });

    const result = commitQueueMessagesDrained({
      projectDir,
      sessionId,
      state: read.state,
      messages: read.messages,
      bus,
    });

    expect(result.count).toBe(1);
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ count: 1, ids: ['msg-a'] }),
    ]);
    const persisted = loadState(ref)?.messageQueue ?? [];
    expect(persisted.map((message) => [message.id, message.drainedAt !== undefined])).toEqual([
      ['msg-a', true],
      ['msg-b', false],
    ]);
    const next = readQueueForPrompt({ projectDir, sessionId, state: result.state });
    expect(next.messages.map((message) => message.id)).toEqual(['msg-b']);
  });

  it('acknowledges the claimed message while a natively owned arrival stays pending', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const a = { ...makeMessage('use JWT'), id: 'msg-a' };
    const b = { ...makeMessage('native owns this turn'), id: 'msg-b' };
    saveState(ref, makeStateWithQueue([a]));
    const { bus, events } = makeBusRecorder();

    const read = readQueueForPrompt({ projectDir, sessionId, state: makeResearchingState() });
    transitionAndSave(ref, read.state, { type: 'ENQUEUE_USER_MSG', message: b });
    expect(claimQueuedMessage(ref, b.id, 'native')).toBe(true);

    try {
      const result = commitQueueMessagesDrained({
        projectDir,
        sessionId,
        state: read.state,
        messages: read.messages,
        bus,
      });

      expect(result.count).toBe(1);
      expect(events.find((event) => event.type === 'queue_drained')).toMatchObject({
        count: 1,
        ids: ['msg-a'],
      });
      const persisted = loadState(ref)?.messageQueue ?? [];
      expect(persisted.map((message) => [message.id, message.drainedAt !== undefined])).toEqual([
        ['msg-a', true],
        ['msg-b', false],
      ]);
    } finally {
      releaseQueuedMessage(ref, b.id, 'native');
    }
  });

  it('does not resurrect a claimed message cleared before its commit', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const a = { ...makeMessage('use JWT'), id: 'msg-a' };
    saveState(ref, makeStateWithQueue([a]));
    const { bus, events } = makeBusRecorder();

    const read = readQueueForPrompt({ projectDir, sessionId, state: makeResearchingState() });
    clearPendingQueue({ projectDir, sessionId, state: read.state, bus });

    const result = commitQueueMessagesDrained({
      projectDir,
      sessionId,
      state: read.state,
      messages: read.messages,
      bus,
    });

    expect(result.count).toBe(0);
    expect(result.state.messageQueue).toEqual([]);
    expect(events.some((event) => event.type === 'queue_drained')).toBe(false);
    expect(loadState(ref)?.messageQueue).toEqual([]);
    expect(readQueueForPrompt({ projectDir, sessionId, state: result.state }).messages).toEqual([]);
  });

  it('refuses the acknowledgement when the state revision moves under it and releases the claim', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const a = { ...makeMessage('use JWT'), id: 'msg-a' };
    const b = { ...makeMessage('also add refresh tokens'), id: 'msg-b' };
    saveState(ref, makeStateWithQueue([a]));
    const { bus, events } = makeBusRecorder();

    const read = readQueueForPrompt({ projectDir, sessionId, state: makeResearchingState() });
    stateHead.afterRead = () => {
      transitionAndSave(ref, read.state, { type: 'ENQUEUE_USER_MSG', message: b });
    };

    expect(() =>
      commitQueueMessagesDrained({
        projectDir,
        sessionId,
        state: read.state,
        messages: read.messages,
        bus,
      }),
    ).toThrow(expect.objectContaining({ kind: 'state-conflict' }));

    expect(events.some((event) => event.type === 'queue_drained')).toBe(false);
    const persisted = loadState(ref)?.messageQueue ?? [];
    expect(persisted.map((message) => [message.id, message.drainedAt !== undefined])).toEqual([
      ['msg-a', false],
      ['msg-b', false],
    ]);
    const next = readQueueForPrompt({ projectDir, sessionId, state: read.state });
    expect(next.messages.map((message) => message.id)).toEqual(['msg-a', 'msg-b']);
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

  it('drains pending messages and forwards the seat and task id to the event', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = makeStateWithQueue([
      {
        id: 'msg-1',
        ...plainUserMessage('first message'),
        queuedAt: new Date().toISOString(),
        phase: 'researching',
      },
      {
        id: 'msg-2',
        ...plainUserMessage('second message'),
        queuedAt: new Date().toISOString(),
        phase: 'researching',
      },
    ]);
    const { bus, events } = makeBusRecorder();

    const result = drainQueue({ projectDir, sessionId, state, bus, seat: 'build', taskId: 'T001' });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.text).toBe('first message');
    expect(result.messages[1]?.text).toBe('second message');
    expect(result.state.messageQueue.every((m) => m.drainedAt)).toBe(true);

    expect(events.find((e) => e.type === 'queue_drained')).toMatchObject({
      type: 'queue_drained',
      count: 2,
      seat: 'build',
      taskId: 'T001',
    });
  });

  it('ignores already-drained messages', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const now = new Date().toISOString();
    const state = makeStateWithQueue([
      {
        id: 'msg-1',
        ...plainUserMessage('already drained'),
        queuedAt: now,
        phase: 'researching',
        drainedAt: now,
      },
      { id: 'msg-2', ...plainUserMessage('pending'), queuedAt: now, phase: 'researching' },
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

  it('keeps a live native owner out of prompt drain across a persisted rebase', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const staleState = makeResearchingState();
    const ref = { projectDir, sessionId };
    const queued = makeMessage('native owns this turn');
    const pending = makeStateWithQueue([queued]);
    saveState(ref, pending);
    expect(claimQueuedMessage(ref, queued.id, 'native')).toBe(true);

    try {
      const injecting = transitionAndSave(ref, pending, {
        type: 'MARK_INJECTING_NATIVE',
        id: queued.id,
      });
      const { bus } = makeBusRecorder();
      const inFlight = drainQueue({ projectDir, sessionId, state: staleState, bus });

      expect(inFlight.messages).toEqual([]);

      const delivered = transitionAndSave(ref, injecting, {
        type: 'MARK_DELIVERED_NATIVE',
        id: queued.id,
      });
      const afterDelivery = readQueueForPrompt({
        projectDir,
        sessionId,
        state: delivered,
      });
      expect(afterDelivery.messages).toEqual([]);

      const failedQueued = { ...queued, id: 'msg-failed', text: 'retry after native failure' };
      const pendingAgain = { ...pending, messageQueue: [failedQueued] };
      saveState(ref, pendingAgain);
      expect(claimQueuedMessage(ref, failedQueued.id, 'native')).toBe(true);
      const injectingAgain = transitionAndSave(ref, pendingAgain, {
        type: 'MARK_INJECTING_NATIVE',
        id: failedQueued.id,
      });
      const failed = transitionAndSave(ref, injectingAgain, {
        type: 'MARK_NATIVE_DELIVERY_FAILED',
        id: failedQueued.id,
      });
      releaseQueuedMessage(ref, failedQueued.id, 'native');
      const afterFailure = readQueueForPrompt({
        projectDir,
        sessionId,
        state: failed,
      });
      expect(afterFailure.messages).toEqual([expect.objectContaining({ id: failedQueued.id })]);
    } finally {
      releaseQueuedMessage(ref, queued.id, 'native');
    }
  });

  it('preserves live injecting state on load and recovers it only at a resume boundary', () => {
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

    const loaded = loadState({ projectDir, sessionId });
    expect(loaded?.messageQueue[0]?.nativeDeliveryState).toBe('injecting');
    if (loaded === null) throw new Error('expected persisted workflow state');
    saveState({ projectDir, sessionId }, recoverInterruptedNativeDeliveries(loaded));

    const result = drainQueue({ projectDir, sessionId, state: staleState, bus });

    expect(result.messages).toEqual([expect.objectContaining({ text: 'stale in flight' })]);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
  });

  it('marks the implementer destination on drain', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const state = makeStateWithQueue([makeMessage('use UTC everywhere')]);
    const { bus } = makeBusRecorder();

    const drained = drainQueue({ projectDir, sessionId, state, bus });

    expect(drained.messages.map((message) => message.text)).toEqual(['use UTC everywhere']);
    const persisted = loadState(ref)?.messageQueue ?? [];
    expect(persisted[0]?.deliveredTo?.implementer).toBeDefined();
  });

  it('does not drain a message again once the implementer destination is recorded', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = makeStateWithQueue([makeMessage('use UTC everywhere')]);
    const { bus } = makeBusRecorder();

    const first = drainQueue({ projectDir, sessionId, state, bus });
    const second = drainQueue({ projectDir, sessionId, state: first.state, bus });

    expect(second.messages).toEqual([]);
  });

  it('keeps text consumed by a scheduled review pending for the next implementer boundary', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const state = makeStateWithQueue([makeMessage('use UTC everywhere')]);
    const { bus, events } = makeBusRecorder();

    const reviewed = await drainQueueForReview({ projectDir, sessionId, state, bus });

    expect(reviewed.messages.map((message) => message.text)).toEqual(['use UTC everywhere']);
    const persisted = loadState(ref)?.messageQueue ?? [];
    expect(persisted[0]?.deliveredTo?.reviewer).toBeDefined();
    expect(persisted[0]?.deliveredTo?.implementer).toBeUndefined();
    expect(persisted[0]?.drainedAt).toBeUndefined();
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ seat: 'review', count: 1, ids: ['msg-test'] }),
    ]);

    const secondReview = await drainQueueForReview({
      projectDir,
      sessionId,
      state: reviewed.state,
      bus,
    });
    expect(secondReview.messages).toEqual([]);
    expect(events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);

    const steer = drainQueue({ projectDir, sessionId, state: reviewed.state, bus });
    expect(steer.messages.map((message) => message.text)).toEqual(['use UTC everywhere']);
  });

  it('leaves text pending when the attempt fails between reading and dispatch and the restart delivers it once', () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    saveState(ref, makeStateWithQueue([makeMessage('use UTC everywhere')]));
    const { bus } = makeBusRecorder();

    const first = readQueueForPrompt({ projectDir, sessionId, state: makeResearchingState() });
    expect(first.messages.map((message) => message.text)).toEqual(['use UTC everywhere']);
    const beforeDispatch = loadState(ref)?.messageQueue ?? [];
    expect(beforeDispatch[0]?.drainedAt).toBeUndefined();
    expect(beforeDispatch[0]?.deliveredTo?.implementer).toBeUndefined();
    for (const message of first.messages) releaseQueuedMessage(ref, message.id, 'prompt');

    const restart = readQueueForPrompt({ projectDir, sessionId, state: first.state });
    expect(restart.messages.map((message) => message.text)).toEqual(['use UTC everywhere']);
    const delivered = commitQueueMessagesDrained({
      projectDir,
      sessionId,
      state: restart.state,
      messages: restart.messages,
      bus,
    });
    expect(delivered.count).toBe(1);
    const afterDispatch = loadState(ref)?.messageQueue ?? [];
    expect(afterDispatch[0]?.drainedAt).toBeDefined();
    expect(afterDispatch[0]?.deliveredTo?.implementer).toBeDefined();

    const repeat = commitQueueMessagesDrained({
      projectDir,
      sessionId,
      state: delivered.state,
      messages: restart.messages,
      bus,
    });
    expect(repeat.count).toBe(0);
  });
});

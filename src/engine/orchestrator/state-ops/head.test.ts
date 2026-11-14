import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeLegacyV3State } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeQueuedMessage, setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../../../core/paths.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue/state.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { clearPendingQueue } from '../queue/clear.js';
import { readQueueForPrompt, releaseQueuedMessage } from '../queue/drain.js';
import { enqueueUserMessage } from '../queue/enqueue.js';
import { dispatchNativeInjection } from '../queue/native-injection.js';
import { readWorkflowStateHead, rebaseOnPersistedWorkflowState } from './head.js';
import { transitionAndSave } from './transition.js';

describe('rebaseOnPersistedWorkflowState', () => {
  it.each([false, true])('preserves a persisted clear with keepUnsaved=%s', (keepUnsaved) => {
    const ref = setupProject();
    try {
      const { bus } = makeBusRecorder();
      const stale = transitionAndSave(ref, createInitialState('feature'), {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });
      clearPendingQueue({ ...ref, state: stale, bus });

      const rebased = rebaseOnPersistedWorkflowState(ref, stale, { keepUnsaved });

      expect(rebased.messageQueue).toEqual([]);
      expect(loadState(ref)?.messageQueue).toEqual([]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('keeps an enqueue that has not been saved at the current revision', () => {
    const ref = setupProject();
    try {
      const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
      const unsaved = transition(saved, {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });

      const rebased = rebaseOnPersistedWorkflowState(ref, unsaved, { keepUnsaved: true });

      expect(rebased.messageQueue).toEqual([makeQueuedMessage()]);
      expect(loadState(ref)?.messageQueue).toEqual([]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('keeps persisted delivery markers when the caller still holds a pending message', () => {
    const ref = setupProject();
    try {
      const stale = transitionAndSave(ref, createInitialState('feature'), {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });
      const drained = transitionAndSave(ref, stale, { type: 'DRAIN_QUEUE' });

      const rebased = rebaseOnPersistedWorkflowState(ref, stale, { keepUnsaved: true });

      expect(rebased.messageQueue).toEqual(drained.messageQueue);
      expect(rebased.messageQueue.some(isQueuedMessagePendingDelivery)).toBe(false);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('prefers persisted rewindPending and phase over stale in-memory state', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      let staleState = createInitialState('feature');
      staleState = transition(staleState, { type: 'START' });
      saveState({ projectDir, sessionId }, staleState);

      staleState = transition(staleState, {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });
      saveState(
        { projectDir, sessionId },
        transition(
          { ...staleState, phase: 'reviewing-plan' },
          { type: 'CORRECT_PLAN', comment: 'revise the approach' },
        ),
      );

      const rebased = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, staleState);

      expect(rebased.phase).toBe('reviewing-plan');
      expect(rebased.rewindPending).toEqual({ target: 'plan', comment: 'revise the approach' });
      expect(rebased.messageQueue).toEqual([expect.objectContaining({ id: 'msg-one' })]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('queue callers after a persisted clear', () => {
  it.each(['enqueue', 'clear', 'prompt', 'native'] as const)(
    'does not restore a cleared message through %s',
    async (caller) => {
      const ref = setupProject();
      try {
        const { bus } = makeBusRecorder();
        const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
        const stale = enqueueUserMessage({
          ...ref,
          state: saved,
          message: plainUserMessage('cleared correction'),
          phase: saved.phase,
          bus,
          reviewNone: false,
        }).state;
        clearPendingQueue({ ...ref, state: stale, bus });

        if (caller === 'enqueue') {
          const submitted = enqueueUserMessage({
            ...ref,
            state: stale,
            message: plainUserMessage('new correction'),
            phase: stale.phase,
            bus,
            reviewNone: false,
          });
          expect(submitted.result.status).toBe('accepted');
          expect(submitted.state.messageQueue.map((message) => message.text)).toEqual([
            'new correction',
          ]);
        } else if (caller === 'clear') {
          expect(clearPendingQueue({ ...ref, state: stale, bus })).toMatchObject({
            count: 0,
            state: { messageQueue: [] },
          });
        } else if (caller === 'prompt') {
          const read = readQueueForPrompt({ ...ref, state: stale });
          for (const message of read.messages) releaseQueuedMessage(ref, message.id, 'prompt');
          expect(read.messages).toEqual([]);
          expect(read.state.messageQueue).toEqual([]);
        } else {
          const message = stale.messageQueue[0];
          if (message === undefined) throw new Error('missing enqueued message');
          const injectUserTurn = vi.fn().mockResolvedValue({ status: 'delivered', usage: null });
          const result = await dispatchNativeInjection({
            ...ref,
            message,
            planner: makePlanner({ injectUserTurn }),
            getState: () => stale,
            setState: vi.fn(),
            bus,
          });
          expect(result).toEqual({ status: 'not-delivered', reason: 'cleared' });
          expect(injectUserTurn).not.toHaveBeenCalled();
        }
        expect(loadState(ref)?.messageQueue.map((message) => message.text)).toEqual(
          caller === 'enqueue' ? ['new correction'] : [],
        );
      } finally {
        cleanupTempDir(ref.projectDir);
      }
    },
  );
});

describe('a state saved as v3', () => {
  function setupV3(): { ref: { projectDir: string; sessionId: string }; file: string } {
    const ref = setupProject();
    const file = join(sessionDir(ref.projectDir, ref.sessionId), 'state.json');
    writeFileSync(file, JSON.stringify(makeLegacyV3State('v3 run')));
    return { ref, file };
  }

  it('reads as the v4 state it loads as, with the revision of its own bytes', () => {
    const { ref, file } = setupV3();
    try {
      const head = readWorkflowStateHead(ref);

      expect(head?.state).toEqual(loadState(ref));
      expect(head?.state.stateVersion).toBe(4);
      expect(head?.digest).toBe(createHash('sha256').update(readFileSync(file)).digest('hex'));
      // An open run, never ready to apply: a v3 run has no workspace.
      const state = head?.state ?? createInitialState('none');
      expect(deriveRunStatus({ reviewNone: false, state, liveness: 'not-alive' }).kind).toBe(
        'open',
      );
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('hands a correction it queued to the next prompt', () => {
    const ref = setupProject();
    const file = join(sessionDir(ref.projectDir, ref.sessionId), 'state.json');
    writeFileSync(
      file,
      JSON.stringify({ ...makeLegacyV3State('v3 run'), messageQueue: [makeQueuedMessage()] }),
    );
    try {
      const loaded = loadState(ref);
      if (loaded === null) throw new Error('the v3 state did not load');

      const read = readQueueForPrompt({ ...ref, state: loaded });

      expect(read.messages.map((message) => message.text)).toEqual([
        'queued while planner was running',
      ]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });
});

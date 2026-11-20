import { describe, expect, it } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeQueuedMessage, setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { clearPendingQueue } from '../queue/clear.js';
import { transitionAndSave } from './transition.js';

describe('transitionAndSave', () => {
  it.each(['transition', 'queue'] as const)(
    'does not persist a cleared message through a stale %s writer',
    (writer) => {
      const ref = setupProject();
      try {
        const { bus } = makeBusRecorder();
        const stale = transitionAndSave(ref, createInitialState('feature'), {
          type: 'ENQUEUE_USER_MSG',
          message: makeQueuedMessage(),
        });
        const cleared = clearPendingQueue({ ...ref, state: stale, bus }).state;
        const next =
          writer === 'queue'
            ? transitionAndSave(
                ref,
                stale,
                { type: 'MARK_INJECTING_NATIVE', id: makeQueuedMessage().id },
                { expectedRevision: cleared.stateRevision },
              )
            : transitionAndSave(ref, stale, { type: 'START' });

        expect(next.messageQueue).toEqual([]);
        expect(loadState(ref)?.messageQueue).toEqual([]);
      } finally {
        cleanupTempDir(ref.projectDir);
      }
    },
  );

  it('saves an enqueue that the caller has not saved yet', () => {
    const ref = setupProject();
    try {
      const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
      const unsaved = transition(saved, {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });

      const next = transitionAndSave(ref, unsaved, { type: 'PLAN_DONE', tasks: [] });

      expect(next.messageQueue).toEqual([makeQueuedMessage()]);
      expect(loadState(ref)?.messageQueue).toEqual([makeQueuedMessage()]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('applies transitions to the latest persisted state so queued messages are not lost', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      let staleState = createInitialState('feature');
      staleState = transition(staleState, { type: 'START' });
      saveState({ projectDir, sessionId }, { ...staleState, messageQueue: [makeQueuedMessage()] });

      const next = transitionAndSave({ projectDir, sessionId }, staleState, {
        type: 'PLAN_DONE',
        tasks: [],
      });

      expect(next.phase).toBe('reviewing-plan');
      expect(next.messageQueue).toEqual([expect.objectContaining({ id: 'msg-one' })]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

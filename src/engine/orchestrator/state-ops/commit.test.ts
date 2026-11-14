import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeQueuedMessage, setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../../../core/paths.js';
import { resumeStep } from '../../../core/sessions/run/status.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { stateOpsError } from './errors.js';
import { transitionAndSave, transitionsAndSave } from './transition.js';

describe('a state write that fails', () => {
  it('names state.json and the cause in plain words', () => {
    const ref = setupProject();
    const dir = sessionDir(ref.projectDir, ref.sessionId);
    const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
    chmodSync(dir, 0o555);
    try {
      expect(() =>
        transitionAndSave(ref, saved, {
          type: 'INTERRUPT_STEP',
          step: resumeStep(saved, false),
          source: 'user',
          cut: 'mid-step',
        }),
      ).toThrow(
        'Could not save the run state: permission denied · .splitbrief/sessions/sess-state-ops/state.json',
      );
    } finally {
      chmodSync(dir, 0o755);
      cleanupTempDir(ref.projectDir);
    }
  });

  it('names state.json in plain words when it cannot read it before the write', () => {
    const ref = setupProject();
    const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
    writeFileSync(join(sessionDir(ref.projectDir, ref.sessionId), 'state.json'), '{"tru');
    try {
      expect(() =>
        transitionAndSave(ref, saved, {
          type: 'INTERRUPT_STEP',
          step: resumeStep(saved, false),
          source: 'user',
          cut: 'mid-step',
        }),
      ).toThrow(
        'Could not read the run state: it could not be read, or its content is not valid · .splitbrief/sessions/sess-state-ops/state.json',
      );
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('says in plain words when a written state cannot be confirmed', () => {
    const { message } = stateOpsError.durabilityUncertain('sess-state-ops');
    expect(message).toBe(
      'Saved the run state, but could not confirm it on disk · .splitbrief/sessions/sess-state-ops/state.json',
    );
  });

  it('says in plain words when another write lands before a change is saved', () => {
    const ref = setupProject();
    try {
      const initial = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
      transitionAndSave(ref, initial, { type: 'ENQUEUE_USER_MSG', message: makeQueuedMessage() });
      expect(() =>
        transitionsAndSave(ref, initial, [(state) => state], {
          expectedRevision: initial.stateRevision ?? 0,
        }),
      ).toThrow(
        'Another process changed the run state, so this change was not saved · .splitbrief/sessions/sess-state-ops/state.json',
      );
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('says in plain words when state conflicts exhaust retries', () => {
    const ref = setupProject();
    try {
      const initial = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
      let counter = 0;
      let caught: unknown;
      try {
        transitionsAndSave(
          ref,
          initial,
          [
            (state) => {
              counter += 1;
              saveState(ref, { ...state, feature: `external-${counter}` });
              return state;
            },
          ],
          { retryWhile: () => true },
        );
      } catch (error) {
        caught = error;
      }
      expect(counter).toBe(2);
      expect(caught).toMatchObject({
        kind: 'state-conflict-exhausted',
        message:
          'Another process kept changing the run state, so this change was not saved · .splitbrief/sessions/sess-state-ops/state.json',
      });
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });
});

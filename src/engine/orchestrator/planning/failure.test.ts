import { afterEach, describe, expect, it } from 'vitest';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';
import { error } from '../../../utils/error.js';
import { handlePlanningFailure } from './failure.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('planning-failure-test');
  dirs.push(projectDir);
  const sessionId = 'sess-planning-failure';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('handlePlanningFailure', () => {
  it('preserves persisted rewind state on abort instead of overwriting it with cancel', () => {
    const { projectDir, sessionId } = setupProject();
    const staleState = { ...createInitialState('feature'), phase: 'planning' as const };
    const persistedState = {
      ...staleState,
      rewindPending: { target: 'plan' as const, comment: TRANSCRIPT_OMITTED_MESSAGE },
    };
    saveState({ projectDir, sessionId }, persistedState);

    const result = handlePlanningFailure({
      err: error('operation-aborted', 'workflow-rewind'),
      projectDir,
      sessionId,
      state: staleState,
      wctx: makeWctx({ projectDir, sessionId }),
    });

    expect(result).toMatchObject({ cancelled: true, failed: false });
    expect(result.state.rewindPending).toEqual({
      target: 'plan',
      comment: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(loadState({ projectDir, sessionId })?.rewindPending).toEqual({
      target: 'plan',
      comment: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(loadState({ projectDir, sessionId })?.phase).toBe('planning');
  });
});

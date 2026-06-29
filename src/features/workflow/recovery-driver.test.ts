import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { saveState } from '../../core/state/persistence.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { createRecoveryDriver } from './recovery-driver.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  resetAllStores();
});

function setupSession(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('recovery-driver-test');
  dirs.push(projectDir);
  const sessionId = 'sess-recovery';
  ensureSessionDir(projectDir, sessionId);
  const state = makeImplState([makeTask({ id: 'T001' })], {
    pendingRecovery: makeRecoveryIssue(),
  });
  saveState({ projectDir, sessionId }, state);
  return { projectDir, sessionId };
}

function makeInputMode(answers: string[]): {
  inputMode: UseInputModeResult;
  feedbackAtPrompt: Array<{ message: string | null; isError: boolean }>;
} {
  const queue = [...answers];
  const feedbackAtPrompt: Array<{ message: string | null; isError: boolean }> = [];
  const inputMode: UseInputModeResult = {
    mode: 'question',
    hint: '',
    questionEpoch: 0,
    setReviewMode: async (): Promise<ApprovalReviewResult> => ({ approved: false }),
    setQuestionMode: async (): Promise<string> => {
      feedbackAtPrompt.push({ ...feedbackStore.get() });
      return queue.shift() ?? '';
    },
    resolve: () => {},
    resetMode: () => {},
  };
  return { inputMode, feedbackAtPrompt };
}

function runDriver(
  projectDir: string,
  sessionId: string,
  inputMode: UseInputModeResult,
): ReturnType<ReturnType<ReturnType<typeof createRecoveryDriver>>> {
  const promptPendingRecovery = createRecoveryDriver()({
    projectDir,
    config: makeConfig(),
    inputMode,
    abortedRef: { current: false },
    setInlineResume: () => {},
  });
  return promptPendingRecovery({
    state: makeImplState([makeTask({ id: 'T001' })], { pendingRecovery: makeRecoveryIssue() }),
    activeSessionId: sessionId,
    controller: new AbortController(),
    republishPrompt: false,
  });
}

describe('createRecoveryDriver — unparseable answers', () => {
  it('re-prompts with an error instead of applying a fallback action when the answer is unknown', async () => {
    const { projectDir, sessionId } = setupSession();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['not-a-real-action', 'pause']);

    const result = await runDriver(projectDir, sessionId, inputMode);

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[0]).toEqual({ message: null, isError: false });
    expect(feedbackAtPrompt[1]).toEqual({ message: 'Unknown recovery action.', isError: true });
    expect(result.shouldRun).toBe(false);
  });

  it('applies a valid action on the first answer without re-prompting', async () => {
    const { projectDir, sessionId } = setupSession();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['pause']);

    const result = await runDriver(projectDir, sessionId, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(false);
    expect(feedbackStore.get().message).toBe('Recovery paused. Resume with diptych resume.');
  });
});

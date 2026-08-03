import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { reactivateExistingSession } from '../../core/sessions/lifecycle.js';
import { saveState } from '../../core/state/persistence.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
  type RunnerGate,
} from '../../engine/runners/prepared-execution.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { createRecoveryDriver } from './recovery-driver.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  resetAllStores();
});

type RecoveryOverrides = Partial<ReturnType<typeof makeRecoveryIssue>>;

function setupSession(recoveryOverrides: RecoveryOverrides = {}): {
  projectDir: string;
  sessionId: string;
} {
  const projectDir = createTempDir('recovery-driver-test');
  dirs.push(projectDir);
  const sessionId = 'sess-recovery';
  ensureSessionDir(projectDir, sessionId);
  const state = makeImplState([makeTask({ id: 'T001' })], {
    pendingRecovery: makeRecoveryIssue(recoveryOverrides),
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
  const prepared = makePreparedExecution(projectDir, sessionId);
  const promptPendingRecovery = createRecoveryDriver()({
    prepared,
    inputMode,
    abortedRef: { current: false },
    setInlineResume: () => {},
  });
  return promptPendingRecovery({
    state: makeImplState([makeTask({ id: 'T001' })], { pendingRecovery: makeRecoveryIssue() }),
    controller: new AbortController(),
    republishPrompt: false,
  });
}

function makePreparedExecution(projectDir: string, sessionId: string): PreparedExecution {
  const ref = { projectDir, sessionId };
  const config = parsePreparedConfig(
    makeConfig({
      planner: { kind: 'agent', command: 'test-planner' },
      implementer: { kind: 'agent', command: 'test-implementer', model: 'test-model' },
    }),
  );
  const preparationId = `recovery-${sessionId}`;
  const gates = [
    {
      kind: 'agent',
      slot: { role: 'planner' },
      preparationId,
      command: { kind: 'validated-config' },
    },
    {
      kind: 'agent',
      slot: { role: 'implementer', profile: 'default' },
      preparationId,
      command: { kind: 'validated-config' },
    },
  ] as const satisfies readonly RunnerGate[];
  const active = reactivateExistingSession(ref);
  return {
    purpose: 'resume',
    config,
    preparationId,
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir,
      status: 'ready',
      counts: { ok: gates.length, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates,
    session: { kind: 'existing', ref, active },
    runtime: {
      feature: 'recovery test',
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
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
    expect(feedbackStore.get().message).toBe('Recovery paused. Resume with splitbrief resume.');
  });

  it('reopens paused recovery and applies the selected action', async () => {
    const { projectDir, sessionId } = setupSession({
      status: 'paused',
      selectedAction: 'pause-run',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['retry-same-worker']);

    const result = await runDriver(projectDir, sessionId, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
    }
  });

  it('replays an applying selected action without prompting', async () => {
    const { projectDir, sessionId } = setupSession({
      status: 'applying',
      selectedAction: 'retry-same-worker',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode([]);

    const result = await runDriver(projectDir, sessionId, inputMode);

    expect(feedbackAtPrompt).toHaveLength(0);
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
    }
  });
});

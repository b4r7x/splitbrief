import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { taskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { reactivateExistingSession } from '../../core/sessions/active-pointer.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import {
  recoveryNoticeStore,
  type RecoveryNoticeState,
} from '../../stores/workflow/recovery-notice.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { createRecoveryDriver } from './recovery-driver.js';
import { addTuiEvent } from './tui-sink.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  resetAllStores();
});

function setupSession(recoveryOverrides: Partial<RecoveryIssue> = {}): {
  prepared: PreparedExecution;
  state: WorkflowState;
} {
  const projectDir = createTempDir('recovery-driver-test');
  dirs.push(projectDir);
  const sessionId = 'sess-recovery';
  ensureSessionDir(projectDir, sessionId);
  const state = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
    pendingRecovery: makeRecoveryIssue(recoveryOverrides),
  });
  saveState({ projectDir, sessionId }, state);
  const saved = loadState({ projectDir, sessionId });
  if (saved === null) throw new Error('expected the recovery state to persist');
  const prepared = makePreparedExecution({
    projectDir,
    sessionId,
    feature: 'recovery test',
    config: makeConfig({
      planner: { kind: 'agent', command: 'test-planner' },
      implementer: { kind: 'agent', command: 'test-implementer', model: 'test-model' },
    }),
    resumeState: saved,
    active: reactivateExistingSession({ projectDir, sessionId }),
  });
  return { prepared, state: saved };
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
  prepared: PreparedExecution,
  state: WorkflowState,
  inputMode: UseInputModeResult,
): ReturnType<ReturnType<typeof createRecoveryDriver>> {
  const promptPendingRecovery = createRecoveryDriver({
    prepared,
    inputMode,
    abortedRef: { current: false },
    sink: addTuiEvent,
    setInlineResume: () => {},
  });
  return promptPendingRecovery({
    state,
    controller: new AbortController(),
    republishPrompt: false,
  });
}

describe('createRecoveryDriver', () => {
  it('re-prompts with an error instead of applying a fallback action when the answer is unknown', async () => {
    const { prepared, state } = setupSession();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['not-a-real-action', 'pause']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[0]).toEqual({ message: null, isError: false });
    expect(feedbackAtPrompt[1]).toEqual({ message: 'Unknown recovery action.', isError: true });
    expect(result.shouldRun).toBe(false);
  });

  it('applies a valid action on the first answer without re-prompting', async () => {
    const { prepared, state } = setupSession();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['pause']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(false);
    expect(feedbackStore.get().message).toBe('Recovery paused. Resume with splitbrief resume.');
  });

  it('resumes the run on a retry and carries the selected worker as the profile override', async () => {
    const { prepared, state } = setupSession();
    const { inputMode } = makeInputMode(['retry-same-worker']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
      expect(result.retryProfileOverride).toBe('local-qwen');
      expect(result.retryProfileOverrideTaskId).toBe(taskId('T001'));
    }
  });

  it('reopens paused recovery and applies the selected action', async () => {
    const { prepared, state } = setupSession({ status: 'paused', selectedAction: 'pause-run' });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['retry-same-worker']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeUndefined();
    }
  });

  it('replays an applying selected action without prompting', async () => {
    const { prepared, state } = setupSession({
      status: 'applying',
      selectedAction: 'retry-same-worker',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode([]);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(0);
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
    }
  });

  it('hands a switch-seat choice back to the run and leaves the halt pending', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code', model: 'opus' }] },
    });
    const { inputMode } = makeInputMode(['switch-seat']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeDefined();
      expect(result.switchSeat?.candidate).toEqual({ tool: 'claude-code', model: 'opus' });
      expect(result.switchSeat?.policy.purpose).toBe('resume');
      expect(result.retryProfileOverride).toBeUndefined();
    }
  });

  it('takes the tool the pressed row named, not the first one offered', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
      recommendedAction: 'switch-seat',
      resetAt: '2026-07-13T17:00:00.000Z',
      switchSeat: {
        seat: 'build',
        candidates: [{ tool: 'claude-code', model: 'opus' }, { tool: 'opencode' }],
      },
    });
    const { inputMode } = makeInputMode(['w2']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({ tool: 'opencode' });
    }
    expect(recoveryNoticeStore.get()).toEqual({ seat: null, resetAt: null, issue: null });
  });

  it('marks the halted seat for the header while the operator is answering', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
      recommendedAction: 'switch-seat',
      resetAt: '2026-07-13T17:00:00.000Z',
      switchSeat: { seat: 'build', candidates: [{ tool: 'opencode' }] },
    });
    const noticeAtPrompt: Array<{ seat: string | null; resetAt: number | null; issue: unknown }> =
      [];
    const { inputMode } = makeInputMode(['a']);
    const observed: UseInputModeResult = {
      ...inputMode,
      setQuestionMode: async (hint: string) => {
        noticeAtPrompt.push({ ...recoveryNoticeStore.get() });
        return inputMode.setQuestionMode(hint);
      },
    };

    await runDriver(prepared, state, observed);

    expect(noticeAtPrompt).toEqual([
      {
        seat: 'build',
        resetAt: Date.parse('2026-07-13T17:00:00.000Z'),
        issue: state.pendingRecovery,
      },
    ]);
    expect(recoveryNoticeStore.get()).toEqual({ seat: null, resetAt: null, issue: null });
  });

  it('publishes a halt that offers no other tool, with no seat for the bar to mark', async () => {
    const { prepared, state } = setupSession({
      reason: 'review-failed',
      taskId: undefined,
      taskTitle: undefined,
      seat: 'review',
      files: [],
      affectedTaskIds: [],
      attempts: undefined,
      maxAttempts: undefined,
      message: 'The review seat was not given the context this call needs.',
      facts: {
        apiContextCode: 'insufficient-context',
        apiContextSeat: 'review',
        apiContextCause: 'input-budget',
        apiContextRequiredTokens: 412_096,
        apiContextAvailableTokens: 32_768,
      },
      availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
      recommendedAction: 'pause-run',
    });
    const noticeAtPrompt: RecoveryNoticeState[] = [];
    const { inputMode } = makeInputMode(['pause']);
    const observed: UseInputModeResult = {
      ...inputMode,
      setQuestionMode: async (hint: string) => {
        noticeAtPrompt.push({ ...recoveryNoticeStore.get() });
        return inputMode.setQuestionMode(hint);
      },
    };

    await runDriver(prepared, state, observed);

    // No swap offer, so the header bar has no seat to annotate — but the halt itself is published,
    // which is what the details surface reads while this process still holds it.
    expect(noticeAtPrompt).toEqual([{ seat: null, resetAt: null, issue: state.pendingRecovery }]);
    expect(recoveryNoticeStore.get()).toEqual({ seat: null, resetAt: null, issue: null });
  });

  it('end run closes the run on the state and stops the loop', async () => {
    const { prepared, state } = setupSession({
      reason: 'review-failed',
      taskId: undefined,
      availableActions: ['pause-run', 'end-run'],
      recommendedAction: 'pause-run',
    });
    const { inputMode } = makeInputMode(['a']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
    expect(result.state?.pendingRecovery).toBeUndefined();
    const persisted = loadState(prepared.session.ref);
    expect(persisted?.closed?.as).toBe('ended');
    expect(feedbackStore.get().message).toContain('Run ended');
  });

  it('revise asks for the correction and carries it into the queue', async () => {
    const { prepared, state } = setupSession({
      reason: 'brief-review-no-progress',
      taskId: undefined,
      phase: 'reviewing-briefs',
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
    });
    const { inputMode } = makeInputMode(['v', 'split the first brief']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    expect(result.state?.pendingRecovery).toBeUndefined();
    expect(result.state?.messageQueue.map((message) => message.text)).toEqual([
      'split the first brief',
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { taskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { reactivateExistingSession } from '../../core/sessions/active-pointer.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import {
  recoveryNoticeStore,
  type RecoveryNoticeState,
} from '../../stores/workflow/recovery-notice.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { createRecoveryDriver } from './recovery-driver.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEW_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import { buildReviewFailedRecoveryIssue } from '../../engine/orchestrator/recovery/builders/task.js';
import { addTuiEvent } from './tui-sink.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  resetAllStores();
});

function setupSession(
  recoveryOverrides: Partial<RecoveryIssue> = {},
  task = makeTask({ id: 'T001', status: 'failed' }),
): {
  prepared: PreparedExecution;
  state: WorkflowState;
} {
  const projectDir = createTempDir('recovery-driver-test');
  dirs.push(projectDir);
  const sessionId = 'sess-recovery';
  ensureSessionDir(projectDir, sessionId);
  const state = makeImplState([task], {
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

/**
 * Drives the seat picker the driver opened for a swap: writes `implementer` to the config of
 * record as the picker would, or leaves it alone, and closes the overlay.
 */
async function closeSeatPicker(
  prepared: PreparedExecution,
  implementer?: NonNullable<Parameters<typeof makeConfig>[0]>['implementer'],
): Promise<void> {
  await vi.waitFor(() => {
    expect(overlayStore.get().active).toBe('implementer-picker');
  });
  if (implementer !== undefined) {
    configStore.__testReset({
      projectDir: prepared.session.ref.projectDir,
      config: makeConfig({ planner: { kind: 'agent', command: 'test-planner' }, implementer }),
    });
  }
  overlayStore.close();
}

function runDriver(
  prepared: PreparedExecution,
  state: WorkflowState,
  inputMode: UseInputModeResult,
  correction?: string,
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
    ...(correction !== undefined && { correction }),
  });
}

/** A run whose final review failed after the repair cycles ran out, with its review on disk. */
function setupFailedReview(): { prepared: PreparedExecution; state: WorkflowState } {
  const { prepared } = setupSession();
  const ref = prepared.session.ref;
  const halted: WorkflowState = {
    ...makeImplState([makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })]),
    phase: 'complete',
    reviewStatus: 'failed',
    completedAt: '2026-09-24T00:00:00.000Z',
    reviewFixes: { cycle: 2, findings: {} },
    pendingRecovery: buildReviewFailedRecoveryIssue({
      blocking: 1,
      phase: 'complete',
      createdAt: '2026-09-24T00:00:00.000Z',
    }),
  };
  saveState(ref, halted);
  writeSpecFile(
    ref,
    REVIEW_FILE,
    '### Verdict\nfail\n\n### Findings\n- **Critical**: src/alpha.ts drops the error\n',
  );
  const saved = loadState(ref);
  if (saved === null) throw new Error('expected the failed review to persist');
  return { prepared, state: saved };
}

function sessionLog(prepared: PreparedExecution): string {
  const { projectDir, sessionId } = prepared.session.ref;
  return readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
}

describe('createRecoveryDriver', () => {
  it('applies a valid action on the first answer without re-prompting', async () => {
    const { prepared, state } = setupSession();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['pause']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(false);
    expect(feedbackStore.get().message).toBe('Recovery paused. Resume with splitbrief resume.');
  });

  it('keeps the halt menu open when an action cannot be applied', async () => {
    const { prepared, state } = setupSession({
      reason: 'review-failed',
      taskId: taskId('T999'),
      taskTitle: 'Missing review task',
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'pause-run'],
      recommendedAction: 'retry-same-worker',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['retry-same-worker', 'pause']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[1]?.isError).toBe(true);
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

    const pending = runDriver(prepared, state, inputMode);
    await closeSeatPicker(prepared, { kind: 'cli', tool: 'claude-code', model: 'opus' });
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeDefined();
      expect(result.switchSeat?.candidate).toEqual({ tool: 'claude-code', model: 'opus' });
      expect(result.switchSeat?.policy.purpose).toBe('resume');
      expect(result.retryProfileOverride).toBeUndefined();
    }
  });

  it("opens the seat's picker on the offered tool and swaps to the model and effort it wrote", async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    const { inputMode } = makeInputMode(['switch-seat']);

    const pending = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => {
      expect(overlayStore.get()).toMatchObject({
        active: 'implementer-picker',
        focus: 'tool:claude-code',
      });
    });
    await closeSeatPicker(prepared, {
      kind: 'cli',
      tool: 'claude-code',
      model: 'opus',
      effort: 'high',
      variant: 'thinking',
    });
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({
        tool: 'claude-code',
        model: 'opus',
        effort: 'high',
        variant: 'thinking',
      });
    }
    expect(recoveryNoticeStore.get().issue).toBeNull();
  });

  it('keeps the halt when the picker closes without changing the seat', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['switch-seat', 'pause']);

    const pending = runDriver(prepared, state, inputMode);
    await closeSeatPicker(prepared);
    const result = await pending;

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(result.shouldRun).toBe(false);
    expect(result.state?.pendingRecovery?.status).toBe('paused');
    expect(loadState(prepared.session.ref)?.pendingRecovery).toBeDefined();
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

    const pending = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => {
      expect(overlayStore.get().focus).toBe('tool:opencode');
    });
    await closeSeatPicker(prepared, { kind: 'cli', tool: 'opencode' });
    const result = await pending;

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

  it('retries the brief with a typed correction as the steer', async () => {
    const { prepared, state } = setupSession(
      { taskId: taskId('T005'), affectedTaskIds: [taskId('T005')] },
      makeTask({ id: 'T005', status: 'failed' }),
    );
    const { inputMode, feedbackAtPrompt } = makeInputMode(['the prop is optional — add a default']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(feedbackStore.get().isError).toBe(false);
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.steer).toBe('the prop is optional — add a default');
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
    }
  });

  it('carries no steer when the retry keyword itself is typed', async () => {
    const { prepared, state } = setupSession();
    const { inputMode } = makeInputMode(['retry']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) expect(result.steer).toBeUndefined();
  });

  it('refuses a sentence at a halt that offers nothing to carry it, and says why', async () => {
    const { prepared, state } = setupSession({
      reason: 'dependency-blocked',
      availableActions: ['pause-run', 'end-run'],
      recommendedAction: 'pause-run',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['make the prop optional', 'pause']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[1]).toEqual({
      message: 'This halt takes no typed correction. Choose one of its actions.',
      isError: true,
    });
    expect(result.shouldRun).toBe(false);
  });

  it('turns a sentence at a planner halt into the revise note, not a steer', async () => {
    const { prepared, state } = setupSession({
      reason: 'brief-review-no-progress',
      taskId: undefined,
      phase: 'reviewing-briefs',
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['split the first brief']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.steer).toBeUndefined();
      expect(result.state.messageQueue.map((message) => message.text)).toEqual([
        'split the first brief',
      ]);
    }
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

  it('sends a failed review back through one more repair with the correction typed on the panel', async () => {
    const { prepared, state } = setupFailedReview();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['keep the error, log it and rethrow']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(feedbackStore.get().isError).toBe(false);
    expect(result.shouldRun).toBe(true);
    if (!result.shouldRun) return;
    expect(result.steer).toBeUndefined();
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.phase).toBe('implementing');
    expect(result.state.reviewStatus).toBeUndefined();
    expect(result.state.tasks[0]?.status).toBe('pending');
    expect(result.state.reviewFixes).toEqual({
      cycle: 3,
      findings: {
        T001: [
          'src/alpha.ts drops the error',
          'Operator correction: keep the error, log it and rethrow',
        ],
      },
    });
    const log = sessionLog(prepared);
    expect(log).toContain('"type":"user_message"');
    expect(log).toContain('keep the error, log it and rethrow');
    expect(log).toContain('"type":"review_fix_started"');
  });

  it('takes the words a failed review was continued with as its correction, without asking', async () => {
    const { prepared, state } = setupFailedReview();
    const { inputMode, feedbackAtPrompt } = makeInputMode([]);

    const result = await runDriver(prepared, state, inputMode, 'log the error and rethrow');

    expect(feedbackAtPrompt).toHaveLength(0);
    expect(result.shouldRun).toBe(true);
    if (!result.shouldRun) return;
    expect(result.correctionTaken).toBe(true);
    expect(result.steer).toBeUndefined();
    expect(result.state.phase).toBe('implementing');
    expect(result.state.reviewFixes?.findings['T001']).toContain(
      'Operator correction: log the error and rethrow',
    );
  });
});

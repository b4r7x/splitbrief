import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { writeConfig } from '../../core/config/load/io.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { taskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { reactivateExistingSession } from '../../core/sessions/active-pointer.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { configStore } from '../../stores/project/config.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../stores/ui/composer-live.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import {
  recoveryNoticeStore,
  type RecoveryNoticeState,
} from '../../stores/workflow/recovery-notice.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { createRecoveryDriver } from './recovery-driver.js';
import { readFileSync } from 'node:fs';
import { readEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { join } from 'node:path';
import { REVIEW_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import { buildReviewFailedRecoveryIssue } from '../../engine/orchestrator/recovery/builders/task.js';
import { addTuiEvent } from './tui-sink.js';

let dirs: string[] = [];

const CONSULT_BOUND: Partial<RecoveryIssue> = {
  reason: 'consult-bound-spent',
  availableActions: ['continue', 'skip-current-task', 'end-run'],
  recommendedAction: 'continue',
};

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
    ...makeImplState([makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })]),
    phase: 'complete',
    reviewStatus: 'failed',
    completedAt: '2026-09-24T00:00:00.000Z',
    fixCycles: { used: 2, allowance: 2, notes: [] },
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
  it('records skipped brief evidence without the mode an older run saved', async () => {
    const { prepared, state } = setupSession();
    const saved = { ...state, mode: 'speckit' as const };
    saveState(prepared.session.ref, saved);
    const { inputMode } = makeInputMode(['skip-current-task']);
    const result = await runDriver(prepared, saved, inputMode);
    expect(result.shouldRun).toBe(true);
    const ledger = readEvidenceLedger(prepared.session.ref);
    expect(ledger).not.toBeNull();
    expect(ledger).not.toHaveProperty('mode');
  });

  it('applies a valid action on the first answer without re-prompting', async () => {
    const { prepared, state } = setupSession();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['skip']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(true);
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('keeps the halt menu open when an action cannot be applied', async () => {
    const { prepared, state } = setupSession({
      reason: 'review-failed',
      taskId: taskId('T999'),
      taskTitle: 'Missing review task',
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['retry-same-worker', 'end']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[1]?.isError).toBe(true);
    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
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

  it.each(['required-checks-unrunnable', 'review-failed'] as const)(
    'returns refreshed preparation only for required-checks recovery on a %s retry',
    async (reason) => {
      const { prepared, state } = setupSession({
        reason,
        phase: 'final-review',
        seat: 'review',
        taskId: undefined,
        availableActions: ['retry-same-worker', 'end-run'],
      });
      const onDisk = makeConfig({
        planner: { kind: 'agent', command: 'changed-on-disk' },
        validation: { render: 'true {id} {out}', endChecks: false, testCommand: 'disk-tests' },
      });
      writeConfig(prepared.session.ref.projectDir, onDisk);
      const { inputMode } = makeInputMode(['retry-same-worker']);

      const result = await runDriver(prepared, state, inputMode);

      expect(result.shouldRun).toBe(true);
      if (result.shouldRun) {
        expect(result.state.pendingRecovery).toBeUndefined();
        if (reason === 'required-checks-unrunnable') {
          expect(result.prepared).toEqual({
            ...prepared,
            config: { ...prepared.config, validation: onDisk.validation },
          });
        } else {
          expect(result.prepared).toBeUndefined();
        }
      }
      expect(prepared.config.validation.render).toBeUndefined();
    },
  );

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
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
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
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
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

  it('takes the automatic intent at once, with no panel question and no picker', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        candidates: [{ tool: 'claude-code', model: 'opus' }],
        auto: { candidate: { tool: 'claude-code', model: 'opus' }, configRevision: 'revision' },
      },
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode([]);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(0);
    expect(overlayStore.get().active).toBe('none');
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({ tool: 'claude-code', model: 'opus' });
      expect(result.switchSeat?.policy.purpose).toBe('resume');
      expect(result.state.pendingRecovery).toBeDefined();
    }
    expect(recoveryNoticeStore.get().issue).toBeNull();
  });

  it("drafts the chosen candidate's model and effort into the picker", async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        candidates: [{ tool: 'claude-code', model: 'opus', effort: 'high' }],
      },
    });
    const { inputMode } = makeInputMode(['switch-seat']);

    const pending = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => {
      expect(overlayStore.get()).toMatchObject({
        active: 'implementer-picker',
        focus: 'tool:claude-code',
      });
    });
    expect(pickerViewStore.get()).toMatchObject({ expandedModelId: 'opus', effortDraft: 'high' });
    await closeSeatPicker(prepared, {
      kind: 'cli',
      tool: 'claude-code',
      model: 'opus',
      effort: 'high',
    });
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({
        tool: 'claude-code',
        model: 'opus',
        effort: 'high',
      });
    }
  });

  it('counts an effort-only change as a swap', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    configStore.__testReset({
      projectDir: prepared.session.ref.projectDir,
      config: makeConfig({
        planner: { kind: 'agent', command: 'test-planner' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'opus' },
      }),
    });
    const { inputMode } = makeInputMode(['switch-seat']);

    const pending = runDriver(prepared, state, inputMode);
    await closeSeatPicker(prepared, {
      kind: 'cli',
      tool: 'claude-code',
      model: 'opus',
      effort: 'high',
    });
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({
        tool: 'claude-code',
        model: 'opus',
        effort: 'high',
      });
    }
  });

  it('keeps the halt when the picker closes without changing the seat', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['switch-seat', 'end']);

    const pending = runDriver(prepared, state, inputMode);
    await closeSeatPicker(prepared);
    const result = await pending;

    // The halt asks again rather than resuming on a seat nobody changed.
    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[1]?.isError).toBe(false);
    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
  });

  it('takes the tool the pressed row named, not the first one offered', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
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
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
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

  it('opens the PLAN picker for a review halt whose REVIEW follows PLAN, and marks PLAN', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      phase: 'final-review',
      taskId: undefined,
      taskTitle: undefined,
      seat: 'review',
      files: [],
      affectedTaskIds: [],
      attempts: undefined,
      maxAttempts: undefined,
      message: 'OpenAI Codex CLI hit its usage limit',
      resetAt: '2026-10-03T13:02:00.000Z',
      switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
    });
    const { inputMode } = makeInputMode(['switch-seat']);

    const pending = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => {
      expect(overlayStore.get()).toMatchObject({
        active: 'planner-picker',
        focus: 'tool:claude-code',
      });
    });
    expect(recoveryNoticeStore.get().seat).toBe('plan');
    configStore.__testReset({
      projectDir: prepared.session.ref.projectDir,
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus' },
        implementer: { kind: 'agent', command: 'test-implementer', model: 'test-model' },
      }),
    });
    overlayStore.close();
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({ tool: 'claude-code', model: 'opus' });
      expect(result.state.pendingRecovery).toBeDefined();
    }
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
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
    });
    const noticeAtPrompt: RecoveryNoticeState[] = [];
    const { inputMode } = makeInputMode(['end']);
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
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
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

  it('accept as is stops a checkout run without changing its failed review', async () => {
    const { prepared, state } = setupFailedReview();
    const halted: WorkflowState = {
      ...state,
      workspace: {
        kind: 'checkout',
        path: prepared.session.ref.projectDir,
        base: { snapshotId: 'base', head: null },
      },
      pendingRecovery: buildReviewFailedRecoveryIssue({
        blocking: 1,
        phase: 'complete',
        acceptAsIs: true,
        createdAt: '2026-09-24T00:00:00.000Z',
      }),
    };
    saveState(prepared.session.ref, halted);
    const { inputMode, feedbackAtPrompt } = makeInputMode(['accept-as-is']);

    const result = await runDriver(prepared, halted, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(false);
    expect(result.state?.acceptedAsIs).toBeDefined();
    expect(result.state?.reviewStatus).toBe('failed');
    expect(result.state?.pendingRecovery).toBeUndefined();
    expect(loadState(prepared.session.ref)?.reviewStatus).toBe('failed');
    expect(recoveryNoticeStore.get().issue).toBeNull();
    expect(feedbackStore.get().message).toContain('Run closed');
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

  it('continues a consult-bound halt with a typed sentence as its note and the brief steer', async () => {
    const { prepared, state } = setupSession(CONSULT_BOUND);
    const { inputMode, feedbackAtPrompt } = makeInputMode(['run the formatter before the tests']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(feedbackStore.get().isError).toBe(false);
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.steer).toBe('run the formatter before the tests');
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(JSON.stringify(result.state.lineages)).toContain('run the formatter before the tests');
    }
  });

  it('takes the composer draft as the note when Continue is chosen on the panel', async () => {
    const { prepared, state } = setupSession(CONSULT_BOUND);
    composerLiveStore.setDraft(createDraftDocument('run the formatter before the tests'));
    const { inputMode } = makeInputMode(['c']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.steer).toBe('run the formatter before the tests');
      expect(JSON.stringify(result.state.lineages)).toContain('run the formatter before the tests');
    }
    expect(composerDraftStore.get().request?.value).toBe('');
  });

  it('takes the composer draft as the steer when Try again is chosen on the panel', async () => {
    const { prepared, state } = setupSession();
    composerLiveStore.setDraft(createDraftDocument('the prop is optional'));
    const { inputMode } = makeInputMode(['r']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) expect(result.steer).toBe('the prop is optional');
    expect(composerDraftStore.get().request?.value).toBe('');
  });

  it('leaves the composer draft alone when an action that takes no note is chosen', async () => {
    const { prepared, state } = setupSession(CONSULT_BOUND);
    composerLiveStore.setDraft(createDraftDocument('run the formatter before the tests'));
    const { inputMode } = makeInputMode(['a']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(false);
    expect(composerDraftStore.get().request).toBeNull();
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
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['make the prop optional', 'end']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[1]).toEqual({
      message: 'This halt takes no typed correction. Choose one of its actions.',
      isError: true,
    });
    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
  });

  it('turns a sentence at a planner halt into the revise note, not a steer', async () => {
    const { prepared, state } = setupSession({
      reason: 'plan-checks-failed',
      taskId: undefined,
      phase: 'planning',
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
      reason: 'plan-checks-failed',
      taskId: undefined,
      phase: 'planning',
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

  it('sends a failed review back through one more fix cycle with the correction typed on the panel', async () => {
    const { prepared, state } = setupFailedReview();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['keep the error, log it and rethrow']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(feedbackStore.get().isError).toBe(false);
    expect(result.shouldRun).toBe(true);
    if (!result.shouldRun) return;
    expect(result.steer).toBeUndefined();
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.phase).toBe('final-review');
    expect(result.state.reviewStatus).toBeUndefined();
    expect(result.state.pendingTriage).toEqual({
      inputs: [
        {
          id: 'U1',
          kind: 'defect',
          source: 'user',
          text: 'keep the error, log it and rethrow',
          file: null,
        },
      ],
    });
    // The correction arrives at the cap, so it grants one more fix cycle and is recorded.
    expect(result.state.fixCycles).toEqual({
      used: 2,
      allowance: 3,
      notes: ['keep the error, log it and rethrow'],
    });
    // The correction never resets a brief; the fix work is a new appended task.
    expect(result.state.tasks[0]?.status).toBe('done');
    const log = sessionLog(prepared);
    expect(log).toContain('"type":"user_message"');
    expect(log).toContain('keep the error, log it and rethrow');
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
    expect(result.state.phase).toBe('final-review');
    expect(result.state.pendingTriage?.inputs).toContainEqual({
      id: 'U1',
      kind: 'defect',
      source: 'user',
      text: 'log the error and rethrow',
      file: null,
    });
    expect(result.state.tasks[0]?.status).toBe('done');
  });
});

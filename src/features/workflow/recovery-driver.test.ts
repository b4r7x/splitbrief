import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { plainUserMessage, type UserMessageInput } from '../../core/types/user-input.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
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
import {
  plainAnswer,
  type QuestionAnswer,
  type UseInputModeResult,
} from './hooks/use-input-mode.js';
import { createRecoveryDriver } from './recovery-driver.js';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { join } from 'node:path';
import { REVIEW_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import { buildReviewFailedRecoveryIssue } from '../../engine/orchestrator/recovery/builders/task.js';
import { addTuiEvent } from './tui-sink.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../engine/events/workflow-cancel.js';
import { attachedMessage, expectCompactMessage } from '#testing/helpers/user-message.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { readMessages } from '../../core/sessions/log-reader.js';

let dirs: string[] = [];

const CONSULT_BOUND: Partial<RecoveryIssue> = {
  reason: 'consult-bound-spent',
  availableActions: ['continue', 'skip-current-task', 'end-run'],
  recommendedAction: 'continue',
};

/** A REVIEW call that never landed: the halt names no brief, so Try again re-issues the step. */
const SEAT_LEVEL_RETRY: Partial<RecoveryIssue> = {
  reason: 'planner-call-failed',
  taskId: undefined,
  phase: 'final-review',
  seat: 'review',
  availableActions: ['retry-same-worker', 'end-run'],
  recommendedAction: 'retry-same-worker',
  status: 'applying',
  selectedAction: 'retry-same-worker',
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
    setQuestionMode: async (): Promise<QuestionAnswer> => {
      feedbackAtPrompt.push({ ...feedbackStore.get() });
      return plainAnswer(queue.shift() ?? '');
    },
    resolve: () => {},
    resetMode: () => {},
  };
  return { inputMode, feedbackAtPrompt };
}

/**
 * Drives the seat picker the driver opened for a swap: takes a row that writes `implementer` to
 * the config of record as the picker would, or takes none, and closes the overlay.
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
    pickerViewStore.setCommitted(true);
  }
  overlayStore.close();
}

/** Records every halt the driver opens for the rest of the screen until the returned stop runs. */
function recordNoticeOpens(): { opens: RecoveryIssue[]; stop: () => void } {
  const opens: RecoveryIssue[] = [];
  const stop = recoveryNoticeStore.subscribe(() => {
    const { issue } = recoveryNoticeStore.get();
    if (issue !== null) opens.push(issue);
  });
  return { opens, stop };
}

function runDriver(
  prepared: PreparedExecution,
  state: WorkflowState,
  inputMode: UseInputModeResult,
  correction?: UserMessageInput,
): ReturnType<ReturnType<typeof createRecoveryDriver>> {
  const promptPendingRecovery = createRecoveryDriver({
    prepared,
    configOfRun: prepared.sourceConfig,
    inputMode,
    abortedRef: { current: false },
    retentionNoticeHandled: { current: false },
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

/** A run whose final review failed after two fix cycles, with its review on disk. */
function setupFailedReview(): { prepared: PreparedExecution; state: WorkflowState } {
  const { prepared } = setupSession();
  const ref = prepared.session.ref;
  const halted: WorkflowState = {
    ...makeImplState([makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })]),
    phase: 'complete',
    reviewStatus: 'failed',
    completedAt: '2026-09-24T00:00:00.000Z',
    fixCycles: { used: 2, notes: [] },
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
  it('settles the pending question and clears the notice when aborted', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      seat: 'build',
      resetAt: '2026-10-10T17:00:00.000Z',
      switchSeat: { seat: 'build', candidates: [{ tool: 'codex' }] },
    });
    const controller = new AbortController();
    const { inputMode } = makeInputMode([]);
    let cancelQuestion = (): void => {};
    const promptPendingRecovery = createRecoveryDriver({
      prepared,
      configOfRun: prepared.sourceConfig,
      inputMode: {
        ...inputMode,
        setQuestionMode: () =>
          new Promise<QuestionAnswer>((_resolve, reject) => {
            cancelQuestion = () => reject(WORKFLOW_USER_CANCELLED_ABORT_REASON);
          }),
        resetMode: () => cancelQuestion(),
      },
      abortedRef: { current: false },
      retentionNoticeHandled: { current: false },
      sink: addTuiEvent,
      setInlineResume: () => {},
    });
    const pending = promptPendingRecovery({ state, controller, republishPrompt: false });
    const settled = expect(pending).rejects.toBe(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    await vi.waitFor(() =>
      expect(recoveryNoticeStore.get()).toEqual({
        seat: 'build',
        ranOn: null,
        resetAt: Date.parse('2026-10-10T17:00:00.000Z'),
        issue: state.pendingRecovery,
        at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
      }),
    );

    controller.abort();

    await settled;
    expect(recoveryNoticeStore.get()).toEqual({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: null,
      at: null,
    });
  });

  it('clears the notice if the recovery question fails', async () => {
    const { prepared, state } = setupSession();
    const { inputMode } = makeInputMode([]);
    const failure = new Error('Question failed');

    await expect(
      runDriver(prepared, state, {
        ...inputMode,
        setQuestionMode: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(recoveryNoticeStore.get().issue).toBeNull();
  });

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
    expect(recoveryNoticeStore.get().issue).toBeNull();
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

  it('resumes the run on a retry with the brief pinned to the selected worker in the state', async () => {
    const { prepared, state } = setupSession();
    const { inputMode } = makeInputMode(['retry-same-worker']);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
      expect(result.state.retryProfile).toEqual({ taskId: 'T001', profile: 'local-qwen' });
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
    const notices = recordNoticeOpens();

    const result = await runDriver(prepared, state, inputMode);
    notices.stop();

    expect(feedbackAtPrompt).toHaveLength(0);
    expect(notices.opens).toEqual([]);
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
    }
  });

  // A replay asks nothing, so the words typed at rest carry what the panel would take from them.
  describe('words typed at rest before a replayed action', () => {
    const words = plainUserMessage('split the first brief');

    it('steers a replayed Try again with them, as Try again on the panel does', async () => {
      const { prepared, state } = setupSession({
        status: 'applying',
        selectedAction: 'retry-same-worker',
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);

      const result = await runDriver(prepared, state, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(0);
      if (!result.shouldRun) throw new Error('expected the retry to run');
      expect(result.steer).toEqual(words);
      expect(result.correctionTaken).toBeUndefined();
    });

    it('sends them as the note of a replayed revise', async () => {
      const { prepared, state } = setupSession({
        reason: 'plan-checks-failed',
        taskId: undefined,
        phase: 'planning',
        availableActions: ['revise', 'end-run'],
        recommendedAction: 'revise',
        status: 'applying',
        selectedAction: 'revise',
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);

      const result = await runDriver(prepared, state, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(0);
      if (!result.shouldRun) throw new Error('expected the revise to run');
      expect(result.state.messageQueue.map((message) => message.text)).toEqual([words.text]);
      expect(result.correctionTaken).toBe(true);
    });

    it('records them as the note of a replayed review skip', async () => {
      const { prepared, state } = setupSession({
        reason: 'review-input-too-large',
        taskId: undefined,
        seat: 'review',
        availableActions: ['accept-as-is', 'end-run'],
        recommendedAction: 'end-run',
        status: 'applying',
        selectedAction: 'accept-as-is',
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);

      const result = await runDriver(prepared, state, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(0);
      expect(result.state?.acceptedAsIs?.note).toBe(words.text);
    });

    it('records them as the note of a replayed Continue on a spent bound', async () => {
      const { prepared, state } = setupSession({
        ...CONSULT_BOUND,
        status: 'applying',
        selectedAction: 'continue',
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);

      const result = await runDriver(prepared, state, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(0);
      if (!result.shouldRun) throw new Error('expected the grant to run');
      expect(JSON.stringify(result.state.lineages)).toContain(words.text);
    });

    it('keeps them for the panel when the replayed action is refused', async () => {
      // A brief that failed its attempts cannot be continued safely, so the replay is refused.
      const { prepared, state } = setupSession({
        availableActions: ['continue', 'retry-same-worker', 'skip-current-task', 'end-run'],
        status: 'applying',
        selectedAction: 'continue',
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode(['r']);

      const result = await runDriver(prepared, state, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(1);
      expect(feedbackAtPrompt[0]?.isError).toBe(true);
      if (!result.shouldRun) throw new Error('expected the retry to run');
      expect(result.state.messageQueue).toEqual([]);
      expect(result.steer).toEqual(words);
    });

    it('replays a seat-level Try again with them queued as its note', async () => {
      const { prepared, state } = setupSession(SEAT_LEVEL_RETRY);
      const halted: WorkflowState = { ...state, phase: 'final-review', tasks: [] };
      saveState(prepared.session.ref, halted);
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);

      const result = await runDriver(prepared, halted, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(0);
      if (!result.shouldRun) throw new Error('expected the retry to run');
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.messageQueue.map((message) => message.text)).toEqual([words.text]);
      expect(result.correctionTaken).toBe(true);
    });

    it('replays a seat-level Try again with nothing typed', async () => {
      const { prepared, state } = setupSession(SEAT_LEVEL_RETRY);
      const halted: WorkflowState = { ...state, phase: 'final-review', tasks: [] };
      saveState(prepared.session.ref, halted);
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);

      const result = await runDriver(prepared, halted, inputMode);

      expect(feedbackAtPrompt).toHaveLength(0);
      if (!result.shouldRun) throw new Error('expected the retry to run');
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.messageQueue).toEqual([]);
      expect(result.steer).toBeUndefined();
      expect(result.correctionTaken).toBeUndefined();
    });

    it('replays an action that takes no note without queuing the words or claiming them', async () => {
      const { prepared, state } = setupSession({
        status: 'applying',
        selectedAction: 'skip-current-task',
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);

      const result = await runDriver(prepared, state, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(0);
      if (!result.shouldRun) throw new Error('expected the skip to run');
      expect(result.state.tasks[0]?.status).toBe('skipped');
      expect(result.state.messageQueue).toEqual([]);
      expect(result.steer).toBeUndefined();
      expect(result.correctionTaken).toBeUndefined();
    });
  });

  it('opens the halt in the same tick the run enters it, so no frame paints the run without it', async () => {
    const { prepared, state } = setupSession();
    const { inputMode } = makeInputMode(['skip-current-task']);

    const pending = runDriver(prepared, state, inputMode);
    const openAtEntry = recoveryNoticeStore.get().issue;
    await pending;

    expect(openAtEntry?.reason).toBe(state.pendingRecovery?.reason);
  });

  it('holds the halt open while a reopened run replays a seat switch in the picker', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code', model: 'opus' }] },
      status: 'applying',
      selectedAction: 'switch-seat',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode([]);

    const pending = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => {
      expect(overlayStore.get().active).toBe('implementer-picker');
    });
    expect(recoveryNoticeStore.get().issue?.reason).toBe('runner-usage-limit');
    await closeSeatPicker(prepared, { kind: 'cli', tool: 'claude-code', model: 'opus' });
    const result = await pending;

    expect(feedbackAtPrompt).toHaveLength(0);
    expect(result.shouldRun && result.switchSeat?.candidate).toEqual({
      tool: 'claude-code',
      model: 'opus',
    });
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
      expect(result.state.retryProfile).toBeUndefined();
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

  it("swaps a halted named BUILD profile onto the default profile's own seat", async () => {
    const big = {
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
      contextLength: 200_000,
    } as const;
    const profiled = (small: { kind: 'cli'; tool: 'codex' | 'claude-code'; model: string }) =>
      makeConfig({
        planner: { kind: 'agent', command: 'test-planner' },
        implementer: big,
        implementerProfiles: { default: 'big', profiles: { big, small } },
      });
    const { prepared: base, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      selectedImplementerProfile: 'small',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    const prepared = {
      ...base,
      sourceConfig: profiled({ kind: 'cli', tool: 'codex', model: 'gpt-5-codex' }),
    };
    const { inputMode } = makeInputMode(['switch-seat', 'end']);

    const pending = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => {
      expect(overlayStore.get().active).toBe('implementer-picker');
    });
    configStore.__testReset({
      projectDir: prepared.session.ref.projectDir,
      config: profiled({ kind: 'cli', tool: 'claude-code', model: 'sonnet' }),
    });
    pickerViewStore.setCommitted(true);
    overlayStore.close();
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({ tool: 'claude-code', model: 'sonnet' });
    }
  });

  it('swaps to the seat the run was opened on when the halted call ran on another seat', async () => {
    const saved = { kind: 'cli', tool: 'claude-code', model: 'haiku' } as const;
    const { prepared: base, state } = setupSession({
      reason: 'runner-usage-limit',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        from: { tool: 'antigravity', model: 'gemini-nonexistent-9' },
        candidates: [{ tool: 'codex' }],
      },
    });
    const prepared = {
      ...base,
      sourceConfig: makeConfig({
        planner: { kind: 'agent', command: 'test-planner' },
        implementer: saved,
      }),
    };
    const { inputMode } = makeInputMode(['switch-seat', 'end']);

    const pending = runDriver(prepared, state, inputMode);
    await closeSeatPicker(prepared, saved);
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({ tool: 'claude-code', model: 'haiku' });
    }
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

  it.each([
    { label: 'no model', seat: { kind: 'cli', tool: 'claude-code' } as const },
    { label: 'auto', seat: { kind: 'cli', tool: 'claude-code', model: 'auto' } as const },
  ])(
    'keeps the halt when the picker takes the seat that left its model to the tool ($label)',
    async ({ seat }) => {
      const { prepared: base, state } = setupSession({
        reason: 'runner-usage-limit',
        message: 'T001 hit the implementer usage limit',
        availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
        recommendedAction: 'switch-seat',
        switchSeat: {
          seat: 'build',
          from: { tool: 'claude-code', model: 'opus' },
          candidates: [{ tool: 'claude-code' }],
        },
      });
      const planner = { kind: 'agent', command: 'test-planner' } as const;
      const prepared = {
        ...base,
        config: makeConfig({
          planner,
          implementer: { kind: 'cli', tool: 'claude-code', model: 'opus' },
        }),
        sourceConfig: makeConfig({ planner, implementer: seat }),
      };
      const { inputMode, feedbackAtPrompt } = makeInputMode(['switch-seat', 'end']);

      const pending = runDriver(prepared, state, inputMode);
      await closeSeatPicker(prepared, seat);
      const result = await pending;

      expect(feedbackAtPrompt).toHaveLength(2);
      expect(result.shouldRun).toBe(false);
      expect(result.state?.closed?.as).toBe('ended');
    },
  );

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
    expect(recoveryNoticeStore.get()).toEqual({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: null,
      at: null,
    });
  });

  it('marks Apply as the step an Apply halt waits at', async () => {
    const { prepared, state } = setupSession({
      reason: 'apply-conflict',
      phase: 'complete',
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
    });
    const halted: WorkflowState = {
      ...state,
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: {
        kind: 'worktree',
        path: join(prepared.session.ref.projectDir, 'run-worktree'),
        base: { snapshotId: 'base', head: null },
      },
    };
    const controller = new AbortController();
    const { inputMode } = makeInputMode([]);
    let cancelQuestion: (() => void) | undefined;
    const promptPendingRecovery = createRecoveryDriver({
      prepared,
      configOfRun: prepared.sourceConfig,
      inputMode: {
        ...inputMode,
        setQuestionMode: () =>
          new Promise<QuestionAnswer>((_resolve, reject) => {
            cancelQuestion = () => reject(WORKFLOW_USER_CANCELLED_ABORT_REASON);
          }),
        resetMode: () => cancelQuestion?.(),
      },
      abortedRef: { current: false },
      retentionNoticeHandled: { current: false },
      sink: addTuiEvent,
      setInlineResume: () => {},
    });
    const pending = promptPendingRecovery({ state: halted, controller, republishPrompt: false });
    const settled = expect(pending).rejects.toBe(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    await vi.waitFor(() => expect(cancelQuestion).toBeDefined());
    expect(recoveryNoticeStore.get().at).toEqual({ kind: 'apply' });

    controller.abort();
    await settled;
    expect(recoveryNoticeStore.get().at).toBeNull();
  });

  it('marks the halted seat for the header while the operator is answering', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      seat: 'build',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      resetAt: '2026-07-13T17:00:00.000Z',
      switchSeat: { seat: 'build', candidates: [{ tool: 'opencode' }] },
    });
    const noticeAtPrompt: Array<{
      seat: string | null;
      resetAt: number | null;
      issue: unknown;
      at: unknown;
    }> = [];
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
        ranOn: null,
        resetAt: Date.parse('2026-07-13T17:00:00.000Z'),
        issue: state.pendingRecovery,
        at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
      },
    ]);
    expect(recoveryNoticeStore.get()).toEqual({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: null,
      at: null,
    });
  });

  it('opens the PLAN picker for a review halt whose REVIEW follows PLAN, and marks REVIEW', async () => {
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
    expect(recoveryNoticeStore.get().seat).toBe('review');
    configStore.__testReset({
      projectDir: prepared.session.ref.projectDir,
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus' },
        implementer: { kind: 'agent', command: 'test-implementer', model: 'test-model' },
      }),
    });
    pickerViewStore.setCommitted(true);
    overlayStore.close();
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({ tool: 'claude-code', model: 'opus' });
      expect(result.state.pendingRecovery).toBeDefined();
    }
  });

  it('publishes a BUILD halt without a reset or swap offer', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      seat: 'build',
      message: 'T001 hit the implementer usage limit',
      availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
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

    expect(noticeAtPrompt).toEqual([
      {
        seat: 'build',
        ranOn: null,
        resetAt: null,
        issue: state.pendingRecovery,
        at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
      },
    ]);
    expect(recoveryNoticeStore.get()).toEqual({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: null,
      at: null,
    });
  });

  it('publishes the halted seat even when it offers no other tool', async () => {
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

    expect(noticeAtPrompt).toEqual([
      {
        seat: 'review',
        ranOn: null,
        resetAt: null,
        issue: state.pendingRecovery,
        at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
      },
    ]);
    expect(recoveryNoticeStore.get()).toEqual({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: null,
      at: null,
    });
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
      expect(result.steer).toEqual(plainUserMessage('the prop is optional — add a default'));
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
      expect(result.steer).toEqual(plainUserMessage('run the formatter before the tests'));
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
      expect(result.steer).toEqual(plainUserMessage('run the formatter before the tests'));
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
    if (result.shouldRun) expect(result.steer).toEqual(plainUserMessage('the prop is optional'));
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

  it('leaves the composer draft alone when Skip task is chosen beside it', async () => {
    const { prepared, state } = setupSession();
    composerLiveStore.setDraft(createDraftDocument('the prop is optional'));
    const { inputMode, feedbackAtPrompt } = makeInputMode(['s']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun && result.state.tasks[0]?.status).toBe('skipped');
    expect(composerDraftStore.get().request).toBeNull();
  });

  describe('words beside the menu for an action that reads none', () => {
    /** Answers each panel question in turn; the composer is emptied before the answer `clearAt`. */
    function answersClearingAt(
      answers: string[],
      clearAt: number,
    ): ReturnType<typeof makeInputMode> {
      const made = makeInputMode([]);
      const queue = [...answers];
      let asked = 0;
      made.inputMode.setQuestionMode = async () => {
        made.feedbackAtPrompt.push({ ...feedbackStore.get() });
        asked += 1;
        if (asked === clearAt) composerLiveStore.setDraft(createDraftDocument(''));
        return plainAnswer(queue.shift() ?? '');
      };
      return made;
    }

    const APPLY_PARTIAL: Partial<RecoveryIssue> = {
      reason: 'apply-partial',
      phase: 'complete',
      taskId: undefined,
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'restore-backup'],
      recommendedAction: 'retry-same-worker',
      facts: { backupId: 'backup-1', written: 1, total: 2 },
    };

    it.each([
      ['r', 'retry-same-worker', 'Re-run Apply'],
      ['u', 'restore-backup', 'Restore backup'],
    ] as const)(
      'refuses %s on an apply-partial halt, keeps the words, and takes it once they are cleared',
      async (key, action, label) => {
        const { prepared, state } = setupSession(APPLY_PARTIAL);
        composerLiveStore.setDraft(createDraftDocument('mind the lockfile'));
        const { inputMode, feedbackAtPrompt } = answersClearingAt([key, key], 2);

        const result = await runDriver(prepared, state, inputMode);

        expect(feedbackAtPrompt[1]).toEqual({
          message: `Cannot send words with ${label}. Clear them.`,
          isError: true,
        });
        expect(composerDraftStore.get().request).toBeNull();
        if (!result.shouldRun) throw new Error('expected the Apply action to run');
        expect(result.state.pendingRecovery).toMatchObject({
          status: 'applying',
          selectedAction: action,
        });
        expect(result.steer).toBeUndefined();
        expect(result.state.messageQueue).toEqual([]);
      },
    );

    it('refuses Re-run Apply on an apply-conflict halt while the composer holds words', async () => {
      const { prepared, state } = setupSession({
        reason: 'apply-conflict',
        phase: 'complete',
        taskId: undefined,
        affectedTaskIds: [],
        availableActions: ['retry-same-worker', 'end-run'],
        recommendedAction: 'retry-same-worker',
      });
      composerLiveStore.setDraft(createDraftDocument('keep my version of a.ts'));
      const { inputMode, feedbackAtPrompt } = answersClearingAt(['r', 'r'], 2);

      const result = await runDriver(prepared, state, inputMode);

      expect(feedbackAtPrompt[1]).toEqual({
        message: 'Cannot send words with Re-run Apply. Clear them.',
        isError: true,
      });
      if (!result.shouldRun) throw new Error('expected Re-run Apply to run');
      expect(result.state.messageQueue).toEqual([]);
      expect(result.correctionTaken).toBeUndefined();
      expect(result.steer).toBeUndefined();
    });

    it('refuses Accept as is on a failed review while the composer holds words', async () => {
      const { prepared, state } = setupFailedReview();
      const halted: WorkflowState = {
        ...state,
        pendingRecovery: buildReviewFailedRecoveryIssue({
          blocking: 1,
          phase: 'complete',
          acceptAsIs: true,
          createdAt: '2026-09-24T00:00:00.000Z',
        }),
      };
      saveState(prepared.session.ref, halted);
      composerLiveStore.setDraft(createDraftDocument('the finding is a false alarm'));
      const { inputMode, feedbackAtPrompt } = answersClearingAt(['k', 'a'], 3);

      const result = await runDriver(prepared, halted, inputMode);

      expect(feedbackAtPrompt[1]).toEqual({
        message: 'Cannot send words with Accept as is. Clear them.',
        isError: true,
      });
      expect(result.state?.acceptedAsIs).toBeUndefined();
      expect(composerDraftStore.get().request).toBeNull();
    });

    it('refuses a sentence typed as the answer on an apply-partial halt and puts it back', async () => {
      const { prepared, state } = setupSession(APPLY_PARTIAL);
      const { inputMode, feedbackAtPrompt } = makeInputMode(['mind the lockfile', 'u']);

      const result = await runDriver(prepared, state, inputMode);

      expect(feedbackAtPrompt[1]).toEqual({
        message: 'This halt takes no typed correction. Choose an action.',
        isError: true,
      });
      if (!result.shouldRun) throw new Error('expected Restore backup to run');
      expect(result.state.pendingRecovery?.selectedAction).toBe('restore-backup');
      expect(result.steer).toBeUndefined();
      expect(composerDraftStore.get().request).toMatchObject({
        kind: 'prepend',
        value: 'mind the lockfile',
        document: createDraftDocument('mind the lockfile'),
      });
    });
  });

  it.each([
    ['checkout', 'closes the run'],
    ['worktree', 'leaves it ready to apply'],
  ] as const)(
    'takes Accept as is an older build left chosen, with nothing typed, in %s mode: it %s',
    async (mode, _outcome) => {
      const { prepared, state } = setupFailedReview();
      const projectDir = prepared.session.ref.projectDir;
      const halted: WorkflowState = {
        ...state,
        workspace: {
          kind: mode,
          path: mode === 'checkout' ? projectDir : join(projectDir, 'wt'),
          base: { snapshotId: 'base', head: null },
        },
        pendingRecovery: {
          ...buildReviewFailedRecoveryIssue({
            blocking: 1,
            phase: 'complete',
            acceptAsIs: true,
            createdAt: '2026-09-24T00:00:00.000Z',
          }),
          status: 'applying',
          selectedAction: 'accept-as-is',
        },
      };
      saveState(prepared.session.ref, halted);
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);

      const result = await runDriver(prepared, halted, inputMode);

      expect(feedbackAtPrompt).toHaveLength(0);
      expect(result.state?.acceptedAsIs).toBeDefined();
      expect(result.state?.pendingRecovery).toBeUndefined();
      expect(result.shouldRun).toBe(mode === 'worktree');
      if (mode === 'checkout') expect(feedbackStore.get().message).toContain('Run closed');
    },
  );

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
      message: 'This halt takes no typed correction. Choose an action.',
      isError: true,
    });
    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
  });

  it('keeps words typed at reopen for the step Skip task runs next, with no refusal', async () => {
    const { prepared, state } = setupSession({
      reason: 'dependency-blocked',
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['s']);

    const result = await runDriver(
      prepared,
      state,
      inputMode,
      plainUserMessage('mind the lockfile'),
    );

    expect(feedbackAtPrompt).toEqual([{ message: null, isError: false }]);
    if (!result.shouldRun) throw new Error('expected the skip to run');
    expect(result.state.tasks[0]?.status).toBe('skipped');
    expect(result.steer).toBeUndefined();
    expect(result.correctionTaken).toBeUndefined();
  });

  it('says a halt End run alone answers takes no typed correction at reopen', async () => {
    const { prepared, state } = setupSession({
      availableActions: ['end-run'],
      recommendedAction: 'end-run',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['end']);

    await runDriver(prepared, state, inputMode, plainUserMessage('mind the lockfile'));

    expect(feedbackAtPrompt[0]).toEqual({
      message: 'This halt takes no typed correction. Choose an action.',
      isError: true,
    });
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

  it('sends a failed review back through another fix cycle with the correction typed on the panel', async () => {
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
    // The correction is recorded for the next fix cycle.
    expect(result.state.fixCycles).toEqual({
      used: 2,
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
    const notices = recordNoticeOpens();

    const result = await runDriver(
      prepared,
      state,
      inputMode,
      plainUserMessage('log the error and rethrow'),
    );
    notices.stop();

    expect(feedbackAtPrompt).toHaveLength(0);
    expect(notices.opens).toEqual([]);
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

describe('prepared recovery corrections', () => {
  it.each(['allowance-only', 'plan-retry', 'review-retry', 'task-retry'] as const)(
    'reports recording ownership and preserves the attached correction on %s',
    async (route) => {
      const phase = route === 'review-retry' ? 'final-review' : 'planning';
      const { prepared, state } = setupSession(
        route === 'task-retry'
          ? {}
          : {
              reason: route === 'allowance-only' ? 'planner-calls-spent' : 'planner-call-failed',
              taskId: undefined,
              phase,
              seat: route === 'review-retry' ? 'review' : 'plan',
              availableActions:
                route === 'allowance-only'
                  ? ['continue', 'end-run']
                  : ['retry-same-worker', 'end-run'],
              recommendedAction: route === 'allowance-only' ? 'continue' : 'retry-same-worker',
            },
      );
      const halted: WorkflowState = route === 'task-retry' ? state : { ...state, phase, tasks: [] };
      saveState(prepared.session.ref, halted);
      const outside = createTempDir('recovery-correction-outside');
      dirs.push(outside);
      const correction = attachedMessage(outside);
      composerLiveStore.setDraft(createDraftDocument(correction.displayText));
      const { inputMode } = makeInputMode([route === 'allowance-only' ? 'c' : 'r']);

      const result = await runDriver(prepared, halted, inputMode);

      if (!result.shouldRun) throw new Error('expected recovery to continue');
      const events = eventsStore.get().events;
      if (route === 'allowance-only' || route === 'task-retry') {
        expect(result.steer).toEqual(correction);
        expect(result.correctionTaken).toBeUndefined();
        expect(events.filter((event) => event.type === 'user_message')).toHaveLength(0);
        const logged = [];
        for await (const entry of readMessages(prepared.session.ref)) logged.push(entry);
        expect(logged).toHaveLength(0);
      } else {
        expect(result.steer).toBeUndefined();
        expect(result.correctionTaken).toBe(true);
        expect(result.state.messageQueue[0]).toMatchObject(correction);
        await expectCompactMessage(prepared.session.ref, events, correction);
      }
      expect(composerDraftStore.get().request?.value).toBe('');
    },
  );

  it('forwards an unrecorded correction supplied on reentry after allowance-only Continue', async () => {
    const { prepared, state } = setupSession({
      reason: 'planner-calls-spent',
      taskId: undefined,
      availableActions: ['continue', 'end-run'],
      recommendedAction: 'continue',
    });
    const correction = attachedMessage(prepared.session.ref.projectDir);
    const { inputMode } = makeInputMode(['c']);

    const result = await runDriver(prepared, state, inputMode, correction);

    if (!result.shouldRun) throw new Error('expected recovery to continue');
    expect(result.steer).toBe(correction);
    expect(result.correctionTaken).toBeUndefined();
    expect(result.state.messageQueue).toEqual([]);
  });

  it('prepares the draft document on a menu retry and keeps text bodies and image atoms', async () => {
    const { prepared, state } = setupSession();
    const outside = createTempDir('recovery-outside');
    dirs.push(outside);
    const path = join(outside, 'context.txt');
    const imagePath = join(outside, 'a.png');
    writeFileSync(path, 'body');
    writeFileSync(imagePath, 'png');
    const image = {
      id: 'att-existing',
      kind: 'image' as const,
      path: realpathSync(imagePath),
      mimeType: 'image/png' as const,
      sizeBytes: 3,
    };
    const document = {
      version: 1 as const,
      parts: [
        { kind: 'text' as const, text: `fix @${path} ` },
        { kind: 'image' as const, attachment: image },
      ],
    };
    composerLiveStore.setDraft(document);
    const visionPrepared: PreparedExecution = {
      ...prepared,
      config: { ...prepared.config, planner: { kind: 'cli' as const, tool: 'claude-code' } },
    };
    const { inputMode } = makeInputMode(['r']);
    const result = await runDriver(visionPrepared, state, inputMode);
    expect(result.shouldRun).toBe(true);
    if (!result.shouldRun) throw new Error('expected retry');
    expect(result.steer?.text).toContain(`--- @${path} ---\nbody`);
    expect(result.steer?.displayText).not.toContain('body');
    expect(result.steer?.images).toEqual([image]);
    expect(result.steer?.attachedInputs).toContainEqual({ kind: 'text', path: realpathSync(path) });
    expect(attachmentsStore.peek()).toEqual([image]);
    expect(composerDraftStore.get().request?.value).toBe('');
  });

  it('keeps draft and pending images on a refused menu correction', async () => {
    const { prepared, state } = setupSession();
    const document = createDraftDocument('fix @/definitely-missing/context.txt');
    composerLiveStore.setDraft(document);
    const pendingImage = {
      id: 'pending',
      kind: 'image' as const,
      path: '/outside/a.png',
      mimeType: 'image/png' as const,
      sizeBytes: 1,
    };
    attachmentsStore.replacePendingImages([pendingImage]);
    const { inputMode, feedbackAtPrompt } = makeInputMode(['r', 'end']);
    await runDriver(prepared, state, inputMode);
    expect(feedbackAtPrompt[1]).toEqual({
      message: 'Cannot send: file not found. Check the path and try again. File: context.txt.',
      isError: true,
    });
    expect(composerLiveStore.get().document).toBe(document);
    expect(composerDraftStore.get().request).toMatchObject({ kind: 'document', document });
    expect(attachmentsStore.peek()).toEqual([pendingImage]);
  });

  it.each(['retry', 'revise'] as const)(
    'transports the full prepared correction for %s',
    async (action) => {
      const { prepared, state } = setupSession(
        action === 'revise'
          ? {
              reason: 'plan-checks-failed',
              taskId: undefined,
              phase: 'planning',
              availableActions: ['revise', 'end-run'],
              recommendedAction: 'revise',
            }
          : {},
      );
      const original: UserMessageInput = {
        text: 'fix @/outside/context.txt\n\n--- @/outside/context.txt ---\nbody',
        displayText: 'fix @/outside/context.txt',
        images: [],
        attachedInputs: [{ kind: 'text', path: '/outside/context.txt' }],
      };
      const { inputMode } = makeInputMode([]);
      const result = await runDriver(prepared, state, {
        ...inputMode,
        setQuestionMode: async () => ({
          message: original,
          document: createDraftDocument(original.displayText),
        }),
      });
      if (!result.shouldRun) throw new Error('expected recovery');
      if (action === 'retry') expect(result.steer).toBe(original);
      else expect(result.state.messageQueue[0]).toMatchObject(original);
    },
  );
});

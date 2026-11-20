import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderInputMode } from '#testing/helpers/input-mode.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { configPath } from '../../../core/config/load/document.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { taskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { PreparedExecution } from '../../../engine/runners/prepare-execution/prepared.js';
import { configStore } from '../../../stores/project/config.js';
import {
  composerDraftStore,
  type ComposerDraftRequest,
} from '../../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { createDraftDocument } from '../../../core/composer/document.js';
import { feedbackStore, type FeedbackState } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { questionPromptStore } from '../../../stores/prompts/question.js';
import {
  recoveryNoticeStore,
  type RecoveryNoticeState,
} from '../../../stores/workflow/recovery-notice.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { hydrateFromState } from '../../../stores/workflow/actions/hydrate.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { afterLastBrief, resumeStep } from '../../../core/sessions/run/status.js';
import {
  plainAnswer,
  type QuestionAnswer,
  type UseInputModeResult,
} from '../hooks/use-input-mode.js';
import { createRecoveryDriver } from './driver.js';
import { acquireLiveness } from '../../../engine/orchestrator/run/liveness.js';
import type { PendingRecoveryResult } from './types.js';
import { clearAllHandlers, setStopHandler } from '../run-requests/registry.js';
import { requestSteer } from '../run-requests/stop-resume.js';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { join } from 'node:path';
import { REVIEW_FILE, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir, writeSpecFile } from '../../../core/sessions/spec-files.js';
import { buildReviewFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/review-failed.js';
import { addTuiEvent } from '../tui-sink.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../../engine/events/workflow-cancel.js';
import { attachedMessage, expectCompactMessage } from '#testing/helpers/user-message.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import { readMessages } from '../../../core/sessions/log/reader.js';

let dirs: string[] = [];

/** What the menu sends for a row: its key, with the mark only a row carries. */
const rowPick = (key: string): QuestionAnswer => ({ ...plainAnswer(key), row: true });

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
  configStore.__testReset({ projectDir, config: prepared.sourceConfig });
  return { prepared, state: saved };
}

function makeInputMode(answers: Array<string | QuestionAnswer | Promise<QuestionAnswer>>): {
  inputMode: UseInputModeResult;
  feedbackAtPrompt: FeedbackState[];
  noticeAtPrompt: RecoveryNoticeState[];
} {
  const queue = [...answers];
  const feedbackAtPrompt: FeedbackState[] = [];
  const noticeAtPrompt: RecoveryNoticeState[] = [];
  const inputMode: UseInputModeResult = {
    mode: 'question',
    hint: '',
    questionEpoch: 0,
    setReviewMode: async (): Promise<ApprovalReviewResult> => ({ approved: false }),
    setQuestionMode: async (): Promise<QuestionAnswer> => {
      feedbackAtPrompt.push({ ...feedbackStore.get() });
      noticeAtPrompt.push({ ...recoveryNoticeStore.get() });
      const answer = queue.shift();
      if (answer === undefined) throw new Error('The halt asked past the last scripted answer.');
      return typeof answer === 'string' ? plainAnswer(answer) : answer;
    },
    resolve: () => {},
    resetMode: () => {},
  };
  return { inputMode, feedbackAtPrompt, noticeAtPrompt };
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

/** Records every time the driver opens the panel, until the returned stop runs. */
function recordNoticeOpens(): { opens: RecoveryNoticeState[]; stop: () => void } {
  const opens: RecoveryNoticeState[] = [];
  const stop = recoveryNoticeStore.subscribe(() => {
    const notice = recoveryNoticeStore.get();
    if (notice.open) opens.push(notice);
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

/** A task review that failed before a move to REVIEW None, with the run past that brief. */
function setupNoneTaskReview(briefLeft: boolean): {
  prepared: PreparedExecution;
  state: WorkflowState;
} {
  const { prepared } = setupSession();
  const ref = prepared.session.ref;
  const halted: WorkflowState = {
    ...makeImplState([
      makeTask({ id: 'T001', status: 'done' }),
      ...(briefLeft ? [makeTask({ id: 'T002' })] : []),
    ]),
    currentTaskIndex: 1,
    pendingScheduledReview: { afterTaskId: taskId('T001') },
    review: {
      scope: 'task',
      afterTaskId: taskId('T001'),
      cycle: 0,
      verdict: { tasks: [], criteria: [], findings: [] },
      outcome: 'fail',
      verification: [],
      at: '2026-11-09T00:00:00.000Z',
    },
    pendingRecovery: buildReviewFailedRecoveryIssue({
      blocking: 1,
      phase: 'implementing',
      createdAt: '2026-11-09T00:00:00.000Z',
    }),
  };
  saveState(ref, halted);
  const saved = loadState(ref);
  if (saved?.pendingRecovery?.reason !== 'review-failed') {
    throw new Error('expected the failed task review to persist');
  }
  return {
    prepared: {
      ...prepared,
      config: makeConfig({
        planner: { kind: 'agent', command: 'test-planner' },
        implementer: { kind: 'agent', command: 'test-implementer', model: 'test-model' },
        reviewer: 'none',
      }),
    },
    state: saved,
  };
}

function sessionLog(prepared: PreparedExecution): string {
  const { projectDir, sessionId } = prepared.session.ref;
  return readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
}

describe('createRecoveryDriver', () => {
  it('runs no action on an empty answer and asks again', async () => {
    const { prepared, state } = setupSession();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['', rowPick('a')]);
    const result = await runDriver(prepared, state, inputMode);
    expect(feedbackAtPrompt[1]).toEqual({ message: 'Unknown recovery action.', severity: 'error' });
    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
  });

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
    await vi.waitFor(() => expect(recoveryNoticeStore.get()).toEqual({ open: true, asking: true }));

    controller.abort();

    await settled;
    expect(recoveryNoticeStore.get()).toEqual({ open: false, asking: false });
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

    expect(recoveryNoticeStore.get().open).toBe(false);
  });

  it('records skipped brief evidence without the mode an older run saved', async () => {
    const { prepared, state } = setupSession();
    const saved = { ...state, mode: 'speckit' as const };
    saveState(prepared.session.ref, saved);
    const { inputMode } = makeInputMode([rowPick('s')]);
    const result = await runDriver(prepared, saved, inputMode);
    expect(result.shouldRun).toBe(true);
    const ledger = readEvidenceLedger(prepared.session.ref);
    expect(ledger).not.toBeNull();
    expect(ledger).not.toHaveProperty('mode');
  });

  it('applies a valid action on the first answer without re-prompting', async () => {
    const { prepared, state } = setupSession();
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('s')]);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(true);
    expect(feedbackStore.get().severity).toBe('info');
    expect(recoveryNoticeStore.get().open).toBe(false);
  });

  it('shows one error after a moved project blocks Skip brief', async () => {
    const { prepared, state } = setupSession({
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    });
    const moved: WorkflowState = {
      ...state,
      workspace: {
        kind: 'checkout',
        path: join(prepared.session.ref.projectDir, 'original'),
        base: { head: null, snapshotId: 'base' },
      },
    };
    saveState(prepared.session.ref, moved);
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('s'), rowPick('a')]);
    await runDriver(prepared, moved, inputMode);
    const errors = eventsStore
      .get()
      .events.flatMap((event) =>
        event.type === 'recovery_action_failed' || event.type === 'error' ? [event.message] : [],
      );
    const notices = [...errors, feedbackAtPrompt[1]?.message ?? ''];
    expect(notices.filter((message) => message.includes('This run started in'))).toHaveLength(1);
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
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('r'), rowPick('a')]);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[1]?.severity).toBe('error');
    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
  });

  it('resumes the run on a retry with the brief pinned to the selected worker in the state', async () => {
    const { prepared, state } = setupSession();
    const { inputMode } = makeInputMode([rowPick('r')]);

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
      const { inputMode } = makeInputMode([rowPick('r')]);

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

    it('keeps them for the panel when the replayed action is refused', async () => {
      // A brief that failed its attempts cannot be continued safely, so the replay is refused.
      const { prepared, state } = setupSession({
        availableActions: ['continue', 'retry-same-worker', 'skip-current-task', 'end-run'],
        status: 'applying',
        selectedAction: 'continue',
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('r')]);

      const result = await runDriver(prepared, state, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(1);
      expect(feedbackAtPrompt[0]?.severity).toBe('error');
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

  it('opens the panel in the same tick the run enters the halt, so no frame paints it closed', async () => {
    const { prepared, state } = setupSession();
    const { inputMode } = makeInputMode([rowPick('s')]);

    const pending = runDriver(prepared, state, inputMode);
    const openAtEntry = recoveryNoticeStore.get().open;
    await pending;

    expect(openAtEntry).toBe(true);
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
    expect(recoveryNoticeStore.get()).toEqual({ open: true, asking: false });
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
    const { inputMode } = makeInputMode([rowPick('w')]);

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
    const { inputMode } = makeInputMode([rowPick('w')]);

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
    expect(recoveryNoticeStore.get().open).toBe(false);
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
    const { inputMode } = makeInputMode([rowPick('w'), rowPick('a')]);

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
    const { inputMode } = makeInputMode([rowPick('w'), rowPick('a')]);

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
    expect(recoveryNoticeStore.get().open).toBe(false);
  });

  describe('Decide for me', () => {
    const CANNOT: Partial<RecoveryIssue> = {
      facts: {
        cannot: 'The SDK has no payment API.',
        cannotBy: 'planner',
        cannotNext: 'skip-brief',
      },
      availableActions: ['decide-for-me', 'skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    };

    /** The driver reads the config of record before it applies the row, as a loaded screen holds it. */
    function withConfig(overrides: Partial<RecoveryIssue>) {
      const session = setupSession(overrides);
      configStore.__testReset({
        projectDir: session.prepared.session.ref.projectDir,
        config: session.prepared.sourceConfig,
      });
      return session;
    }

    function decided(overrides: Partial<RecoveryIssue>) {
      const { prepared, state } = withConfig(overrides);
      const chosen: WorkflowState = { ...state, decideForMe: true };
      saveState(prepared.session.ref, chosen);
      return { prepared, state: chosen };
    }

    it('applies the row chosen on the panel and records the choice', async () => {
      const { prepared, state } = withConfig(CANNOT);
      const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('d')]);

      const result = await runDriver(prepared, state, inputMode);

      expect(feedbackAtPrompt).toHaveLength(1);
      expect(result.shouldRun).toBe(true);
      const saved = loadState(prepared.session.ref);
      expect(saved?.decideForMe).toBe(true);
      expect(saved?.tasks[0]?.status).toBe('skipped');
    });

    it('takes a d typed in the composer as words for the retry, not as the row', async () => {
      const { prepared, state } = withConfig({
        ...CANNOT,
        availableActions: ['retry-same-worker', 'decide-for-me', 'skip-current-task', 'end-run'],
      });
      const { inputMode } = makeInputMode(['d']);

      const result = await runDriver(prepared, state, inputMode);

      expect(result.shouldRun).toBe(true);
      if (result.shouldRun) expect(result.steer?.text).toBe('d');
      expect(loadState(prepared.session.ref)?.decideForMe).not.toBe(true);
    });

    it('cannot end on the saved decision while another driver holds the run', async () => {
      const { prepared, state } = decided({
        ...CANNOT,
        facts: { ...CANNOT.facts, cannotNext: 'end-run' },
      });
      const { ref } = prepared.session;
      const saved = loadState(ref);
      const { inputMode } = makeInputMode([]);
      const release = await acquireLiveness({ ...ref, feature: state.feature });

      try {
        await expect(runDriver(prepared, state, inputMode)).rejects.toMatchObject({
          kind: 'workflow-session-already-live',
        });
        expect(loadState(ref)).toEqual(saved);
      } finally {
        await release();
      }
    });

    it('skips a brief the planner cannot do with no panel once the user chose it', async () => {
      const { prepared, state } = decided(CANNOT);
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);
      const notices = recordNoticeOpens();

      const result = await runDriver(prepared, state, inputMode);
      notices.stop();

      expect(feedbackAtPrompt).toHaveLength(0);
      expect(notices.opens).toHaveLength(0);
      expect(result.shouldRun).toBe(true);
      expect(loadState(prepared.session.ref)?.tasks[0]?.status).toBe('skipped');
    });

    it('lets words typed to continue answer the halt instead of the decided step', async () => {
      const { prepared, state } = decided({
        ...CANNOT,
        availableActions: ['retry-same-worker', 'decide-for-me', 'skip-current-task', 'end-run'],
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('r')]);
      const words = plainUserMessage('use the REST endpoint instead');

      const result = await runDriver(prepared, state, inputMode, words);

      expect(feedbackAtPrompt).toHaveLength(1);
      expect(result.shouldRun).toBe(true);
      if (result.shouldRun) expect(result.steer).toEqual(words);
      const saved = loadState(prepared.session.ref);
      expect(saved?.tasks[0]?.status).not.toBe('skipped');
      expect(saved?.pendingRecovery).toBeUndefined();
    });

    it('waits for the reset of a seat down with no fallback, with no panel', async () => {
      const resetAt = '2099-05-01T10:00:00.000Z';
      const { prepared, state } = decided({
        reason: 'runner-usage-limit',
        seat: 'build',
        resetAt,
        availableActions: ['retry-later', 'switch-seat', 'end-run'],
        recommendedAction: 'retry-later',
        switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
      });
      const { inputMode, feedbackAtPrompt } = makeInputMode([]);
      const notices = recordNoticeOpens();

      const result = await runDriver(prepared, state, inputMode);
      notices.stop();

      expect(feedbackAtPrompt).toHaveLength(0);
      expect(notices.opens).toHaveLength(0);
      expect(result.shouldRun).toBe(true);
      expect(loadState(prepared.session.ref)?.seatWait?.resetAt).toBe(resetAt);
    });

    it('still asks on a halt the run cannot decide itself', async () => {
      const { prepared, state } = decided({});
      const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('s')]);

      await runDriver(prepared, state, inputMode);

      expect(feedbackAtPrompt).toHaveLength(1);
    });
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
    const { inputMode } = makeInputMode([rowPick('w')]);

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
    const { inputMode } = makeInputMode([rowPick('w')]);

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
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('w'), rowPick('a')]);

    const pending = runDriver(prepared, state, inputMode);
    await closeSeatPicker(prepared);
    const result = await pending;

    // The halt asks again rather than resuming on a seat nobody changed.
    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[1]?.severity).toBe('info');
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
      const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('w'), rowPick('a')]);

      const pending = runDriver(prepared, state, inputMode);
      await closeSeatPicker(prepared, seat);
      const result = await pending;

      expect(feedbackAtPrompt).toHaveLength(2);
      expect(result.shouldRun).toBe(false);
      expect(result.state?.closed?.as).toBe('ended');
    },
  );

  it('opens the picker on the first tool offered and takes the tool chosen there', async () => {
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
    const { inputMode } = makeInputMode([rowPick('w')]);

    const pending = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => {
      expect(overlayStore.get().focus).toBe('tool:claude-code');
    });
    await closeSeatPicker(prepared, { kind: 'cli', tool: 'opencode' });
    const result = await pending;

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.switchSeat?.candidate).toEqual({ tool: 'opencode' });
    }
    expect(recoveryNoticeStore.get()).toEqual({ open: false, asking: false });
  });

  it('republishes an Apply halt with Apply as the step it waits at', async () => {
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
    const pending = promptPendingRecovery({ state: halted, controller, republishPrompt: true });
    const settled = expect(pending).rejects.toBe(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    await vi.waitFor(() => expect(cancelQuestion).toBeDefined());
    expect(runViewStore.get().halt?.at).toEqual({ kind: 'apply' });

    controller.abort();
    await settled;
    // A stop leaves the halt pending: the view keeps it, only the panel closes.
    expect(runViewStore.get().halt?.at).toEqual({ kind: 'apply' });
    expect(recoveryNoticeStore.get().open).toBe(false);
  });

  it('opens the PLAN picker for a review halt whose REVIEW follows PLAN', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      phase: 'final-review',
      taskId: undefined,
      taskTitle: undefined,
      seat: 'review',
      files: [],
      affectedTaskIds: [],
      message: 'OpenAI Codex CLI hit its usage limit',
      resetAt: '2026-10-03T13:02:00.000Z',
      switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
    });
    const { inputMode } = makeInputMode([rowPick('w')]);

    const pending = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => {
      expect(overlayStore.get()).toMatchObject({
        active: 'planner-picker',
        focus: 'tool:claude-code',
      });
    });
    expect(recoveryNoticeStore.get()).toEqual({ open: true, asking: false });
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

  it('keeps the halt when the recovery panel answers after another driver enters', async () => {
    const { prepared, state } = setupSession({
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
    });
    const { ref } = prepared.session;
    const answer = Promise.withResolvers<QuestionAnswer>();
    const { inputMode, feedbackAtPrompt } = makeInputMode([answer.promise]);
    const prompt = runDriver(prepared, state, inputMode);
    await vi.waitFor(() => expect(feedbackAtPrompt).toHaveLength(1));
    const release = await acquireLiveness({ ...ref, feature: state.feature });

    try {
      answer.resolve(rowPick('a'));
      await expect(prompt).rejects.toMatchObject({ kind: 'workflow-session-already-live' });
      expect(loadState(ref)).toEqual(state);
    } finally {
      await release();
    }
  });

  it('end run closes the run on the state and stops the loop', async () => {
    const { prepared, state } = setupSession({
      reason: 'review-failed',
      taskId: undefined,
      availableActions: ['retry-same-worker', 'end-run'],
      recommendedAction: 'retry-same-worker',
    });
    const { inputMode } = makeInputMode([rowPick('a')]);

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
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('k')]);

    const result = await runDriver(prepared, halted, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(result.shouldRun).toBe(false);
    expect(result.state?.acceptedAsIs).toBeDefined();
    expect(result.state?.reviewStatus).toBe('failed');
    expect(result.state?.pendingRecovery).toBeUndefined();
    expect(loadState(prepared.session.ref)?.reviewStatus).toBe('failed');
    expect(recoveryNoticeStore.get().open).toBe(false);
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
    expect(feedbackStore.get().severity).toBe('info');
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.steer).toEqual(plainUserMessage('the prop is optional — add a default'));
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
    }
  });

  it('a steer at a waiting recovery panel runs the correction action with the words', async () => {
    const { prepared, state } = setupSession({
      reason: 'runner-usage-limit',
      seat: 'build',
      resetAt: '2026-10-10T17:00:00.000Z',
    });
    const stop = vi.fn();
    setStopHandler(stop);
    const { inputMode, mode, unmount } = await renderInputMode();
    const controller = new AbortController();
    const outcome = createRecoveryDriver({
      prepared,
      configOfRun: prepared.sourceConfig,
      inputMode,
      abortedRef: { current: false },
      retentionNoticeHandled: { current: true },
      sink: addTuiEvent,
      setInlineResume: () => {},
    })({ state, controller, republishPrompt: false });
    onTestFinished(async () => {
      controller.abort();
      await outcome.catch(() => undefined);
      unmount();
      clearAllHandlers();
    });
    await vi.waitFor(() => expect(mode()).toBe('question'));

    expect(requestSteer(plainUserMessage('also fix the typo'))).toBeUndefined();

    expect(stop).not.toHaveBeenCalled();
    const result = await outcome;
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.steer).toEqual(plainUserMessage('also fix the typo'));
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.tasks[0]?.status).toBe('pending');
    }
  });

  it('takes a steer as the note of a review skip on a halt that takes no typed correction', async () => {
    const { prepared, state } = setupSession({
      reason: 'review-input-too-large',
      taskId: undefined,
      seat: 'review',
      availableActions: ['accept-as-is', 'end-run'],
      recommendedAction: 'end-run',
    });
    const { inputMode, mode, unmount } = await renderInputMode();
    const controller = new AbortController();
    const outcome = createRecoveryDriver({
      prepared,
      configOfRun: prepared.sourceConfig,
      inputMode,
      abortedRef: { current: false },
      retentionNoticeHandled: { current: true },
      sink: addTuiEvent,
      setInlineResume: () => {},
    })({ state, controller, republishPrompt: false });
    onTestFinished(async () => {
      controller.abort();
      await outcome.catch(() => undefined);
      unmount();
      clearAllHandlers();
    });
    await vi.waitFor(() => expect(mode()).toBe('question'));
    inputMode.resolve(rowPick('k'));
    await vi.waitFor(() => {
      expect(questionPromptStore.get().hint).toBe('Why skip the review? (enter records none)');
      expect(recoveryNoticeStore.get().asking).toBe(false);
    });

    expect(requestSteer(plainUserMessage('the change is a generated lockfile'))).toBeUndefined();

    const result = await outcome;
    expect(result.state?.acceptedAsIs?.note).toBe('the change is a generated lockfile');
    expect(feedbackStore.get().severity).toBe('info');
  });

  it('takes the composer draft as the steer when Try again is chosen on the panel', async () => {
    const { prepared, state } = setupSession();
    composerLiveStore.setDraft(createDraftDocument('the prop is optional'));
    const { inputMode } = makeInputMode([rowPick('r')]);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) expect(result.steer).toEqual(plainUserMessage('the prop is optional'));
    expect(composerDraftStore.get().request?.value).toBe('');
  });

  it('leaves the composer draft alone when an action that takes no note is chosen', async () => {
    const { prepared, state } = setupSession();
    composerLiveStore.setDraft(createDraftDocument('run the formatter before the tests'));
    const { inputMode } = makeInputMode([rowPick('a')]);

    const result = await runDriver(prepared, state, inputMode);

    expect(result.shouldRun).toBe(false);
    expect(composerDraftStore.get().request).toBeNull();
  });

  it('leaves the composer draft alone when Skip brief is chosen beside it', async () => {
    const { prepared, state } = setupSession();
    composerLiveStore.setDraft(createDraftDocument('the prop is optional'));
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('s')]);

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
        return rowPick(queue.shift() ?? '');
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
          message: `${label} takes no message. Clear the input first.`,
          severity: 'warning',
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
        message: 'Re-run Apply takes no message. Clear the input first.',
        severity: 'warning',
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
        message: 'Accept as is takes no message. Clear the input first.',
        severity: 'warning',
      });
      expect(result.state?.acceptedAsIs).toBeUndefined();
      expect(composerDraftStore.get().request).toBeNull();
    });

    it('refuses a sentence typed as the answer on an apply-partial halt and puts it back', async () => {
      const { prepared, state } = setupSession(APPLY_PARTIAL);
      const { inputMode, feedbackAtPrompt } = makeInputMode(['mind the lockfile', rowPick('u')]);

      const result = await runDriver(prepared, state, inputMode);

      expect(feedbackAtPrompt[1]).toEqual({
        message: 'This halt takes no typed correction. Choose an action.',
        severity: 'warning',
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

  it.each([
    'a',
    'end',
    'end run',
    'end-run',
    'q',
    'quit',
    'abort',
    's',
    'skip',
    'skip brief',
    'skip-current-task',
  ])('takes %s typed in the composer as the correction of Try again', async (word) => {
    const { prepared, state } = setupSession();
    const { inputMode } = makeInputMode([word]);

    const result = await runDriver(prepared, state, inputMode);

    if (!result.shouldRun) throw new Error(`expected ${word} to retry, not to stop the run`);
    expect(result.steer?.text).toBe(word);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.closed).toBeUndefined();
    expect(result.state.tasks[0]?.status).toBe('pending');
  });

  it('refuses a typed word at a halt with no correction, and the row still acts', async () => {
    const { prepared, state } = setupSession({
      reason: 'dependency-blocked',
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['end', rowPick('a')]);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt[1]).toEqual({
      message: 'This halt takes no typed correction. Choose an action.',
      severity: 'warning',
    });
    expect(composerDraftStore.get().request).toMatchObject({ kind: 'prepend', value: 'end' });
    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
  });

  it('takes k typed at a failed review as the note of Review again, not as Accept as is', async () => {
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
    const { inputMode } = makeInputMode(['k']);

    const result = await runDriver(prepared, halted, inputMode);

    if (!result.shouldRun) throw new Error('expected the fix cycle to run');
    expect(result.state.acceptedAsIs).toBeUndefined();
    expect(result.state.fixCycles?.notes).toEqual(['k']);
  });

  it('refuses a sentence at a halt that offers nothing to carry it, and says why', async () => {
    const { prepared, state } = setupSession({
      reason: 'dependency-blocked',
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode(['make the prop optional', rowPick('a')]);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(2);
    expect(feedbackAtPrompt[1]).toEqual({
      message: 'This halt takes no typed correction. Choose an action.',
      severity: 'warning',
    });
    expect(result.shouldRun).toBe(false);
    expect(result.state?.closed?.as).toBe('ended');
  });

  it('keeps words typed at reopen for the step Skip brief runs next, with no refusal', async () => {
    const { prepared, state } = setupSession({
      reason: 'dependency-blocked',
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    });
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('s')]);

    const result = await runDriver(
      prepared,
      state,
      inputMode,
      plainUserMessage('mind the lockfile'),
    );

    expect(feedbackAtPrompt).toEqual([{ message: null, severity: 'info' }]);
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
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('a')]);

    await runDriver(prepared, state, inputMode, plainUserMessage('mind the lockfile'));

    expect(feedbackAtPrompt[0]).toEqual({
      message: 'This halt takes no typed correction. Choose an action.',
      severity: 'warning',
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
    const { inputMode, noticeAtPrompt } = makeInputMode([rowPick('v'), 'split the first brief']);

    const result = await runDriver(prepared, state, inputMode);

    // The panel's own question is the recovery prompt; the note it asks for next is not.
    expect(noticeAtPrompt).toEqual([
      { open: true, asking: true },
      { open: true, asking: false },
    ]);
    expect(recoveryNoticeStore.get()).toEqual({ open: false, asking: false });
    expect(result.shouldRun).toBe(true);
    expect(result.state?.pendingRecovery).toBeUndefined();
    expect(result.state?.messageQueue.map((message) => message.text)).toEqual([
      'split the first brief',
    ]);
  });

  it('sends a failed review back to the reviewer with the correction typed on the panel', async () => {
    const { prepared, state } = setupFailedReview();
    const { inputMode, feedbackAtPrompt } = makeInputMode(['keep the error, log it and rethrow']);

    const result = await runDriver(prepared, state, inputMode);

    expect(feedbackAtPrompt).toHaveLength(1);
    expect(feedbackStore.get().severity).toBe('info');
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
      briefed: 2,
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
  it.each(['plan-retry', 'review-retry', 'task-retry'] as const)(
    'reports recording ownership and preserves the attached correction on %s',
    async (route) => {
      const phase = route === 'review-retry' ? 'final-review' : 'planning';
      const { prepared, state } = setupSession(
        route === 'task-retry'
          ? {}
          : {
              reason: 'planner-call-failed',
              taskId: undefined,
              phase,
              seat: route === 'review-retry' ? 'review' : 'plan',
              availableActions: ['retry-same-worker', 'end-run'],
              recommendedAction: 'retry-same-worker',
            },
      );
      const halted: WorkflowState = route === 'task-retry' ? state : { ...state, phase, tasks: [] };
      saveState(prepared.session.ref, halted);
      const outside = createTempDir('recovery-correction-outside');
      dirs.push(outside);
      const correction = attachedMessage(outside);
      composerLiveStore.setDraft(createDraftDocument(correction.displayText));
      const { inputMode } = makeInputMode([rowPick('r')]);

      const result = await runDriver(prepared, halted, inputMode);

      if (!result.shouldRun) throw new Error('expected recovery to continue');
      const events = eventsStore.get().events;
      if (route === 'task-retry') {
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
    const { inputMode } = makeInputMode([rowPick('r')]);
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
    const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('r'), rowPick('a')]);
    await runDriver(prepared, state, inputMode);
    expect(feedbackAtPrompt[1]).toEqual({
      message: 'Cannot send: file not found. Check the path and try again. File: context.txt.',
      severity: 'warning',
    });
    expect(composerLiveStore.get().document).toBe(document);
    expect(composerDraftStore.get().request).toMatchObject({ kind: 'document', document });
    expect(attachmentsStore.peek()).toEqual([pendingImage]);
  });

  describe('a failed task review after a move to REVIEW None', () => {
    const WORDS = 'mind the lockfile';
    const NO_CORRECTION = 'This halt takes no typed correction. Choose an action.';

    it('asks for no note on Review again, as no seat reads one', async () => {
      const { prepared, state } = setupNoneTaskReview(true);
      const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('v'), 'a note nobody reads']);

      const result = await runDriver(prepared, state, inputMode);

      expect(feedbackAtPrompt).toHaveLength(1);
      expect(result.shouldRun).toBe(true);
    });

    it('carries words typed on the halt to the next brief', async () => {
      const { prepared, state } = setupNoneTaskReview(true);
      const { inputMode } = makeInputMode([WORDS]);

      const result = await runDriver(prepared, state, inputMode);

      if (!result.shouldRun) throw new Error('expected the run to continue');
      expect(result.steer?.text).toBe(WORDS);
      expect(result.correctionTaken).toBeUndefined();
      expect(result.state.pendingTriage?.inputs ?? []).toEqual([]);
    });

    it('refuses words typed on the halt when no brief is left', async () => {
      const { prepared, state } = setupNoneTaskReview(false);
      const { inputMode, feedbackAtPrompt } = makeInputMode([WORDS, rowPick('a')]);

      await runDriver(prepared, state, inputMode);

      expect(feedbackAtPrompt[1]).toMatchObject({ message: NO_CORRECTION, severity: 'warning' });
    });

    it('refuses Continue with words in the composer when no brief is left', async () => {
      const { prepared, state } = setupNoneTaskReview(false);
      composerLiveStore.setDraft(createDraftDocument(WORDS));
      const { inputMode, feedbackAtPrompt } = makeInputMode([rowPick('v'), rowPick('a')]);

      await runDriver(prepared, state, inputMode);

      expect(feedbackAtPrompt[1]).toMatchObject({
        message: 'Continue takes no message. Clear the input first.',
        severity: 'warning',
      });
    });

    describe('while the panel waits', () => {
      /** The halt on a run that still has its seat. */
      function setupSeatedTaskReview(briefLeft: boolean): {
        prepared: PreparedExecution;
        state: WorkflowState;
      } {
        const { prepared, state } = setupNoneTaskReview(briefLeft);
        return { prepared: { ...prepared, config: prepared.sourceConfig }, state };
      }

      function moveReviewToNone(prepared: PreparedExecution): void {
        configStore.__testReset({
          projectDir: prepared.session.ref.projectDir,
          config: { ...prepared.sourceConfig, reviewer: 'none' },
        });
      }

      /** The panel waits, `during` runs, and only then the first scripted answer arrives. */
      function answerAfter(
        answers: Array<string | QuestionAnswer>,
        during: () => void,
      ): ReturnType<typeof makeInputMode> {
        const made = makeInputMode(answers);
        let waited = false;
        return {
          ...made,
          inputMode: {
            ...made.inputMode,
            setQuestionMode: (...args) => {
              if (!waited) {
                waited = true;
                during();
              }
              return made.inputMode.setQuestionMode(...args);
            },
          },
        };
      }

      it('refuses words sent after the move when no brief is left, and keeps them', async () => {
        const { prepared, state } = setupSeatedTaskReview(false);
        const { inputMode, feedbackAtPrompt } = answerAfter([WORDS, rowPick('a')], () =>
          moveReviewToNone(prepared),
        );

        await runDriver(prepared, state, inputMode);

        expect(feedbackAtPrompt[1]).toMatchObject({ message: NO_CORRECTION, severity: 'warning' });
        expect(composerDraftStore.get().request).toMatchObject({ kind: 'prepend' });
      });

      it('carries words sent after the move to the next brief', async () => {
        const { prepared, state } = setupSeatedTaskReview(true);
        const { inputMode } = answerAfter([WORDS], () => moveReviewToNone(prepared));

        const result = await runDriver(prepared, state, inputMode);

        if (!result.shouldRun) throw new Error('expected the run to continue');
        expect(result.steer?.text).toBe(WORDS);
        expect(result.correctionTaken).toBeUndefined();
        expect(result.state.pendingTriage?.inputs ?? []).toEqual([]);
      });

      it('asks for no note on the row after the move', async () => {
        const { prepared, state } = setupSeatedTaskReview(true);
        const { inputMode, feedbackAtPrompt } = answerAfter(
          [rowPick('v'), 'a note nobody reads'],
          () => moveReviewToNone(prepared),
        );

        const result = await runDriver(prepared, state, inputMode);

        expect(feedbackAtPrompt).toHaveLength(1);
        expect(result.shouldRun).toBe(true);
      });

      it('reads a hand edit of the file when the answer comes', async () => {
        const { prepared, state } = setupSeatedTaskReview(false);
        const { projectDir } = prepared.session.ref;
        writeConfig(projectDir, prepared.sourceConfig);
        configStore.load(projectDir);
        const { inputMode, feedbackAtPrompt } = answerAfter([WORDS, rowPick('a')], () =>
          writeConfig(projectDir, { ...prepared.sourceConfig, reviewer: 'none' }),
        );

        await runDriver(prepared, state, inputMode);

        expect(feedbackAtPrompt[1]).toMatchObject({ message: NO_CORRECTION, severity: 'warning' });
      });

      it('changes the halt on the view in the same tick, and leaves the run as it is', async () => {
        const { prepared, state } = setupSeatedTaskReview(false);
        hydrateFromState(state, false);
        const view = runViewStore.get();
        const lifecycle = lifecycleStore.get();
        let moved = view;
        let lifecycleAtMove = lifecycle;
        const { inputMode } = answerAfter([rowPick('a')], () => {
          moveReviewToNone(prepared);
          moved = runViewStore.get();
          lifecycleAtMove = lifecycleStore.get();
        });

        await runDriver(prepared, state, inputMode);

        expect(view.reviewNone).toBe(false);
        expect(moved.reviewNone).toBe(true);
        expect(moved.afterLastBrief).toEqual(afterLastBrief(state, true, 0));
        expect(moved.halt).toEqual({ issue: state.pendingRecovery, at: resumeStep(state, true) });
        expect(moved.phase).toBe(view.phase);
        expect(moved.briefs).toBe(view.briefs);
        expect(lifecycleAtMove).toBe(lifecycle);
      });

      it('leaves the view alone once the panel has its answer', async () => {
        const { prepared, state } = setupSeatedTaskReview(false);
        hydrateFromState(state, false);
        const { inputMode } = makeInputMode([rowPick('a')]);
        await runDriver(prepared, state, inputMode);
        const view = runViewStore.get();

        moveReviewToNone(prepared);

        expect(runViewStore.get()).toBe(view);
      });

      it('leaves the view alone once the wait was cancelled', async () => {
        const { prepared, state } = setupSeatedTaskReview(false);
        hydrateFromState(state, false);
        const { inputMode } = makeInputMode([]);
        await expect(
          runDriver(prepared, state, {
            ...inputMode,
            setQuestionMode: () => Promise.reject(WORKFLOW_USER_CANCELLED_ABORT_REASON),
          }),
        ).rejects.toBe(WORKFLOW_USER_CANCELLED_ABORT_REASON);
        const view = runViewStore.get();

        moveReviewToNone(prepared);

        expect(runViewStore.get()).toBe(view);
      });

      const PANEL = 'Needs you · Final review failed with 1 blocking finding';
      const NOTE = "What should the fix change? (enter sends the review's findings alone)";
      const MALFORMED =
        'Malformed YAML in .splitbrief/config.yaml — fix the syntax or delete the file to use defaults.';

      /**
       * Records the first line of each question and REVIEW None on the view when it is asked. Then
       * `onAsk` runs with the number of that question, and the next scripted answer comes.
       */
      function recordQuestions(
        answers: Array<string | QuestionAnswer | Promise<QuestionAnswer>>,
        onAsk: (asked: number) => void = () => {},
      ): ReturnType<typeof makeInputMode> & {
        asked: Array<{ question: string; reviewNone: boolean }>;
      } {
        const made = makeInputMode(answers);
        const asked: Array<{ question: string; reviewNone: boolean }> = [];
        return {
          ...made,
          asked,
          inputMode: {
            ...made.inputMode,
            setQuestionMode: (question) => {
              asked.push({
                question: question.split('\n')[0] ?? '',
                reviewNone: runViewStore.get().reviewNone,
              });
              onAsk(asked.length);
              return made.inputMode.setQuestionMode(question);
            },
          },
        };
      }

      /** The halt on a run that still has its seat, with its config in the file. */
      function setupOnDisk(): { prepared: PreparedExecution; state: WorkflowState } {
        const setup = setupSeatedTaskReview(false);
        const { projectDir } = setup.prepared.session.ref;
        writeConfig(projectDir, setup.prepared.sourceConfig);
        configStore.load(projectDir);
        hydrateFromState(setup.state, false);
        return setup;
      }

      function breakConfigFile(prepared: PreparedExecution): void {
        writeFileSync(configPath(prepared.session.ref.projectDir), 'reviewer: [\n');
      }

      it('ends the note question on a move, keeps the note, and asks the panel again', async () => {
        const { prepared, state } = setupSeatedTaskReview(false);
        hydrateFromState(state, false);
        const { inputMode, asked } = recordQuestions([rowPick('v'), WORDS, rowPick('a')], (at) => {
          if (at === 2) moveReviewToNone(prepared);
        });

        const result = await runDriver(prepared, state, inputMode);

        expect(asked.map(({ question }) => question)).toEqual([PANEL, NOTE, PANEL]);
        expect(asked[2]?.reviewNone).toBe(true);
        expect(result).toMatchObject({ shouldRun: false, state: { closed: { as: 'ended' } } });
        expect(composerDraftStore.get().request).toMatchObject({ kind: 'prepend', value: WORDS });
      });

      it('sends the kept note to the next brief from the panel asked again', async () => {
        const { prepared, state } = setupSeatedTaskReview(true);
        hydrateFromState(state, false);
        const { inputMode, asked } = recordQuestions([rowPick('v'), WORDS, WORDS], (at) => {
          if (at === 2) moveReviewToNone(prepared);
        });

        const result = await runDriver(prepared, state, inputMode);

        expect(asked.map(({ question }) => question)).toEqual([PANEL, NOTE, PANEL]);
        expect(composerDraftStore.get().request).toMatchObject({ kind: 'prepend', value: WORDS });
        if (!result.shouldRun) throw new Error('expected the run to continue');
        expect(result.steer?.text).toBe(WORDS);
        expect(result.correctionTaken).toBeUndefined();
        expect(result.state.pendingTriage?.inputs ?? []).toEqual([]);
      });

      it('ends the note question at once when the move comes before its answer', async () => {
        const { prepared, state } = setupSeatedTaskReview(false);
        hydrateFromState(state, false);
        const note = Promise.withResolvers<QuestionAnswer>();
        const { inputMode, asked } = recordQuestions([rowPick('v'), note.promise, rowPick('a')]);

        const running = runDriver(prepared, state, inputMode);
        await vi.waitFor(() => {
          expect(asked.map(({ question }) => question)).toEqual([PANEL, NOTE]);
        });
        moveReviewToNone(prepared);
        await vi.waitFor(() => {
          expect(asked).toHaveLength(3);
        });
        note.resolve(plainAnswer(WORDS));

        await expect(running).resolves.toMatchObject({
          shouldRun: false,
          state: { closed: { as: 'ended' } },
        });
        expect(asked[2]).toEqual({ question: PANEL, reviewNone: true });
        expect(composerDraftStore.get().request).toBeNull();
      });

      it('ends the note question on a hand edit that loads, read when the note comes', async () => {
        const { prepared, state } = setupOnDisk();
        const { projectDir } = prepared.session.ref;
        const { inputMode, asked } = recordQuestions([rowPick('v'), WORDS, rowPick('a')], (at) => {
          if (at === 2) writeConfig(projectDir, { ...prepared.sourceConfig, reviewer: 'none' });
        });

        const result = await runDriver(prepared, state, inputMode);

        expect(asked.map(({ question }) => question)).toEqual([PANEL, NOTE, PANEL]);
        expect(asked[2]?.reviewNone).toBe(true);
        expect(result).toMatchObject({ shouldRun: false, state: { closed: { as: 'ended' } } });
        expect(composerDraftStore.get().request).toMatchObject({ kind: 'prepend', value: WORDS });
      });

      it('ends the run on End run when the file does not load', async () => {
        const { prepared, state } = setupOnDisk();
        const { inputMode } = recordQuestions([rowPick('a')], (at) => {
          if (at === 1) breakConfigFile(prepared);
        });

        await expect(runDriver(prepared, state, inputMode)).resolves.toMatchObject({
          shouldRun: false,
          state: { closed: { as: 'ended' } },
        });
        expect(loadState(prepared.session.ref)?.closed?.as).toBe('ended');
        expect(feedbackStore.get().message).toContain('Run ended');
      });

      it('refuses typed words when the file does not load, keeps them, and leaves the halt open', async () => {
        const { prepared, state } = setupOnDisk();
        let halt: RecoveryIssue | undefined;
        const { inputMode, asked, feedbackAtPrompt } = recordQuestions(
          [WORDS, rowPick('a')],
          (at) => {
            if (at === 1) breakConfigFile(prepared);
            if (at === 2) halt = loadState(prepared.session.ref)?.pendingRecovery;
          },
        );

        await expect(runDriver(prepared, state, inputMode)).resolves.toMatchObject({
          shouldRun: false,
        });

        expect(asked.map(({ question }) => question)).toEqual([PANEL, PANEL]);
        expect(feedbackAtPrompt[1]).toMatchObject({ message: MALFORMED, severity: 'error' });
        expect(composerDraftStore.get().request).toMatchObject({ kind: 'prepend', value: WORDS });
        expect(halt).toMatchObject({ reason: 'review-failed', status: 'awaiting-user' });
      });

      it('refuses a row that starts a pass when the file does not load, and asks no note', async () => {
        const { prepared, state } = setupOnDisk();
        let halt: RecoveryIssue | undefined;
        const { inputMode, asked, feedbackAtPrompt } = recordQuestions(
          [rowPick('v'), rowPick('a')],
          (at) => {
            if (at === 1) breakConfigFile(prepared);
            if (at === 2) halt = loadState(prepared.session.ref)?.pendingRecovery;
          },
        );

        await expect(runDriver(prepared, state, inputMode)).resolves.toMatchObject({
          shouldRun: false,
        });

        expect(asked.map(({ question }) => question)).toEqual([PANEL, PANEL]);
        expect(feedbackAtPrompt[1]).toMatchObject({ message: MALFORMED, severity: 'error' });
        expect(composerDraftStore.get().request).toBeNull();
        expect(halt).toMatchObject({ reason: 'review-failed', status: 'awaiting-user' });
        expect(halt?.selectedAction).toBeUndefined();
      });

      it('takes the next answer once the file loads again', async () => {
        const { prepared, state } = setupOnDisk();
        const { projectDir } = prepared.session.ref;
        const { inputMode, asked, feedbackAtPrompt } = recordQuestions(
          [WORDS, rowPick('v'), ''],
          (at) => {
            if (at === 1) breakConfigFile(prepared);
            if (at === 2) writeConfig(projectDir, prepared.sourceConfig);
          },
        );

        await expect(runDriver(prepared, state, inputMode)).resolves.toMatchObject({
          shouldRun: true,
        });

        expect(asked.map(({ question }) => question)).toEqual([PANEL, PANEL, NOTE]);
        expect(feedbackAtPrompt[1]).toMatchObject({ message: MALFORMED, severity: 'error' });
        expect(loadState(prepared.session.ref)?.pendingRecovery).toBeUndefined();
        expect(feedbackStore.get()).toEqual({ message: null, severity: 'info' });
      });

      it('refuses the note when the file breaks while the note question waits, keeps it, and asks the panel again', async () => {
        const { prepared, state } = setupOnDisk();
        const drafts: Array<ComposerDraftRequest | null> = [];
        const halts: Array<RecoveryIssue | undefined> = [];
        const { inputMode, asked, feedbackAtPrompt } = recordQuestions(
          [rowPick('v'), WORDS, rowPick('a')],
          (at) => {
            if (at === 2) breakConfigFile(prepared);
            if (at === 3) {
              drafts.push(composerDraftStore.get().request);
              halts.push(loadState(prepared.session.ref)?.pendingRecovery);
            }
          },
        );

        const result = await runDriver(prepared, state, inputMode);

        expect(asked.map(({ question }) => question)).toEqual([PANEL, NOTE, PANEL]);
        expect(feedbackAtPrompt[2]).toEqual({ message: MALFORMED, severity: 'error' });
        expect(drafts[0]).toMatchObject({ kind: 'prepend', value: WORDS });
        expect(halts[0]).toMatchObject({ reason: 'review-failed', status: 'awaiting-user' });
        expect(halts[0]?.selectedAction).toBeUndefined();
        expect(result).toMatchObject({ shouldRun: false, state: { closed: { as: 'ended' } } });
      });

      it('refuses three answers in a row while the file does not load, and End run still ends the run', async () => {
        const { prepared, state } = setupOnDisk();
        const drafts: Array<ComposerDraftRequest | null> = [];
        const halts: Array<RecoveryIssue | undefined> = [];
        const { inputMode, asked, feedbackAtPrompt } = recordQuestions(
          [WORDS, rowPick('v'), WORDS, rowPick('a')],
          (at) => {
            if (at === 1) breakConfigFile(prepared);
            drafts.push(composerDraftStore.get().request);
            halts.push(loadState(prepared.session.ref)?.pendingRecovery);
            composerDraftStore.clear();
          },
        );

        const result = await runDriver(prepared, state, inputMode);

        expect(asked.map(({ question }) => question)).toEqual([PANEL, PANEL, PANEL, PANEL]);
        expect(feedbackAtPrompt.slice(1)).toEqual([
          { message: MALFORMED, severity: 'error' },
          { message: MALFORMED, severity: 'error' },
          { message: MALFORMED, severity: 'error' },
        ]);
        expect(drafts.map((draft) => draft?.kind ?? null)).toEqual([
          null,
          'prepend',
          null,
          'prepend',
        ]);
        expect(drafts.map((draft) => draft?.value ?? null)).toEqual([null, WORDS, null, WORDS]);
        expect(halts.map((halt) => halt?.status)).toEqual([
          'awaiting-user',
          'awaiting-user',
          'awaiting-user',
          'awaiting-user',
        ]);
        expect(halts.map((halt) => halt?.selectedAction)).toEqual([
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
        expect(result).toMatchObject({ shouldRun: false, state: { closed: { as: 'ended' } } });
      });

      it('asks the note again after a move to None and back to the seat, and sends it as the correction', async () => {
        const { prepared, state } = setupSeatedTaskReview(false);
        hydrateFromState(state, false);
        const note = Promise.withResolvers<QuestionAnswer>();
        const { inputMode, asked } = recordQuestions(
          [rowPick('v'), note.promise, rowPick('v'), WORDS],
          (at) => {
            if (at === 3) {
              configStore.__testReset({
                projectDir: prepared.session.ref.projectDir,
                config: prepared.sourceConfig,
              });
            }
          },
        );

        const running = runDriver(prepared, state, inputMode);
        await vi.waitFor(() => {
          expect(asked.map(({ question }) => question)).toEqual([PANEL, NOTE]);
        });
        moveReviewToNone(prepared);
        const result = await running;

        expect(asked.map(({ question }) => question)).toEqual([PANEL, NOTE, PANEL, NOTE]);
        expect(asked.map(({ reviewNone }) => reviewNone)).toEqual([false, false, true, false]);
        if (!result.shouldRun) throw new Error('expected the correction to run');
        expect(result.correctionTaken).toBe(true);
        expect(result.steer).toBeUndefined();
        expect(result.state.pendingTriage?.inputs).toHaveLength(1);
        expect(result.state.pendingTriage?.inputs[0]).toMatchObject({
          kind: 'defect',
          source: 'user',
          text: WORDS,
        });
        expect(runViewStore.get().reviewNone).toBe(false);
      });

      it('acts on REVIEW None once the file loads again as None', async () => {
        const { prepared, state } = setupOnDisk();
        const { projectDir } = prepared.session.ref;
        const drafts: Array<ComposerDraftRequest | null> = [];
        const { inputMode, asked, feedbackAtPrompt } = recordQuestions(
          [WORDS, WORDS, rowPick('a')],
          (at) => {
            if (at === 1) breakConfigFile(prepared);
            if (at === 2) {
              drafts.push(composerDraftStore.get().request);
              writeConfig(projectDir, { ...prepared.sourceConfig, reviewer: 'none' });
            }
            if (at === 3) drafts.push(composerDraftStore.get().request);
          },
        );

        const result = await runDriver(prepared, state, inputMode);

        expect(asked.map(({ question }) => question)).toEqual([PANEL, PANEL, PANEL]);
        expect(asked.map(({ reviewNone }) => reviewNone)).toEqual([false, false, true]);
        expect(feedbackAtPrompt[1]).toEqual({ message: MALFORMED, severity: 'error' });
        expect(feedbackAtPrompt[2]).toEqual({ message: NO_CORRECTION, severity: 'warning' });
        expect(drafts).toHaveLength(2);
        expect(drafts[0]).toMatchObject({ kind: 'prepend', value: WORDS });
        expect(drafts[1]).toMatchObject({ kind: 'prepend', value: WORDS });
        expect(result).toMatchObject({ shouldRun: false, state: { closed: { as: 'ended' } } });
      });

      it.each([false, true])(
        'shows a move made before the panel waits when it asks, brief left %s',
        async (briefLeft) => {
          const { prepared, state } = setupSeatedTaskReview(briefLeft);
          hydrateFromState(state, false);
          moveReviewToNone(prepared);
          const { inputMode, asked } = recordQuestions([rowPick('v')]);

          const result = await runDriver(prepared, state, inputMode);

          expect(asked).toEqual([{ question: PANEL, reviewNone: true }]);
          expect(result.shouldRun).toBe(true);
        },
      );
    });
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

describe('the order of the steps of one halt', () => {
  /**
   * Logs the steps of one prompt in their order: each settle, each question with REVIEW None on
   * the view as it is asked, each start and stop of the config follow, each change of the panel
   * notice, each reset of the input mode, and each listener the run's signal loses.
   */
  function logSteps(
    controller: AbortController,
    inputMode: UseInputModeResult,
    onSettle: (settled: number) => void = () => {},
  ): { steps: string[]; inputMode: UseInputModeResult; setInlineResume: () => void } {
    const steps: string[] = [];
    const subscribe = configStore.subscribe;
    const follow = vi.spyOn(configStore, 'subscribe').mockImplementation((listener) => {
      steps.push('follow the config');
      const stop = subscribe(listener);
      return () => {
        steps.push('stop following');
        stop();
      };
    });
    onTestFinished(() => follow.mockRestore());
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'removeEventListener').mockImplementation((type, listener) => {
      steps.push(`remove the ${type} listener`);
      remove(type, listener);
    });
    onTestFinished(
      recoveryNoticeStore.subscribe(() => {
        const { open, asking } = recoveryNoticeStore.get();
        steps.push(open ? (asking ? 'notice asks' : 'notice open') : 'notice closed');
      }),
    );
    let settled = 0;
    return {
      steps,
      inputMode: {
        ...inputMode,
        setQuestionMode: (question) => {
          const first = question.split('\n')[0] ?? '';
          steps.push(`ask: ${first} (REVIEW None ${runViewStore.get().reviewNone})`);
          return inputMode.setQuestionMode(question);
        },
        resetMode: () => {
          steps.push('reset the mode');
          inputMode.resetMode();
        },
      },
      setInlineResume: () => {
        settled += 1;
        steps.push('settle');
        onSettle(settled);
      },
    };
  }

  function prompt(
    prepared: PreparedExecution,
    state: WorkflowState,
    controller: AbortController,
    log: ReturnType<typeof logSteps>,
  ): Promise<PendingRecoveryResult> {
    return createRecoveryDriver({
      prepared,
      configOfRun: prepared.sourceConfig,
      inputMode: log.inputMode,
      abortedRef: { current: false },
      retentionNoticeHandled: { current: true },
      sink: addTuiEvent,
      setInlineResume: log.setInlineResume,
    })({ state, controller, republishPrompt: false });
  }

  it('settles the decided step, asks, applies the correction, and asks again on the next pass', async () => {
    const { prepared, state: halted } = setupSession({
      taskId: taskId('T999'),
      affectedTaskIds: [taskId('T999')],
      facts: { question: 'Which endpoint?' },
      availableActions: ['retry-same-worker', 'decide-for-me', 'skip-current-task', 'end-run'],
    });
    const state: WorkflowState = { ...halted, decideForMe: true };
    saveState(prepared.session.ref, state);
    hydrateFromState(state, false);
    const controller = new AbortController();
    const { inputMode } = makeInputMode(['use the REST endpoint', rowPick('a')]);
    // REVIEW moves while the correction applies, when no question follows the config.
    const log = logSteps(controller, inputMode, (settled) => {
      if (settled !== 2) return;
      configStore.__testReset({
        projectDir: prepared.session.ref.projectDir,
        config: { ...prepared.sourceConfig, reviewer: 'none' },
      });
    });

    const result = await prompt(prepared, state, controller, log);

    expect(log.steps).toEqual([
      'settle',
      'notice open',
      'notice asks',
      'follow the config',
      'ask: Needs you · T999 needs your answer (REVIEW None false)',
      'stop following',
      'notice open',
      'settle',
      'notice asks',
      'follow the config',
      'ask: Needs you · T999 needs your answer (REVIEW None true)',
      'stop following',
      'notice open',
      'settle',
      'remove the abort listener',
      'notice closed',
    ]);
    expect(result).toMatchObject({ shouldRun: false, state: { closed: { as: 'ended' } } });
  });

  it('stops following the config, then removes its abort listener and closes the notice', async () => {
    const { prepared, state } = setupSession();
    const controller = new AbortController();
    const { inputMode } = makeInputMode([rowPick('s')]);
    const log = logSteps(controller, inputMode);

    const result = await prompt(prepared, state, controller, log);
    controller.abort();

    expect(log.steps).toEqual([
      'notice open',
      'notice asks',
      'follow the config',
      'ask: Needs you · T001 failed (REVIEW None false)',
      'stop following',
      'notice open',
      'settle',
      'remove the abort listener',
      'notice closed',
    ]);
    expect(result.shouldRun).toBe(true);
  });

  it('stops following the config, then removes its abort listener and closes the notice on an abort', async () => {
    const { prepared, state } = setupSession();
    const controller = new AbortController();
    const { inputMode } = makeInputMode([]);
    let cancelQuestion = (): void => {};
    const log = logSteps(controller, {
      ...inputMode,
      setQuestionMode: () =>
        new Promise<QuestionAnswer>((_resolve, reject) => {
          cancelQuestion = () => reject(WORKFLOW_USER_CANCELLED_ABORT_REASON);
        }),
      resetMode: () => cancelQuestion(),
    });

    const pending = prompt(prepared, state, controller, log);
    const settled = expect(pending).rejects.toBe(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    await vi.waitFor(() => expect(recoveryNoticeStore.get()).toEqual({ open: true, asking: true }));
    controller.abort();
    await settled;

    expect(log.steps).toEqual([
      'notice open',
      'notice asks',
      'follow the config',
      'ask: Needs you · T001 failed (REVIEW None false)',
      'reset the mode',
      'stop following',
      'remove the abort listener',
      'notice closed',
    ]);
  });
});

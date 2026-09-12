import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { clearActiveReceipt } from '../../core/sessions/active-pointer.js';
import { createEventBus } from '../../engine/events/bus.js';
import { createJsonlSink } from '../../engine/events/sinks/jsonl.js';
import type { EventBus } from '../../engine/events/types.js';
import { publishRecoveryPrompted } from '../../engine/orchestrator/events.js';
import { applyRecoveryAction } from '../../engine/orchestrator/recovery/actions.js';
import type { SeatSwapChoice } from '../../engine/orchestrator/run/seat-swap.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { markWorkflowPaused } from '../../stores/workflow/actions/pause.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import {
  formatRecoveryPrompt,
  parseRecoveryActionAnswer,
  switchSeatCandidateForAnswer,
} from './recovery-prompt.js';
import { addTuiEvent } from './tui-sink.js';

type PendingRecoveryResult =
  | {
      shouldRun: true;
      state: WorkflowState;
      retryProfileOverride?: string | undefined;
      retryProfileOverrideTaskId?: TaskId | undefined;
      switchSeat?: SeatSwapChoice | undefined;
    }
  | { shouldRun: false; state?: WorkflowState | undefined };

interface PromptPendingRecoveryArgs {
  state: WorkflowState;
  controller: AbortController;
  republishPrompt: boolean;
}

interface RecoveryDriverOptions {
  prepared: PreparedExecution;
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  setInlineResume: (state: WorkflowState) => void;
}

function createRecoveryBus(projectDir: string, sessionId: string): EventBus {
  const bus = createEventBus();
  bus.subscribe(addTuiEvent);
  bus.subscribe(
    createJsonlSink({
      projectDir,
      sessionId,
      onDegraded: (warning) => bus.publish(warning),
    }),
  );
  return bus;
}

/**
 * The swapped-in tool is admitted under the same terms this interactive run was:
 * the seat swap re-prepares the session, and a preparation the TUI drives is
 * always interactive, discloses unverified auth and approves through the
 * tiered-approval prompt.
 */
function seatSwapPolicy(prepared: PreparedExecution): SeatSwapChoice['policy'] {
  return {
    purpose: 'resume',
    interaction: 'interactive',
    unverifiedAuth: 'disclosed',
    allowHooks: prepared.runtime.allowHooks,
    allowRepoRunners: prepared.runtime.allowRepoRunners,
    onTieredApproval: openApprovalPrompt,
  };
}

/**
 * What the chrome keeps saying while the operator reads the panel: the halted
 * seat and, when the runner named one, the clock its quota comes back on. Only
 * a halt that names its seat can annotate one — the swap offer is what names
 * it — so a halt without an offer leaves the header alone.
 */
function openRecoveryNotice(issue: RecoveryIssue): void {
  const seat = issue.switchSeat?.seat;
  if (seat === undefined) return;
  const resetAt = issue.resetAt === undefined ? Number.NaN : Date.parse(issue.resetAt);
  recoveryNoticeStore.open({ seat, resetAt: Number.isFinite(resetAt) ? resetAt : null });
}

/**
 * The one surface that resolves a halt in the TUI: it renders the pending
 * recovery as a question, parses the operator's answer into a recovery action
 * and applies it, so the workflow loop either resumes on the returned state or
 * stops with a reason.
 *
 * `switch-seat` is the exception it does not apply itself — taking that offer
 * re-prepares the session on another tool, which only `runWorkflow` can do, so
 * the choice travels back as `switchSeat` and the halt stays pending until the
 * run resolves it.
 *
 * The halt is read once from the passed state and reused for the prompt text, the
 * answer parse and the apply: a session has one running process, and that process
 * is parked on this prompt, so nothing else can resolve or replace the halt while
 * the operator is answering.
 */
export function createRecoveryDriver(
  opts: RecoveryDriverOptions,
): (args: PromptPendingRecoveryArgs) => Promise<PendingRecoveryResult> {
  const { prepared, inputMode, abortedRef, setInlineResume } = opts;
  const { ref, active } = prepared.session;
  const { projectDir, sessionId } = ref;
  const config = prepared.config;

  return async function promptPendingRecovery({
    state,
    controller,
    republishPrompt,
  }: PromptPendingRecoveryArgs): Promise<PendingRecoveryResult> {
    const issue = state.pendingRecovery;
    if (issue === undefined) return { shouldRun: true, state };

    const bus = createRecoveryBus(projectDir, sessionId);

    const applyAction = (action: RecoveryAction, answer = ''): PendingRecoveryResult => {
      recoveryNoticeStore.clear();
      if (action === 'switch-seat') {
        const candidate = switchSeatCandidateForAnswer(answer, issue.switchSeat);
        if (candidate === undefined) {
          feedbackStore.setError('No other tool is offered for this seat.');
          return { shouldRun: false, state };
        }
        return {
          shouldRun: true,
          state,
          switchSeat: { candidate, policy: seatSwapPolicy(prepared) },
        };
      }

      const retryProfileOverrideTaskId = issue.taskId ?? state.tasks[state.currentTaskIndex]?.id;
      const result = applyRecoveryAction({
        projectDir,
        sessionId,
        state,
        action,
        bus,
        config,
        mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      });

      setInlineResume(result.state);

      if (!result.ok) {
        feedbackStore.setError(result.message);
        return { shouldRun: false, state: result.state };
      }

      if (result.status === 'paused') {
        markWorkflowPaused();
        feedbackStore.setMessage(
          `Recovery paused. Resume with ${SPLITBRIEF_IDENTITY.executable} resume.`,
        );
        return { shouldRun: false, state: result.state };
      }

      if (result.status === 'aborted') {
        // Nothing ran after the halt, so there is no summary to write; releasing
        // the active pointer is what ends the session — the sessions listing
        // recovers its 'interrupted' status from the saved state.
        clearActiveReceipt(ref, active);
        feedbackStore.setMessage('Workflow aborted.');
        return { shouldRun: false, state: result.state };
      }

      const retryProfileOverride = result.implementerProfile ?? issue.selectedImplementerProfile;
      if (retryProfileOverride === undefined || result.status !== 'retry-current-task') {
        return { shouldRun: true, state: result.state };
      }
      return {
        shouldRun: true,
        state: result.state,
        retryProfileOverride,
        ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
      };
    };

    if (issue.status === 'applying') {
      const selected = issue.selectedAction;
      if (selected === undefined) {
        feedbackStore.setError('Recovery is applying but no action is selected.');
        return { shouldRun: false, state };
      }
      return applyAction(selected);
    }

    if (republishPrompt) publishRecoveryPrompted(bus, issue);

    openRecoveryNotice(issue);

    while (true) {
      const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
      if (controller.signal.aborted || abortedRef.current) {
        recoveryNoticeStore.clear();
        return { shouldRun: false, state };
      }
      const action = parseRecoveryActionAnswer(answer, issue);
      if (action === null) {
        feedbackStore.setError('Unknown recovery action.');
        continue;
      }
      return applyAction(action, answer);
    }
  };
}

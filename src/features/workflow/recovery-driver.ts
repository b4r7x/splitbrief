import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { StateAuthorityReceipt } from '../../core/state/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { markWorkflowPaused } from '../../stores/workflow/actions/pause.js';
import {
  applySelectedRecoveryAction,
  createRecoveryBus,
  finalizeRecoveryResult,
  loadPendingRecoveryState,
  recoveryRetryTaskId,
} from '../../engine/orchestrator/recovery/driver.js';
import { publishRecoveryPrompted } from '../../engine/orchestrator/events.js';
import { createTuiSink } from './tui-sink.js';
import { formatRecoveryPrompt, parseRecoveryActionAnswer } from './recovery-prompt.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';
import { refreshWorkflowAuthority } from '../../engine/orchestrator/run/authority.js';

export type PendingRecoveryResult =
  | {
      shouldRun: true;
      state: WorkflowState;
      authority?: StateAuthorityReceipt | undefined;
      retryProfileOverride?: string | undefined;
      retryProfileOverrideTaskId?: TaskId | undefined;
    }
  | { shouldRun: false; state?: WorkflowState | undefined };

interface PromptPendingRecoveryArgs {
  state: WorkflowState;
  controller: AbortController;
  republishPrompt: boolean;
}

interface RecoveryDriverOptions {
  prepared: PreparedExecution;
  authority?: StateAuthorityReceipt | undefined;
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  setInlineResume: (state: WorkflowState) => void;
}

export function createRecoveryDriver(
  opts: RecoveryDriverOptions,
): (args: PromptPendingRecoveryArgs) => Promise<PendingRecoveryResult> {
  const { prepared, authority, inputMode, abortedRef, setInlineResume } = opts;
  const { ref, active } = prepared.session;
  const { projectDir, sessionId } = ref;
  const config = prepared.config;

  return async function promptPendingRecovery({
    state,
    controller,
    republishPrompt,
  }: PromptPendingRecoveryArgs): Promise<PendingRecoveryResult> {
    const loaded = loadPendingRecoveryState(ref, state, authority);
    if (!loaded.pending) return { shouldRun: true, state: loaded.state };

    const bus = createRecoveryBus({
      projectDir,
      sessionId,
      persistTranscript: config.workflow.persistTranscript,
      sinks: [createTuiSink({ persistTranscript: config.workflow.persistTranscript })],
    });

    const applyAction = (
      currentState: WorkflowState,
      action: NonNullable<typeof loaded.issue.selectedAction>,
    ) => {
      const currentIssue = currentState.pendingRecovery;
      const selectedImplementerProfile = currentIssue?.selectedImplementerProfile;
      const retryProfileOverrideTaskId = recoveryRetryTaskId(currentState);
      const result = applySelectedRecoveryAction({
        projectDir,
        sessionId,
        state: currentState,
        action,
        bus,
        config,
        ...(authority === undefined ? {} : { authority }),
      });

      setInlineResume(result.state);

      if (!result.ok) {
        feedbackStore.setError(result.message);
        return { shouldRun: false as const, state: result.state };
      }

      if (result.status === 'paused') {
        markWorkflowPaused();
        feedbackStore.setMessage(
          `Recovery paused. Resume with ${SPLITBRIEF_IDENTITY.executable} resume.`,
        );
        return { shouldRun: false as const, state: result.state };
      }

      if (result.status === 'aborted') {
        finalizeRecoveryResult({
          projectDir,
          sessionId,
          active,
          state: result.state,
          config,
          status: result.status,
        });
        feedbackStore.setMessage('Workflow aborted.');
        return { shouldRun: false as const, state: result.state };
      }

      const retryProfileOverride = result.implementerProfile ?? selectedImplementerProfile;
      const retryOverrides =
        retryProfileOverride !== undefined && result.status === 'retry-current-task'
          ? {
              retryProfileOverride,
              ...(retryProfileOverrideTaskId !== undefined ? { retryProfileOverrideTaskId } : {}),
            }
          : {};
      const nextAuthority =
        authority === undefined
          ? undefined
          : refreshWorkflowAuthority(ref, authority, result.state);
      return {
        shouldRun: true as const,
        state: result.state,
        ...(nextAuthority === undefined ? {} : { authority: nextAuthority }),
        ...retryOverrides,
      };
    };

    if (loaded.issue.status === 'applying') {
      const action = loaded.issue.selectedAction;
      if (action === undefined) {
        feedbackStore.setError('Recovery is applying but no action is selected.');
        return { shouldRun: false, state: loaded.state };
      }
      return applyAction(loaded.state, action);
    }

    if (republishPrompt) publishRecoveryPrompted(bus, loaded.issue);

    while (true) {
      const promptLoaded = loadPendingRecoveryState(ref, loaded.state, authority);
      const promptIssue = promptLoaded.pending ? promptLoaded.issue : loaded.issue;
      const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(promptIssue));
      if (controller.signal.aborted || abortedRef.current) {
        return { shouldRun: false, state: loaded.state };
      }

      const latest = loadPendingRecoveryState(ref, loaded.state, authority);
      if (!latest.pending) return { shouldRun: true, state: latest.state };

      const action = parseRecoveryActionAnswer(answer, latest.issue);
      if (action === null) {
        feedbackStore.setError('Unknown recovery action.');
        continue;
      }
      return applyAction(latest.state, action);
    }
  };
}

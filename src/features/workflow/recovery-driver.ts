import type { Config } from '../../core/schemas/config.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import {
  applySelectedRecoveryAction,
  createRecoveryBus,
  finalizeRecoveryResult,
  loadPendingRecoveryState,
  publishPendingRecoveryPrompt,
  recoveryRetryTaskId,
} from '../../engine/orchestrator/recovery/driver.js';
import { createTuiSink } from './tui-sink.js';
import { formatRecoveryPrompt, parseRecoveryActionAnswer } from './recovery-prompt.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

export type PendingRecoveryResult =
  | {
      shouldRun: true;
      state: WorkflowState;
      retryProfileOverride?: string | undefined;
      retryProfileOverrideTaskId?: TaskId | undefined;
    }
  | { shouldRun: false; state?: WorkflowState | undefined };

interface PromptPendingRecoveryArgs {
  state: WorkflowState;
  activeSessionId: string;
  controller: AbortController;
  republishPrompt: boolean;
}

interface UseRecoveryDriverOptions {
  projectDir: string;
  config: Config;
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  setInlineResume: (state: WorkflowState) => void;
}

export function createRecoveryDriver(): (
  opts: UseRecoveryDriverOptions,
) => (args: PromptPendingRecoveryArgs) => Promise<PendingRecoveryResult> {
  return (opts: UseRecoveryDriverOptions) => {
    const { projectDir, config, inputMode, abortedRef, setInlineResume } = opts;

    return async function promptPendingRecovery({
      state,
      activeSessionId,
      controller,
      republishPrompt,
    }: PromptPendingRecoveryArgs): Promise<PendingRecoveryResult> {
      const loaded = loadPendingRecoveryState({ projectDir, sessionId: activeSessionId }, state);
      if (!loaded.pending) return { shouldRun: true, state: loaded.state };

      const bus = createRecoveryBus({
        projectDir,
        sessionId: activeSessionId,
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
          sessionId: activeSessionId,
          state: currentState,
          action,
          bus,
          config,
        });

        setInlineResume(result.state);

        if (!result.ok) {
          feedbackStore.setError(result.message);
          return { shouldRun: false as const, state: result.state };
        }

        if (result.status === 'paused') {
          feedbackStore.setMessage('Recovery paused. Resume with diptych resume.');
          return { shouldRun: false as const, state: result.state };
        }

        if (result.status === 'aborted') {
          finalizeRecoveryResult({
            projectDir,
            sessionId: activeSessionId,
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
        return {
          shouldRun: true as const,
          state: result.state,
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

      publishPendingRecoveryPrompt(bus, loaded.issue, republishPrompt);

      while (true) {
        const promptLoaded = loadPendingRecoveryState(
          { projectDir, sessionId: activeSessionId },
          loaded.state,
        );
        const promptIssue = promptLoaded.pending ? promptLoaded.issue : loaded.issue;
        const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(promptIssue));
        if (controller.signal.aborted || abortedRef.current) {
          return { shouldRun: false, state: loaded.state };
        }

        const latest = loadPendingRecoveryState(
          { projectDir, sessionId: activeSessionId },
          loaded.state,
        );
        if (!latest.pending) return { shouldRun: true, state: latest.state };

        const action = parseRecoveryActionAnswer(answer, latest.issue);
        if (action === null) {
          feedbackStore.setError('Unknown recovery action.');
          continue;
        }
        return applyAction(latest.state, action);
      }
    };
  };
}

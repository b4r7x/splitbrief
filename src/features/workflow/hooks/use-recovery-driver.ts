import type { Config } from '../../../core/schemas/config.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import {
  applySelectedRecoveryAction,
  createRecoveryBus,
  loadPendingRecoveryState,
  publishPendingRecoveryPrompt,
  recoveryRetryTaskId,
  saveAbortedRecoverySession,
} from '../../../engine/orchestrator/recovery/driver.js';
import { createTuiSink } from '../tui-sink.js';
import { formatRecoveryPrompt, parseRecoveryActionAnswer } from '../recovery-prompt.js';
import type { UseInputModeResult } from './use-input-mode.js';

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

export function useRecoveryDriver(): (
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
      const issue = state.pendingRecovery;
      if (!issue) return { shouldRun: true, state };

      const bus = createRecoveryBus({
        projectDir,
        sessionId: activeSessionId,
        persistTranscript: config.workflow.persistTranscript,
        sinks: [createTuiSink()],
      });
      publishPendingRecoveryPrompt(bus, issue, republishPrompt);

      const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
      if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };

      const latest = loadPendingRecoveryState({ projectDir, sessionId: activeSessionId }, state);
      if (!latest.pending) return { shouldRun: true, state: latest.state };

      const action = parseRecoveryActionAnswer(answer, latest.issue);
      const selectedImplementerProfile = latest.issue.selectedImplementerProfile;
      const retryProfileOverrideTaskId = recoveryRetryTaskId(latest.state);
      const result = applySelectedRecoveryAction({
        projectDir,
        sessionId: activeSessionId,
        state: latest.state,
        action,
        bus,
        config,
      });

      setInlineResume(result.state);

      if (!result.ok) {
        feedbackStore.setError(result.message);
        return { shouldRun: false, state: result.state };
      }

      if (result.status === 'paused') {
        feedbackStore.setMessage('Recovery paused. Resume with diptych resume.');
        return { shouldRun: false, state: result.state };
      }

      if (result.status === 'aborted') {
        saveAbortedRecoverySession({
          projectDir,
          sessionId: activeSessionId,
          state: result.state,
          config,
        });
        feedbackStore.setMessage('Workflow aborted.');
        return { shouldRun: false, state: result.state };
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
        shouldRun: true,
        state: result.state,
        ...retryOverrides,
      };
    };
  };
}

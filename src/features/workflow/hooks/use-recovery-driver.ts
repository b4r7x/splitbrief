import { DEFAULT_WORKFLOW_MODE, type Config } from '../../../core/schemas/config.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { createJsonlSink } from '../../../engine/events/sinks/jsonl.js';
import { publishRecoveryPrompted } from '../../../engine/orchestrator/events.js';
import { applyRecoveryAction } from '../../../engine/orchestrator/recovery/actions.js';
import { buildSummary } from '../../../engine/orchestrator/summary.js';
import { saveFinalSession } from '../../../engine/orchestrator/session-lifecycle.js';
import { loadState } from '../../../core/state/persistence.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { resolveAutoModel } from '../../../core/providers/model-selection.js';
import { createTuiSink } from '../tui-sink.js';
import { formatRecoveryPrompt, parseRecoveryActionAnswer } from '../recovery-prompt.js';
import type { UseInputModeResult } from './use-input-mode.js';

export type PendingRecoveryResult =
  | { shouldRun: true; state: WorkflowState; retryProfileOverride?: string | undefined; retryProfileOverrideTaskId?: TaskId | undefined }
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

    const createRecoveryBus = (activeSessionId: string) => {
      const bus = createEventBus();
      bus.subscribe(createTuiSink());
      bus.subscribe(createJsonlSink(projectDir, activeSessionId, config.workflow.persistTranscript));
      return bus;
    };

    const saveAbortedRecoverySession = (state: WorkflowState, activeSessionId: string) => {
      const parsedStart = Date.parse(state.startedAt);
      const startTime = Number.isFinite(parsedStart) ? parsedStart : Date.now();
      const plannerTool = state.plannerTool ?? getRunnerDisplayName(config.planner);
      const plannerModel = state.plannerModel ?? getRunnerModelName(config.planner);
      const implementerTool = state.implementerTool ?? getRunnerDisplayName(config.implementer);
      const implementerModel = state.implementerModel
        ?? resolveAutoModel(config.implementer.model, getRunnerDisplayName(config.implementer));
      const summary = buildSummary({
        feature: state.feature,
        state,
        startTime,
        plannerTool,
        ...(plannerModel !== undefined && { plannerModel }),
        implementerTool,
        ...(implementerModel !== undefined && { implementerModel }),
        mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
        projectDir,
        sessionId: activeSessionId,
      });
      saveFinalSession({
        projectDir,
        sessionId: activeSessionId,
        feature: state.feature,
        startTime,
        status: 'interrupted',
        summary,
      });
    };

    return async function promptPendingRecovery({
      state,
      activeSessionId,
      controller,
      republishPrompt,
    }: PromptPendingRecoveryArgs): Promise<PendingRecoveryResult> {
      const issue = state.pendingRecovery;
      if (!issue) return { shouldRun: true, state };

      const bus = createRecoveryBus(activeSessionId);
      if (republishPrompt) publishRecoveryPrompted(bus, issue);

      const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
      if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };

      const latest = loadState(projectDir, activeSessionId) ?? state;
      if (!latest.pendingRecovery) return { shouldRun: true, state: latest };

      const action = parseRecoveryActionAnswer(answer, latest.pendingRecovery);
      const selectedImplementerProfile = latest.pendingRecovery.selectedImplementerProfile;
      const retryProfileOverrideTaskId = latest.pendingRecovery.taskId ?? latest.tasks[latest.currentTaskIndex]?.id;
      const result = applyRecoveryAction({
        projectDir,
        sessionId: activeSessionId,
        state: latest,
        action,
        bus,
        config,
        selectedAt: new Date().toISOString(),
        mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
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
        saveAbortedRecoverySession(result.state, activeSessionId);
        feedbackStore.setMessage('Workflow aborted.');
        return { shouldRun: false, state: result.state };
      }

      const retryProfileOverride = result.implementerProfile ?? selectedImplementerProfile;
      const retryOverrides = retryProfileOverride !== undefined && result.status === 'retry-current-task'
        ? { retryProfileOverride, ...(retryProfileOverrideTaskId !== undefined ? { retryProfileOverrideTaskId } : {}) }
        : {};
      return {
        shouldRun: true,
        state: result.state,
        ...retryOverrides,
      };
    };
  };
}

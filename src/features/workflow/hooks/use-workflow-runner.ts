import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { SkillMeta } from '../../../engine/skills/discovery.js';
import { addEvent, resetWorkflow } from '../../../stores/workflow/actions.js';
import { openApprovalPrompt } from '../../../stores/approval-prompt/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { runWorkflow } from '../../../engine/orchestrator/run/run.js';
import type { WorkflowSinks } from '../../../engine/orchestrator/types.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { createJsonlSink } from '../../../engine/events/sinks/jsonl.js';
import { createTuiSink } from '../../../engine/events/sinks/tui.js';
import { publishRecoveryPrompted } from '../../../engine/orchestrator/events.js';
import { applyRecoveryAction } from '../../../engine/orchestrator/recovery.js';
import { buildSummary } from '../../../engine/orchestrator/summary.js';
import { saveFinalSession } from '../../../engine/orchestrator/session-lifecycle.js';
import {
  setAbortHandler,
  setCancelHandler,
  setQueueHandler,
  setRewindHandler,
  clearAllHandlers,
} from '../handlers.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readActive } from '../../../core/sessions/lifecycle.js';
import { transition } from '../../../core/state/machine.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { resolveAutoModel } from '../../../core/providers/model-selection.js';
import { REVIEW_HINT } from '../review-parser.js';
import { formatCost } from '../../../core/formatting.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildRewindAction } from './build-rewind-action.js';
import { formatUserEditConflictPrompt, parseUserEditConflictAnswer } from '../user-edit-conflict-prompt.js';
import { formatRecoveryPrompt, parseRecoveryActionAnswer } from '../recovery-prompt.js';

interface UseWorkflowRunnerOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  initialResumeState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  sessionId?: string | undefined;
  enabled?: boolean | undefined;
}

interface UseWorkflowRunnerResult {
  startedAt: string;
  handleResume: () => void;
}

type PendingRecoveryResult =
  | { shouldRun: true; state: WorkflowState }
  | { shouldRun: false; state?: WorkflowState | undefined };

export function useWorkflowRunner({
  feature,
  projectDir,
  config,
  onComplete,
  initialResumeState,
  selectedSkills,
  inputMode,
  sessionId: initialSessionId,
  enabled = true,
}: UseWorkflowRunnerOptions): UseWorkflowRunnerResult {
  const abortedRef = useRef(false);
  const pendingRewindEventRef = useRef<EngineEvent | null>(null);
  const [startedAt] = useState(() => new Date().toISOString());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WorkflowState | undefined>(undefined);

  const resumeState = inlineResume ?? initialResumeState;

  const sinks: WorkflowSinks = {
    setAbortHandler,
    setQueueHandler,
  };

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

  const promptPendingRecovery = async (
    state: WorkflowState,
    activeSessionId: string,
    controller: AbortController,
    republishPrompt: boolean,
  ): Promise<PendingRecoveryResult> => {
    const issue = state.pendingRecovery;
    if (!issue) return { shouldRun: true, state };

    const bus = createRecoveryBus(activeSessionId);
    if (republishPrompt) publishRecoveryPrompted(bus, issue);

    const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
    if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };

    const latest = loadState(projectDir, activeSessionId) ?? state;
    if (!latest.pendingRecovery) return { shouldRun: true, state: latest };

    const action = parseRecoveryActionAnswer(answer, latest.pendingRecovery);
    const result = applyRecoveryAction({
      projectDir,
      sessionId: activeSessionId,
      state: latest,
      action,
      bus,
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

    return { shouldRun: true, state: result.state };
  };

  const buildBudgetPromptIssue = (
    reason: 'budget-paused' | 'budget-exceeded',
    currentCost: number,
    maxBudget: number,
  ): RecoveryIssue => {
    const budgetPercent = maxBudget > 0 ? Math.round((currentCost / maxBudget) * 100) : 0;
    const exceeded = reason === 'budget-exceeded';
    return {
      id: `rec_budget_callback_${Date.now()}`,
      reason,
      phase: lifecycleStore.get().phase,
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: [],
      message: exceeded ? `Budget exceeded at ${budgetPercent}%` : `Budget pause at ${budgetPercent}%`,
      details: [
        `Spent ${formatCost(currentCost)} of ${formatCost(maxBudget)}`,
        ...(exceeded ? ['Continuing requires a separate raise-budget flow.'] : []),
      ],
      facts: {
        currentCost,
        maxBudget,
        budgetPercent,
        belowMaxBudget: currentCost < maxBudget,
      },
      availableActions: exceeded ? ['pause-run', 'abort-workflow'] : ['continue', 'pause-run', 'abort-workflow'],
      recommendedAction: 'pause-run',
      createdAt: new Date().toISOString(),
    };
  };

  const startWorkflow = useEffectEvent(async (controller: AbortController) => {
    let stateForRun = resumeState;
    let activeSessionId = initialSessionId;
    let recoveryPromptAlreadyPublished = false;

    resetWorkflow(stateForRun);
    if (pendingRewindEventRef.current) {
      addEvent(pendingRewindEventRef.current);
      pendingRewindEventRef.current = null;
    }
    conversationScrollStore.reset();
    setCancelHandler(() => {
      inputMode.resetMode();
      controller.abort();
    });
    setRewindHandler((request) => {
      inputMode.resetMode();
      const activeSessionId = readActive(projectDir);
      if (!activeSessionId) return;
      const current = loadState(projectDir, activeSessionId);
      if (!current) return;

      const { action, event } = buildRewindAction(request, projectDir, activeSessionId, current);
      const next = transition(current, action);
      saveState(projectDir, activeSessionId, next);
      pendingRewindEventRef.current = event;
      controller.abort();
      setInlineResume(next);
      setRunId(id => id + 1);
    });

    try {
      while (!controller.signal.aborted && !abortedRef.current) {
        if (stateForRun?.pendingRecovery) {
          activeSessionId = activeSessionId ?? readActive(projectDir) ?? undefined;
          if (!activeSessionId) {
            feedbackStore.setError('No active session found for pending recovery.');
            return;
          }
          const recovery = await promptPendingRecovery(
            stateForRun,
            activeSessionId,
            controller,
            !recoveryPromptAlreadyPublished,
          );
          recoveryPromptAlreadyPublished = false;
          if (!recovery.shouldRun) return;
          stateForRun = recovery.state;
        }

        await runWorkflow({
          feature,
          projectDir,
          config,
          sinks,
          signal: controller.signal,
          callbacks: {
            onApprovalNeeded: async (_type, filePath) => {
              reviewStore.setReviewFile(filePath);
              const result = await inputMode.setReviewMode(REVIEW_HINT);
              reviewStore.clearReview();
              return result;
            },
            onExternalChanges: async () =>
              (await inputMode.setReviewMode('External changes detected. continue / quit')).approved,
            onUserEditConflict: async (conflict) => {
              const answer = await inputMode.setQuestionMode(formatUserEditConflictPrompt(conflict));
              return parseUserEditConflictAnswer(answer, conflict.availableActions);
            },
            onBudgetExceeded: async (currentCost, maxBudget) => {
              const issue = buildBudgetPromptIssue('budget-exceeded', currentCost, maxBudget);
              const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
              return parseRecoveryActionAnswer(answer, issue) === 'continue';
            },
            onBudgetPaused: async (currentCost, maxBudget) => {
              const issue = buildBudgetPromptIssue('budget-paused', currentCost, maxBudget);
              const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
              return parseRecoveryActionAnswer(answer, issue) === 'continue' ? 'continue' : 'abort';
            },
            onContinuationNeeded: async (_partial) =>
              inputMode.setQuestionMode('Task interrupted. Enter instructions to continue (or press Enter to retry):'),
            onTieredApproval: (request) => openApprovalPrompt(request),
            onQuestionAsked: (question, num, total) =>
              inputMode.setQuestionMode(`Question ${num}/${total}: ${question.text}`),
            onComplete: (summary) => {
              if (!abortedRef.current) onComplete(summary);
            },
          },
          savedState: stateForRun,
          selectedSkills,
          sessionId: activeSessionId,
        });

        if (controller.signal.aborted || abortedRef.current) return;

        const savedSessionId = readActive(projectDir) ?? activeSessionId;
        const saved = savedSessionId ? loadState(projectDir, savedSessionId) : null;
        if (!saved?.pendingRecovery) return;

        activeSessionId = savedSessionId;
        stateForRun = saved;
        setInlineResume(saved);
        recoveryPromptAlreadyPublished = true;
      }
    } catch (err) {
      if (!abortedRef.current && !lifecycleStore.get().cancelled) {
        addEvent({ type: 'error', ts: Date.now(), phase: lifecycleStore.get().phase, message: String(err) });
      }
    }
  });

  useEffect(() => {
    if (!enabled) return undefined;

    abortedRef.current = false;
    const controller = new AbortController();
    void startWorkflow(controller);
    return () => {
      abortedRef.current = true;
      inputMode.resetMode();
      controller.abort();
      clearAllHandlers();
      killAllProcesses();
    };
  // config is intentionally excluded from the dep array: config changes mid-workflow
  // should NOT restart the workflow. The latest config is captured via useEffectEvent
  // when startWorkflow fires.
  }, [enabled, feature, projectDir, runId]);

  const handleResume = () => {
    const sessionId = readActive(projectDir);
    const saved = sessionId ? loadState(projectDir, sessionId) : null;
    if (!saved) {
      feedbackStore.setError('No saved state to resume. Press ESC to return home.');
      return;
    }
    setInlineResume(saved);
    setRunId(id => id + 1);
  };

  return { startedAt, handleResume };
}

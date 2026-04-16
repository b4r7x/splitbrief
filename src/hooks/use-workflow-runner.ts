import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { Config, Summary, WorkflowState, SkillMeta, TuiEvent, StateAction } from '../types.js';
import { taskId } from '../types.js';
import { workflowStore } from '../stores/workflow.js';
import { reviewStore } from '../stores/review.js';
import { feedbackStore } from '../stores/feedback.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { runWorkflow } from '../core/runtime/run.js';
import { killAllProcesses } from '../utils/process.js';
import { loadState, saveState, appendEvent } from '../core/state/persistence.js';
import { readActive } from '../core/sessions/active.js';
import { transition } from '../core/state/machine.js';
import { REVIEW_HINT } from '../core/commands/review-commands.js';
import type { UseInputModeResult } from './use-input-mode.js';

interface UseWorkflowRunnerOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  initialResumeState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  sessionId?: string | undefined;
}

interface UseWorkflowRunnerResult {
  startedAt: string;
  handleResume: () => void;
}

export function useWorkflowRunner({
  feature,
  projectDir,
  config,
  onComplete,
  initialResumeState,
  selectedSkills,
  inputMode,
  sessionId: initialSessionId,
}: UseWorkflowRunnerOptions): UseWorkflowRunnerResult {
  const abortedRef = useRef(false);
  const pendingRewindEventRef = useRef<TuiEvent | null>(null);
  const [startedAt] = useState(() => new Date().toISOString());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WorkflowState | undefined>(undefined);

  const resumeState = inlineResume ?? initialResumeState;

  const startWorkflow = useEffectEvent((controller: AbortController) => {
    workflowStore.reset({
      phase: resumeState?.phase ?? 'idle',
      currentTask: resumeState?.currentTaskIndex ?? 0,
      totalTasks: resumeState?.tasks?.length ?? 0,
    });
    if (pendingRewindEventRef.current) {
      workflowStore.addEvent(pendingRewindEventRef.current);
      pendingRewindEventRef.current = null;
    }
    conversationScrollStore.reset();
    workflowStore.setCancelHandler(() => {
      inputMode.resetMode();
      controller.abort();
    });
    workflowStore.setRewindHandler((request) => {
      inputMode.resetMode();
      const activeSessionId = readActive(projectDir);
      if (!activeSessionId) return;
      const current = loadState(projectDir, activeSessionId);
      if (!current) return;

      let action: StateAction;
      let event: TuiEvent;
      if (request.target === 'spec') {
        action = { type: 'REWIND_TO_SPEC', ...(request.comment ? { comment: request.comment } : {}) };
        event = { type: 'rewind', ts: Date.now(), target: 'spec', comment: request.comment };
        const data = request.comment ? { comment: request.comment } : {};
        appendEvent(projectDir, activeSessionId, {
          ts: Date.now(), type: 'rewind_to_spec', taskId: undefined,
          phase: current.phase, data,
        });
      } else if (request.target === 'plan') {
        action = { type: 'REWIND_TO_PLAN', ...(request.comment ? { comment: request.comment } : {}) };
        event = { type: 'rewind', ts: Date.now(), target: 'plan', comment: request.comment };
        const data = request.comment ? { comment: request.comment } : {};
        appendEvent(projectDir, activeSessionId, {
          ts: Date.now(), type: 'rewind_to_plan', taskId: undefined,
          phase: current.phase, data,
        });
      } else {
        const tid = taskId(request.taskId);
        action = { type: 'RESET_TASK', taskId: tid };
        event = { type: 'task-reset', ts: Date.now(), taskId: tid };
        appendEvent(projectDir, activeSessionId, {
          ts: Date.now(), type: 'task_reset', taskId: tid,
          phase: current.phase, data: { taskId: request.taskId },
        });
      }

      const next = transition(current, action);
      saveState(projectDir, activeSessionId, next);
      pendingRewindEventRef.current = event;
      controller.abort();
      setInlineResume(next);
      setRunId(id => id + 1);
    });

    const addEvent = (event: TuiEvent) => {
      if (abortedRef.current) return;
      workflowStore.addEvent(event);
    };

    runWorkflow({
      feature,
      projectDir,
      config,
      signal: controller.signal,
      callbacks: {
        onEvent: addEvent,
        onApprovalNeeded: async (_type, filePath) => {
          reviewStore.setReviewFile(filePath);
          const result = await inputMode.setReviewMode(REVIEW_HINT);
          reviewStore.clearReview();
          return result;
        },
        onExternalChanges: async () =>
          (await inputMode.setReviewMode('External changes detected. continue / quit')).approved,
        onBudgetExceeded: async (currentCost, maxBudget) =>
          (await inputMode.setReviewMode(`Budget exceeded: $${currentCost.toFixed(2)} of $${maxBudget.toFixed(2)}. continue / quit`)).approved,
        onContinuationNeeded: async (_partial) =>
          inputMode.setQuestionMode('Task interrupted. Enter instructions to continue (or press Enter to retry):'),
        onQuestionAsked: (question, num, total) =>
          inputMode.setQuestionMode(`Question ${num}/${total}: ${question.text}`),
        onComplete: (summary) => {
          if (!abortedRef.current) onComplete(summary);
        },
      },
      savedState: resumeState,
      selectedSkills,
      sessionId: initialSessionId,
    }).catch((err) => {
      if (!abortedRef.current && !workflowStore.get().cancelled) {
        workflowStore.addEvent({ type: 'error', ts: Date.now(), message: String(err) });
      }
    });
  });

  useEffect(() => {
    abortedRef.current = false;
    const controller = new AbortController();
    startWorkflow(controller);
    return () => {
      abortedRef.current = true;
      inputMode.resetMode();
      controller.abort();
      workflowStore.setCancelHandler(null);
      workflowStore.setRewindHandler(null);
      killAllProcesses();
    };
  // config is intentionally excluded from the dep array: config changes mid-workflow
  // should NOT restart the workflow. The latest config is captured via useEffectEvent
  // when startWorkflow fires.
  }, [feature, projectDir, runId]);

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

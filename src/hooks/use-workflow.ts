import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { Config, Summary, WorkflowState as WfState, SkillMeta, TuiEvent } from '../types.js';
import { useInputMode } from './use-input-mode.js';
import { workflowStore } from '../stores/workflow.js';
import { feedbackStore } from '../stores/feedback.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { runWorkflow } from '../engine/orchestrator/index.js';
import { killAllProcesses } from '../utils/process.js';
import { REVIEW_HINT, parseReviewCommand } from '../core/commands/review-commands.js';
import { openInEditor } from '../utils/editor.js';
import { calculateCostBreakdown } from '../engine/orchestrator/cost.js';
import { loadState } from '../core/state/persistence.js';

interface UseWorkflowOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  initialResumeState?: WfState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
}

export function useWorkflow({ feature, projectDir, config, onComplete, initialResumeState, selectedSkills }: UseWorkflowOptions) {
  const inputMode = useInputMode();
  const abortedRef = useRef(false);
  const [startedAt] = useState(() => new Date().toISOString());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WfState | undefined>(undefined);

  const resumeState = inlineResume ?? initialResumeState;

  const startWorkflow = useEffectEvent((controller: AbortController) => {
    workflowStore.reset({
      phase: resumeState?.phase ?? 'idle',
      currentTask: resumeState?.currentTaskIndex ?? 0,
      totalTasks: resumeState?.tasks?.length ?? 0,
    });
    conversationScrollStore.reset();
    workflowStore.setAbortController(controller);

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
          workflowStore.setReviewFile(filePath);
          const result = await inputMode.setReviewMode(REVIEW_HINT);
          workflowStore.setReviewFile(null);
          return result;
        },
        onExternalChanges: async () =>
          (await inputMode.setReviewMode('External changes detected. continue / quit')).approved,
        onQuestionAsked: (question, num, total) =>
          inputMode.setQuestionMode(`Question ${num}/${total}: ${question.text}`),
        onComplete: (summary) => {
          if (!abortedRef.current) onComplete(summary);
        },
      },
      savedState: resumeState,
      selectedSkills,
    }).catch((err) => {
      if (!abortedRef.current && !workflowStore.get().cancelled) {
        workflowStore.addEvent({ type: 'planner-text', ts: Date.now(), text: `Error: ${String(err)}` });
      }
    });
  });

  useEffect(() => {
    abortedRef.current = false;
    const controller = new AbortController();
    startWorkflow(controller);
    return () => {
      abortedRef.current = true;
      controller.abort();
      inputMode.resetMode();
      killAllProcesses();
    };
  }, [feature, projectDir, runId]);

  const reviewFilePath = workflowStore.use(s => s.reviewFilePath);
  const tokenUsage = workflowStore.use(s => s.tokenUsage);
  const cancelled = workflowStore.use(s => s.cancelled);
  const localCount = workflowStore.use(s => s.localCount);
  const escalatedCount = workflowStore.use(s => s.escalatedCount);
  const totalTasks = workflowStore.use(s => s.totalTasks);

  const localRate = (localCount + escalatedCount) > 0
    ? (localCount / (localCount + escalatedCount)) * 100
    : 0;

  const costBreakdown = tokenUsage
    ? calculateCostBreakdown({
        tokenUsage,
        totalTasks,
        escalatedCount,
        plannerTool: config.planner.tool,
        implementerTool: config.implementer.tool,
      })
    : null;

  const handleResume = () => {
    const saved = loadState(projectDir);
    if (!saved) {
      feedbackStore.setError('No saved state to resume. Press ESC to return home.');
      return;
    }
    setInlineResume(saved);
    setRunId(id => id + 1);
  };

  const handleInput = async (text: string) => {
    if (inputMode.mode === 'review') {
      const parsed = parseReviewCommand(text);
      if (!parsed) {
        feedbackStore.setError('Unknown command. Use: approve, edit, comment <text>, or quit');
        return;
      }
      if (parsed.action === 'approve') {
        inputMode.resolve({ approved: true, comment: parsed.comment });
      } else if (parsed.action === 'quit') {
        inputMode.resolve({ approved: false });
      } else if (parsed.action === 'edit') {
        const filePath = workflowStore.get().reviewFilePath;
        if (filePath) {
          await openInEditor(filePath, (msg) => feedbackStore.setError(msg));
        }
      }
      return;
    }

    if (inputMode.mode === 'question') {
      inputMode.resolve(text);
    }
  };

  return {
    events: workflowStore.use(s => s.events),
    phase: workflowStore.use(s => s.phase),
    currentTask: workflowStore.use(s => s.currentTask),
    totalTasks,
    localCount,
    escalatedCount,
    taskMap: workflowStore.use(s => s.taskMap),
    inputMode: inputMode.mode,
    inputHint: inputMode.hint,
    reviewFilePath,
    handleInput,
    cancelled,
    localRate,
    costBreakdown,
    handleResume,
    startedAt,
  };
}

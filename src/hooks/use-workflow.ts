import { useRef, useEffect, useEffectEvent } from 'react';
import { spawn } from 'node:child_process';
import type { Config, Summary, WorkflowState as WfState, SkillMeta, TuiEvent } from '../types.js';
import { useInputMode } from './use-input-mode.js';
import { useLatestRef } from './use-latest-ref.js';
import { workflowStore } from '../stores/workflow.js';
import { feedbackStore } from '../stores/error.js';
import { runWorkflow } from '../engine/orchestrator/index.js';
import { killAllProcesses } from '../utils/process.js';

export const REVIEW_HINT = 'approve / edit / comment <text> / quit';

// Known limitation: editor inherits Ink's alternate screen buffer and Ink
// continues rendering during the session. Terminal vim handles this, others may not.
function openInEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR || 'vi';
  return new Promise<void>((resolve) => {
    const child = spawn(editor, [filePath], { stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', (err) => {
      feedbackStore.setError(`Failed to open editor: ${err.message}`);
      resolve();
    });
  });
}

const APPROVE_ALIASES = new Set(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue']);
const QUIT_ALIASES = new Set(['quit', 'reject', 'no', 'n']);

type ReviewAction = { action: 'approve'; comment?: string } | { action: 'quit' } | { action: 'edit' } | null;

export function parseReviewCommand(text: string): ReviewAction {
  const cmd = text.toLowerCase().trim();
  if (APPROVE_ALIASES.has(cmd)) return { action: 'approve' };
  if (QUIT_ALIASES.has(cmd)) return { action: 'quit' };
  if (cmd === 'edit') return { action: 'edit' };
  if (cmd.startsWith('comment ')) {
    const trimmed = text.trim();
    return { action: 'approve', comment: trimmed.slice(8).trim() };
  }
  return null;
}

interface UseWorkflowOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  resumeState?: WfState;
  selectedSkills?: SkillMeta[];
  runId: number;
}

export function useWorkflow({ feature, projectDir, config, onComplete, resumeState, selectedSkills, runId }: UseWorkflowOptions) {
  const inputMode = useInputMode();
  const abortedRef = useRef(false);

  const configRef = useLatestRef(config);
  const stableOnComplete = useEffectEvent(onComplete);
  const resumeStateRef = useLatestRef(resumeState);
  const selectedSkillsRef = useLatestRef(selectedSkills);

  useEffect(() => {
    abortedRef.current = false;

    const controller = new AbortController();
    workflowStore.reset({
      phase: resumeStateRef.current?.phase ?? 'idle',
      currentTask: resumeStateRef.current?.currentTaskIndex ?? 0,
      totalTasks: resumeStateRef.current?.tasks?.length ?? 0,
    });
    workflowStore.setAbortController(controller);

    const addEvent = (event: TuiEvent) => {
      if (abortedRef.current) return;
      workflowStore.addEvent(event);
    };

    runWorkflow({
      feature,
      projectDir,
      config: configRef.current,
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
          if (!abortedRef.current) stableOnComplete(summary);
        },
      },
      savedState: resumeStateRef.current,
      selectedSkills: selectedSkillsRef.current,
    }).catch((err) => {
      if (!abortedRef.current && !workflowStore.get().cancelled) {
        workflowStore.addEvent({ type: 'planner-text', ts: Date.now(), text: `Error: ${String(err)}` });
      }
    });

    return () => {
      abortedRef.current = true;
      controller.abort();
      inputMode.resetMode();
      killAllProcesses();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs for config/resumeState/selectedSkills avoid restarting workflow; stableOnComplete via useEffectEvent; inputMode methods use internal refs; runId forces re-run on resume
  }, [feature, projectDir, runId]);

  const reviewFilePath = workflowStore.use(s => s.reviewFilePath);

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
          await openInEditor(filePath);
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
    totalTasks: workflowStore.use(s => s.totalTasks),
    localCount: workflowStore.use(s => s.localCount),
    escalatedCount: workflowStore.use(s => s.escalatedCount),
    taskMap: workflowStore.use(s => s.taskMap),
    inputMode: inputMode.mode,
    inputHint: inputMode.hint,
    reviewFilePath,
    handleInput,
  };
}

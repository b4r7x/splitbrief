import { useRef, useEffect } from 'react';
import type { Config, Summary, WorkflowState as WfState, SkillMeta, TuiEvent } from '../types.js';
import { useInputMode } from './use-input-mode.js';
import { useLatestRef } from './use-latest-ref.js';
import { workflowStore } from '../stores/workflow.js';
import { runWorkflow } from '../engine/orchestrator/index.js';
import { killAllProcesses } from '../utils/process.js';

export const REVIEW_HINT = 'approve / edit / comment <text> / quit';

interface UseWorkflowOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  resumeState?: WfState;
  selectedSkills?: SkillMeta[];
}

export function useWorkflow({ feature, projectDir, config, onComplete, resumeState, selectedSkills }: UseWorkflowOptions) {
  const inputMode = useInputMode();
  const abortedRef = useRef(false);

  const configRef = useLatestRef(config);
  const onCompleteRef = useLatestRef(onComplete);
  const resumeStateRef = useLatestRef(resumeState);
  const selectedSkillsRef = useLatestRef(selectedSkills);

  useEffect(() => {
    abortedRef.current = false;

    workflowStore.reset({
      phase: resumeState?.phase ?? 'idle',
      currentTask: resumeState?.currentTaskIndex ?? 0,
      totalTasks: resumeState?.tasks.length ?? 0,
    });

    const addEvent = (event: TuiEvent) => {
      if (abortedRef.current) return;
      workflowStore.addEvent(event);
    };

    runWorkflow({
      feature,
      projectDir,
      config: configRef.current,
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
          if (!abortedRef.current) onCompleteRef.current(summary);
        },
      },
      savedState: resumeStateRef.current,
      selectedSkills: selectedSkillsRef.current,
    }).catch((err) => {
      if (!abortedRef.current) {
        workflowStore.addEvent({ type: 'planner-text', ts: Date.now(), text: `Error: ${String(err)}` });
      }
    });

    return () => {
      abortedRef.current = true;
      inputMode.resetMode();
      killAllProcesses();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs used for config/onComplete/resumeState/selectedSkills; feature+projectDir are stable
  }, [feature, projectDir]);

  const inputModeRef = useLatestRef(inputMode);
  const reviewFilePath = workflowStore.use(s => s.reviewFilePath);

  const handleInput = async (text: string) => {
    const mode = inputModeRef.current;
    if (mode.mode === 'review') {
      const cmd = text.toLowerCase().trim();
      if (cmd === 'approve') {
        mode.resolve({ approved: true });
      } else if (cmd === 'edit') {
        const filePath = workflowStore.get().reviewFilePath;
        if (filePath) {
          const editor = process.env.EDITOR || 'vi';
          const { spawn } = await import('node:child_process');
          await new Promise<void>((resolve) => {
            const child = spawn(editor, [filePath], { stdio: 'inherit' });
            child.on('close', () => resolve());
            child.on('error', () => resolve());
          });
        }
      } else if (cmd.startsWith('comment ')) {
        const comment = text.slice(8).trim();
        mode.resolve({ approved: true, comment });
      } else if (cmd === 'continue') {
        mode.resolve({ approved: true });
      } else if (cmd === 'quit') {
        mode.resolve({ approved: false });
      }
      return;
    }

    if (mode.mode === 'question') {
      mode.resolve(text);
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

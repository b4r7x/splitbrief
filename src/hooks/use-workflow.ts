import { useReducer, useRef, useEffect } from 'react';
import type { Config, Summary, WorkflowState as WfState, SkillMeta, TuiEvent } from '../types.js';
import { useInputMode } from './use-input-mode.js';
import { useLatestRef } from './use-latest-ref.js';
import { workflowReducer } from './workflow-reducer.js';
import type { HookWorkflowState } from './workflow-reducer.js';
import { runWorkflow } from '../engine/orchestrator/index.js';
import { killAllProcesses } from '../utils/process.js';

const defaultInitialState: HookWorkflowState = {
  events: [],
  phase: 'idle',
  currentTask: 0,
  totalTasks: 0,
  localCount: 0,
  escalatedCount: 0,
  reviewFilePath: null,
  taskMap: new Map(),
};

interface UseWorkflowOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  resumeState?: WfState;
  selectedSkills?: SkillMeta[];
}

export function useWorkflow({ feature, projectDir, config, onComplete, resumeState, selectedSkills }: UseWorkflowOptions) {
  const [state, dispatch] = useReducer(workflowReducer, {
    ...defaultInitialState,
    phase: resumeState?.phase ?? 'idle',
    currentTask: resumeState?.currentTaskIndex ?? 0,
    totalTasks: resumeState?.tasks.length ?? 0,
  });

  const inputMode = useInputMode();
  const abortedRef = useRef(false);

  const configRef = useLatestRef(config);
  const onCompleteRef = useLatestRef(onComplete);
  const resumeStateRef = useLatestRef(resumeState);
  const selectedSkillsRef = useLatestRef(selectedSkills);

  useEffect(() => {
    abortedRef.current = false;

    const addEvent = (event: TuiEvent) => {
      if (abortedRef.current) return;
      dispatch({ type: 'ADD_EVENT', event });
    };

    runWorkflow({
      feature,
      projectDir,
      config: configRef.current,
      callbacks: {
        onEvent: addEvent,
        onApprovalNeeded: async (_type, filePath) => {
          dispatch({ type: 'SET_REVIEW_FILE', path: filePath });
          const result = await inputMode.setReviewMode('approve / edit / comment <text> / quit');
          dispatch({ type: 'SET_REVIEW_FILE', path: null });
          return result;
        },
        onExternalChanges: async () => {
          const result = await inputMode.setReviewMode('External changes detected. continue / quit');
          return result.approved;
        },
        onQuestionAsked: async (question, num, total) => {
          const answer = await inputMode.setQuestionMode(`Question ${num}/${total}: ${question.text}`);
          return answer;
        },
        onComplete: (summary) => {
          if (!abortedRef.current) onCompleteRef.current(summary);
        },
      },
      savedState: resumeStateRef.current,
      selectedSkills: selectedSkillsRef.current,
    }).catch((err) => {
      if (!abortedRef.current) {
        dispatch({ type: 'ADD_EVENT', event: { type: 'planner-text', ts: Date.now(), text: `Error: ${String(err)}` } });
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
  const reviewFilePathRef = useLatestRef(state.reviewFilePath);

  const handleInput = async (text: string) => {
    const mode = inputModeRef.current;
    if (mode.mode === 'review') {
      const cmd = text.toLowerCase().trim();
      if (cmd === 'approve') {
        mode.resolve({ approved: true });
      } else if (cmd === 'edit') {
        if (reviewFilePathRef.current) {
          const editor = process.env.EDITOR || 'vi';
          const { spawn } = await import('node:child_process');
          await new Promise<void>((resolve) => {
            const child = spawn(editor, [reviewFilePathRef.current!], { stdio: 'inherit' });
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
    events: state.events,
    phase: state.phase,
    currentTask: state.currentTask,
    totalTasks: state.totalTasks,
    localCount: state.localCount,
    escalatedCount: state.escalatedCount,
    taskMap: state.taskMap,
    inputMode: inputMode.mode,
    inputHint: inputMode.hint,
    reviewFilePath: state.reviewFilePath,
    handleInput,
  };
}

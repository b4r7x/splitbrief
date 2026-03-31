import { useState, useCallback, useRef, useEffect } from 'react';
import { spawnSync } from 'node:child_process';
import type { Phase, TuiEvent, Config, Summary, WorkflowState } from '../types.js';
import { useInputMode } from './use-input-mode.js';
import { runWorkflow } from '../engine/orchestrator.js';
import { killAllProcesses } from '../utils/process.js';

const MAX_EVENTS = 10_000;

interface UseWorkflowOptions {
  feature: string;
  projectDir: string;
  config: Config;
  auto: boolean;
  onComplete: (summary: Summary) => void;
  resumeState?: WorkflowState;
}

export function useWorkflow({ feature, projectDir, config, auto, onComplete, resumeState }: UseWorkflowOptions) {
  const [events, setEvents] = useState<TuiEvent[]>([]);
  const [phase, setPhase] = useState<Phase>(resumeState?.phase ?? 'idle');
  const [currentTask, setCurrentTask] = useState(resumeState?.currentTaskIndex ?? 0);
  const [totalTasks, setTotalTasks] = useState(resumeState?.tasks.length ?? 0);
  const [localCount, setLocalCount] = useState(0);
  const [escalatedCount, setEscalatedCount] = useState(0);
  const [reviewFilePath, setReviewFilePath] = useState<string | null>(null);

  const inputMode = useInputMode();
  const abortedRef = useRef(false);

  const addEvent = useCallback((event: TuiEvent) => {
    if (abortedRef.current) return;
    setEvents(prev => {
      const next = [...prev, event];
      return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
    });
    if (event.type === 'planner-status') setPhase(event.phase as Phase);
    if (event.type === 'task-start') {
      setCurrentTask(event.index + 1);
      setTotalTasks(event.total);
    }
    if (event.type === 'task-complete') {
      if (event.method === 'local') setLocalCount(prev => prev + 1);
      else setEscalatedCount(prev => prev + 1);
    }
  }, []);

  useEffect(() => {
    abortedRef.current = false;

    runWorkflow(feature, projectDir, config, {
      onEvent: addEvent,
      onApprovalNeeded: async (_type, filePath) => {
        setReviewFilePath(filePath);
        const result = await inputMode.setReviewMode('approve / edit / comment <text> / quit');
        setReviewFilePath(null);
        return result as { approved: boolean; comment?: string };
      },
      onExternalChanges: async () => {
        const result = await inputMode.setReviewMode('External changes detected. continue / quit');
        return (result as { approved: boolean }).approved;
      },
      onQuestionAsked: async (question, num, total) => {
        const answer = await inputMode.setQuestionMode(`Question ${num}/${total}: ${question.text}`);
        return answer as string;
      },
      onComplete: (summary) => {
        if (!abortedRef.current) onComplete(summary);
      },
    }, resumeState).catch((err) => {
      if (!abortedRef.current) {
        addEvent({ type: 'planner-text', ts: Date.now(), text: `Error: ${String(err)}` });
      }
    });

    return () => {
      abortedRef.current = true;
      inputMode.resetMode();
      killAllProcesses();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props are stable for screen lifetime
  }, []);

  const handleInput = useCallback((text: string) => {
    if (inputMode.mode === 'review') {
      const cmd = text.toLowerCase().trim();
      if (cmd === 'approve') {
        inputMode.resolve({ approved: true });
      } else if (cmd === 'edit') {
        if (reviewFilePath) {
          const editor = process.env.EDITOR || 'vi';
          spawnSync(editor, [reviewFilePath], { stdio: 'inherit' });
        }
      } else if (cmd.startsWith('comment ')) {
        const comment = text.slice(8).trim();
        inputMode.resolve({ approved: true, comment });
      } else if (cmd === 'quit') {
        inputMode.resolve({ approved: false });
      }
      return;
    }

    if (inputMode.mode === 'question') {
      inputMode.resolve(text);
    }
  }, [inputMode, reviewFilePath]);

  return {
    events,
    phase,
    currentTask,
    totalTasks,
    localCount,
    escalatedCount,
    inputMode: inputMode.mode,
    inputHint: inputMode.hint,
    reviewFilePath,
    handleInput,
  };
}

import { useState, useEffect } from 'react';
import { Box } from 'ink';
import Layout from './tui/layout.js';
import { runWorkflow } from './orchestrator/orchestrator.js';
import { loadConfig } from './config.js';
import type { Phase, Task, Summary, OrchestratorCallbacks, ValidationResult, WorkflowState } from './types.js';

interface AppProps {
  feature: string;
  projectDir: string;
  auto: boolean;
  modelOverride?: string;
  providerOverride?: string;
  contextLengthOverride?: number;
  savedState?: WorkflowState;
}

export default function App({ feature, projectDir, auto, modelOverride, providerOverride, contextLengthOverride, savedState }: AppProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [plannerLines, setPlannerLines] = useState<string[]>([]);
  const [implementerLines, setImplementerLines] = useState<string[]>([]);
  const [currentTask, setCurrentTask] = useState(0);
  const [totalTasks, setTotalTasks] = useState(0);
  const [retries, setRetries] = useState(0);
  const [model, setModel] = useState('');
  const [approval, setApproval] = useState<{
    type: 'spec' | 'plan';
    filePath: string;
    onApprove: () => void;
    onReject: () => void;
  } | null>(null);
  const [startedAt, setStartedAt] = useState('');

  const MAX_LINES = 10_000;
  const appendLines = (setter: typeof setPlannerLines) => (text: string) => {
    setter(prev => {
      const next = [...prev, text];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  };

  useEffect(() => {
    const config = loadConfig(projectDir);

    if (modelOverride) config.implementer.model = modelOverride;
    if (providerOverride) config.implementer.provider = providerOverride as typeof config.implementer.provider;
    if (contextLengthOverride) config.implementer.contextLength = contextLengthOverride;

    setModel(config.implementer.model);
    setStartedAt(new Date().toISOString());

    const callbacks: OrchestratorCallbacks = {
      onPhaseChange(p: Phase) {
        setPhase(p);
      },
      onPlannerOutput: appendLines(setPlannerLines),
      onImplementerOutput: appendLines(setImplementerLines),
      onTaskStart(task: Task, index: number, total: number) {
        setCurrentTask(index + 1);
        setTotalTasks(total);
      },
      onTaskRetry(_task: Task, attempt: number, _error: string) {
        setRetries(attempt);
      },
      onTaskComplete(_task: Task, _method: 'local' | 'escalated') {
        setRetries(0);
      },
      onTaskSkipped(_task: Task, _reason: string) {},
      onValidationResult(_task: Task, _results: ValidationResult[]) {},
      onApprovalNeeded(type: 'spec' | 'plan', filePath: string): Promise<boolean> {
        if (auto) return Promise.resolve(true);
        return new Promise<boolean>(resolve => {
          setApproval({
            type,
            filePath,
            onApprove() {
              setApproval(null);
              resolve(true);
            },
            onReject() {
              setApproval(null);
              resolve(false);
            },
          });
        });
      },
      onExternalChanges(): Promise<boolean> {
        if (auto) return Promise.resolve(true);
        return new Promise<boolean>(resolve => {
          setApproval({
            type: 'plan',
            filePath: '',
            onApprove() {
              setApproval(null);
              resolve(true);
            },
            onReject() {
              setApproval(null);
              resolve(false);
            },
          });
        });
      },
      onComplete(summary: Summary) {
        const secs = Math.floor(summary.totalTime / 1000);
        const mins = Math.floor(secs / 60);
        const timeStr = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
        setImplementerLines(prev => {
          const next = [
            ...prev,
            '',
            `--- Complete ---`,
            `Tasks: ${summary.completedByLocal + summary.escalatedToOpus}/${summary.totalTasks}`,
            `Escalated: ${summary.escalatedToOpus}`,
            `Failed: ${summary.failed}`,
            `Time: ${timeStr}`,
            `Savings: ${summary.estimatedCostSavings}`,
          ];
          return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
        });
      },
      onError: (error: string) => {
        appendLines(setImplementerLines)(`[ERROR] ${error}`);
      },
    };

    runWorkflow(feature, projectDir, config, callbacks, savedState).catch(err => callbacks.onError(String(err)));
  }, []);

  return (
    <Layout
      feature={feature}
      startedAt={startedAt}
      phase={phase}
      currentTask={currentTask}
      totalTasks={totalTasks}
      model={model}
      retries={retries}
      plannerLines={plannerLines}
      implementerLines={implementerLines}
      approval={approval}
    />
  );
}

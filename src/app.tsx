import React, { useState, useCallback, useEffect } from 'react';
import { Box } from 'ink';
import Layout from './tui/layout.js';
import { runWorkflow } from './orchestrator/orchestrator.js';
import { loadConfig } from './config.js';
import type { Phase, Task, Summary, OrchestratorCallbacks, ValidationResult } from './types.js';

interface AppProps {
  feature: string;
  projectDir: string;
  auto: boolean;
  modelOverride?: string;
  providerOverride?: string;
}

export default function App({ feature, projectDir, auto, modelOverride, providerOverride }: AppProps) {
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

  useEffect(() => {
    const config = loadConfig(projectDir);

    if (modelOverride) config.implementer.model = modelOverride;
    if (providerOverride) config.implementer.provider = providerOverride as typeof config.implementer.provider;

    setModel(config.implementer.model);
    setStartedAt(new Date().toISOString());

    const callbacks: OrchestratorCallbacks = {
      onPhaseChange(p: Phase) {
        setPhase(p);
      },
      onPlannerOutput(text: string) {
        setPlannerLines(prev => [...prev, text]);
      },
      onImplementerOutput(text: string) {
        setImplementerLines(prev => [...prev, text]);
      },
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
        setImplementerLines(prev => [
          ...prev,
          '',
          `--- Complete ---`,
          `Tasks: ${summary.completedByLocal + summary.escalatedToOpus}/${summary.totalTasks}`,
          `Escalated: ${summary.escalatedToOpus}`,
          `Failed: ${summary.failed}`,
          `Time: ${summary.totalTime}s`,
          `Savings: ${summary.estimatedCostSavings}`,
        ]);
      },
      onError(error: string) {
        setImplementerLines(prev => [...prev, `[ERROR] ${error}`]);
      },
    };

    runWorkflow(feature, projectDir, config, callbacks);
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

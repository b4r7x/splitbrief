import { useState, useRef, useMemo } from 'react';
import { Box, useInput, useStdout, useApp } from 'ink';
import type { Config, Summary, WorkflowState } from '../types.js';
import type { Theme } from '../theme.js';
import Header from '../ui/header.js';
import ConversationFlow from '../ui/conversation-flow.js';
import type { ConversationFlowHandle } from '../ui/conversation-flow.js';
import CostFooter from '../ui/cost-footer.js';
import { InputBar } from '../ui/input-bar.js';
import ReviewView from '../ui/review-view.js';
import Sidebar from '../ui/sidebar.js';
import { useSidebar } from '../hooks/use-sidebar.js';
import { useWorkflow } from '../hooks/use-workflow.js';

interface WorkflowScreenProps {
  feature: string;
  config: Config;
  theme: Theme;
  auto: boolean;
  projectDir: string;
  onComplete: (summary: Summary) => void;
  resumeState?: WorkflowState;
  onSlashCommand?: (command: string) => void;
  onOpenOverlay?: (type: import('../types.js').OverlayType) => void;
  errorMessage?: string | null;
  onClearError?: () => void;
}

export function WorkflowScreen({ feature, config, theme: t, auto, projectDir, onComplete, resumeState, onSlashCommand, onOpenOverlay, errorMessage, onClearError }: WorkflowScreenProps) {
  const { stdout } = useStdout();
  const { exit } = useApp();
  const flowRef = useRef<ConversationFlowHandle>(null);

  const workflow = useWorkflow({ feature, projectDir, config, auto, onComplete, resumeState });

  const sidebar = useSidebar();
  const [startedAt] = useState(() => new Date().toISOString());

  const sidebarTasks = useMemo(() => {
    const taskMap = new Map<string, { id: string; title: string; status: 'pending' | 'done' | 'failed' | 'skipped' | 'in_progress' }>();
    for (const ev of workflow.events) {
      if (ev.type === 'task-start') {
        taskMap.set(ev.taskId, { id: ev.taskId, title: ev.title, status: 'in_progress' });
      } else if (ev.type === 'task-complete') {
        const existing = taskMap.get(ev.taskId);
        if (existing) existing.status = 'done';
      } else if (ev.type === 'task-skipped') {
        const existing = taskMap.get(ev.taskId);
        if (existing) existing.status = 'skipped';
      }
    }
    return Array.from(taskMap.values());
  }, [workflow.events]);

  const costData = useMemo(() => ({
    localRate: (workflow.localCount + workflow.escalatedCount) > 0 ? (workflow.localCount / (workflow.localCount + workflow.escalatedCount)) * 100 : 0,
    spent: 0,
    saved: 0,
  }), [workflow.localCount, workflow.escalatedCount]);

  const rows = stdout?.rows ?? 24;
  const contentHeight = Math.max(0, rows - 4);

  useInput((input, key) => {
    if (input === '?' && workflow.inputMode === 'normal') {
      onOpenOverlay?.('help');
    } else if (key.ctrl && input === '\\' && workflow.inputMode === 'normal') {
      sidebar.toggle();
    } else if (input === 'q' && workflow.inputMode === 'normal') {
      exit();
    } else if (input === 'd') {
      flowRef.current?.toggleDiff();
    } else if (key.upArrow) {
      flowRef.current?.scrollUp();
    } else if (key.downArrow) {
      flowRef.current?.scrollDown();
    }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Header feature={feature} startedAt={startedAt} phase={workflow.phase} />

      <Box flexDirection="row" flexGrow={1}>
        {sidebar.visible && (
          <Sidebar tasks={sidebarTasks} costData={costData} theme={t} />
        )}
        {workflow.inputMode === 'review' && workflow.reviewFilePath ? (
          <ReviewView filePath={workflow.reviewFilePath} theme={t} height={contentHeight} />
        ) : (
          <ConversationFlow ref={flowRef} events={workflow.events} height={contentHeight} />
        )}
      </Box>

      <CostFooter
        currentTask={workflow.currentTask}
        totalTasks={workflow.totalTasks}
        localRate={costData.localRate}
        estimatedCost={0}
        estimatedSavings={0}
        implementerModel={config.implementer.model}
      />

      <InputBar
        onSubmit={workflow.handleInput}
        onSlashCommand={onSlashCommand}
        errorMessage={errorMessage}
        onClearError={onClearError}
        mode={workflow.inputMode}
        hint={workflow.inputHint || (workflow.inputMode === 'review' ? 'approve / edit / comment <text> / quit' : '')}
        currentScreen="workflow"
        theme={t}
      />
    </Box>
  );
}

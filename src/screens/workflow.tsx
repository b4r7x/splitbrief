import { useState, useRef } from 'react';
import { Box, useInput } from 'ink';
import type { Config, Summary, WorkflowState, SlashCommandDef, SkillMeta } from '../types.js';
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
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';

interface WorkflowScreenProps {
  feature: string;
  config: Config;
  theme: Theme;
  auto: boolean;
  projectDir: string;
  onComplete: (summary: Summary) => void;
  resumeState?: WorkflowState;
  commands: SlashCommandDef[];
  onSlashCommand: (command: string) => void;
  onOpenOverlay?: (type: import('../types.js').OverlayType) => void;
  errorMessage?: string | null;
  onClearError?: () => void;
  selectedSkills?: SkillMeta[];
}

export function WorkflowScreen({ feature, config, theme: t, auto, projectDir, onComplete, resumeState, commands, onSlashCommand, onOpenOverlay, errorMessage, onClearError, selectedSkills }: WorkflowScreenProps) {
  const { cols, rows, isSmall } = useResponsiveLayout();
  const flowRef = useRef<ConversationFlowHandle>(null);

  const workflow = useWorkflow({ feature, projectDir, config, auto, onComplete, resumeState, selectedSkills });

  const sidebar = useSidebar(isSmall);
  const [startedAt] = useState(() => new Date().toISOString());

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
  const sidebarTasks = Array.from(taskMap.values());

  const costData = {
    localRate: (workflow.localCount + workflow.escalatedCount) > 0 ? (workflow.localCount / (workflow.localCount + workflow.escalatedCount)) * 100 : 0,
    spent: 0,
    saved: 0,
  };

  const showSidebar = sidebar.visible && !isSmall;
  const sidebarWidth = Math.floor(cols * 0.25);
  const contentHeight = Math.max(0, rows - 4);

  useInput((input, key) => {
    if (key.ctrl && input === '\\') { sidebar.toggle(); return; }
    if (key.ctrl && input === 'd') { flowRef.current?.toggleDiff(); return; }
    if (key.upArrow) { flowRef.current?.scrollUp(); return; }
    if (key.downArrow) { flowRef.current?.scrollDown(); return; }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Header feature={feature} startedAt={startedAt} phase={workflow.phase} />

      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && (
          <Sidebar tasks={sidebarTasks} costData={costData} theme={t} width={sidebarWidth} />
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
        isSmall={isSmall}
      />

      <InputBar
        onSubmit={workflow.handleInput}
        onSlashCommand={onSlashCommand}
        commands={commands}
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

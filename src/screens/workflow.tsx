import { useRef } from 'react';
import { Box, useInput } from 'ink';
import type { SlashCommandDef, Summary } from '../types.js';
import Header from '../components/header.js';
import ConversationFlow from '../components/conversation-flow.js';
import type { ConversationFlowHandle } from '../components/conversation-flow.js';
import CostFooter from '../components/cost-footer.js';
import { InputBar } from '../components/input-bar.js';
import ReviewView from '../components/review-view.js';
import Sidebar from '../components/sidebar.js';
import { useSidebar } from '../hooks/use-sidebar.js';
import { useWorkflow, REVIEW_HINT } from '../hooks/use-workflow.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { configStore } from '../stores/config.js';
import { skillsStore } from '../stores/skills.js';
import { overlayStore } from '../stores/overlay.js';
import { routerStore } from '../stores/router.js';

interface WorkflowScreenProps {
  commands: SlashCommandDef[];
  onSlashCommand: (command: string) => void;
}

export function WorkflowScreen({ commands, onSlashCommand }: WorkflowScreenProps) {
  const config = configStore.useConfig();
  const projectDir = configStore.use(s => s.projectDir);
  const selectedSkillMetas = skillsStore.use(s => s.available.filter(m => s.selected.has(m.id)));
  const hasOverlay = overlayStore.use(s => s.active) !== 'none';
  const feature = routerStore.use(s => s.screen === 'workflow' ? s.feature : '');
  const resumeState = routerStore.use(s => s.screen === 'workflow' ? s.resumeState : undefined);
  const { cols, rows, isSmall } = useResponsiveLayout();
  const flowRef = useRef<ConversationFlowHandle>(null);
  const startedAt = useRef(new Date().toISOString());

  const onComplete = (summary: Summary) =>
    routerStore.navigate('summary', { summary });

  const workflow = useWorkflow({ feature, projectDir, config, onComplete, resumeState, selectedSkills: selectedSkillMetas });
  const sidebar = useSidebar(isSmall);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'e') { sidebar.toggle(); return; }
      if (key.ctrl && input === 'd') { flowRef.current?.toggleDiff(); return; }
      if (key.upArrow) { flowRef.current?.scrollUp(); return; }
      if (key.downArrow) { flowRef.current?.scrollDown(); return; }
    },
    { isActive: !hasOverlay },
  );

  const sidebarTasks = Array.from(workflow.taskMap.values());

  const localRate = (workflow.localCount + workflow.escalatedCount) > 0
    ? (workflow.localCount / (workflow.localCount + workflow.escalatedCount)) * 100
    : 0;

  const showSidebar = sidebar.visible && !isSmall;
  const sidebarWidth = Math.floor(cols * 0.25);
  const contentHeight = Math.max(0, rows - 4);

  return (
    <Box flexDirection="column" height={rows}>
      <Header feature={feature} startedAt={startedAt.current} phase={workflow.phase} />

      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && (
          <Sidebar tasks={sidebarTasks} costData={{ localRate, spent: 0, saved: 0 }} width={sidebarWidth} />
        )}
        {workflow.inputMode === 'review' && workflow.reviewFilePath ? (
          <ReviewView filePath={workflow.reviewFilePath} height={contentHeight} />
        ) : (
          <ConversationFlow ref={flowRef} events={workflow.events} height={contentHeight} />
        )}
      </Box>

      <CostFooter
        currentTask={workflow.currentTask}
        totalTasks={workflow.totalTasks}
        localRate={localRate}
        estimatedCost={0}
        estimatedSavings={0}
        implementerModel={config.implementer.model}
        isSmall={isSmall}
      />

      <InputBar
        onSubmit={workflow.handleInput}
        onSlashCommand={onSlashCommand}
        commands={commands}
        mode={workflow.inputMode}
        hint={workflow.inputHint || (workflow.inputMode === 'review' ? REVIEW_HINT : '')}
        currentScreen="workflow"
        disabled={hasOverlay}
      />
    </Box>
  );
}

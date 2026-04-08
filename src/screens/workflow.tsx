import { useState } from 'react';
import { useInput } from 'ink';
import { Box } from 'ink';
import type { InputMode, SlashCommandDef, Summary } from '../types.js';
import Header from '../components/workflow/header.js';
import ConversationFlow from '../components/conversation-flow/index.js';
import CostFooter from '../components/workflow/cost-footer.js';
import { InputBar } from '../components/input-bar/index.js';
import ReviewView from '../components/workflow/review-view.js';
import Sidebar from '../components/workflow/sidebar.js';
import { useWorkflow } from '../hooks/use-workflow.js';
import { REVIEW_HINT } from '../core/commands/review-commands.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { configStore } from '../stores/config.js';
import { skillsStore } from '../stores/skills.js';
import { overlayStore } from '../stores/overlay.js';
import { routerStore } from '../stores/router.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { findLatestDiffEventIndex } from '../utils/event-sections.js';

interface WorkflowScreenProps {
  commands: SlashCommandDef[];
  onSlashCommand: (command: string) => void;
}

function resolveInputHint(cancelled: boolean, inputHint: string, inputMode: InputMode): string {
  if (cancelled) return 'Enter to resume, ESC for home, /quit to exit';
  if (inputHint) return inputHint;
  if (inputMode === 'review') return REVIEW_HINT;
  return '';
}

export function WorkflowScreen({ commands, onSlashCommand }: WorkflowScreenProps) {
  const config = configStore.useConfig();
  const projectDir = configStore.use(s => s.projectDir);
  const available = skillsStore.use(s => s.available);
  const selected = skillsStore.use(s => s.selected);
  const selectedSkillMetas = available.filter(m => selected.has(m.id));
  const hasOverlay = overlayStore.use(s => s.active !== 'none');
  const feature = routerStore.use(s => s.screen === 'workflow' ? s.feature : '');
  const resumeState = routerStore.use(s => s.screen === 'workflow' ? s.resumeState : undefined);
  const { cols, rows, isSmall } = useResponsiveLayout();

  const onComplete = (summary: Summary) =>
    routerStore.navigate('summary', { summary });

  const workflow = useWorkflow({ feature, projectDir, config, onComplete, initialResumeState: resumeState, selectedSkills: selectedSkillMetas });
  const [sidebarUserWants, setSidebarUserWants] = useState(false);
  const showSidebar = sidebarUserWants && !isSmall;

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'e') {
        if (!isSmall) setSidebarUserWants(prev => !prev);
        return;
      }
      if (key.ctrl && input === 'd') {
        const idx = findLatestDiffEventIndex(workflow.events);
        if (idx != null) conversationScrollStore.toggleDiff(idx);
        return;
      }
      if (key.upArrow) {
        const maxOffset = Math.max(0, workflow.events.length - 1);
        conversationScrollStore.scrollUp(maxOffset, workflow.events.length);
        return;
      }
      if (key.downArrow) {
        conversationScrollStore.scrollDown();
        return;
      }
      if (input === 'G') {
        conversationScrollStore.scrollToBottom(workflow.events.length);
        return;
      }
    },
    { isActive: !hasOverlay && workflow.inputMode === 'normal' },
  );

  const sidebarTasks = Array.from(workflow.taskMap.values());
  const sidebarWidth = Math.floor(cols * 0.25);
  const contentHeight = Math.max(0, rows - 4);
  const contentWidth = showSidebar ? cols - sidebarWidth : cols;

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      <Header feature={feature} startedAt={workflow.startedAt} phase={workflow.phase} />

      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && (
          <Sidebar tasks={sidebarTasks} costData={{ localRate: workflow.localRate, spent: workflow.costBreakdown?.totalActualCost ?? 0, saved: workflow.costBreakdown?.savingsAmount ?? 0 }} width={sidebarWidth} />
        )}
        {workflow.inputMode === 'review' && workflow.reviewFilePath ? (
          <ReviewView filePath={workflow.reviewFilePath} height={contentHeight} width={contentWidth} isActive={!hasOverlay} />
        ) : (
          <ConversationFlow events={workflow.events} height={contentHeight} width={contentWidth} />
        )}
      </Box>

      <CostFooter
        currentTask={workflow.currentTask}
        totalTasks={workflow.totalTasks}
        localRate={workflow.localRate}
        estimatedSavings={workflow.costBreakdown?.savingsAmount ?? 0}
      />

      <InputBar
        onSubmit={workflow.cancelled ? workflow.handleResume : workflow.handleInput}
        onSlashCommand={onSlashCommand}
        commands={commands}
        mode={workflow.inputMode}
        hint={resolveInputHint(workflow.cancelled, workflow.inputHint, workflow.inputMode)}
        currentScreen="workflow"
        disabled={hasOverlay}
      />
    </Box>
  );
}

import { useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import type { InputMode, SlashCommandDef, Summary, WorkflowState as WfState } from '../types.js';
import { loadState } from '../core/state-persistence.js';
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
import { workflowStore } from '../stores/workflow.js';
import { calculateCostBreakdown } from '../engine/orchestrator/cost.js';
import { skillsStore } from '../stores/skills.js';
import { overlayStore } from '../stores/overlay.js';
import { feedbackStore } from '../stores/error.js';
import { routerStore } from '../stores/router.js';

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
  const flowRef = useRef<ConversationFlowHandle>(null);
  const [startedAt] = useState(() => new Date().toISOString());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WfState | undefined>(undefined);

  const effectiveResumeState = inlineResume ?? resumeState;

  const onComplete = (summary: Summary) =>
    routerStore.navigate('summary', { summary });

  const workflow = useWorkflow({ feature, projectDir, config, onComplete, resumeState: effectiveResumeState, selectedSkills: selectedSkillMetas, runId });
  const sidebar = useSidebar(isSmall);
  const tokenUsage = workflowStore.use(s => s.tokenUsage);
  const cancelled = workflowStore.use(s => s.cancelled);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'e') { sidebar.toggle(); return; }
      if (key.ctrl && input === 'd') { flowRef.current?.toggleDiff(); return; }
      if (key.upArrow) { flowRef.current?.scrollUp(); return; }
      if (key.downArrow) { flowRef.current?.scrollDown(); return; }
      if (input === 'G') { flowRef.current?.scrollToBottom(); return; }
    },
    { isActive: !hasOverlay && workflow.inputMode === 'normal' },
  );

  const sidebarTasks = Array.from(workflow.taskMap.values());

  const localRate = (workflow.localCount + workflow.escalatedCount) > 0
    ? (workflow.localCount / (workflow.localCount + workflow.escalatedCount)) * 100
    : 0;

  const costBreakdown = tokenUsage
    ? calculateCostBreakdown({
        tokenUsage,
        totalTasks: workflow.totalTasks,
        escalatedCount: workflow.escalatedCount,
        plannerTool: config.planner.tool,
        implementerProvider: config.implementer.provider,
      })
    : null;

  const showSidebar = sidebar.visible && !isSmall;
  const sidebarWidth = Math.floor(cols * 0.25);
  const contentHeight = Math.max(0, rows - 4);
  const contentWidth = showSidebar ? cols - sidebarWidth : cols;

  const handleResume = () => {
    const saved = loadState(projectDir);
    if (!saved) {
      feedbackStore.setError('No saved state to resume. Press ESC to return home.');
      return;
    }
    setInlineResume(saved);
    setRunId(id => id + 1);
  };

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      <Header feature={feature} startedAt={startedAt} phase={workflow.phase} />

      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && (
          <Sidebar tasks={sidebarTasks} costData={{ localRate, spent: costBreakdown?.totalActualCost ?? 0, saved: costBreakdown?.savingsAmount ?? 0 }} width={sidebarWidth} />
        )}
        {workflow.inputMode === 'review' && workflow.reviewFilePath ? (
          <ReviewView filePath={workflow.reviewFilePath} height={contentHeight} width={contentWidth} />
        ) : (
          <ConversationFlow ref={flowRef} events={workflow.events} height={contentHeight} width={contentWidth} />
        )}
      </Box>

      <CostFooter
        currentTask={workflow.currentTask}
        totalTasks={workflow.totalTasks}
        localRate={localRate}
        estimatedSavings={costBreakdown?.savingsAmount ?? 0}
      />

      <InputBar
        onSubmit={cancelled ? handleResume : workflow.handleInput}
        onSlashCommand={onSlashCommand}
        commands={commands}
        mode={workflow.inputMode}
        hint={resolveInputHint(cancelled, workflow.inputHint, workflow.inputMode)}
        currentScreen="workflow"
        disabled={hasOverlay}
      />
    </Box>
  );
}

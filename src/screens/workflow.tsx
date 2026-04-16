import { Box } from 'ink';
import { appendFileSync } from 'fs';
import type { InputMode, SlashCommandDef, Summary } from '../types.js';
import { Header } from '../components/workflow/header.js';
import { AgentStatusRow } from '../components/workflow/agent-status-row.js';
import { ConfigLine } from '../components/workflow/config-line.js';
import { ConversationFlow } from '../components/conversation-flow/index.js';
import { FeedbackRow } from '../components/input-bar/feedback-row.js';
import { InputBar } from '../components/input-bar/index.js';
import { InputFooter } from '../components/input-bar/input-footer.js';
import { ScreenShell } from '../components/screen-shell.js';
import { ReviewView } from '../components/workflow/review-view.js';
import { Sidebar } from '../components/workflow/sidebar.js';
import { useWorkflow } from '../hooks/use-workflow.js';
import { REVIEW_HINT } from '../core/commands/review-commands.js';
import { terminalSizeStore } from '../stores/terminal-size.js';
import { configStore } from '../stores/config.js';
import { skillsStore } from '../stores/skills.js';
import { overlayStore } from '../stores/overlay.js';
import { routerStore } from '../stores/router.js';
import { workflowStore } from '../stores/workflow.js';
import { reviewStore } from '../stores/review.js';
import { inputHeightStore } from '../stores/input-height.js';

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
  const sessionId = routerStore.use(s => s.screen === 'workflow' ? s.sessionId : undefined);
  const { cols, rows, isSmall } = terminalSizeStore.use(s => s);
  const inputRows = inputHeightStore.use(s => s.rows);

  const onComplete = (summary: Summary) =>
    routerStore.navigate('summary', { summary });

  const workflow = useWorkflow({
    feature,
    projectDir,
    config,
    onComplete,
    initialResumeState: resumeState,
    selectedSkills: selectedSkillMetas,
    sessionId,
  });

  const events = workflowStore.use(s => s.events);
  const cancelled = workflowStore.use(s => s.cancelled);
  const reviewFilePath = reviewStore.use(s => s.filePath);
  const sidebarVisible = workflowStore.use(s => s.sidebarVisible);
  const showSidebar = sidebarVisible && !isSmall;

  const hasWorkflowConfig = workflowStore.use(s =>
    s.events.some(ev => ev.type === 'workflow-config'),
  );

  const sidebarWidth = Math.floor(cols * 0.25);
  // L1=3 (header+agent-status+spacer), L2=0|2 (config-line, dynamic), feedback=1, input=dynamic, footer=1
  const l2 = hasWorkflowConfig ? 2 : 0;
  const contentHeight = Math.max(0, rows - 3 - l2 - 1 - inputRows - 1);
  const contentWidth = showSidebar ? cols - sidebarWidth : cols;

  // DEBUG
  const stdoutRows = process.stdout.rows;
  const stdoutCols = process.stdout.columns;
  appendFileSync('/tmp/scroll-debug.log', `WORKFLOW: storeRows=${rows} stdoutRows=${stdoutRows} cols=${cols} l2=${l2} inputRows=${inputRows} contentHeight=${contentHeight}\n`);

  return (
    <ScreenShell
      header={
        <>
          <Header startedAt={workflow.startedAt} />
          <ConfigLine />
          <AgentStatusRow />
          <Box height={1} flexShrink={0} />
        </>
      }
      footer={
        <>
          <FeedbackRow />
          <InputBar
            onSubmit={cancelled ? workflow.handleResume : workflow.handleInput}
            onSlashCommand={onSlashCommand}
            commands={commands}
            mode={workflow.inputMode}
            hint={resolveInputHint(cancelled, workflow.inputHint, workflow.inputMode)}
            currentScreen="workflow"
            disabled={hasOverlay}
          />
          <InputFooter />
        </>
      }
    >
      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && (
          <Sidebar width={sidebarWidth} />
        )}
        {workflow.inputMode === 'review' && reviewFilePath ? (
          <ReviewView height={contentHeight} width={contentWidth} />
        ) : (
          <ConversationFlow events={events} height={contentHeight} width={contentWidth} />
        )}
      </Box>
    </ScreenShell>
  );
}

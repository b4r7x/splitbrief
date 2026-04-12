import { Box } from 'ink';
import type { InputMode, SlashCommandDef, Summary } from '../types.js';
import { Header } from '../components/workflow/header.js';
import { ConversationFlow } from '../components/conversation-flow/index.js';
import { CostFooter } from '../components/workflow/cost-footer.js';
import { InputBar } from '../components/input-bar/index.js';
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
  const cols = terminalSizeStore.use(s => s.cols);
  const rows = terminalSizeStore.use(s => s.rows);
  const isSmall = terminalSizeStore.use(s => s.isSmall);

  const onComplete = (summary: Summary) =>
    routerStore.navigate('summary', { summary });

  const workflow = useWorkflow({
    feature,
    projectDir,
    config,
    onComplete,
    initialResumeState: resumeState,
    selectedSkills: selectedSkillMetas,
  });

  const events = workflowStore.use(s => s.events);
  const cancelled = workflowStore.use(s => s.cancelled);
  const reviewFilePath = reviewStore.use(s => s.filePath);
  const sidebarVisible = workflowStore.use(s => s.sidebarVisible);
  const showSidebar = sidebarVisible && !isSmall;

  const sidebarWidth = Math.floor(cols * 0.25);
  const contentHeight = Math.max(0, rows - 4);
  const contentWidth = showSidebar ? cols - sidebarWidth : cols;

  return (
    <ScreenShell
      header={<Header startedAt={workflow.startedAt} />}
      footer={
        <>
          <CostFooter />
          <InputBar
            onSubmit={cancelled ? workflow.handleResume : workflow.handleInput}
            onSlashCommand={onSlashCommand}
            commands={commands}
            mode={workflow.inputMode}
            hint={resolveInputHint(cancelled, workflow.inputHint, workflow.inputMode)}
            currentScreen="workflow"
            disabled={hasOverlay}
          />
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

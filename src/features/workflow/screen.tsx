import { Box } from 'ink';
import type { InputMode, SlashCommandDef, Summary } from '../../types.js';
import { Header } from './components/header.js';
import { AgentStatusRow } from './components/agent-status-row.js';
import { ConfigLine } from './components/config-line.js';
import { ConversationFlow } from './components/conversation-flow/flow.js';
import { FeedbackRow } from '../../components/input-bar/feedback-row.js';
import { InputBar } from '../../components/input-bar/index.js';
import { InputFooter } from '../../components/input-bar/input-footer.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { ReviewView } from './components/review-view.js';
import { Sidebar } from './components/sidebar.js';
import { useWorkflow } from './hooks/use-workflow.js';
import { useWorkflowKeys } from './hooks/use-workflow-keys.js';
import { REVIEW_HINT } from '../../core/slash-commands/review-commands.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { configStore } from '../../stores/project/config.js';
import { skillsStore } from '../../stores/project/skills.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { useSections } from '../../stores/workflow/actions.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { useStores } from '../../stores/use-stores.js';
import {
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from '../../core/layout/workflow-rect.js';

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
  useWorkflowKeys();
  const [configState, skills, input, terminal] = useStores(
    configStore,
    skillsStore,
    inputHeightStore,
    terminalSizeStore,
  );
  const { config, projectDir } = configState;
  if (!config) throw new Error('configStore.load must be called before rendering');
  const selectedSkillMetas = skills.available.filter(m => skills.selected.has(m.id));
  const hasOverlay = overlayStore.use(s => s.active !== 'none');
  const feature = routerStore.use(s => s.screen === 'workflow' ? s.feature : '');
  const resumeState = routerStore.use(s => s.screen === 'workflow' ? s.resumeState : undefined);
  const sessionId = routerStore.use(s => s.screen === 'workflow' ? s.sessionId : undefined);
  const { cols, rows, isSmall } = terminal;
  const inputRows = input.rows;

  const onComplete = (summary: Summary) =>
    routerStore.navigate({ to: 'summary', summary });

  const workflow = useWorkflow({
    feature,
    projectDir,
    config,
    onComplete,
    initialResumeState: resumeState,
    selectedSkills: selectedSkillMetas,
    sessionId,
  });

  const [{ cancelled }, { filePath: reviewFilePath }] = useStores(lifecycleStore, reviewStore);
  const sections = useSections();
  const sidebarVisible = controlsStore.use(s => s.sidebarVisible);

  const hasConfig = eventsStore.use(s => hasWorkflowConfig(s.events));

  const sidebarWidth = getWorkflowSidebarWidth(cols, sidebarVisible, isSmall);
  const showSidebar = sidebarWidth > 0;
  const contentHeight = getWorkflowViewportHeight(rows, inputRows, hasConfig);
  const contentWidth = getWorkflowContentWidth(cols, sidebarVisible, isSmall);

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
          <ConversationFlow sections={sections} height={contentHeight} width={contentWidth} />
        )}
      </Box>
    </ScreenShell>
  );
}

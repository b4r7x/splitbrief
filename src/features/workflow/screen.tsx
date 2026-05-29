import { useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Summary } from '../../core/schemas/summary.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { ApprovalPrompt } from './components/approval-prompt.js';
import { CostApprovalPromptConnected } from './components/cost-approval-prompt.js';
import { ReadinessPanel } from './components/readiness-panel.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { WorkflowBody } from './components/workflow-body.js';
import { WorkflowFooter, WorkflowHeader } from './components/workflow-chrome.js';
import { useInputMode } from './hooks/use-input-mode.js';
import { useWorkflowRunner } from './hooks/use-workflow-runner.js';
import { useIpcClient } from './hooks/use-ipc-client.js';
import { useIpcPromptDispatcher } from './hooks/use-ipc-prompt-dispatcher.js';
import { useReadinessFetch } from './hooks/use-readiness-fetch.js';
import { useWorkflowKeys } from './hooks/use-workflow-keys.js';
import { createReviewInputHandler } from './review-parser.js';
import { resolveAttachInputHint, resolveInputHint } from './input-hints.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { configStore } from '../../stores/project/config.js';
import { skillsStore } from '../../stores/project/skills.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { addEvent, resetWorkflow, useSections } from '../../stores/workflow/actions.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { planEditorStore } from '../../stores/workflow/plan-editor.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { approvalPromptStore } from '../../stores/approval-prompt/store.js';
import { costApprovalStore } from '../../stores/cost-approval/store.js';
import { useStores } from '../../stores/use-stores.js';
import {
  clampWorkflowPromptRows,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from './layout/workflow-rect.js';
import { getApprovalPromptRows, getCostApprovalPromptRows } from './prompt-rows.js';

interface WorkflowScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
}

export function WorkflowScreen({ commands, onRuntimeCommand }: WorkflowScreenProps) {
  const { exit } = useApp();
  const config = configStore.useConfig();
  const projectDir = configStore.use((s) => s.projectDir);
  const [skills, input, terminal] = useStores(skillsStore, inputHeightStore, terminalSizeStore);
  const selectedSkillMetas = skills.available.filter((m) => skills.selected.has(m.id));
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const feature = routerStore.use((s) => (s.screen === 'workflow' ? s.feature : ''));
  const plannerContext = routerStore.use((s) =>
    s.screen === 'workflow' ? s.plannerContext : undefined,
  );
  const resumeState = routerStore.use((s) => (s.screen === 'workflow' ? s.resumeState : undefined));
  const sessionId = routerStore.use((s) => (s.screen === 'workflow' ? s.sessionId : undefined));
  const routeReadiness = routerStore.use((s) =>
    s.screen === 'workflow' ? s.readiness : undefined,
  );
  const attach = routerStore.use((s) => (s.screen === 'workflow' ? s.attach : undefined));
  const isAttachedClient = attach !== undefined;
  const readiness = useReadinessFetch({ isAttachedClient, routeReadiness, projectDir, config });
  const readinessLoaded = isAttachedClient || readiness !== undefined;
  const readinessBlocked = !isAttachedClient && readiness?.status === 'blocked';
  const { cols, rows, isSmall } = terminal;
  const inputRows = input.rows;

  const onComplete = (summary: Summary) =>
    routerStore.navigate({ to: 'summary', summary, sessionId });

  const inputMode = useInputMode();
  const runner = useWorkflowRunner({
    feature,
    plannerContext,
    projectDir,
    config,
    onComplete,
    initialResumeState: resumeState,
    selectedSkills: selectedSkillMetas,
    sessionId,
    inputMode,
    enabled: !isAttachedClient && readinessLoaded && !readinessBlocked,
  });
  const review = createReviewInputHandler(inputMode);
  const handleIpcPrompt = useIpcPromptDispatcher(inputMode);
  const [ipcState, ipcActions] = useIpcClient({
    sockPath: attach?.sockPath ?? '',
    enabled: isAttachedClient,
    onEvent: addEvent,
    onPromptRequest: handleIpcPrompt,
  });

  const [{ cancelled, phase }, { filePath: reviewFilePath }] = useStores(
    lifecycleStore,
    reviewStore,
  );
  const sections = useSections();
  const sidebarVisible = controlsStore.use((s) => s.sidebarVisible);

  const hasConfig = eventsStore.use((s) => hasWorkflowConfig(s.events));
  const approvalPromptState = approvalPromptStore.use((s) => s);
  const costApprovalState = costApprovalStore.use((s) => s);

  const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible, isSmall });
  const showSidebar = sidebarWidth > 0;
  const approvalRows = getApprovalPromptRows(approvalPromptState, cols);
  const costRows = getCostApprovalPromptRows(costApprovalState, cols);
  const promptRows = clampWorkflowPromptRows(
    rows,
    inputRows,
    hasConfig,
    approvalRows + costRows,
    cols,
  );
  const approvalPromptRows = Math.min(approvalRows, promptRows);
  const costPromptRows = Math.min(costRows, Math.max(0, promptRows - approvalPromptRows));
  const contentHeight = getWorkflowViewportHeight(rows, inputRows, hasConfig, promptRows, cols);
  const contentWidth = getWorkflowContentWidth({ cols, sidebarVisible, isSmall });

  const briefReview = config.workflow.briefReview ?? 'simple';
  const runtimeRichMode = planEditorStore.use((s) => s.runtimeRichMode);
  const useRichEditor = briefReview === 'rich' || runtimeRichMode;

  const useRichEditorActive = phase === 'reviewing-briefs' && useRichEditor;
  useWorkflowKeys(!useRichEditorActive);

  useEffect(() => {
    if (!isAttachedClient) return;
    resetWorkflow();
    conversationScrollStore.reset();
  }, [isAttachedClient, attach?.sockPath]);

  useInput(
    (input, key) => {
      if (!(key.ctrl && input === 'd')) return;
      ipcActions.detach();
      exit();
    },
    { isActive: isAttachedClient && !hasOverlay },
  );

  const handleInput = isAttachedClient
    ? (text: string) => {
        if (ipcState.status !== 'connected') {
          feedbackStore.setError('Cannot send input: not connected to server.');
          return;
        }
        ipcActions.sendUserInput(text);
      }
    : cancelled
      ? runner.handleResume
      : review.handleInput;

  const inputHint = isAttachedClient
    ? resolveAttachInputHint(ipcState.status)
    : resolveInputHint({
        cancelled,
        inputHint: inputMode.hint,
        inputMode: inputMode.mode,
        phase,
      });

  if (!isAttachedClient && !readinessLoaded) {
    return (
      <ScreenShell justifyContent="center" alignItems="center">
        <Text>Checking run readiness...</Text>
      </ScreenShell>
    );
  }

  if (!isAttachedClient && readinessBlocked && readiness !== undefined) {
    return <ReadinessPanel report={readiness} />;
  }

  return (
    <ScreenShell
      header={<WorkflowHeader startedAt={runner.startedAt} />}
      footer={
        <WorkflowFooter
          handleInput={handleInput}
          onRuntimeCommand={onRuntimeCommand}
          commands={commands}
          mode={inputMode.mode}
          inputHint={inputHint}
          disabled={hasOverlay || (isAttachedClient && ipcState.status !== 'connected')}
        />
      }
    >
      <WorkflowBody
        showSidebar={showSidebar}
        sidebarWidth={sidebarWidth}
        inputMode={inputMode}
        reviewFilePath={reviewFilePath}
        phase={phase}
        useRichEditor={useRichEditor}
        contentHeight={contentHeight}
        contentWidth={contentWidth}
        sections={sections}
      />
      <Box height={promptRows} overflow="hidden" flexDirection="column" flexShrink={0}>
        {approvalPromptRows > 0 && <ApprovalPrompt />}
        {costPromptRows > 0 && <CostApprovalPromptConnected />}
      </Box>
    </ScreenShell>
  );
}

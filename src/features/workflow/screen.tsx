import { useEffect, useRef } from 'react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { isResumable } from '../../core/phases.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { createStartReadinessRecord } from '../../core/readiness/format.js';
import { READINESS_FILE, sessionDir } from '../../core/paths.js';
import { writeSecureFile } from '../../lib/fs.js';
import { loadState } from '../../core/state/persistence.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { ApprovalPrompt } from './components/approval-prompt.js';
import { CostApprovalPromptConnected } from './components/cost-approval-prompt.js';
import { ReadinessPanel } from './components/readiness-panel.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { WorkflowBody } from './components/body.js';
import { WorkflowFooter, WorkflowHeader } from './components/chrome.js';
import { useInputMode } from './hooks/use-input-mode.js';
import { useWorkflowRunner, type WorkflowCompletion } from './hooks/use-runner.js';
import { useIpcClient } from './hooks/use-ipc-client.js';
import { createIpcPromptDispatcher } from './ipc-prompt-dispatcher.js';
import { useReadinessFetch } from './hooks/use-readiness-fetch.js';
import { useWorkflowKeys } from './hooks/use-keys.js';
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
import { approvalPromptStore } from '../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../stores/cost-approval/prompt.js';
import { useStores } from '../../stores/use-stores.js';
import {
  clampWorkflowPromptRows,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from './layout/rect.js';
import { getApprovalPromptRows, getCostApprovalPromptRows } from './prompt-rows.js';

interface WorkflowScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
}

function persistTuiReadiness(projectDir: string, report: ReadinessReport): void {
  const sessionId = readActive(projectDir);
  if (!sessionId) return;
  const target = join(sessionDir(projectDir, sessionId), READINESS_FILE);
  if (existsSync(target)) return;
  writeSecureFile(target, JSON.stringify(createStartReadinessRecord(report), null, 2) + '\n');
}

function hasLoadedResumableStateForSession({
  projectDir,
  sessionId,
  routeSessionId,
  routeResumeState,
}: {
  projectDir: string;
  sessionId: string;
  routeSessionId?: string | undefined;
  routeResumeState?: WorkflowState | undefined;
}): boolean {
  if (routeSessionId === sessionId && routeResumeState && isResumable(routeResumeState)) {
    return true;
  }

  try {
    const state = loadState({ projectDir, sessionId });
    return state ? isResumable(state) : false;
  } catch {
    return false;
  }
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

  const onComplete = ({ summary, sessionId, status }: WorkflowCompletion) =>
    routerStore.navigate({ to: 'summary', summary, sessionId, status });

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
  const handleIpcPrompt = createIpcPromptDispatcher(inputMode, {
    sessionDirPath: sessionId === undefined ? undefined : sessionDir(projectDir, sessionId),
  });
  const [ipcState, ipcActions] = useIpcClient({
    sockPath: attach?.sockPath ?? '',
    authToken: attach?.authToken ?? '',
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
  const promptPending =
    approvalPromptState.status === 'pending' || costApprovalState.status === 'pending';

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
  const promptBoxRows = promptPending ? Math.max(1, promptRows) : promptRows;
  const contentHeight = getWorkflowViewportHeight(rows, inputRows, hasConfig, promptBoxRows, cols);
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

  // TUI-started workflows (home composer, setup completion) compute readiness client-side and
  // create the session id lazily inside runWorkflow. Persist the report once the session exists
  // (phase has advanced off idle) so review packets find the readiness artifact CLI starts write.
  const readinessPersistedRef = useRef(false);
  useEffect(() => {
    if (isAttachedClient || routeReadiness || readinessPersistedRef.current) return;
    if (phase === 'idle' || !readiness || readiness.status === 'blocked') return;
    readinessPersistedRef.current = true;
    persistTuiReadiness(projectDir, readiness);
  }, [isAttachedClient, routeReadiness, phase, readiness, projectDir]);

  useInput(
    (input, key) => {
      if (!(key.ctrl && input === 'd')) return;
      ipcActions.detach();
      exit();
    },
    { isActive: isAttachedClient && !hasOverlay },
  );

  const currentSessionId = sessionId ?? runner.sessionId;
  const canResumeCancelledSession =
    !isAttachedClient &&
    cancelled &&
    currentSessionId !== undefined &&
    hasLoadedResumableStateForSession({
      projectDir,
      sessionId: currentSessionId,
      routeSessionId: sessionId,
      routeResumeState: resumeState,
    });

  const handleInput = isAttachedClient
    ? (text: string) => {
        if (ipcState.status !== 'connected') {
          feedbackStore.setError('Cannot send input: not connected to server.');
          return;
        }
        if (inputMode.mode !== 'normal') {
          void review.handleInput(text);
          return;
        }
        ipcActions.sendUserInput(text);
      }
    : cancelled
      ? canResumeCancelledSession
        ? runner.handleResume
        : () => {}
      : review.handleInput;

  const handleRuntimeCommand = isAttachedClient
    ? (command: string) => {
        if (command.trim().toLowerCase() === '/queue clear') {
          if (ipcState.status !== 'connected') {
            feedbackStore.setError('Cannot clear queue: not connected to server.');
            return;
          }
          ipcActions.clearQueue();
          feedbackStore.setMessage('Queue clear requested');
          return;
        }
        onRuntimeCommand(command);
      }
    : onRuntimeCommand;

  const inputHint = isAttachedClient
    ? resolveAttachInputHint(ipcState.status)
    : resolveInputHint({
        cancelled,
        canResumeCancelled: canResumeCancelledSession,
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
          onEmptySubmit={canResumeCancelledSession ? runner.handleResume : undefined}
          onRuntimeCommand={handleRuntimeCommand}
          commands={commands}
          mode={inputMode.mode}
          inputHint={inputHint}
          disabled={
            hasOverlay ||
            promptPending ||
            useRichEditorActive ||
            (isAttachedClient && ipcState.status !== 'connected')
          }
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
      <Box height={promptBoxRows} overflow="hidden" flexDirection="column" flexShrink={0}>
        {approvalPromptState.status === 'pending' && <ApprovalPrompt />}
        {costApprovalState.status === 'pending' && <CostApprovalPromptConnected />}
      </Box>
    </ScreenShell>
  );
}

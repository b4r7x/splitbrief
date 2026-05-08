import { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { dirname } from 'node:path';
import type { Summary } from '../../core/schemas/summary.js';
import type { InputMode } from '../../stores/navigation/router.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { ApprovalPrompt } from './components/approval-prompt.js';
import { CostApprovalPromptConnected } from './components/cost-approval-prompt.js';
import { ReadinessPanel } from './components/readiness-panel.js';
import { openApprovalPrompt } from '../../stores/approval-prompt/actions.js';
import { Header } from './components/header.js';
import { AgentStatusRow } from './components/agent-status-row.js';
import { CostStatusLine } from './components/cost/status-line.js';
import { ConfigLine } from './components/config-line.js';
import { ConversationFlow } from './components/conversation-flow/flow.js';
import { FeedbackRow } from './components/feedback-row.js';
import { Composer } from '../../components/composer/composer.js';
import { InputFooter } from './components/input-footer.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { ReviewView } from './components/review-view.js';
import { BriefReviewView } from './components/brief-review-view.js';
import { PlanEditorComponent } from './components/plan-editor.js';
import { Sidebar } from './components/sidebar.js';
import { useInputMode } from './hooks/use-input-mode.js';
import { useWorkflowRunner } from './hooks/use-workflow-runner.js';
import { useIpcClient, type IpcClientStatus } from './hooks/use-ipc-client.js';
import type { IpcPromptRequest, IpcPromptResponse } from '../../engine/ipc/protocol.js';
import { useWorkflowKeys } from './hooks/use-workflow-keys.js';
import { REVIEW_HINT, BRIEFS_REVIEW_HINT, createReviewInputHandler } from './review-parser.js';
import { formatUserEditConflictPrompt, parseUserEditConflictAnswer } from './user-edit-conflict-prompt.js';
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
import { buildTargetedRejectionComment } from '../../engine/orchestrator/planning/regen-targeted.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { useStores } from '../../stores/use-stores.js';
import {
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from '../../core/layout/workflow-rect.js';
import { collectReadiness } from '../../core/readiness/collect.js';
import type { ReadinessReport } from '../../core/readiness/types.js';

interface WorkflowScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
}

function resolveInputHint(cancelled: boolean, inputHint: string, inputMode: InputMode, phase: string): string {
  if (cancelled) return 'Enter to resume, ESC for home, /quit to exit';
  if (inputHint) return inputHint;
  if (inputMode === 'review') return phase === 'reviewing-briefs' ? BRIEFS_REVIEW_HINT : REVIEW_HINT;
  return '';
}

function resolveAttachInputHint(status: IpcClientStatus): string {
  if (status === 'connected') return 'queue message to running workflow';
  if (status === 'readonly') return 'attached read-only';
  if (status === 'reconnecting') return 'reconnecting to server...';
  if (status === 'failed') return 'server connection failed';
  if (status === 'detached') return 'detached';
  return 'connecting to server...';
}

export function WorkflowScreen({ commands, onRuntimeCommand }: WorkflowScreenProps) {
  const { exit } = useApp();
  const config = configStore.useConfig();
  const projectDir = configStore.use(s => s.projectDir);
  const [skills, input, terminal] = useStores(
    skillsStore,
    inputHeightStore,
    terminalSizeStore,
  );
  const selectedSkillMetas = skills.available.filter(m => skills.selected.has(m.id));
  const hasOverlay = overlayStore.use(s => s.active !== 'none');
  const feature = routerStore.use(s => s.screen === 'workflow' ? s.feature : '');
  const resumeState = routerStore.use(s => s.screen === 'workflow' ? s.resumeState : undefined);
  const sessionId = routerStore.use(s => s.screen === 'workflow' ? s.sessionId : undefined);
  const routeReadiness = routerStore.use(s => s.screen === 'workflow' ? s.readiness : undefined);
  const attach = routerStore.use(s => s.screen === 'workflow' ? s.attach : undefined);
  const isAttachedClient = attach !== undefined;
  const [computedReadiness, setComputedReadiness] = useState<ReadinessReport | undefined>(routeReadiness);
  const readiness = routeReadiness ?? computedReadiness;
  const readinessLoaded = isAttachedClient || readiness !== undefined;
  const readinessBlocked = !isAttachedClient && readiness?.status === 'blocked';
  const { cols, rows, isSmall } = terminal;
  const inputRows = input.rows;

  const onComplete = (summary: Summary) =>
    routerStore.navigate({ to: 'summary', summary, sessionId });

  const inputMode = useInputMode();
  const runner = useWorkflowRunner({
    feature,
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
  const handleIpcPrompt = async (request: IpcPromptRequest): Promise<IpcPromptResponse> => {
    if (request.kind === 'approval_needed') {
      reviewStore.setReviewFile(request.filePath);
      const hint = request.approvalType === 'briefs' ? BRIEFS_REVIEW_HINT : REVIEW_HINT;
      const result = await inputMode.setReviewMode(hint);
      reviewStore.clearReview();
      return {
        kind: 'approval_needed',
        approved: result.approved,
        ...(result.comment !== undefined && { comment: result.comment }),
        ...(result.action !== undefined && { action: result.action }),
      };
    }

    if (request.kind === 'external_changes') {
      const result = await inputMode.setReviewMode('External changes detected. continue / quit');
      return { kind: 'external_changes', proceed: result.approved };
    }

    if (request.kind === 'user_edit_conflict') {
      const answer = await inputMode.setQuestionMode(formatUserEditConflictPrompt(request.conflict));
      return {
        kind: 'user_edit_conflict',
        selectedAction: parseUserEditConflictAnswer(answer, request.conflict.availableActions),
      };
    }

    if (request.kind === 'question_asked') {
      const answer = await inputMode.setQuestionMode(`Question ${request.num}/${request.total}: ${request.question.text}`);
      return { kind: 'question_asked', answer };
    }

    if (request.kind === 'budget_exceeded') {
      const result = await inputMode.setReviewMode(
        `Budget exceeded: $${request.currentCost.toFixed(2)} of $${request.maxBudget.toFixed(2)}. continue / quit`,
      );
      return { kind: 'budget_exceeded', proceed: result.approved };
    }

    if (request.kind === 'budget_paused') {
      const result = await inputMode.setReviewMode(
        `Budget ${Math.round((request.currentCost / request.maxBudget) * 100)}% reached: ${request.currentCost.toFixed(2)} of ${request.maxBudget.toFixed(2)}. continue / abort`,
      );
      return { kind: 'budget_paused', decision: result.approved ? 'continue' : 'abort' };
    }

    if (request.kind === 'continuation_needed') {
      const text = await inputMode.setQuestionMode('Task interrupted. Enter instructions to continue (or press Enter to retry):');
      return { kind: 'continuation_needed', text };
    }

    const response = await openApprovalPrompt(request.request);
    return { kind: 'tiered_approval', response };
  };
  const [ipcState, ipcActions] = useIpcClient({
    sockPath: attach?.sockPath ?? '',
    enabled: isAttachedClient,
    onEvent: addEvent,
    onPromptRequest: handleIpcPrompt,
  });

  const [{ cancelled, phase }, { filePath: reviewFilePath }] = useStores(lifecycleStore, reviewStore);
  const sections = useSections();
  const sidebarVisible = controlsStore.use(s => s.sidebarVisible);

  const hasConfig = eventsStore.use(s => hasWorkflowConfig(s.events));

  const sidebarWidth = getWorkflowSidebarWidth(cols, sidebarVisible, isSmall);
  const showSidebar = sidebarWidth > 0;
  const contentHeight = getWorkflowViewportHeight(rows, inputRows, hasConfig);
  const contentWidth = getWorkflowContentWidth(cols, sidebarVisible, isSmall);

  const briefReview = config.workflow.briefReview ?? 'simple';
  const runtimeRichMode = planEditorStore.use(s => s.runtimeRichMode);
  const useRichEditor = briefReview === 'rich' || runtimeRichMode;

  const useRichEditorActive = phase === 'reviewing-briefs' && useRichEditor;
  useWorkflowKeys(!useRichEditorActive);

  useEffect(() => {
    if (!isAttachedClient) return;
    resetWorkflow();
    conversationScrollStore.reset();
  }, [isAttachedClient, attach?.sockPath]);

  useEffect(() => {
    if (isAttachedClient || routeReadiness || !projectDir) return undefined;
    let cancelled = false;
    collectReadiness({ projectDir, config })
      .then(({ report }) => {
        if (!cancelled) setComputedReadiness(report);
      })
      .catch((err) => {
        if (!cancelled) feedbackStore.setError(`Readiness check failed: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [isAttachedClient, routeReadiness, projectDir, config]);

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
    : cancelled ? runner.handleResume : review.handleInput;

  const inputHint = isAttachedClient
    ? resolveAttachInputHint(ipcState.status)
    : resolveInputHint(cancelled, inputMode.hint, inputMode.mode, phase);

  if (!isAttachedClient && !readinessLoaded) {
    return (
      <ScreenShell justifyContent="center" alignItems="center">
        <Text>Checking run readiness...</Text>
      </ScreenShell>
    );
  }

  if (!isAttachedClient && readinessBlocked && readiness !== undefined) {
    return (
      <ReadinessPanel
        report={readiness}
      />
    );
  }

  return (
    <ScreenShell
      header={
        <>
          <Header startedAt={runner.startedAt} />
          <ConfigLine />
          <AgentStatusRow />
          <CostStatusLine />
          <Box height={1} flexShrink={0} />
        </>
      }
      footer={
        <>
          <FeedbackRow />
          <Composer
            onSubmit={handleInput}
            onRuntimeCommand={onRuntimeCommand}
            commands={commands}
            mode={inputMode.mode}
            hint={inputHint}
            currentScreen="workflow"
            disabled={hasOverlay || (isAttachedClient && ipcState.status !== 'connected')}
          />
          <InputFooter />
        </>
      }
    >
      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && (
          <Sidebar width={sidebarWidth} />
        )}
        {inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' && useRichEditor ? (
          <PlanEditorComponent
            filePath={reviewFilePath}
            height={contentHeight}
            width={contentWidth}
            sessionDirPath={dirname(reviewFilePath)}
            onApprove={() => inputMode.resolve({ approved: true })}
            onRegenerateFlagged={async () => {
              const flagged = planEditorStore.getFlaggedTasks();
              if (flagged.length === 0) return;
              const comment = buildTargetedRejectionComment(flagged);
              planEditorStore.clearFlags();
              inputMode.resolve({ approved: true, comment });
            }}
          />
        ) : inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' ? (
          <BriefReviewView filePath={reviewFilePath} height={contentHeight} width={contentWidth} />
        ) : inputMode.mode === 'review' && reviewFilePath ? (
          <ReviewView height={contentHeight} width={contentWidth} />
        ) : (
          <ConversationFlow sections={sections} height={contentHeight} width={contentWidth} />
        )}
      </Box>
      <ApprovalPrompt />
      <CostApprovalPromptConnected />
    </ScreenShell>
  );
}

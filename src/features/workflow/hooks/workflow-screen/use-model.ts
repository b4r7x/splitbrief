import { sessionDir } from '../../../../core/paths.js';
import type { CopyResult, CopyTarget } from '../../../../core/runtime/commands/types.js';
import type { Focus } from '../../../../stores/ui/focus.js';
import { useInputMode } from '../use-input-mode.js';
import { useWorkflowRunner, type RunWorkflowFn, type WorkflowCompletion } from '../use-runner.js';
import { createReviewInputHandler } from '../../review-parser.js';
import { useWorkflowKeys } from '../use-keys.js';
import { useBriefReviewKeys } from '../use-brief-review-keys.js';
import {
  resolveAttachBoxHint,
  resolveAttachFeedbackHint,
  resolveAttachInputHint,
  resolveCancelledHints,
  resolveInputHint,
} from '../../input-hints.js';
import { configStore } from '../../../../stores/project/config.js';
import { skillsStore } from '../../../../stores/project/skills.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { approvalPromptStore } from '../../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../../stores/cost-approval/prompt.js';
import { useStores } from '../../../../stores/use-stores.js';
import { type CollectReadinessFn, useWorkflowReadiness } from './use-readiness.js';
import { useWorkflowAttachment } from './use-attachment.js';
import { useWorkflowInlineEdit } from './use-inline-edit.js';
import { canResumeCancelledWorkflow } from './resume.js';

export interface WorkflowScreenDeps {
  runWorkflow?: RunWorkflowFn | undefined;
  collectReadiness?: CollectReadinessFn | undefined;
}

interface UseWorkflowScreenOptions {
  onRuntimeCommand: (command: string) => void;
  copyTarget?: ((target: CopyTarget) => Promise<CopyResult>) | undefined;
  canCopyFocused?: ((focus: Focus | null) => boolean) | undefined;
  deps?: WorkflowScreenDeps | undefined;
}

export function useWorkflowScreen({
  onRuntimeCommand,
  copyTarget,
  canCopyFocused,
  deps,
}: UseWorkflowScreenOptions) {
  const config = configStore.useConfig();
  const projectDir = configStore.use((s) => s.projectDir);
  const [skills] = useStores(skillsStore);
  const selectedSkillMetas = skills.available.filter((m) => skills.selected.has(m.id));
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const onWorkflowScreen = routerStore.use((s) => s.screen === 'workflow');
  const feature = routerStore.use((s) => (s.screen === 'workflow' ? s.feature : ''));
  const plannerContext = routerStore.use((s) =>
    s.screen === 'workflow' ? s.plannerContext : undefined,
  );
  const resumeState = routerStore.use((s) => (s.screen === 'workflow' ? s.resumeState : undefined));
  const sessionId = routerStore.use((s) => (s.screen === 'workflow' ? s.sessionId : undefined));
  const allowRepoRunners = routerStore.use((s) =>
    s.screen === 'workflow' ? s.allowRepoRunners : undefined,
  );
  const routeReadiness = routerStore.use((s) =>
    s.screen === 'workflow' ? s.readiness : undefined,
  );
  const attach = routerStore.use((s) => (s.screen === 'workflow' ? s.attach : undefined));

  const inputMode = useInputMode();
  const review = createReviewInputHandler(inputMode);

  const attachment = useWorkflowAttachment({
    attach,
    projectDir,
    sessionId,
    inputMode,
    review,
    onRuntimeCommand,
    hasOverlay,
  });
  const { isAttachedClient, ipcStatus, handleAttachedInput, handleAttachedRuntimeCommand } =
    attachment;

  const [{ cancelled, phase }, { filePath: reviewFilePath }] = useStores(
    lifecycleStore,
    reviewStore,
  );

  const { readiness, readinessLoaded, readinessBlocked } = useWorkflowReadiness({
    isAttachedClient,
    routeReadiness,
    projectDir,
    config,
    phase,
    collectReadiness: deps?.collectReadiness,
  });

  const onComplete = ({ summary, sessionId: completedSessionId, status }: WorkflowCompletion) =>
    routerStore.navigate({ to: 'summary', summary, sessionId: completedSessionId, status });

  const runner = useWorkflowRunner({
    feature,
    plannerContext,
    projectDir,
    config,
    onComplete,
    initialResumeState: resumeState,
    selectedSkills: selectedSkillMetas,
    sessionId,
    allowRepoRunners: allowRepoRunners ?? false,
    inputMode,
    // Stop the runner as soon as the route leaves workflow. Otherwise a still-mounted
    // WorkflowScreen (tests, or any delayed unmount) sees feature collapse to '' and
    // restarts with a fresh `…-unknown` session id that overwrites the summary route.
    enabled: onWorkflowScreen && !isAttachedClient && readinessLoaded && !readinessBlocked,
    runWorkflow: deps?.runWorkflow,
  });

  const approvalPromptState = approvalPromptStore.use((s) => s);
  const costApprovalState = costApprovalStore.use((s) => s);
  const approvalPending = approvalPromptState.status === 'pending';
  const costPending = costApprovalState.status === 'pending';
  const promptPending = approvalPending || costPending;

  const activeSessionId = sessionId ?? runner.sessionId;
  const sessionDirPath =
    activeSessionId === undefined ? undefined : sessionDir(projectDir, activeSessionId);

  const { fieldSessionOwned } = useWorkflowInlineEdit({
    promptPending,
    projectDir,
    activeSessionId,
    inputMode,
    sessionDirPath,
  });

  const globalKeysActive = !promptPending && !fieldSessionOwned;
  useWorkflowKeys({ isActive: globalKeysActive });
  useBriefReviewKeys({
    isActive: globalKeysActive,
    copyTarget,
    canCopyFocused,
  });

  const canResumeCancelledSession = canResumeCancelledWorkflow({
    isAttachedClient,
    cancelled,
    projectDir,
    sessionId,
    runnerSessionId: runner.sessionId,
    routeSessionId: sessionId,
    routeResumeState: resumeState,
  });

  const handleInput = isAttachedClient
    ? handleAttachedInput
    : cancelled
      ? canResumeCancelledSession
        ? runner.handleResume
        : () => {}
      : review.handleInput;

  const handleRuntimeCommand = isAttachedClient ? handleAttachedRuntimeCommand : onRuntimeCommand;

  const attachedNormal = isAttachedClient && inputMode.mode === 'normal';
  const cancelledHints =
    !isAttachedClient && cancelled ? resolveCancelledHints(canResumeCancelledSession) : null;
  const inputHint = attachedNormal
    ? ipcStatus === 'connected'
      ? resolveAttachInputHint(ipcStatus)
      : '…'
    : cancelledHints
      ? cancelledHints.placeholder
      : resolveInputHint({
          inputHint: inputMode.hint,
          inputMode: inputMode.mode,
          phase,
        });
  const feedbackHint = attachedNormal
    ? resolveAttachFeedbackHint(ipcStatus)
    : cancelledHints
      ? ''
      : inputHint;
  const boxHintOverride = cancelledHints
    ? { keys: cancelledHints.byline, cost: false }
    : attachedNormal
      ? resolveAttachBoxHint(ipcStatus)
      : undefined;

  const fixCommand = readiness?.nextAction.command;
  const onOpenReadinessFix = fixCommand?.startsWith('/')
    ? () => onRuntimeCommand(fixCommand)
    : undefined;

  return {
    readiness,
    readinessLoaded,
    readinessBlocked,
    isAttachedClient,
    hasOverlay,
    onOpenReadinessFix,
    phase,
    cancelled,
    inputMode,
    reviewFilePath,
    approvalPromptState,
    costApprovalState,
    approvalPending,
    costPending,
    promptPending,
    startedAt: runner.startedAt,
    handleInput,
    handleRuntimeCommand,
    onEmptySubmit: canResumeCancelledSession ? runner.handleResume : undefined,
    onEditShortcut: undefined,
    inputHint,
    feedbackHint,
    boxHintOverride,
    questionEpoch: inputMode.questionEpoch,
    ipcConnected: ipcStatus === 'connected',
  };
}

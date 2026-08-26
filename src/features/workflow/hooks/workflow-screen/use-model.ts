import { useEffect, useState } from 'react';
import { dirname } from 'node:path';
import { sessionDir } from '../../../../core/paths.js';
import type { BriefRecoveryProjectionV1 } from '../../../../core/schemas/brief-recovery/document.js';
import type { Phase } from '../../../../core/schemas/enums.js';
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
import { useWorkflowAttachment } from './use-attachment.js';
import { useWorkflowInlineEdit } from './use-inline-edit.js';
import { canResumeCancelledWorkflow } from './resume.js';
import { loadBriefReviewData } from '../../brief-review-loader.js';

export interface WorkflowScreenDeps {
  runWorkflow?: RunWorkflowFn | undefined;
  recovery?: BriefRecoveryProjectionV1 | null | undefined;
}

interface UseWorkflowScreenOptions {
  onRuntimeCommand: (command: string) => void;
  copyTarget?: ((target: CopyTarget) => Promise<CopyResult>) | undefined;
  canCopyFocused?: ((focus: Focus | null) => boolean) | undefined;
  deps?: WorkflowScreenDeps | undefined;
}

function usePersistedBriefRecovery(
  filePath: string | null,
  phase: Phase,
  ownerToken: number,
  injectedRecovery?: BriefRecoveryProjectionV1 | null,
): BriefRecoveryProjectionV1 | null | undefined {
  const [recovery, setRecovery] = useState<BriefRecoveryProjectionV1 | null | undefined>(undefined);

  useEffect(() => {
    if (filePath === null || phase !== 'reviewing-briefs') {
      setRecovery(undefined);
      return;
    }
    if (injectedRecovery !== undefined) {
      setRecovery(injectedRecovery);
      return;
    }

    const controller = new AbortController();
    loadBriefReviewData({
      filePath,
      sessionDirPath: dirname(filePath),
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setRecovery(result.recovery);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRecovery(null);
      });

    return () => controller.abort();
  }, [filePath, phase, ownerToken, injectedRecovery]);

  return recovery;
}

export function useWorkflowScreen({
  onRuntimeCommand,
  copyTarget,
  canCopyFocused,
  deps,
}: UseWorkflowScreenOptions) {
  const configuredProjectDir = configStore.use((s) => s.projectDir);
  const [skills] = useStores(skillsStore);
  const selectedSkillMetas = skills.available.filter((m) => skills.selected.has(m.id));
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const route = routerStore.use((s) => s);
  const execution = route.screen === 'workflow' ? route.execution : undefined;
  const prepared = execution?.kind === 'local' ? execution.prepared : undefined;
  const attached = execution?.kind === 'attached' ? execution : undefined;
  const projectDir = prepared?.session.ref.projectDir ?? configuredProjectDir;
  const sessionId = prepared?.session.ref.sessionId ?? attached?.sessionId;
  const attach = attached?.attach;

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

  const [{ cancelled, phase }, { filePath: reviewFilePath, ownerToken: reviewOwnerToken }] =
    useStores(lifecycleStore, reviewStore);
  const recovery = usePersistedBriefRecovery(
    reviewFilePath,
    phase,
    reviewOwnerToken,
    deps?.recovery,
  );

  const onComplete = ({ summary, sessionId: completedSessionId, status }: WorkflowCompletion) =>
    routerStore.navigate({ to: 'summary', summary, sessionId: completedSessionId, status });

  const runner = useWorkflowRunner({
    prepared,
    onComplete,
    selectedSkills: selectedSkillMetas,
    inputMode,
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
  const navigateBriefReview = useBriefReviewKeys({
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
    routeSessionId: prepared?.session.ref.sessionId,
    routeResumeState: prepared?.runtime.resumeState,
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

  return {
    isAttachedClient,
    hasOverlay,
    phase: phase,
    cancelled,
    inputMode,
    reviewFilePath,
    recovery,
    approvalPromptState,
    costApprovalState,
    approvalPending,
    costPending,
    promptPending,
    navigateBriefReview,
    startedAt: runner.startedAt,
    handleInput,
    handleRuntimeCommand,
    onEmptySubmit: canResumeCancelledSession ? runner.handleResume : undefined,
    inputHint,
    feedbackHint,
    boxHintOverride,
    questionEpoch: inputMode.questionEpoch,
    ipcConnected: ipcStatus === 'connected',
  };
}

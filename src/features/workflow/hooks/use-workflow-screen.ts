import { useEffect, useRef } from 'react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { useApp, useInput } from 'ink';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { isResumable } from '../../../core/phases.js';
import { readActive } from '../../../core/sessions/lifecycle.js';
import { createStartReadinessRecord } from '../../../core/readiness/format.js';
import { READINESS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSecureFile } from '../../../lib/fs.js';
import { loadState } from '../../../core/state/persistence.js';
import type { CopyResult, CopyTarget } from '../../../core/runtime/commands/types.js';
import type { Focus } from '../../../stores/ui/focus.js';
import { useInputMode } from './use-input-mode.js';
import { useWorkflowRunner, type RunWorkflowFn, type WorkflowCompletion } from './use-runner.js';
import { useIpcClient } from './use-ipc-client.js';
import { createIpcPromptDispatcher } from '../ipc-prompt-dispatcher.js';
import { type CollectReadinessFn, useReadinessFetch } from './use-readiness-fetch.js';
import { useWorkflowKeys } from './use-keys.js';
import { useBriefReviewKeys } from './use-brief-review-keys.js';
import { createReviewInputHandler } from '../review-parser.js';
import {
  resolveAttachBoxHint,
  resolveAttachFeedbackHint,
  resolveAttachInputHint,
  resolveCancelledHints,
  resolveInputHint,
} from '../input-hints.js';
import { configStore } from '../../../stores/project/config.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../stores/cost-approval/prompt.js';
import { useStores } from '../../../stores/use-stores.js';
import { addTuiEvent } from '../tui-sink.js';

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

export function useWorkflowScreen({
  onRuntimeCommand,
  copyTarget,
  canCopyFocused,
  deps,
}: UseWorkflowScreenOptions) {
  const { exit } = useApp();
  const config = configStore.useConfig();
  const projectDir = configStore.use((s) => s.projectDir);
  const [skills] = useStores(skillsStore);
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
  const readiness = useReadinessFetch({
    isAttachedClient,
    routeReadiness,
    projectDir,
    config,
    collectReadiness: deps?.collectReadiness,
  });
  const readinessLoaded = isAttachedClient || readiness !== undefined;
  const readinessBlocked = !isAttachedClient && readiness?.status === 'blocked';

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
    runWorkflow: deps?.runWorkflow,
  });
  const review = createReviewInputHandler(inputMode);
  const handleIpcPrompt = createIpcPromptDispatcher(inputMode, {
    sessionDirPath: sessionId === undefined ? undefined : sessionDir(projectDir, sessionId),
  });
  const [ipcState, ipcActions] = useIpcClient({
    sockPath: attach?.sockPath ?? '',
    authToken: attach?.authToken ?? '',
    enabled: isAttachedClient,
    onEvent: (event) =>
      addTuiEvent(event, {
        persistTranscript: config.workflow.persistTranscript,
      }),
    onPromptRequest: handleIpcPrompt,
  });

  const [{ cancelled, phase }, { filePath: reviewFilePath }] = useStores(
    lifecycleStore,
    reviewStore,
  );

  const approvalPromptState = approvalPromptStore.use((s) => s);
  const costApprovalState = costApprovalStore.use((s) => s);
  const approvalPending = approvalPromptState.status === 'pending';
  const costPending = costApprovalState.status === 'pending';
  const promptPending = approvalPending || costPending;

  useWorkflowKeys({ isActive: !promptPending });
  useBriefReviewKeys({
    isActive: !promptPending,
    copyTarget,
    canCopyFocused,
  });

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

  const reviewEditShortcutActive =
    inputMode.mode === 'review' &&
    reviewFilePath !== null &&
    (phase === 'reviewing-spec' || phase === 'reviewing-plan' || phase === 'reviewing-briefs');
  const handleReviewEditShortcut = reviewEditShortcutActive
    ? () => {
        void review.handleInput('edit');
      }
    : undefined;

  const attachedNormal = isAttachedClient && inputMode.mode === 'normal';
  const cancelledHints =
    !isAttachedClient && cancelled ? resolveCancelledHints(canResumeCancelledSession) : null;
  const inputHint = attachedNormal
    ? ipcState.status === 'connected'
      ? resolveAttachInputHint(ipcState.status)
      : '…'
    : cancelledHints
      ? cancelledHints.placeholder
      : resolveInputHint({
          inputHint: inputMode.hint,
          inputMode: inputMode.mode,
          phase,
        });
  const feedbackHint = attachedNormal
    ? resolveAttachFeedbackHint(ipcState.status)
    : cancelledHints
      ? ''
      : inputHint;
  const boxHintOverride = cancelledHints
    ? { keys: cancelledHints.byline, cost: false }
    : attachedNormal
      ? resolveAttachBoxHint(ipcState.status)
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
    onEditShortcut: handleReviewEditShortcut,
    inputHint,
    feedbackHint,
    boxHintOverride,
    questionEpoch: inputMode.questionEpoch,
    ipcConnected: ipcState.status === 'connected',
  };
}

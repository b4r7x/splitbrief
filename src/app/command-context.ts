import { useRef } from 'react';
import { createRuntimeCommands } from '../core/runtime/commands/registry.js';
import { executeRuntimeCommand } from '../core/runtime/commands/dispatch.js';
import {
  requestClearQueue,
  requestEndRun,
  requestQuit,
  requestResume,
  requestSteer,
} from '../features/workflow/handlers.js';
import {
  findLatestConversationRowAction,
  type ConversationRowAction,
} from '../features/workflow/conversation-rows/row-actions.js';
import { readConversationRowActions } from '../features/workflow/conversation-rows/read-row-actions.js';
import { readConversationScrollSnapshot } from '../features/workflow/layout/snapshot.js';
import { getWorkflowSidebarWidth } from '../features/workflow/layout/rect.js';
import { resolveCopyValue } from '../features/workflow/copy/resolve.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { RunRecord } from '../core/sessions/run-record.js';
import type { SessionRef } from '../core/types/session-ref.js';
import type { Screen } from '../core/navigation/types.js';
import { configStore } from '../stores/project/config.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { composerDraftStore } from '../stores/ui/composer-draft.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { controlsStore } from '../stores/ui/controls.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { isOpenRunAtRest, routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { queueCopy } from '../features/workflow/queue-copy.js';
import { phaseStage } from '../core/rail-stages.js';
import { selectRunningBrief, tasksStore } from '../stores/workflow/tasks.js';
import { projectFilesStore } from '../stores/ui/project-files.js';
import { skillsStore } from '../stores/project/skills.js';
import { refreshSkills } from './refresh-skills.js';
import { attachImage, detachImage, listAttachments } from '../stores/workflow/attachments.js';
import { resolveAttachment } from '../core/attachments/resolve.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { getDefaultDetectionService } from '../engine/detection/service.js';
import { refreshDetectionForCurrentConfig } from '../engine/detection/store-publication.js';
import { detectionStore } from '../stores/project/detection.js';
import { readActive } from '../core/sessions/active-pointer.js';
import type {
  AcceptRunResult,
  AttachImageResult,
  CopyResult,
  CopyTarget,
  QueueClearCommandResult,
  RejectRunResult,
  RuntimeCommandContext,
  ScrollCommandTarget,
  ScrollConversationResult,
  SkillCommandOption,
  SkillToggleResult,
  ToggleLatestActivityBatchResult,
  ToggleLatestDiffResult,
} from '../core/runtime/commands/types.js';
import { plannerSupportsImages } from '../core/runners/capabilities.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { createCommandContext } from '../core/runtime/commands/context-factory.js';
import { copyToClipboard } from '../lib/clipboard/clipboard.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../engine/snapshots/run/lifecycle.js';
import { runApply } from '../engine/orchestrator/apply/run.js';
import { undoApply } from '../engine/orchestrator/apply/restore.js';
import { canUndoApply } from '../core/sessions/run-status.js';
import { createRecoveryBus } from '../engine/orchestrator/recovery/bus.js';
import { closeRunIfOpen } from '../engine/orchestrator/run/close.js';
import { finalizeRunAtRest } from '../engine/orchestrator/session-lifecycle/finalize.js';
import { addTuiEvent } from '../features/workflow/tui-sink.js';
import { readRunRecord } from '../core/sessions/run-record-io.js';
import { writeUiPrefs } from '../core/ui-prefs.js';
import { error } from '../utils/error.js';
import { assertNever } from '../utils/type-guards.js';
import type { RouteData } from '../stores/navigation/router.js';
import { createDraftDocument } from '../core/composer/document.js';
import { prepareDraftSubmission, type DraftSubmission } from '../core/composer/submission.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { formatSubmissionFailure } from '../components/composer/home-hint.js';
import { plainUserMessage } from '../core/types/user-input.js';

export interface ConversationScrollMetrics {
  renderableCount: number;
  totalHeight: number;
  maxOffset: number;
  viewportHeight: number;
}

// Workflow-feature operations the runtime commands need but that the page tree must not
// reach into. `useRuntimeCommands` (below, in this module) wires the real
// `features/workflow/**` implementations into these ports; the page files never see them.
export interface WorkflowCommandPorts {
  requestClearQueue: () => QueueClearCommandResult | Promise<QueueClearCommandResult>;
  getRowActions: () => ReadonlyMap<string, ConversationRowAction>;
  readScrollMetrics: () => ConversationScrollMetrics;
  resolveCopyValue: (target: CopyTarget) => string | null;
}

const appCommandContextError = {
  noActiveSession: (command: string) =>
    error('app-command-no-active-session', `No active session for ${command}`, { command }),
  submissionRefused: (submission: Extract<DraftSubmission, { ok: false }>) =>
    error('app-command-submission-refused', formatSubmissionFailure(submission), submission),
} as const;

function routeSessionId(route: RouteData, projectDir: string): string | null {
  if (route.screen === 'workflow') return route.run.ref.sessionId;
  return readActive(projectDir);
}

function runCommandState(
  record: RunRecord,
):
  | { kind: 'snapshot' }
  | { kind: 'workspace'; state: WorkflowState }
  | { kind: 'unavailable'; message: string } {
  const { hydration } = record;
  if (hydration.kind === 'invalid') {
    return { kind: 'unavailable', message: `Cannot read this run: ${hydration.message}` };
  }
  if (hydration.kind === 'missing') return { kind: 'snapshot' };
  const { state } = hydration;
  return state.workspace !== undefined ? { kind: 'workspace', state } : { kind: 'snapshot' };
}

function isRunAtRest(ref: SessionRef): boolean {
  const route = routerStore.get();
  return (
    route.screen === 'workflow' &&
    route.execution.kind === 'at-rest' &&
    route.run.ref.projectDir === ref.projectDir &&
    route.run.ref.sessionId === ref.sessionId
  );
}

async function acceptRun(
  projectDir: string,
  sessionId: string,
  confirm: boolean,
): Promise<AcceptRunResult> {
  const record = readRunRecord({ projectDir, sessionId });
  const run = runCommandState(record);
  if (run.kind === 'unavailable') return { status: 'unavailable', message: run.message };
  if (run.kind === 'snapshot') {
    return { status: 'snapshot-accepted', ...(await acceptRunSnapshot(projectDir, sessionId)) };
  }
  const { state } = run;
  if (record.status.kind === 'closed') {
    return {
      status: 'unavailable',
      message:
        record.status.as === 'applied'
          ? 'Run already applied.'
          : `Run is closed (${record.status.as}).`,
    };
  }
  if (!isRunAtRest(record.ref) || record.status.kind === 'running') {
    return { status: 'unavailable', message: 'Apply is unavailable while the run is active.' };
  }
  if (state.workspace?.kind !== 'checkout' && record.status.kind !== 'ready-to-apply') {
    return { status: 'unavailable', message: 'Run is not ready to apply.' };
  }
  const config = configStore.get().config;
  if (config === null) {
    return { status: 'unavailable', message: 'Apply requires a project configuration.' };
  }
  const bus = createRecoveryBus({ projectDir, sessionId, sink: addTuiEvent });
  if (state.workspace?.kind === 'checkout') {
    const closure = await closeRunIfOpen({ projectDir, sessionId, bus }, state);
    if (closure.closedNow) {
      finalizeRunAtRest({ ref: record.ref, config, state: closure.state });
      sessionsStore.refresh();
    }
    return { status: 'ended' };
  }
  const result = await runApply({
    wctx: { projectDir, sessionId, bus },
    state,
    overrideConfirmed: confirm,
  });
  if (result.outcome === 'halted') return { status: 'halted' };
  if (result.outcome === 'review') return { status: 'review' };
  if (result.outcome === 'needs-confirmation') return { status: 'confirm-override' };
  finalizeRunAtRest({ ref: record.ref, config, state: result.state });
  sessionsStore.refresh();
  return { status: 'applied', files: result.files };
}

async function rejectRun(projectDir: string, sessionId: string): Promise<RejectRunResult> {
  const record = readRunRecord({ projectDir, sessionId });
  const run = runCommandState(record);
  if (run.kind === 'unavailable') return { status: 'unavailable', message: run.message };
  if (record.status.kind === 'closed' && !(run.kind === 'workspace' && canUndoApply(run.state))) {
    return { status: 'unavailable', message: `Run is closed (${record.status.as}).` };
  }
  if (run.kind === 'snapshot') return rejectRunSnapshot(projectDir, sessionId);
  const { state } = run;
  if (!isRunAtRest(record.ref) || record.status.kind === 'running') {
    return {
      status: 'unavailable',
      message: 'Run rejection is unavailable while the run is active.',
    };
  }
  if (record.status.kind === 'closed') {
    return { status: 'undone', ...(await undoApply(record.ref, state)) };
  }
  const config = configStore.get().config;
  if (config === null) {
    return { status: 'unavailable', message: 'Discard requires a project configuration.' };
  }
  const bus = createRecoveryBus({ projectDir, sessionId, sink: addTuiEvent });
  if (state.workspace?.kind === 'checkout') {
    const result = await rejectRunSnapshot(projectDir, sessionId);
    if (
      result.status === 'rejected' &&
      result.conflictedPaths.length === 0 &&
      result.missingSnapshotFiles.length === 0
    ) {
      const closure = await closeRunIfOpen({ projectDir, sessionId, bus }, state, 'discarded');
      if (closure.closedNow) {
        finalizeRunAtRest({ ref: record.ref, config, state: closure.state });
        sessionsStore.refresh();
      }
    }
    return result;
  }
  const closure = await closeRunIfOpen({ projectDir, sessionId, bus }, state, 'discarded');
  if (closure.closedNow) {
    finalizeRunAtRest({ ref: record.ref, config, state: closure.state });
    sessionsStore.refresh();
  }
  return { status: 'discarded' };
}

function insertImageIntoComposer(input: Parameters<typeof attachImage>[0]): AttachImageResult {
  if (!input.supportsImages) return { ok: false, reason: 'no-vision' };
  const result = resolveAttachment({ input: input.path, projectDir: input.projectDir });
  if (!result.ok) return { ok: false, reason: result.reason };
  composerDraftStore.requestImage(result.attachment);
  return { ok: true, path: result.attachment.path };
}

function conversationPageStep(viewportHeight: number): number {
  return Math.max(1, viewportHeight - 1);
}

function scrollConversation(
  target: ScrollCommandTarget,
  readScrollMetrics: WorkflowCommandPorts['readScrollMetrics'],
): ScrollConversationResult {
  const metrics = readScrollMetrics();
  switch (target) {
    case 'top':
      conversationScrollStore.scrollUp({
        renderableCount: metrics.renderableCount,
        totalHeight: metrics.totalHeight,
        step: metrics.maxOffset,
        maxOffset: metrics.maxOffset,
      });
      return { status: 'scrolled' };
    case 'bottom':
      conversationScrollStore.scrollToBottom(metrics.renderableCount);
      return { status: 'scrolled' };
    case 'page-up':
      conversationScrollStore.scrollUp({
        renderableCount: metrics.renderableCount,
        totalHeight: metrics.totalHeight,
        step: conversationPageStep(metrics.viewportHeight),
        maxOffset: metrics.maxOffset,
      });
      return { status: 'scrolled' };
    case 'page-down':
      conversationScrollStore.scrollDown(conversationPageStep(metrics.viewportHeight));
      return { status: 'scrolled' };
    default:
      return assertNever(target);
  }
}

function toggleLatestActivityBatch(
  getRowActions: WorkflowCommandPorts['getRowActions'],
): ToggleLatestActivityBatchResult {
  const action = findLatestConversationRowAction(getRowActions(), 'toggle-activity-batch');
  if (action === null) {
    return {
      status: 'unavailable',
      message: 'No expandable activity batch is available.',
    };
  }

  const expanded = !conversationScrollStore.get().expandedActivityBatches.has(action.key);
  conversationScrollStore.toggleActivityBatch(action.key);
  return { status: 'toggled', expanded };
}

function toggleLatestDiff(
  getRowActions: WorkflowCommandPorts['getRowActions'],
): ToggleLatestDiffResult {
  const action = findLatestConversationRowAction(getRowActions(), 'toggle-diff');
  if (action === null) {
    return { status: 'unavailable', message: 'No diff is available to expand.' };
  }

  const expanded = !conversationScrollStore.get().expandedDiffs.has(action.key);
  conversationScrollStore.toggleDiff(action.key);
  return { status: 'toggled', expanded };
}

// Project skills first, then the ones already selected this session — the in-session selection set
// is what "recently used" means here; there is no persisted recency store.
function listSkills(): readonly SkillCommandOption[] {
  const { available, selected } = skillsStore.get();
  const project = available.filter((skill) => skill.scope === 'project');
  const globals = available.filter((skill) => skill.scope === 'global');
  return [
    ...project,
    ...globals.filter((skill) => selected.has(skill.id)),
    ...globals.filter((skill) => !selected.has(skill.id)),
  ].map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    attached: selected.has(skill.id),
  }));
}

function toggleSkill(id: string): SkillToggleResult {
  const { available, selected } = skillsStore.get();
  const skill = available.find((candidate) => candidate.id === id);
  if (skill === undefined) return { status: 'unknown' };
  const wasSelected = selected.has(id);
  skillsStore.toggleSelected(id);
  return { status: wasSelected ? 'deselected' : 'selected', name: skill.name };
}

async function copyTarget(
  target: CopyTarget,
  resolveCopyValue: WorkflowCommandPorts['resolveCopyValue'],
): Promise<CopyResult> {
  const value = resolveCopyValue(target);
  if (value === null || value.length === 0) return 'empty';
  return copyToClipboard(value);
}

export function buildCommandContext({
  exit,
  workflow,
}: {
  exit: () => void;
  workflow: WorkflowCommandPorts;
}): RuntimeCommandContext {
  const route = routerStore.get();
  const projectDir =
    route.screen === 'workflow' ? route.run.ref.projectDir : configStore.get().projectDir;
  return createCommandContext({
    projectDir: () => projectDir,
    getSessionId: () => routeSessionId(route, projectDir),
    noActiveSession: appCommandContextError.noActiveSession,
    openOverlay: overlayStore.open,
    navigateHome: () => routerStore.navigate({ to: 'home' }),
    quit: () => requestQuit(exit),
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {
      return refreshDetectionForCurrentConfig({
        service: getDefaultDetectionService(),
        publication: detectionStore,
        getCurrent: () => {
          const { config, projectDir } = configStore.get();
          if (config === null) return null;
          return { config, projectDir };
        },
      });
    },
    refreshProjectFiles: projectFilesStore.requestRefresh,
    listSkills,
    toggleSkill,
    refreshSkills,
    getCurrentPhase: () => lifecycleStore.get().phase,
    resumeRun: () => requestResume(plainUserMessage('')),
    steerRun: (text) => {
      const submission = prepareDraftSubmission(createDraftDocument(text), {
        projectDir,
        supportsImages: plannerSupportsImages(
          configStore.get().config,
          modelCacheStore.getDetection().providers,
        ),
      });
      if (!submission.ok) {
        throw appCommandContextError.submissionRefused(submission);
      }
      attachmentsStore.replacePendingImages(submission.message.images);
      return requestSteer(submission.message);
    },
    endRun: requestEndRun,
    getQueueCopy: (count) => {
      const lifecycle = lifecycleStore.get();
      return queueCopy({
        seat: phaseStage(lifecycle.phase),
        taskId: selectRunningBrief(tasksStore.get(), lifecycle.phase).current?.id,
        count: count ?? lifecycle.queueDepth,
      });
    },
    clearQueue: workflow.requestClearQueue,
    insertImage: insertImageIntoComposer,
    attachImage,
    plannerSupportsImages: () =>
      plannerSupportsImages(configStore.get().config, modelCacheStore.getDetection().providers),
    detachImage,
    listAttachments,
    acceptRun,
    rejectRun,
    refreshRun: () => {
      const route = routerStore.get();
      if (route.screen !== 'workflow') return;
      routerStore.updateRun({ run: readRunRecord(route.run.ref) });
    },
    scrollConversation: (target) => scrollConversation(target, workflow.readScrollMetrics),
    toggleLatestActivityBatch: () => toggleLatestActivityBatch(workflow.getRowActions),
    toggleLatestDiff: () => toggleLatestDiff(workflow.getRowActions),
    listBriefs: () => tasksStore.get().tasks.map(({ id, status }) => ({ id, status })),
    copyTarget: (target) => copyTarget(target, workflow.resolveCopyValue),
    toggleSidebar: () => {
      // The layout owns the breakpoint: at exactly 120 columns `isSmall` is false while
      // `getWorkflowSidebarWidth` is 0, so only the layout can say whether a column will paint.
      const { cols } = terminalSizeStore.get();
      if (getWorkflowSidebarWidth({ cols, sidebarVisible: true }) === 0) {
        return { status: 'unavailable', message: 'Sidebar is hidden on small terminals.' };
      }
      // A closed run takes the whole width and states its crew and its briefs in the block at the
      // end of its transcript, so there is no column for this to open.
      const current = routerStore.get();
      if (
        current.screen === 'workflow' &&
        current.execution.kind === 'at-rest' &&
        current.run.status.kind === 'closed'
      ) {
        return { status: 'unavailable', message: 'A closed run has no sidebar.' };
      }
      controlsStore.toggleSidebar();
      const visible = controlsStore.get().sidebarVisible;
      if (projectDir) {
        writeUiPrefs(projectDir, { sidebarVisible: visible });
      }
      return { status: 'toggled', visible };
    },
  });
}

type Phase = ReturnType<typeof lifecycleStore.get>['phase'];

export function useRuntimeCommands({
  exit,
  phase,
  createContext,
}: {
  exit: () => void;
  phase: Phase;
  /** A supplied context replaces the production one outright; the registry is unchanged. */
  createContext?: (() => RuntimeCommandContext) | undefined;
}) {
  const ctx =
    createContext === undefined
      ? buildCommandContext({
          exit,
          workflow: {
            requestClearQueue,
            getRowActions: readConversationRowActions,
            readScrollMetrics: readConversationScrollSnapshot,
            resolveCopyValue,
          },
        })
      : createContext();
  // The command list embeds the skill id set as `/skills`'s closed options, so it has to be
  // rebuilt whenever that store changes.
  skillsStore.use((s) => s);
  const commands = createRuntimeCommands(ctx);
  const runtimeChainRef = useRef(Promise.resolve());
  const handleRuntimeCommand = (raw: string, from: Screen) => {
    const config = configStore.get().config;
    runtimeChainRef.current = runtimeChainRef.current.then(() =>
      executeRuntimeCommand(commands, raw, {
        screen: from,
        phase,
        plannerSupportsImages: plannerSupportsImages(
          config,
          modelCacheStore.getDetection().providers,
        ),
        openRunAtRest: isOpenRunAtRest(routerStore.get()),
        onError: feedbackStore.setError,
      }),
    );
  };
  return {
    commands,
    handleRuntimeCommand,
  };
}

import { join } from 'node:path';
import { useRef } from 'react';
import { createRuntimeCommands } from '../core/runtime/commands/registry.js';
import { executeRuntimeCommand } from '../core/runtime/commands/dispatch.js';
import { requestRewind, requestClearQueue } from '../features/workflow/handlers.js';
import { findLatestExpandableActivityBatchKey } from '../features/workflow/conversation-rows/activity-batch-key.js';
import { findLatestRenderableDiffKey } from '../core/sections/event-sections.js';
import { createTuiSink } from '../features/workflow/tui-sink.js';
import { readConversationScrollSnapshot } from '../features/workflow/layout/snapshot.js';
import { resolveCopyValue } from '../features/workflow/copy/resolve.js';
import { getSections } from '../stores/workflow/actions/sections.js';
import type { Config } from '../core/schemas/config.js';
import type { Screen } from '../core/navigation/types.js';
import { configStore } from '../stores/project/config.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { controlsStore } from '../stores/ui/controls.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { projectFilesStore } from '../stores/ui/project-files.js';
import { skillsStore } from '../stores/project/skills.js';
import { refreshSkills } from './refresh-skills.js';
import { attachImage, detachImage, listAttachments } from '../stores/workflow/attachments.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { getDefaultDetectionService } from '../engine/detection/service.js';
import { refreshDetectionForCurrentConfig } from '../engine/detection/store-publication.js';
import { detectionStore } from '../stores/project/detection.js';
import { readActive } from '../core/sessions/active-pointer.js';
import type { RewindTarget } from '../core/state/build-rewind-action.js';
import type {
  CopyResult,
  CopyTarget,
  QueueClearCommandResult,
  RuntimeConfigSaveResult,
  RuntimeCommandContext,
  ScrollCommandTarget,
  ScrollConversationResult,
  SkillCommandOption,
  SkillToggleResult,
  ToggleLatestActivityBatchResult,
  ToggleLatestDiffResult,
} from '../core/runtime/commands/types.js';
import { detectedModelFact, seatSupportsImages } from '../core/runners/capabilities.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { createCommandContext } from '../core/runtime/commands/context-factory.js';
import { copyToClipboard } from '../lib/clipboard/clipboard.js';
import { sessionDir } from '../core/paths.js';
import { writeHandoffPack } from '../engine/handoff/write.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../engine/snapshots/run/lifecycle.js';
import { createEventBus } from '../engine/events/bus.js';
import { performManualCompaction } from '../engine/orchestrator/transcript/compaction.js';
import { writeSessionHtmlReport } from '../engine/export/collect.js';
import {
  readApprovalsStore,
  mutateApprovalsStore,
  clearGrantsByScope,
} from '../core/approval/store.js';
import { writeUiPrefs } from '../core/ui-prefs.js';
import { error } from '../utils/error.js';
import { assertNever } from '../utils/type-guards.js';
import type { RouteData } from '../stores/navigation/router.js';

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
  requestRewind: (request: RewindTarget) => boolean;
  requestClearQueue: () => QueueClearCommandResult | Promise<QueueClearCommandResult>;
  findLatestActivityBatchKey: () => string | null;
  findLatestDiffKey: () => string | null;
  readScrollMetrics: () => ConversationScrollMetrics;
  resolveCopyValue: (target: CopyTarget) => string | null;
}

const appCommandContextError = {
  noActiveSession: (command: string) =>
    error('app-command-no-active-session', `No active session for ${command}`, { command }),
} as const;

function routeSessionId(route: RouteData, projectDir: string): string | null {
  if (route.screen === 'workflow') {
    return route.execution.kind === 'local'
      ? route.execution.prepared.session.ref.sessionId
      : route.execution.sessionId;
  }
  if (route.screen === 'summary' && route.sessionId) return route.sessionId;
  return readActive(projectDir);
}

function plannerSupportsImages(config: Config | null): boolean {
  if (config === null) return false;
  return seatSupportsImages({
    runner: config.planner,
    detected: detectedModelFact(modelCacheStore.getDetection().providers, config.planner),
  });
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
  findLatestActivityBatchKey: WorkflowCommandPorts['findLatestActivityBatchKey'],
): ToggleLatestActivityBatchResult {
  const key = findLatestActivityBatchKey();
  if (key === null) {
    return {
      status: 'unavailable',
      message: 'No expandable activity batch is available.',
    };
  }

  const expanded = !conversationScrollStore.get().expandedActivityBatches.has(key);
  conversationScrollStore.toggleActivityBatch(key);
  return { status: 'toggled', expanded };
}

function toggleLatestDiff(
  findLatestDiffKey: WorkflowCommandPorts['findLatestDiffKey'],
): ToggleLatestDiffResult {
  const key = findLatestDiffKey();
  if (key === null) {
    return { status: 'unavailable', message: 'No diff is available to expand.' };
  }

  const expanded = !conversationScrollStore.get().expandedDiffs.has(key);
  conversationScrollStore.toggleDiff(key);
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
  }));
}

function toggleSkill(id: string): SkillToggleResult {
  const { available, selected } = skillsStore.get();
  const skill = available.find((candidate) => candidate.id === id);
  if (skill === undefined) return { status: 'unknown' };
  const next = new Set(selected);
  const wasSelected = next.delete(id);
  if (!wasSelected) next.add(id);
  skillsStore.setSelected(next);
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
  const prepared =
    route.screen === 'workflow' && route.execution.kind === 'local'
      ? route.execution.prepared
      : null;
  const projectDir = prepared?.session.ref.projectDir ?? configStore.get().projectDir;
  return createCommandContext({
    isAttached: route.screen === 'workflow' && route.execution.kind === 'attached',
    projectDir: () => projectDir,
    getConfig: () => configStore.get().config,
    saveConfig: async (config): Promise<RuntimeConfigSaveResult> => {
      const result = await configStore.save(config);
      switch (result.kind) {
        case 'saved':
          return { kind: 'saved', ok: true };
        case 'conflict':
          return {
            kind: 'conflict',
            ok: false,
            errorMessage: 'Config changed on disk. Reload before saving again.',
          };
        case 'durability-uncertain':
          return {
            kind: 'durability-uncertain',
            ok: false,
            errorMessage: `Config save could not be confirmed: ${result.warning}`,
          };
        case 'failure':
          return {
            kind: 'failure',
            ok: false,
            errorMessage: `Failed to save config: ${result.error.message}`,
          };
      }
    },
    setApprovalEnabled: configStore.setApprovalEnabled,
    getSessionId: () => routeSessionId(route, projectDir),
    noActiveSession: appCommandContextError.noActiveSession,
    exportMissingSession: () => ({ status: 'error', error: 'No active session for /export' }),
    openOverlay: overlayStore.open,
    navigateHome: () => routerStore.navigate({ to: 'home' }),
    quit: exit,
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
    requestRewind: workflow.requestRewind,
    requestTaskRedo: (taskId) => workflow.requestRewind({ target: 'task', taskId }),
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: workflow.requestClearQueue,
    attachImage,
    plannerSupportsImages: () => plannerSupportsImages(configStore.get().config),
    detachImage,
    listAttachments,
    writeHandoff: ({ projectDir, sessionId, target, taskId }) =>
      writeHandoffPack({
        projectDir,
        sessionId,
        target,
        outDir: join(sessionDir(projectDir, sessionId), 'handoffs', target),
        ...(taskId !== undefined && { selectedTaskIds: [taskId] }),
        mode: 'overwrite',
      }),
    listApprovals: (projectDir) => readApprovalsStore(projectDir).grants,
    clearApprovals: (projectDir, scope) => {
      let removed = 0;
      mutateApprovalsStore(projectDir, (before) => {
        const after = clearGrantsByScope(before, scope);
        removed = before.grants.length - after.grants.length;
        return after;
      });
      return removed;
    },
    acceptRunSnapshot,
    rejectRunSnapshot,
    compactTranscript: () => {
      if (prepared === null) {
        throw appCommandContextError.noActiveSession('/compact-transcript');
      }
      const bus = createEventBus();
      bus.subscribe(
        createTuiSink({ persistTranscript: prepared.config.workflow.persistTranscript }),
      );
      return performManualCompaction({
        config: prepared.config,
        ref: prepared.session.ref,
        preparationId: prepared.preparationId,
        gates: prepared.gates,
        bus,
      });
    },
    exportSession: async (projectDir, sessionId) =>
      writeSessionHtmlReport(sessionDir(projectDir, sessionId), sessionId),
    scrollConversation: (target) => scrollConversation(target, workflow.readScrollMetrics),
    toggleLatestActivityBatch: () => toggleLatestActivityBatch(workflow.findLatestActivityBatchKey),
    toggleLatestDiff: () => toggleLatestDiff(workflow.findLatestDiffKey),
    copyTarget: (target) => copyTarget(target, workflow.resolveCopyValue),
    toggleSidebar: () => {
      if (terminalSizeStore.get().isSmall) {
        return { status: 'unavailable', message: 'Sidebar is hidden on small terminals.' };
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

export function useRuntimeCommands({ exit, phase }: { exit: () => void; phase: Phase }) {
  const ctx = buildCommandContext({
    exit,
    workflow: {
      requestRewind,
      requestClearQueue,
      findLatestActivityBatchKey: () => findLatestExpandableActivityBatchKey(getSections()),
      findLatestDiffKey: () => findLatestRenderableDiffKey(getSections()),
      readScrollMetrics: readConversationScrollSnapshot,
      resolveCopyValue,
    },
  });
  // The command list embeds the skill id set as `/skills`'s closed options, so it has to be
  // rebuilt whenever a rescan or a toggle changes the store.
  skillsStore.use((s) => s);
  const commands = createRuntimeCommands(ctx);
  const runtimeChainRef = useRef(Promise.resolve());
  const handleRuntimeCommand = (raw: string, from: Screen) => {
    const route = routerStore.get();
    const config = configStore.get().config;
    runtimeChainRef.current = runtimeChainRef.current
      .then(() =>
        executeRuntimeCommand(commands, raw, {
          screen: from,
          phase,
          attached: route.screen === 'workflow' && route.execution.kind === 'attached',
          plannerSupportsImages: plannerSupportsImages(config),
          onError: feedbackStore.setError,
        }),
      )
      .catch(() => {});
  };
  return {
    commands,
    copyTarget: ctx.copyTarget,
    setWorkflowMode: ctx.setWorkflowMode,
    handleRuntimeCommand,
  };
}

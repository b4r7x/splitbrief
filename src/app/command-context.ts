import { join } from 'node:path';
import { configStore } from '../stores/project/config.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { controlsStore } from '../stores/ui/controls.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { projectFilesStore } from '../stores/ui/project-files.js';
import { attachImage, detachImage, listAttachments } from '../stores/workflow/attachments.js';
import { getSections } from '../stores/workflow/actions.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { requestClearQueue, requestRewind } from '../features/workflow/handlers.js';
import { findLatestExpandableActivityBatchKey } from '../features/workflow/conversation-rows/activity-batch-key.js';
import { readConversationScrollSnapshot } from '../features/workflow/layout/snapshot.js';
import { refreshDetection } from '../engine/detection/service.js';
import { readActive } from '../core/sessions/lifecycle.js';
import type {
  RuntimeCommandContext,
  ScrollCommandTarget,
  ScrollConversationResult,
  ToggleLatestActivityBatchResult,
} from '../core/runtime/commands/types.js';
import { createCommandContext } from '../core/runtime/commands/context-factory.js';
import { sessionDir } from '../core/paths.js';
import { rebuildRepomap } from '../engine/codebase/rebuild.js';
import { writeHandoffPack } from '../engine/handoff/write.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../engine/snapshots/run.js';
import { performManualCompaction } from '../engine/orchestrator/transcript-rebuild.js';
import { writeSessionHtmlReport } from '../engine/export/collect.js';
import {
  readApprovalsStore,
  mutateApprovalsStore,
  clearGrantsByScope,
} from '../core/approval/store.js';
import { error } from '../utils/error.js';
import { assertNever } from '../utils/type-guards.js';

const appCommandContextError = {
  noActiveSession: (command: string) =>
    error('app-command-no-active-session', `No active session for ${command}`, { command }),
  noConfig: (command: string) =>
    error('app-command-no-config', `No config loaded for ${command}`, { command }),
} as const;

function currentSessionId(projectDir: string): string | null {
  const route = routerStore.get();
  if ((route.screen === 'workflow' || route.screen === 'summary') && route.sessionId) {
    return route.sessionId;
  }
  return readActive(projectDir);
}

function conversationPageStep(viewportHeight: number): number {
  return Math.max(1, viewportHeight - 1);
}

function scrollConversation(target: ScrollCommandTarget): ScrollConversationResult {
  const snapshot = readConversationScrollSnapshot();
  switch (target) {
    case 'top':
      conversationScrollStore.scrollUp({
        renderableCount: snapshot.renderableCount,
        totalHeight: snapshot.totalHeight,
        step: snapshot.maxOffset,
        maxOffset: snapshot.maxOffset,
      });
      return { status: 'scrolled' };
    case 'bottom':
      conversationScrollStore.scrollToBottom(snapshot.renderableCount);
      return { status: 'scrolled' };
    case 'page-up':
      conversationScrollStore.scrollUp({
        renderableCount: snapshot.renderableCount,
        totalHeight: snapshot.totalHeight,
        step: conversationPageStep(snapshot.viewportHeight),
        maxOffset: snapshot.maxOffset,
      });
      return { status: 'scrolled' };
    case 'page-down':
      conversationScrollStore.scrollDown(conversationPageStep(snapshot.viewportHeight));
      return { status: 'scrolled' };
    default:
      return assertNever(target);
  }
}

function toggleLatestActivityBatch(): ToggleLatestActivityBatchResult {
  const key = findLatestExpandableActivityBatchKey(getSections());
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

export function buildCommandContext({ exit }: { exit: () => void }): RuntimeCommandContext {
  return createCommandContext({
    projectDir: () => configStore.get().projectDir,
    getConfig: () => configStore.get().config,
    saveConfig: (config) => {
      const result = configStore.save(config);
      if (result.ok) return { ok: true };
      return result.error
        ? { ok: false, errorMessage: `Failed to save config: ${result.error.message}` }
        : { ok: false };
    },
    setApprovalEnabled: (enabled) => {
      const current = configStore.get().config;
      if (!current) return;
      configStore.setApprovalEnabled(enabled);
    },
    getSessionId: () => currentSessionId(configStore.get().projectDir),
    noActiveSession: appCommandContextError.noActiveSession,
    noConfig: appCommandContextError.noConfig,
    exportMissingSession: () => ({ status: 'error', error: 'No active session for /export' }),
    openOverlay: overlayStore.open,
    navigateHome: () => routerStore.navigate({ to: 'home' }),
    quit: exit,
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {
      await refreshDetection(configStore.get().projectDir);
    },
    refreshProjectFiles: projectFilesStore.requestRefresh,
    getCurrentPhase: () => lifecycleStore.get().phase,
    requestRewind,
    requestTaskRedo: (taskId) => requestRewind({ target: 'task', taskId }),
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: requestClearQueue,
    rebuildRepomap: async (projectDir, cacheDir) =>
      rebuildRepomap(projectDir, cacheDir === undefined ? {} : { cacheDir }),
    attachImage,
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
    compactTranscript: performManualCompaction,
    exportSession: async (projectDir, sessionId) =>
      writeSessionHtmlReport(sessionDir(projectDir, sessionId), sessionId),
    scrollConversation,
    toggleLatestActivityBatch,
    toggleSidebar: () => {
      if (terminalSizeStore.get().isSmall) {
        return { status: 'unavailable', message: 'Sidebar is hidden on small terminals.' };
      }
      controlsStore.toggleSidebar();
      return { status: 'toggled', visible: controlsStore.get().sidebarVisible };
    },
  });
}

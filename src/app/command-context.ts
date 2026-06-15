import { join } from 'node:path';
import { configStore } from '../stores/project/config.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { projectFilesStore } from '../stores/ui/project-files.js';
import { attachImage, detachImage, listAttachments } from '../stores/workflow/attachments.js';
import { requestClearQueue, requestRewind } from '../features/workflow/handlers.js';
import { refreshDetection } from '../engine/detection/service.js';
import { readActive } from '../core/sessions/lifecycle.js';
import type { RuntimeCommandContext } from '../core/runtime/commands/types.js';
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
  });
}

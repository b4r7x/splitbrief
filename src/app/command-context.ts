import { join } from 'node:path';
import { sessionDir } from '../core/paths.js';
import { configStore } from '../stores/project/config.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { attachImage, detachImage, listAttachments } from '../stores/ui/attachments.js';
import { requestRewind, requestClearQueue, type RewindTarget } from '../features/workflow/handlers.js';
import { refreshDetection } from '../engine/detection/service.js';
import { rebuildRepomap as doRebuildRepomap } from '../engine/codebase/rebuild.js';
import { readActive } from '../core/sessions/lifecycle.js';
import { writeHandoffPack } from '../engine/handoff/write.js';
import { readApprovalsStore, writeApprovalsStore, clearGrantsByScope } from '../engine/orchestrator/approvals-store.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../engine/snapshots/run.js';
import { performManualCompaction } from '../engine/orchestrator/transcript-rebuild.js';
import { writeSessionHtmlReport } from '../engine/export/collect.js';
import type { RuntimeCommandContext } from '../core/runtime/commands/types.js';

function currentSessionId(projectDir: string): string | null {
  const route = routerStore.get();
  if ((route.screen === 'workflow' || route.screen === 'summary') && route.sessionId) {
    return route.sessionId;
  }
  return readActive(projectDir);
}

export function buildCommandContext({ exit }: { exit: () => void }): RuntimeCommandContext {
  return {
    openOverlay: overlayStore.open,
    navigate: (to) => routerStore.navigate({ to }),
    quit: exit,
    setWorkflowMode: (mode) => {
      const current = configStore.get().config;
      if (!current) return false;
      const result = configStore.save({ ...current, workflow: { ...current.workflow, mode } });
      if (!result.ok && result.error) {
        feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      }
      return result.ok;
    },
    setPlannerEffort: (effort) => {
      const current = configStore.get().config;
      if (!current) return false;
      const planner = { ...current.planner, effort };
      const result = configStore.save({ ...current, planner });
      if (!result.ok && result.error) {
        feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      }
      return result.ok;
    },
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {
      const projectDir = configStore.get().projectDir;
      await refreshDetection(projectDir);
    },
    getCurrentPhase: () => lifecycleStore.get().phase,
    requestRewind: (target, comment) => {
      const base: RewindTarget = comment ? { target, comment } : { target };
      return requestRewind(base);
    },
    requestTaskRedo: (taskId) =>
      requestRewind({ target: 'task', taskId }),
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: () => requestClearQueue(),
    rebuildRepomap: async () => {
      const projectDir = configStore.get().projectDir;
      return doRebuildRepomap(projectDir);
    },
    attachImage: (input) => {
      const projectDir = configStore.get().projectDir;
      const result = attachImage(input, projectDir);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, path: result.path };
    },
    detachImage: (idOrIndex) => {
      return detachImage(idOrIndex);
    },
    listAttachments,
    writeHandoff: async (target, taskId) => {
      const projectDir = configStore.get().projectDir;
      const sessionId = readActive(projectDir);
      if (!sessionId) throw new Error('No active session for handoff');
      const outDir = join(
        projectDir, '.diptych', 'sessions', sessionId, 'handoffs', target,
      );
      return writeHandoffPack({
        projectDir,
        sessionId,
        target,
        outDir,
        ...(taskId !== undefined && { selectedTaskIds: [taskId] }),
        mode: 'overwrite',
      });
    },
    listApprovals: () => {
      const projectDir = configStore.get().projectDir;
      return readApprovalsStore(projectDir).grants;
    },
    clearApprovals: (scope = 'all') => {
      const projectDir = configStore.get().projectDir;
      const before = readApprovalsStore(projectDir);
      const after = clearGrantsByScope(before, scope);
      writeApprovalsStore(projectDir, after);
      return before.grants.length - after.grants.length;
    },
    getApprovalEnabled: () => {
      const config = configStore.get().config;
      return config?.approval?.enabled !== false;
    },
    setApprovalEnabled: (enabled) => {
      const current = configStore.get().config;
      if (!current) return;
      configStore.setApprovalEnabled(enabled);
    },
    acceptRunSnapshot: async () => {
      const projectDir = configStore.get().projectDir;
      const sessionId = readActive(projectDir);
      if (!sessionId) throw new Error('No active session for /accept-run');
      return acceptRunSnapshot(projectDir, sessionId);
    },
    rejectRunSnapshot: async () => {
      const projectDir = configStore.get().projectDir;
      const sessionId = readActive(projectDir);
      if (!sessionId) throw new Error('No active session for /reject-run');
      return rejectRunSnapshot(projectDir, sessionId);
    },
    compactTranscript: async () => {
      const { config, projectDir } = configStore.get();
      if (!config) throw new Error('No config loaded for /compact-transcript');
      const sessionId = currentSessionId(projectDir);
      if (!sessionId) throw new Error('No active session for /compact-transcript');
      return performManualCompaction(config, projectDir, sessionId);
    },
    exportSession: async () => {
      const projectDir = configStore.get().projectDir;
      const sessionId = currentSessionId(projectDir);
      if (!sessionId) return { status: 'error', error: 'No active session for /export' };
      return writeSessionHtmlReport(sessionDir(projectDir, sessionId), sessionId);
    },
  };
}

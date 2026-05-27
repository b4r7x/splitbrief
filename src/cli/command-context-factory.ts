import { join } from 'node:path';
import type { Config } from '../core/schemas/config.js';
import type { Phase } from '../core/schemas/enums.js';
import { sessionDir } from '../core/paths.js';
import type { RuntimeCommandContext, ExportSessionResult } from '../core/runtime/commands/types.js';
import type { OverlayType } from '../core/navigation/types.js';
import { rebuildRepomap } from '../engine/codebase/rebuild.js';
import { writeHandoffPack } from '../engine/handoff/write.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../engine/snapshots/run.js';
import { performManualCompaction } from '../engine/orchestrator/transcript-rebuild.js';
import { writeSessionHtmlReport } from '../engine/export/collect.js';
import { readApprovalsStore, writeApprovalsStore, clearGrantsByScope } from '../core/approval/store.js';
import { attachImage, detachImage, listAttachments } from '../stores/workflow/attachments.js';

type ConfigSaveResult = { ok: true } | { ok: false; errorMessage?: string | undefined };
type CommandRewindRequest =
  | { target: 'spec'; comment?: string }
  | { target: 'plan'; comment?: string };

interface CommandContextFactoryOptions {
  projectDir: () => string;
  getConfig: () => Config | null;
  saveConfig: (config: Config) => ConfigSaveResult;
  setApprovalEnabled?: ((enabled: boolean) => void) | undefined;
  getSessionId: (command: string) => string | null | undefined;
  noActiveSession: (command: string) => Error;
  noConfig: (command: string) => Error;
  exportMissingSession?: (() => ExportSessionResult) | undefined;
  openOverlay: (type: OverlayType, focus?: string) => void;
  navigateHome: () => void;
  quit: () => void;
  setFeedbackMessage: (message: string) => void;
  setFeedbackError: (message: string) => void;
  refreshDetection: () => Promise<void>;
  getCurrentPhase: () => Phase;
  requestRewind: (request: CommandRewindRequest) => boolean;
  requestTaskRedo: (taskId: string) => boolean;
  getQueueDepth: () => number;
  clearQueue: () => number;
}

export function createCommandContext(opts: CommandContextFactoryOptions): RuntimeCommandContext {
  const currentConfig = (command: string) => {
    const config = opts.getConfig();
    if (!config) throw opts.noConfig(command);
    return config;
  };
  const sessionIdOrThrow = (command: string) => {
    const sessionId = opts.getSessionId(command);
    if (!sessionId) throw opts.noActiveSession(command);
    return sessionId;
  };
  const updateConfig = (update: (config: Config) => Config): boolean => {
    const config = opts.getConfig();
    if (!config) return false;
    const result = opts.saveConfig(update(config));
    if (!result.ok && result.errorMessage) opts.setFeedbackError(result.errorMessage);
    return result.ok;
  };

  return {
    openOverlay: opts.openOverlay,
    navigate: () => opts.navigateHome(),
    quit: opts.quit,
    setWorkflowMode: mode =>
      updateConfig(current => ({ ...current, workflow: { ...current.workflow, mode } })),
    setPlannerEffort: effort =>
      updateConfig(current => ({ ...current, planner: { ...current.planner, effort } })),
    setFeedbackMessage: opts.setFeedbackMessage,
    setFeedbackError: opts.setFeedbackError,
    refreshDetection: opts.refreshDetection,
    getCurrentPhase: opts.getCurrentPhase,
    requestRewind: (target, comment) => {
      const request: CommandRewindRequest = { target, ...(comment ? { comment } : {}) };
      return opts.requestRewind(request);
    },
    requestTaskRedo: opts.requestTaskRedo,
    getQueueDepth: opts.getQueueDepth,
    clearQueue: opts.clearQueue,
    rebuildRepomap: async () => {
      const projectDir = opts.projectDir();
      const cacheDir = opts.getConfig()?.codebase?.cacheDir;
      return rebuildRepomap(projectDir, cacheDir === undefined ? {} : { cacheDir });
    },
    attachImage: input => attachImage(input, opts.projectDir()),
    detachImage,
    listAttachments,
    writeHandoff: async (target, taskId) => {
      const projectDir = opts.projectDir();
      const sessionId = sessionIdOrThrow('handoff');
      return writeHandoffPack({
        projectDir,
        sessionId,
        target,
        outDir: join(sessionDir(projectDir, sessionId), 'handoffs', target),
        ...(taskId !== undefined && { selectedTaskIds: [taskId] }),
        mode: 'overwrite',
      });
    },
    listApprovals: () => readApprovalsStore(opts.projectDir()).grants,
    clearApprovals: (scope = 'all') => {
      const projectDir = opts.projectDir();
      const before = readApprovalsStore(projectDir);
      const after = clearGrantsByScope(before, scope);
      writeApprovalsStore(projectDir, after);
      return before.grants.length - after.grants.length;
    },
    getApprovalEnabled: () => opts.getConfig()?.approval?.enabled !== false,
    setApprovalEnabled: (enabled) => {
      if (opts.setApprovalEnabled) {
        opts.setApprovalEnabled(enabled);
        return;
      }
      updateConfig(current => {
        const approval = current.approval ?? { enabled: true, feedRejectionsToPlanner: true };
        return { ...current, approval: { ...approval, enabled } };
      });
    },
    acceptRunSnapshot: () => acceptRunSnapshot(opts.projectDir(), sessionIdOrThrow('/accept-run')),
    rejectRunSnapshot: () => rejectRunSnapshot(opts.projectDir(), sessionIdOrThrow('/reject-run')),
    compactTranscript: () => {
      const projectDir = opts.projectDir();
      const config = currentConfig('/compact-transcript');
      const sessionId = sessionIdOrThrow('/compact-transcript');
      return performManualCompaction(config, projectDir, sessionId);
    },
    exportSession: async () => {
      const projectDir = opts.projectDir();
      const sessionId = opts.getSessionId('/export');
      if (!sessionId) {
        if (opts.exportMissingSession) return opts.exportMissingSession();
        throw opts.noActiveSession('/export');
      }
      return writeSessionHtmlReport(sessionDir(projectDir, sessionId), sessionId);
    },
  };
}

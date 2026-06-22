import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EventBus } from '../../engine/events/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import { transitionAndSave } from '../../engine/orchestrator/state-ops.js';
import { clearPendingQueue } from '../../engine/orchestrator/queue.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../engine/orchestrator/run/workflow.js';
import type { RuntimeCommandContext } from '../../core/runtime/commands/types.js';
import { createCommandContext } from '../../core/runtime/commands/context-factory.js';
import { buildRewindAction } from '../../core/state/build-rewind-action.js';
import { sessionDir } from '../../core/paths.js';
import { rebuildRepomap } from '../../engine/codebase/rebuild.js';
import { writeHandoffPack } from '../../engine/handoff/write.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../../engine/snapshots/run.js';
import { performManualCompaction } from '../../engine/orchestrator/transcript-rebuild.js';
import { writeSessionHtmlReport } from '../../engine/export/collect.js';
import {
  readApprovalsStore,
  mutateApprovalsStore,
  clearGrantsByScope,
} from '../../core/approval/store.js';
import { attachImage, detachImage, listAttachments } from '../../stores/workflow/attachments.js';
import { writeConfig } from '../../core/config/load/io.js';
import { defaultApprovalConfig } from '../../core/schemas/config.js';
import { persistedConfigForSave } from '../../stores/project/config-persistence.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { error } from '../../utils/error.js';

const rpcCommandContextError = {
  noActiveSession: () => error('rpc-command-no-active-session', 'No active session.'),
  noConfig: () => error('rpc-command-no-config', 'No config loaded.'),
} as const;

export function createRpcCommandContext(opts: {
  projectDir: string;
  getSessionId: () => string | undefined;
  getState: () => WorkflowState | null;
  getConfig: () => Config | null;
  getPersistedConfig?: (() => Config | null) | undefined;
  setConfig: (config: Config) => void;
  setPersistedConfig?: ((config: Config) => void) | undefined;
  getApprovalEnabled?: (() => boolean) | undefined;
  setApprovalEnabled?: ((enabled: boolean) => void) | undefined;
  getPhase: () => Phase;
  queueHandler: () => QueueHandler | null;
  clearQueueHandler: () => ClearQueueHandler | null;
  abort: (reason?: unknown) => void;
  abortTurn?: ((reason?: unknown) => void) | undefined;
  bus: EventBus;
  setRewindFeedback?: ((feedback: string | undefined) => void) | undefined;
  messages: string[];
  errors: string[];
  pendingQueueDepth: (state: WorkflowState | null) => number;
}): RuntimeCommandContext {
  const pushMessage = (message: string) => {
    opts.messages.push(message);
  };
  const pushError = (message: string) => {
    opts.errors.push(message);
  };
  return createCommandContext({
    projectDir: () => opts.projectDir,
    getConfig: opts.getConfig,
    saveConfig: (config) => {
      try {
        const effective = opts.getConfig();
        const persistedBase = opts.getPersistedConfig?.();
        const persisted =
          effective && persistedBase
            ? persistedConfigForSave({
                persisted: persistedBase,
                effective,
                updated: config,
              })
            : config;
        writeConfig(opts.projectDir, persisted);
        opts.setPersistedConfig?.(persisted);
      } catch (err) {
        return { ok: false, errorMessage: `Failed to save config: ${toErrorMessage(err)}` };
      }
      opts.setConfig(config);
      return { ok: true };
    },
    getApprovalEnabled: opts.getApprovalEnabled,
    setApprovalEnabled: (enabled) => {
      const current = opts.getConfig();
      if (current) {
        const approval = current.approval ?? defaultApprovalConfig();
        opts.setConfig({ ...current, approval: { ...approval, enabled } });
      }
      opts.setApprovalEnabled?.(enabled);
    },
    getSessionId: () => opts.getSessionId(),
    noActiveSession: () => rpcCommandContextError.noActiveSession(),
    noConfig: () => rpcCommandContextError.noConfig(),
    openOverlay: (type) => pushMessage(`Overlay ${type} is not available in RPC mode.`),
    navigateHome: () => pushMessage('Navigation is not available in RPC mode.'),
    quit: () => opts.abort(),
    setFeedbackMessage: pushMessage,
    setFeedbackError: pushError,
    refreshDetection: async () => {
      pushMessage('Tool detection refresh is not available in RPC mode.');
    },
    refreshProjectFiles: () => {
      pushMessage('Project file refresh is not available in RPC mode.');
    },
    getCurrentPhase: opts.getPhase,
    requestRewind: (request) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      const persistTranscript = opts.getConfig()?.workflow.persistTranscript ?? true;
      const { action, persistedAction, event } = buildRewindAction({
        request,
        ref: { projectDir: opts.projectDir, sessionId },
        state,
        persistEvent: false,
        persistTranscript,
      });
      if (action.type === 'REWIND_TO_SPEC' || action.type === 'REWIND_TO_PLAN') {
        opts.setRewindFeedback?.(action.comment);
      }
      transitionAndSave({ projectDir: opts.projectDir, sessionId }, state, persistedAction);
      opts.bus.publish(event);
      opts.abortTurn?.(WORKFLOW_REWIND_ABORT_REASON);
      return true;
    },
    requestTaskRedo: (taskId) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      const persistTranscript = opts.getConfig()?.workflow.persistTranscript ?? true;
      const { persistedAction, event } = buildRewindAction({
        request: { target: 'task', taskId },
        ref: { projectDir: opts.projectDir, sessionId },
        state,
        persistEvent: false,
        persistTranscript,
      });
      transitionAndSave({ projectDir: opts.projectDir, sessionId }, state, persistedAction);
      opts.bus.publish(event);
      opts.abortTurn?.(WORKFLOW_REWIND_ABORT_REASON);
      return true;
    },
    getQueueDepth: () => opts.pendingQueueDepth(opts.getState()),
    clearQueue: () => {
      const clearLiveQueue = opts.clearQueueHandler();
      if (clearLiveQueue) return clearLiveQueue();
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) {
        return { status: 'unavailable', message: 'Cannot clear queue: no active workflow.' };
      }
      return {
        status: 'cleared',
        count: clearPendingQueue({
          projectDir: opts.projectDir,
          sessionId,
          state,
          bus: opts.bus,
        }).count,
      };
    },
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
    scrollConversation: () => ({
      status: 'unavailable',
      message: 'Conversation scrolling is not available in RPC mode.',
    }),
    toggleLatestActivityBatch: () => ({
      status: 'unavailable',
      message: 'Activity expansion is not available in RPC mode.',
    }),
    toggleSidebar: () => ({
      status: 'unavailable',
      message: 'Sidebar is not available in RPC mode.',
    }),
  });
}

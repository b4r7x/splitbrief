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
  writeApprovalsStore,
  clearGrantsByScope,
} from '../../core/approval/store.js';
import { attachImage, detachImage, listAttachments } from '../../stores/workflow/attachments.js';
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
  setConfig: (config: Config) => void;
  getPhase: () => Phase;
  queueHandler: () => QueueHandler | null;
  clearQueueHandler: () => ClearQueueHandler | null;
  abort: (reason?: unknown) => void;
  bus: EventBus;
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
      opts.setConfig(config);
      return { ok: true };
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
      const { action } = buildRewindAction(
        request,
        { projectDir: opts.projectDir, sessionId },
        state,
      );
      transitionAndSave({ projectDir: opts.projectDir, sessionId }, state, action);
      opts.abort(WORKFLOW_REWIND_ABORT_REASON);
      return true;
    },
    requestTaskRedo: (taskId) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      const { action } = buildRewindAction(
        { target: 'task', taskId },
        { projectDir: opts.projectDir, sessionId },
        state,
      );
      transitionAndSave({ projectDir: opts.projectDir, sessionId }, state, action);
      opts.abort(WORKFLOW_REWIND_ABORT_REASON);
      return true;
    },
    getQueueDepth: () => opts.pendingQueueDepth(opts.getState()),
    clearQueue: () => {
      const clearLiveQueue = opts.clearQueueHandler();
      if (clearLiveQueue) return clearLiveQueue();
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return 0;
      return clearPendingQueue(opts.projectDir, sessionId, state, opts.bus).count;
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
      const before = readApprovalsStore(projectDir);
      const after = clearGrantsByScope(before, scope);
      writeApprovalsStore(projectDir, after);
      return before.grants.length - after.grants.length;
    },
    acceptRunSnapshot,
    rejectRunSnapshot,
    compactTranscript: performManualCompaction,
    exportSession: async (projectDir, sessionId) =>
      writeSessionHtmlReport(sessionDir(projectDir, sessionId), sessionId),
  });
}

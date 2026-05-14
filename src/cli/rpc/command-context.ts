import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { taskId as parseTaskId } from '../../core/schemas/task.js';
import type { EventBus } from '../../engine/events/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import { sessionDir } from '../../core/paths.js';
import { transitionAndSave } from '../../engine/orchestrator/state-ops.js';
import { clearPendingQueue } from '../../engine/orchestrator/queue.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../engine/orchestrator/run/run.js';
import type { RuntimeCommandContext } from '../../core/runtime/commands/types.js';
import { rebuildRepomap } from '../../engine/codebase/rebuild.js';
import { attachImage, detachImage, listAttachments } from '../../stores/ui/attachments.js';
import { writeHandoffPack } from '../../engine/handoff/write.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../../engine/snapshots/run.js';
import { readApprovalsStore, writeApprovalsStore, clearGrantsByScope } from '../../core/approval/store.js';
import { performManualCompaction } from '../../engine/orchestrator/transcript-rebuild.js';
import { writeSessionHtmlReport } from '../../engine/export/collect.js';
import { error } from '../../utils/error.js';

const rpcCommandContextError = {
  noActiveSession: () => error('rpc-command-no-active-session', 'No active session.'),
} as const;

export function createRpcCommandContext(opts: {
  projectDir: string;
  getSessionId: () => string | undefined;
  getState: () => WorkflowState | null;
  getConfig: () => Config;
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
  const getSessionIdOrThrow = () => {
    const id = opts.getSessionId();
    if (!id) throw rpcCommandContextError.noActiveSession();
    return id;
  };

  return {
    openOverlay: (type) => pushMessage(`Overlay ${type} is not available in RPC mode.`),
    navigate: () => pushMessage('Navigation is not available in RPC mode.'),
    quit: () => opts.abort(),
    setWorkflowMode: (mode) => {
      const current = opts.getConfig();
      opts.setConfig({ ...current, workflow: { ...current.workflow, mode } });
      return true;
    },
    setPlannerEffort: (effort) => {
      const current = opts.getConfig();
      opts.setConfig({ ...current, planner: { ...current.planner, effort } });
      return true;
    },
    setFeedbackMessage: pushMessage,
    setFeedbackError: pushError,
    refreshDetection: async () => {
      pushMessage('Tool detection refresh is not available in RPC mode.');
    },
    getCurrentPhase: opts.getPhase,
    requestRewind: (target, comment) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      const action = target === 'spec'
        ? { type: 'REWIND_TO_SPEC' as const, ...(comment ? { comment } : {}) }
        : { type: 'REWIND_TO_PLAN' as const, ...(comment ? { comment } : {}) };
      transitionAndSave(opts.projectDir, sessionId, state, action);
      opts.abort(WORKFLOW_REWIND_ABORT_REASON);
      return true;
    },
    requestTaskRedo: (taskId) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      transitionAndSave(opts.projectDir, sessionId, state, { type: 'RESET_TASK', taskId: parseTaskId(taskId) });
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
    rebuildRepomap: async () => {
      const cacheDir = opts.getConfig().codebase?.cacheDir;
      return rebuildRepomap(opts.projectDir, cacheDir === undefined ? {} : { cacheDir });
    },
    attachImage: (input) => attachImage(input, opts.projectDir),
    detachImage,
    listAttachments,
    writeHandoff: async (target, taskId) => {
      const sessionId = getSessionIdOrThrow();
      return writeHandoffPack({
        projectDir: opts.projectDir,
        sessionId,
        target,
        outDir: join(sessionDir(opts.projectDir, sessionId), 'handoffs', target),
        ...(taskId !== undefined && { selectedTaskIds: [taskId] }),
        mode: 'overwrite',
      });
    },
    listApprovals: () => readApprovalsStore(opts.projectDir).grants,
    clearApprovals: (scope = 'all') => {
      const before = readApprovalsStore(opts.projectDir);
      const after = clearGrantsByScope(before, scope);
      writeApprovalsStore(opts.projectDir, after);
      return before.grants.length - after.grants.length;
    },
    getApprovalEnabled: () => opts.getConfig().approval?.enabled !== false,
    setApprovalEnabled: (enabled) => {
      const current = opts.getConfig();
      const approval = current.approval ?? { enabled: true, feedRejectionsToPlanner: true };
      opts.setConfig({ ...current, approval: { ...approval, enabled } });
    },
    acceptRunSnapshot: () => acceptRunSnapshot(opts.projectDir, getSessionIdOrThrow()),
    rejectRunSnapshot: () => rejectRunSnapshot(opts.projectDir, getSessionIdOrThrow()),
    compactTranscript: async () => {
      const sessionId = getSessionIdOrThrow();
      return performManualCompaction(opts.getConfig(), opts.projectDir, sessionId);
    },
    exportSession: async () => {
      const sessionId = getSessionIdOrThrow();
      return writeSessionHtmlReport(sessionDir(opts.projectDir, sessionId), sessionId);
    },
  };
}

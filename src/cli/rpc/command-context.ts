import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EventBus } from '../../engine/events/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import { transitionAndSave } from '../../engine/orchestrator/state-ops.js';
import { clearPendingQueue } from '../../engine/orchestrator/queue.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../engine/orchestrator/run/run.js';
import type { RuntimeCommandContext } from '../../core/runtime/commands/types.js';
import { createCommandContext } from '../../app/command-context-factory.js';
import { buildRewindAction } from '../../core/state/build-rewind-action.js';
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
  return createCommandContext({
    projectDir: () => opts.projectDir,
    getConfig: opts.getConfig,
    saveConfig: (config) => {
      opts.setConfig(config);
      return { ok: true };
    },
    getSessionId: () => opts.getSessionId(),
    noActiveSession: () => rpcCommandContextError.noActiveSession(),
    noConfig: () => rpcCommandContextError.noActiveSession(),
    openOverlay: (type) => pushMessage(`Overlay ${type} is not available in RPC mode.`),
    navigateHome: () => pushMessage('Navigation is not available in RPC mode.'),
    quit: () => opts.abort(),
    setFeedbackMessage: pushMessage,
    setFeedbackError: pushError,
    refreshDetection: async () => {
      pushMessage('Tool detection refresh is not available in RPC mode.');
    },
    getCurrentPhase: opts.getPhase,
    requestRewind: (request) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      const { action } = buildRewindAction(request, opts.projectDir, sessionId, state);
      transitionAndSave(opts.projectDir, sessionId, state, action);
      opts.abort(WORKFLOW_REWIND_ABORT_REASON);
      return true;
    },
    requestTaskRedo: (taskId) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      const { action } = buildRewindAction(
        { target: 'task', taskId },
        opts.projectDir,
        sessionId,
        state,
      );
      transitionAndSave(opts.projectDir, sessionId, state, action);
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
  });
}

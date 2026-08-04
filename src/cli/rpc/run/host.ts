import type { Readable, Writable } from 'node:stream';
import type { Phase } from '../../../core/schemas/enums.js';
import { defaultApprovalConfig } from '../../../core/schemas/config.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Planner } from '../../../engine/planners/types.js';
import type { Implementer } from '../../../engine/implementers/types.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import type { ClearQueueHandler, QueueHandler } from '../../../engine/orchestrator/types.js';
import {
  runWorkflow,
  WORKFLOW_REWIND_ABORT_REASON,
} from '../../../engine/orchestrator/run/workflow.js';
import type { RunWorkflowOptions } from '../../../engine/orchestrator/run/init.js';
import { loadState } from '../../../core/state/persistence.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { eventPhase, isInfrastructurePhaseEvent } from '../../../core/event-phase.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { resolveRunConfigWithBase, type ResolvedRunConfig } from '../../build-overrides.js';
import { installTerminalOutputErrorGuard } from '../../../lib/terminal/control.js';
import { createApprovalGate, createGate } from '../gates.js';
import { createCommandReader } from '../reader.js';
import { createResponseWriter } from '../writer.js';
import { createWorkflowCallbacks } from '../callbacks.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { createCommandHandler } from '../dispatch.js';
import { createRpcBriefReviewDraftSaver } from './brief-review.js';
import { createRpcRecoveryHandlers } from './recovery.js';
import { createRpcStatusProjection, pendingQueueDepth } from './status.js';

type RunWorkflowFn = (opts: RunWorkflowOptions) => Promise<unknown>;

export interface RunRpcDeps {
  input?: Readable | NodeJS.ReadableStream | undefined;
  output?: Writable | NodeJS.WritableStream | undefined;
  runWorkflow?: RunWorkflowFn | undefined;
}

export interface RunRpcOptions {
  prepared: PreparedExecution;
  planner?: Planner | undefined;
  implementer?: Implementer | undefined;
  deps?: RunRpcDeps | undefined;
}

const rpcShutdownError = {
  shuttingDown: (reason: string) => error('rpc-shutting-down', reason, { reason }),
} as const;

function activeTurnGateError(reason: unknown): Error {
  const reasonText = String(reason ?? 'aborted');
  if (reasonText === WORKFLOW_REWIND_ABORT_REASON) {
    return error('operation-aborted', WORKFLOW_REWIND_ABORT_REASON);
  }
  return rpcShutdownError.shuttingDown(reasonText);
}

function preparedRunConfig(
  prepared: PreparedExecution,
  loadPersistence: () => ResolvedRunConfig,
): ResolvedRunConfig {
  let persistence: ResolvedRunConfig | undefined;
  try {
    persistence = loadPersistence();
  } catch {
    persistence = undefined;
  }
  const getPersistence = (): ResolvedRunConfig => {
    persistence ??= loadPersistence();
    return persistence;
  };
  return {
    config: prepared.config,
    get persistedConfig() {
      return getPersistence().persistedConfig;
    },
    get persistenceSnapshot() {
      return getPersistence().persistenceSnapshot;
    },
  };
}

function runConfigWithEffectiveConfig(
  current: ResolvedRunConfig,
  config: ResolvedRunConfig['config'],
): ResolvedRunConfig {
  return {
    config,
    get persistedConfig() {
      return current.persistedConfig;
    },
    get persistenceSnapshot() {
      return current.persistenceSnapshot;
    },
  };
}

export async function runRpc(options: RunRpcOptions): Promise<void> {
  const { prepared, planner, implementer, deps = {} } = options;
  const projectDir = prepared.session.ref.projectDir;
  const sessionId = prepared.session.ref.sessionId;
  installTerminalOutputErrorGuard();
  let resolvedConfig = preparedRunConfig(prepared, () =>
    resolveRunConfigWithBase({ projectDir, opts: {} }),
  );
  let sessionApprovalEnabled = prepared.config.approval?.enabled !== false;
  let rpcClosed = false;
  let activeSessionId = sessionId;

  const writer = createResponseWriter({
    stream: deps.output ?? process.stdout,
    onClose: (reason) => shutdownRpc(reason),
    getPersistTranscript: () => prepared.config.workflow.persistTranscript,
  });

  const bus = createEventBus();
  const approvalGate = createApprovalGate();
  const messageGate = createGate<string>();
  const recoveryGate = createGate<string>();
  const transportController = new AbortController();
  const runWorkflowImpl = deps.runWorkflow ?? runWorkflow;
  let currentPhase: Phase = prepared.runtime.resumeState?.phase ?? 'idle';
  let queueHandler: QueueHandler | null = null;
  let clearQueueHandler: ClearQueueHandler | null = null;
  let abortTurnHandler: (() => void) | null = null;
  let activeTurnController: AbortController | null = null;

  const shutdownRpc = (reason: string) => {
    if (rpcClosed) return;
    rpcClosed = true;
    abortActiveTurn(reason);
    transportController.abort(rpcShutdownError.shuttingDown(reason));
    // biome-ignore-start lint/nursery/noFloatingPromises: gate reject returns boolean, not a Promise
    approvalGate.reject(rpcShutdownError.shuttingDown(reason));
    messageGate.reject(rpcShutdownError.shuttingDown(reason));
    recoveryGate.reject(rpcShutdownError.shuttingDown(reason));
    // biome-ignore-end lint/nursery/noFloatingPromises: gate reject returns boolean, not a Promise
  };

  function abortActiveTurn(reason?: unknown): void {
    abortTurnHandler?.();
    const abortReason = reason ?? 'aborted';
    activeTurnController?.abort(abortReason);
    const gateError = activeTurnGateError(abortReason);
    // biome-ignore-start lint/nursery/noFloatingPromises: gate reject returns boolean, not a Promise
    approvalGate.reject(gateError);
    messageGate.reject(gateError);
    recoveryGate.reject(gateError);
    // biome-ignore-end lint/nursery/noFloatingPromises: gate reject returns boolean, not a Promise
  }

  bus.subscribe((event) => {
    if (!isInfrastructurePhaseEvent(event)) {
      const phase = eventPhase(event);
      if (phase) currentPhase = phase;
    }
    writer.event(event);
  });

  const readCurrentState = (): WorkflowState | null => {
    return loadState({ projectDir, sessionId: activeSessionId });
  };

  const resolveSessionId = (): string => activeSessionId;

  const saveBriefDraft = createRpcBriefReviewDraftSaver({
    projectDir,
    resolveSessionId,
    readCurrentState,
    bus,
    setActiveSessionId: (id) => {
      activeSessionId = id;
    },
  });

  const { writeStatus, waitForApproval, waitForMessage } = createRpcStatusProjection({
    readCurrentState,
    getActiveSessionId: () => activeSessionId,
    getCurrentPhase: () => currentPhase,
    getQueueHandler: () => queueHandler,
    approvalGate,
    messageGate,
    recoveryGate,
    transportAborted: () => transportController.signal.aborted,
    writer,
    isRpcClosed: () => rpcClosed,
    saveBriefDraft,
  });

  const { receiveRecoveryAction, requestRecoveryAction } = createRpcRecoveryHandlers({
    projectDir,
    resolveSessionId,
    setActiveSessionId: (id) => {
      activeSessionId = id;
    },
    readCurrentState,
    executionConfig: () => prepared.config,
    active: prepared.session.active,
    bus,
    recoveryGate,
    writer,
    isRpcClosed: () => rpcClosed,
    transportAborted: () => transportController.signal.aborted,
  });

  const triggerAbort = (reason?: unknown) => {
    shutdownRpc(reason != null ? String(reason) : 'aborted');
  };

  let rewindFeedback: string | undefined;
  const handleCommand = createCommandHandler({
    projectDir,
    getPreparedExecution: () => prepared,
    getSessionId: () => activeSessionId,
    getState: readCurrentState,
    getRunConfig: () => resolvedConfig,
    setRunConfig: (next) => {
      const approval = next.config.approval ?? defaultApprovalConfig();
      resolvedConfig =
        (approval.enabled !== false) === sessionApprovalEnabled
          ? next
          : {
              ...next,
              config: {
                ...next.config,
                approval: { ...approval, enabled: sessionApprovalEnabled },
              },
            };
    },
    reloadRunConfig: () => resolveRunConfigWithBase({ projectDir, opts: {} }),
    setEffectiveConfig: (config) => {
      resolvedConfig = runConfigWithEffectiveConfig(resolvedConfig, config);
    },
    getApprovalEnabled: () => sessionApprovalEnabled,
    setApprovalEnabled: (enabled) => {
      sessionApprovalEnabled = enabled;
    },
    getPhase: () => currentPhase,
    getQueueHandler: () => queueHandler,
    getClearQueueHandler: () => clearQueueHandler,
    abort: triggerAbort,
    abortTurn: abortActiveTurn,
    bus,
    approvalGate,
    messageGate,
    receiveRecoveryAction,
    writeStatus,
    writer,
    pendingQueueDepth,
    setRewindFeedback: (feedback) => {
      rewindFeedback = feedback;
    },
  });

  const reader = createCommandReader({
    stream: deps.input ?? process.stdin,
    onCommand: handleCommand,
    onError: (message) =>
      writer.error(message, { transcriptSensitive: true, summary: 'Invalid RPC frame.' }),
    onClose: () => shutdownRpc('stdin closed unexpectedly'),
  });

  try {
    let stateForRun = prepared.runtime.resumeState;
    let retryProfileOverride: string | undefined;
    let retryProfileOverrideTaskId: TaskId | undefined;
    while (!transportController.signal.aborted) {
      if (stateForRun?.pendingRecovery) {
        const recovery = await requestRecoveryAction(stateForRun);
        if (!recovery.shouldRun) return;
        stateForRun = recovery.state;
        retryProfileOverride = recovery.retryProfileOverride;
        retryProfileOverrideTaskId = recovery.retryProfileOverrideTaskId;
      }

      const callbacks = createWorkflowCallbacks({
        waitForApproval,
        waitForMessage,
        reportError: (message) => writer.error(message),
      });
      const latestState = readCurrentState();
      if (latestState) stateForRun = latestState;
      const turnController = new AbortController();
      activeTurnController = turnController;
      const rewindFeedbackForRun = rewindFeedback;
      rewindFeedback = undefined;
      await runWorkflowImpl({
        prepared,
        getApprovalEnabled: () => sessionApprovalEnabled,
        eventBus: bus,
        sinks: {
          setAbortHandler: (handler) => {
            abortTurnHandler = handler;
          },
          setQueueHandler: (handler) => {
            queueHandler = handler;
          },
          setClearQueueHandler: (handler) => {
            clearQueueHandler = handler;
          },
        },
        modelCache: modelCacheStore,
        drainPendingAttachments: () => attachmentsStore.drain(),
        signal: turnController.signal,
        callbacks,
        savedState: stateForRun,
        _planner: planner,
        _implementer: implementer,
        ...(rewindFeedbackForRun !== undefined && { rewindFeedback: rewindFeedbackForRun }),
        ...(retryProfileOverride !== undefined && { retryProfileOverride }),
        ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
      });
      if (activeTurnController === turnController) activeTurnController = null;
      retryProfileOverride = undefined;
      retryProfileOverrideTaskId = undefined;

      if (transportController.signal.aborted) return;
      const state = loadState({ projectDir, sessionId: activeSessionId });
      if (!state?.pendingRecovery && !state?.rewindPending) return;
      stateForRun = state;
    }
  } catch (err) {
    writer.error(toErrorMessage(err));
    throw err;
  } finally {
    reader.close();
  }
}

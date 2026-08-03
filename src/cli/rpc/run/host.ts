import type { Readable, Writable } from 'node:stream';
import type { Phase } from '../../../core/schemas/enums.js';
import { defaultApprovalConfig } from '../../../core/schemas/config.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { Planner } from '../../../engine/planners/types.js';
import type { Implementer } from '../../../engine/implementers/types.js';
import type { CliStartGates } from '../../../engine/runners/start-gate.js';
import type { ClearQueueHandler, QueueHandler } from '../../../engine/orchestrator/types.js';
import {
  runWorkflow,
  WORKFLOW_REWIND_ABORT_REASON,
} from '../../../engine/orchestrator/run/workflow.js';
import type { RunWorkflowOptions } from '../../../engine/orchestrator/run/init.js';
import { loadState } from '../../../core/state/persistence.js';
import { readActive } from '../../../core/sessions/lifecycle.js';
import { configForSessionTranscriptPolicy } from '../../../core/sessions/io.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { eventPhase, isInfrastructurePhaseEvent } from '../../../core/event-phase.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { resolveRunConfigWithBase } from '../../build-overrides.js';
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
  feature: string;
  projectDir: string;
  opts: WorkflowOpts;
  savedState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  planner?: Planner | undefined;
  implementer?: Implementer | undefined;
  plannerContext?: string | undefined;
  trustedCliGates?: CliStartGates | undefined;
  deps?: RunRpcDeps | undefined;
}

const rpcShutdownError = {
  shuttingDown: (reason: string) => error('rpc-shutting-down', reason, { reason }),
} as const;

function currentSessionId(projectDir: string, sessionId: string | undefined): string | undefined {
  return sessionId ?? readActive(projectDir) ?? undefined;
}

function activeTurnGateError(reason: unknown): Error {
  const reasonText = String(reason ?? 'aborted');
  if (reasonText === WORKFLOW_REWIND_ABORT_REASON) {
    return error('operation-aborted', WORKFLOW_REWIND_ABORT_REASON);
  }
  return rpcShutdownError.shuttingDown(reasonText);
}

export async function runRpc(options: RunRpcOptions): Promise<void> {
  const {
    feature,
    projectDir,
    opts,
    savedState,
    sessionId,
    planner,
    implementer,
    plannerContext,
    trustedCliGates,
    deps = {},
  } = options;
  installTerminalOutputErrorGuard();
  let resolvedConfig = resolveRunConfigWithBase({ projectDir, opts });
  let sessionApprovalEnabled = resolvedConfig.config.approval?.enabled !== false;
  let rpcClosed = false;
  let activeSessionId = currentSessionId(projectDir, sessionId);

  function activeConfig() {
    return configForSessionTranscriptPolicy(
      resolvedConfig.config,
      activeSessionId === undefined ? undefined : { projectDir, sessionId: activeSessionId },
    );
  }

  const writer = createResponseWriter({
    stream: deps.output ?? process.stdout,
    onClose: (reason) => shutdownRpc(reason),
    getPersistTranscript: () => activeConfig().workflow.persistTranscript,
  });

  const bus = createEventBus();
  const approvalGate = createApprovalGate();
  const messageGate = createGate<string>();
  const recoveryGate = createGate<string>();
  const transportController = new AbortController();
  const runWorkflowImpl = deps.runWorkflow ?? runWorkflow;
  let currentPhase: Phase = savedState?.phase ?? 'idle';
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
    const id = activeSessionId ?? currentSessionId(projectDir, sessionId);
    return id ? loadState({ projectDir, sessionId: id }) : null;
  };

  const resolveSessionId = (): string | undefined =>
    activeSessionId ?? currentSessionId(projectDir, sessionId);

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
    activeConfig,
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
    reloadRunConfig: () => resolveRunConfigWithBase({ projectDir, opts }),
    setEffectiveConfig: (config) => {
      resolvedConfig = { ...resolvedConfig, config };
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
    let stateForRun = savedState;
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
      const effectiveConfig = activeConfig();

      const turnController = new AbortController();
      activeTurnController = turnController;
      const rewindFeedbackForRun = rewindFeedback;
      rewindFeedback = undefined;
      await runWorkflowImpl({
        feature,
        plannerContext,
        projectDir,
        config: effectiveConfig,
        getApprovalEnabled: () => sessionApprovalEnabled,
        eventBus: bus,
        allowHooks: opts.allowHooks ?? false,
        allowRepoRunners: opts.allowRepoRunners ?? false,
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
        sessionId: activeSessionId,
        _planner: planner,
        _implementer: implementer,
        trustedCliGates,
        ...(rewindFeedbackForRun !== undefined && { rewindFeedback: rewindFeedbackForRun }),
        ...(retryProfileOverride !== undefined && { retryProfileOverride }),
        ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
      });
      if (activeTurnController === turnController) activeTurnController = null;
      retryProfileOverride = undefined;
      retryProfileOverrideTaskId = undefined;

      if (transportController.signal.aborted) return;
      const savedSessionId = activeSessionId ?? readActive(projectDir) ?? undefined;
      const state = savedSessionId ? loadState({ projectDir, sessionId: savedSessionId }) : null;
      if (!state?.pendingRecovery && !state?.rewindPending) return;
      activeSessionId = savedSessionId;
      stateForRun = state;
    }
  } catch (err) {
    writer.error(toErrorMessage(err));
    throw err;
  } finally {
    reader.close();
  }
}

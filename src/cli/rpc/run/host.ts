import type { Readable, Writable } from 'node:stream';
import type { Phase } from '../../../core/schemas/enums.js';
import { defaultApprovalConfig } from '../../../core/schemas/config.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type { RecoveryResultV1 } from '../../../core/schemas/brief-recovery.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { RewindEventSchema } from '../../../core/state/rewind-event.js';
import { buildRewindAction, type RewindTarget } from '../../../core/state/build-rewind-action.js';
import { appendProtectedEngineEvent } from '../../../core/sessions/log-writer.js';
import type { Planner } from '../../../engine/planners/types.js';
import type { Implementer } from '../../../engine/implementers/types.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import type { ClearQueueHandler, QueueHandler } from '../../../engine/orchestrator/types.js';
import {
  runWorkflow,
  WORKFLOW_REWIND_ABORT_REASON,
} from '../../../engine/orchestrator/run/workflow.js';
import type { RunWorkflowOptions } from '../../../engine/orchestrator/run/init.js';
import { loadStateForResume } from '../../../core/state/persistence.js';
import { readStateAuthority } from '../../../core/state/authority.js';
import type { ResumeLoadAuthority, StateAuthorityReceipt } from '../../../core/state/types.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { eventPhase, isInfrastructurePhaseEvent } from '../../../core/event-phase.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { resolveRunConfigWithBase, type ResolvedRunConfig } from '../../build-overrides.js';
import { installTerminalOutputErrorGuard } from '../../../lib/terminal/control.js';
import { createApprovalGate, createGate } from '../gates.js';
import { createCommandReader, type RpcEnvelopeError } from '../reader.js';
import { createResponseWriter } from '../writer.js';
import { createWorkflowCallbacks } from '../callbacks.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { createCommandHandler } from '../dispatch.js';
import { createRpcRecoveryHandlers } from './recovery.js';
import { createRpcStatusProjection, pendingQueueDepth } from './status.js';
import { projectBriefRecovery } from '../../../engine/orchestrator/planning/brief-recovery-controller.js';
import { recoveryResultFromProjection } from '../../../engine/orchestrator/planning/brief-review-gate.js';
import { transitionAndSave } from '../../../engine/orchestrator/state-ops.js';

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

type OwnedState = Readonly<{
  state: WorkflowState;
  receipt: StateAuthorityReceipt;
}>;

function loadOwnedStateWithAuthority(
  ref: Readonly<{ projectDir: string; sessionId: string }>,
): OwnedState | null {
  let receipt: StateAuthorityReceipt | null;
  try {
    receipt = readStateAuthority(ref);
  } catch {
    return null;
  }
  if (receipt === null) return null;

  const authority: ResumeLoadAuthority = {
    kind: 'fenced',
    receipt,
    promotedFromVersion: null,
  };
  try {
    const loaded = loadStateForResume({ ref, authority });
    return loaded.kind === 'loaded' ? { state: loaded.state, receipt } : null;
  } catch {
    // A concurrently advanced owner receipt is an observational miss. The
    // next status/recovery read retries against the latest committed receipt.
    return null;
  }
}

function loadOwnedState(
  ref: Readonly<{ projectDir: string; sessionId: string }>,
): WorkflowState | null {
  return loadOwnedStateWithAuthority(ref)?.state ?? null;
}

type RpcRecoveryRead = Readonly<{
  projection: BriefRecoveryProjectionV1;
  result: RecoveryResultV1;
}>;

function recoveryReadFromState(
  ref: Readonly<{ projectDir: string; sessionId: string }>,
  state: WorkflowState | null,
): RpcRecoveryRead | null {
  if (state?.briefRecovery === undefined || state.briefRecovery === null) return null;
  const stateRevision = state.stateRevision;
  if (stateRevision === undefined) return null;

  try {
    const projection = projectBriefRecovery({
      sessionId: ref.sessionId,
      now: new Date().toISOString(),
      state: {
        stateVersion: state.stateVersion,
        stateRevision,
        stateFence: state.stateFence ?? { token: 0, ownerId: 'rpc-recovery' },
        phase: state.phase,
        briefRecovery: state.briefRecovery,
      },
    });
    return {
      projection,
      result: recoveryResultFromProjection(projection),
    };
  } catch {
    return null;
  }
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

  const readCurrentState = (): WorkflowState | null => {
    return loadOwnedState({ projectDir, sessionId: activeSessionId });
  };

  const readRecovery = (): RpcRecoveryRead | null => {
    const ref = { projectDir, sessionId: activeSessionId };
    return recoveryReadFromState(ref, loadOwnedState(ref));
  };

  const readAuthoritativeState = (): Readonly<{
    stateVersion: 4;
    projection: BriefRecoveryProjectionV1;
  }> | null => {
    const recovery = readRecovery();
    return recovery === null ? null : { stateVersion: 4, projection: recovery.projection };
  };

  const writer = createResponseWriter({
    stream: deps.output ?? process.stdout,
    onClose: (reason) => shutdownRpc(reason),
    getPersistTranscript: () => prepared.config.workflow.persistTranscript,
  });

  const bus = createEventBus();
  const approvalGate = createApprovalGate({
    getBriefReviewProjection: () => readRecovery()?.projection ?? null,
  });
  const messageGate = createGate<string>();
  const recoveryGate = createGate<string>();
  const transportController = new AbortController();
  const runWorkflowImpl = deps.runWorkflow ?? runWorkflow;
  let currentPhase: Phase = prepared.runtime.resumeState?.phase ?? 'idle';
  let queueHandler: QueueHandler | null = null;
  let clearQueueHandler: ClearQueueHandler | null = null;
  let abortTurnHandler: (() => void) | null = null;
  let activeTurnController: AbortController | null = null;
  let rewindFeedback: string | undefined;

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

  const requestRewind = (request: RewindTarget): boolean => {
    const ref = { projectDir, sessionId: activeSessionId };
    const owned = loadOwnedStateWithAuthority(ref);
    if (owned === null) return false;

    const { action, persistedAction, event } = buildRewindAction({
      request,
      ref,
      state: owned.state,
      persistEvent: false,
      persistTranscript: resolvedConfig.config.workflow.persistTranscript,
    });
    transitionAndSave(ref, owned.state, persistedAction, {
      authority: owned.receipt,
      expectedRevision: owned.state.stateRevision,
    });
    appendProtectedEngineEvent(ref, event, RewindEventSchema);
    bus.publish(event);
    if (action.type === 'REWIND_TO_SPEC' || action.type === 'REWIND_TO_PLAN') {
      rewindFeedback = action.comment;
    }
    abortActiveTurn(WORKFLOW_REWIND_ABORT_REASON);
    return true;
  };

  const requestTaskRedo = (taskId: string): boolean => requestRewind({ target: 'task', taskId });

  bus.subscribe((event) => {
    if (!isInfrastructurePhaseEvent(event)) {
      const phase = eventPhase(event);
      if (phase) currentPhase = phase;
    }
    writer.event(event);
  });

  const resolveSessionId = (): string => activeSessionId;

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
    getRecoveryProjection: () => readRecovery()?.projection ?? null,
    getRecoveryResult: () => readRecovery()?.result ?? null,
  });

  const { receiveRecoveryAction, requestRecoveryAction } = createRpcRecoveryHandlers({
    projectDir,
    resolveSessionId,
    setActiveSessionId: (id) => {
      activeSessionId = id;
    },
    readCurrentState,
    getAuthority: () => {
      try {
        return readStateAuthority({ projectDir, sessionId: activeSessionId });
      } catch {
        return null;
      }
    },
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
    bus,
    approvalGate,
    messageGate,
    receiveRecoveryAction,
    writeStatus,
    writer,
    pendingQueueDepth,
    requestRewind,
    requestTaskRedo,
  });

  const reader = createCommandReader({
    stream: deps.input ?? process.stdin,
    onCommand: handleCommand,
    onError: () => {},
    onTypedError: (rpcError: RpcEnvelopeError) => {
      writer.error(rpcError.message, {
        transcriptSensitive: true,
        summary: 'Invalid RPC frame.',
        data: {
          code: rpcError.code,
          ...(rpcError.details === undefined ? {} : { details: rpcError.details }),
        },
      });
    },
    getAuthoritativeState: readAuthoritativeState,
    onClose: () => shutdownRpc('stdin closed unexpectedly'),
  });

  try {
    let stateForRun: WorkflowState | undefined = readCurrentState() ?? prepared.runtime.resumeState;
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
        getRecoveryProjection: () => readRecovery()?.projection ?? null,
        getRecoveryResult: () => readRecovery()?.result ?? null,
      });
      const latestState = readCurrentState();
      stateForRun = latestState ?? undefined;
      if (latestState !== null) currentPhase = latestState.phase;
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
      const state = readCurrentState();
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

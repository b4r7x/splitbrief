import type { Readable, Writable } from 'node:stream';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';
import { RecoveryActionSchema, type Phase } from '../../core/schemas/enums.js';
import { isQueuedMessagePendingDelivery } from '../../core/queue-state.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { Planner } from '../../engine/planners/types.js';
import type { Implementer } from '../../engine/implementers/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import { runWorkflow } from '../../engine/orchestrator/run/workflow.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import type { CollectedReadiness } from '../../core/readiness/collect.js';
import { loadState } from '../../core/state/persistence.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { createEventBus } from '../../engine/events/bus.js';
import { eventPhase, isInfrastructurePhaseEvent } from '../../engine/events/schema.js';
import { applyRecoveryAction } from '../../engine/orchestrator/recovery/actions.js';
import {
  finalizeRecoveryResult,
  loadPendingRecoveryState,
} from '../../engine/orchestrator/recovery/driver.js';
import { publishRecoveryPrompted } from '../../engine/orchestrator/events.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { error } from '../../utils/error.js';
import { resolveRunConfig } from '../build-overrides.js';
import { installTerminalOutputErrorGuard } from '../../lib/terminal/control.js';
import { createApprovalGate, createGate } from './gates.js';
import { createCommandReader } from './reader.js';
import { createResponseWriter } from './writer.js';
import { rpcError } from './errors.js';
import { createWorkflowCallbacks } from './callbacks.js';
import { createCommandHandler } from './dispatch.js';

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
  readiness?: CollectedReadiness | undefined;
  planner?: Planner | undefined;
  implementer?: Implementer | undefined;
  plannerContext?: string | undefined;
  deps?: RunRpcDeps | undefined;
}

export const rpcShutdownError = {
  shuttingDown: (reason: string) => error('rpc-shutting-down', reason, { reason }),
} as const;

function currentSessionId(projectDir: string, sessionId: string | undefined): string | undefined {
  return sessionId ?? readActive(projectDir) ?? undefined;
}

function pendingQueueDepth(state: WorkflowState | null): number {
  return state?.messageQueue.filter(isQueuedMessagePendingDelivery).length ?? 0;
}

function pendingGateType(
  approval: { isPending(): boolean },
  message: { isPending(): boolean },
  recovery: { isPending(): boolean },
): 'approval' | 'message' | 'recovery' | null {
  if (approval.isPending()) return 'approval';
  if (message.isPending()) return 'message';
  if (recovery.isPending()) return 'recovery';
  return null;
}

export async function runRpc(options: RunRpcOptions): Promise<void> {
  const {
    feature,
    projectDir,
    opts,
    savedState,
    sessionId,
    readiness,
    planner,
    implementer,
    plannerContext,
    deps = {},
  } = options;
  installTerminalOutputErrorGuard();
  let config = resolveRunConfig({ projectDir, opts, readiness });
  let rpcClosed = false;

  const writer = createResponseWriter({
    stream: deps.output ?? process.stdout,
    onClose: (reason) => shutdownRpc(reason),
    getPersistTranscript: () => config.workflow.persistTranscript,
  });

  const bus = createEventBus();
  const approvalGate = createApprovalGate();
  const messageGate = createGate<string>();
  const recoveryGate = createGate<string>();
  const abortController = new AbortController();
  const runWorkflowImpl = deps.runWorkflow ?? runWorkflow;
  let activeSessionId = currentSessionId(projectDir, sessionId);
  let currentPhase: Phase = savedState?.phase ?? 'idle';
  let queueHandler: QueueHandler | null = null;
  let clearQueueHandler: ClearQueueHandler | null = null;
  let abortTurnHandler: (() => void) | null = null;

  const shutdownRpc = (reason: string) => {
    if (rpcClosed) return;
    rpcClosed = true;
    abortTurnHandler?.();
    abortController.abort(rpcShutdownError.shuttingDown(reason));
    // biome-ignore-start lint/nursery/noFloatingPromises: gate reject returns boolean, not a Promise
    approvalGate.reject(rpcShutdownError.shuttingDown(reason));
    messageGate.reject(rpcShutdownError.shuttingDown(reason));
    recoveryGate.reject(rpcShutdownError.shuttingDown(reason));
    // biome-ignore-end lint/nursery/noFloatingPromises: gate reject returns boolean, not a Promise
  };

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

  const writeStatus = () => {
    const state = readCurrentState();
    writer.status({
      sessionId: activeSessionId ?? null,
      phase: state?.phase ?? currentPhase,
      state,
      queueDepth: pendingQueueDepth(state),
      queueReady: queueHandler !== null,
      pending: pendingGateType(approvalGate, messageGate, recoveryGate),
      aborted: abortController.signal.aborted,
    });
  };

  const waitForRecoveryAction = (): Promise<string> => {
    if (rpcClosed) throw rpcError.transportClosed();
    return recoveryGate.wait();
  };

  const receiveRecoveryAction = (action: string): boolean => {
    if (!recoveryGate.isPending()) {
      writer.error(`No pending recovery prompt for action: ${action}`);
      return false;
    }
    const state = readCurrentState();
    const issue = state?.pendingRecovery;
    if (!issue) {
      writer.error('No pending recovery issue is available.');
      return false;
    }
    const parsed = RecoveryActionSchema.safeParse(action);
    if (!parsed.success) {
      writer.error(`Invalid recovery action: ${action}`);
      return false;
    }
    if (!issue.availableActions.includes(parsed.data)) {
      writer.error(`Recovery action is not available for this issue: ${action}`);
      return false;
    }
    if (!recoveryGate.resolve(action)) {
      writer.error(`Recovery action already resolved: ${action}`);
      return false;
    }
    return true;
  };

  const waitForApproval = async (data: unknown) => {
    if (rpcClosed) throw rpcError.transportClosed();
    const pending = approvalGate.wait();
    writer.status(data);
    return pending;
  };

  const waitForMessage = async (data: unknown) => {
    if (rpcClosed) throw rpcError.transportClosed();
    const pending = messageGate.wait();
    writer.status(data);
    return pending;
  };

  const requestRecoveryAction = async (
    state: WorkflowState,
  ): Promise<{
    shouldRun: boolean;
    state: WorkflowState;
    retryProfileOverride?: string | undefined;
    retryProfileOverrideTaskId?: TaskId | undefined;
  }> => {
    const id = activeSessionId ?? currentSessionId(projectDir, sessionId);
    if (!id) {
      writer.error('No active session is available for recovery.');
      return { shouldRun: false, state };
    }

    activeSessionId = id;
    const latest = readCurrentState() ?? state;
    const issue = latest.pendingRecovery;
    if (!issue) return { shouldRun: true, state: latest };

    if (issue.status === 'paused') {
      return { shouldRun: false, state: latest };
    }

    const applyAction = async (action: string) => {
      const parsed = RecoveryActionSchema.safeParse(action);
      if (!parsed.success) {
        writer.error(`Invalid recovery action: ${action}`);
        return null;
      }

      const current = readCurrentState() ?? latest;
      const currentIssue = current.pendingRecovery;
      if (!currentIssue) return { shouldRun: true as const, state: current };

      const selectedImplementerProfile = currentIssue.selectedImplementerProfile;
      const retryProfileOverrideTaskId =
        currentIssue.taskId ?? current.tasks[current.currentTaskIndex]?.id;
      const result = applyRecoveryAction({
        projectDir,
        sessionId: id,
        state: current,
        action: parsed.data,
        bus,
        config,
        mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      });
      if (!result.ok) {
        writer.error(result.message);
        return null;
      }

      writer.ack('recovery', { action: result.action, status: result.status });
      if (result.status === 'aborted') {
        finalizeRecoveryResult({
          projectDir,
          sessionId: id,
          state: result.state,
          config,
          status: result.status,
        });
      }
      const retryProfileOverride = result.implementerProfile ?? selectedImplementerProfile;
      return {
        shouldRun: result.status !== 'paused' && result.status !== 'aborted',
        state: result.state,
        ...(retryProfileOverride !== undefined &&
          result.status === 'retry-current-task' && { retryProfileOverride }),
        ...(retryProfileOverride !== undefined &&
          result.status === 'retry-current-task' &&
          retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
      };
    };

    if (issue.status === 'applying') {
      const action = issue.selectedAction;
      if (!action) {
        writer.error('Recovery is applying but no action is selected.');
        return { shouldRun: false, state: latest };
      }
      const applied = await applyAction(action);
      if (!applied) return { shouldRun: false, state: latest };
      return applied;
    }

    const pending = loadPendingRecoveryState({ projectDir, sessionId: id }, latest);
    if (!pending.pending) return { shouldRun: true, state: pending.state };

    publishRecoveryPrompted(bus, pending.issue);
    writer.status({ pending: 'recovery', issue: pending.issue });

    while (!abortController.signal.aborted) {
      const action = await waitForRecoveryAction();
      const applied = await applyAction(action);
      if (!applied) continue;
      return applied;
    }

    return { shouldRun: false, state };
  };

  const triggerAbort = (reason?: unknown) => {
    shutdownRpc(reason != null ? String(reason) : 'aborted');
  };

  const handleCommand = createCommandHandler({
    projectDir,
    getSessionId: () => activeSessionId,
    getState: readCurrentState,
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
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
  });

  const reader = createCommandReader({
    stream: deps.input ?? process.stdin,
    onCommand: handleCommand,
    onError: (message) => writer.error(message),
    onClose: () => shutdownRpc('stdin closed unexpectedly'),
  });

  try {
    let stateForRun = savedState;
    let retryProfileOverride: string | undefined;
    let retryProfileOverrideTaskId: TaskId | undefined;
    while (!abortController.signal.aborted) {
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
        abort: triggerAbort,
      });
      const latestState = readCurrentState();
      if (latestState) stateForRun = latestState;

      await runWorkflowImpl({
        feature,
        plannerContext,
        projectDir,
        config,
        eventBus: bus,
        allowHooks: opts.allowHooks ?? false,
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
        signal: abortController.signal,
        callbacks,
        savedState: stateForRun,
        sessionId: activeSessionId,
        _planner: planner,
        _implementer: implementer,
        ...(retryProfileOverride !== undefined && { retryProfileOverride }),
        ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
      });
      retryProfileOverride = undefined;
      retryProfileOverrideTaskId = undefined;

      if (abortController.signal.aborted) return;
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

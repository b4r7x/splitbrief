import type { Readable, Writable } from 'node:stream';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';
import { RecoveryActionSchema, type Phase } from '../../core/schemas/enums.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { Planner } from '../../engine/planners/types.js';
import type { Implementer } from '../../engine/implementers/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import { runWorkflow } from '../../engine/orchestrator/run/run.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import type { CollectedReadiness } from '../../core/readiness/collect.js';
import { loadState } from '../../core/state/persistence.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { createEventBus } from '../../engine/events/bus.js';
import { eventPhase } from '../../engine/events/schema.js';
import { applyRecoveryAction } from '../../engine/orchestrator/recovery/actions.js';
import { publishRecoveryPrompted } from '../../engine/orchestrator/events.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { resolveRunConfig } from '../build-overrides.js';
import { createApprovalGate, createGate } from './gates.js';
import { createCommandReader } from './reader.js';
import { createResponseWriter } from './writer.js';
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

function currentSessionId(projectDir: string, sessionId: string | undefined): string | undefined {
  return sessionId ?? readActive(projectDir) ?? undefined;
}

function pendingQueueDepth(state: WorkflowState | null): number {
  return state?.messageQueue.filter((message) => !message.drainedAt).length ?? 0;
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
  let config = resolveRunConfig({ projectDir, opts, readiness });
  const writer = createResponseWriter(deps.output ?? process.stdout);
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
  const queuedRecoveryActions: string[] = [];

  bus.subscribe((event) => {
    const phase = eventPhase(event);
    if (phase) currentPhase = phase;
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
    const queued = queuedRecoveryActions.shift();
    if (queued) return Promise.resolve(queued);
    return recoveryGate.wait();
  };

  const receiveRecoveryAction = (action: string) => {
    if (recoveryGate.resolve(action)) return;
    queuedRecoveryActions.push(action);
  };

  const waitForApproval = async (data: unknown) => {
    const pending = approvalGate.wait();
    writer.status(data);
    return pending;
  };

  const waitForMessage = async (data: unknown) => {
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
    if (!state.pendingRecovery) return { shouldRun: true, state };
    const id = activeSessionId ?? currentSessionId(projectDir, sessionId);
    if (!id) {
      writer.error('No active session is available for recovery.');
      return { shouldRun: false, state };
    }

    activeSessionId = id;
    publishRecoveryPrompted(bus, state.pendingRecovery);
    writer.status({ pending: 'recovery', issue: state.pendingRecovery });

    while (!abortController.signal.aborted) {
      const action = await waitForRecoveryAction();
      const parsed = RecoveryActionSchema.safeParse(action);
      if (!parsed.success) {
        writer.error(`Invalid recovery action: ${action}`);
        continue;
      }

      const latest = readCurrentState() ?? state;
      const issue = latest.pendingRecovery;
      if (!issue) return { shouldRun: true, state: latest };
      const selectedImplementerProfile = issue.selectedImplementerProfile;
      const retryProfileOverrideTaskId = issue.taskId ?? latest.tasks[latest.currentTaskIndex]?.id;
      const result = applyRecoveryAction({
        projectDir,
        sessionId: id,
        state: latest,
        action: parsed.data,
        bus,
        config,
        mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      });
      if (!result.ok) {
        writer.error(result.message);
        continue;
      }

      writer.ack('recovery', { action: result.action, status: result.status });
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
    }

    return { shouldRun: false, state };
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
    abort: (reason?: unknown) => {
      abortTurnHandler?.();
      abortController.abort(reason);
    },
    bus,
    approvalGate,
    messageGate,
    receiveRecoveryAction,
    writeStatus,
    writer,
    pendingQueueDepth,
  });

  const stdinClosedError = new Error('stdin closed unexpectedly');

  const reader = createCommandReader({
    stream: deps.input ?? process.stdin,
    onCommand: handleCommand,
    onError: (message) => writer.error(message),
    onClose: () => {
      abortController.abort(stdinClosedError);
      approvalGate.reject(stdinClosedError);
      messageGate.reject(stdinClosedError);
      recoveryGate.reject(stdinClosedError);
    },
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
      });

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
      if (!state?.pendingRecovery) return;
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

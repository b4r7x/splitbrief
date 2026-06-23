import type { Readable, Writable } from 'node:stream';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';
import { RecoveryActionSchema, type Phase } from '../../core/schemas/enums.js';
import type { BriefReviewPromptKind } from '../../core/schemas/brief-review-command.js';
import { isQueuedMessagePendingDelivery } from '../../core/queue-state.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { Planner } from '../../engine/planners/types.js';
import type { Implementer } from '../../engine/implementers/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import {
  runWorkflow,
  WORKFLOW_REWIND_ABORT_REASON,
} from '../../engine/orchestrator/run/workflow.js';
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
import { runBriefQualityGate } from '../../engine/orchestrator/planning/brief-quality-gate.js';
import { readPersistedTasks } from '../../engine/orchestrator/planning/io.js';
import { transitionAndSave } from '../../engine/orchestrator/state-ops.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { truncateByChars } from '../../utils/truncate.js';
import { error, matches } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import { resolveRunConfigWithBase } from '../build-overrides.js';
import { installTerminalOutputErrorGuard } from '../../lib/terminal/control.js';
import { createApprovalGate, createGate } from './gates.js';
import type { ApprovalGatePrompt, BriefReviewDraftSaveResult } from './gates.js';
import { createCommandReader } from './reader.js';
import { createResponseWriter } from './writer.js';
import { rpcError } from './errors.js';
import { createWorkflowCallbacks } from './callbacks.js';
import { createCommandHandler } from './dispatch.js';

type RunWorkflowFn = (opts: RunWorkflowOptions) => Promise<unknown>;

const RPC_DRAFT_SAVE_ERROR_MAX_CHARS = 2000;

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

function approvalTypeFromStatus(data: unknown): BriefReviewPromptKind | undefined {
  if (!isRecord(data)) return undefined;
  const approvalType = data.approvalType;
  if (approvalType === 'spec' || approvalType === 'plan' || approvalType === 'briefs') {
    return approvalType;
  }
  return undefined;
}

function approvalFilePathFromStatus(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  return typeof data.filePath === 'string' ? data.filePath : undefined;
}

function boundedDraftSaveError(message: string): string {
  return truncateByChars(message, RPC_DRAFT_SAVE_ERROR_MAX_CHARS);
}

function withApprovalPromptStatus(data: unknown, prompt: ApprovalGatePrompt | null): unknown {
  if (!isRecord(data) || prompt === null) return data;
  return {
    ...data,
    promptId: prompt.promptId,
    allowedCommands: prompt.allowedCommands,
  };
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

function activeTurnGateError(reason: unknown): Error {
  const reasonText = String(reason ?? 'aborted');
  if (reasonText === WORKFLOW_REWIND_ABORT_REASON) {
    return error('operation-aborted', WORKFLOW_REWIND_ABORT_REASON);
  }
  return rpcShutdownError.shuttingDown(reasonText);
}

function isWorkflowRewindAbortError(err: unknown): boolean {
  return matches('operation-aborted')(err) && err.message === WORKFLOW_REWIND_ABORT_REASON;
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
  const resolvedConfig = resolveRunConfigWithBase({ projectDir, opts, readiness });
  let config = resolvedConfig.config;
  let persistedConfig = resolvedConfig.persistedConfig;
  let sessionApprovalEnabled = config.approval?.enabled !== false;
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
  const transportController = new AbortController();
  const runWorkflowImpl = deps.runWorkflow ?? runWorkflow;
  let activeSessionId = currentSessionId(projectDir, sessionId);
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

  const writeStatus = () => {
    const state = readCurrentState();
    const approvalPrompt = approvalGate.pendingPrompt();
    writer.status({
      sessionId: activeSessionId ?? null,
      phase: state?.phase ?? currentPhase,
      state,
      queueDepth: pendingQueueDepth(state),
      queueReady: queueHandler !== null,
      pending: pendingGateType(approvalGate, messageGate, recoveryGate),
      approvalPrompt,
      aborted: transportController.signal.aborted,
    });
  };

  const waitForRecoveryAction = (): Promise<string> => {
    if (rpcClosed) throw rpcError.transportClosed();
    return recoveryGate.wait();
  };

  const receiveRecoveryAction = (action: string): boolean => {
    if (!recoveryGate.isPending()) {
      writer.error(`No pending recovery prompt for action: ${action}`, {
        transcriptSensitive: true,
        summary: 'Recovery command rejected.',
      });
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
      writer.error(`Invalid recovery action: ${action}`, {
        transcriptSensitive: true,
        summary: 'Recovery command rejected.',
      });
      return false;
    }
    if (!issue.availableActions.includes(parsed.data)) {
      writer.error(`Recovery action is not available for this issue: ${action}`, {
        transcriptSensitive: true,
        summary: 'Recovery command rejected.',
      });
      return false;
    }
    if (!recoveryGate.resolve(action)) {
      writer.error(`Recovery action already resolved: ${action}`, {
        transcriptSensitive: true,
        summary: 'Recovery command rejected.',
      });
      return false;
    }
    return true;
  };

  const saveBriefDraft = async (tasksFilePath: string): Promise<BriefReviewDraftSaveResult> => {
    const id = activeSessionId ?? currentSessionId(projectDir, sessionId);
    if (!id) {
      return {
        ok: false,
        message: 'No active session is available for Task Brief draft save.',
      };
    }

    const state = readCurrentState();
    if (!state) {
      return {
        ok: false,
        message: 'No active workflow state is available for Task Brief draft save.',
      };
    }

    const persisted = await readPersistedTasks(tasksFilePath);
    if (!persisted.ok) {
      return { ok: false, message: boundedDraftSaveError(persisted.message) };
    }

    activeSessionId = id;
    const { report } = runBriefQualityGate({
      tasks: persisted.tasks,
      projectDir,
      sessionId: id,
      bus,
      phase: state.phase,
    });
    transitionAndSave({ projectDir, sessionId: id }, state, {
      type: 'BRIEFS_READY',
      tasks: persisted.tasks,
    });

    return {
      ok: true,
      qualityPassed: report.passed,
      qualityScore: report.score,
      issueCount: report.issues.length,
      taskCount: persisted.tasks.length,
    };
  };

  const waitForApproval = async (data: unknown) => {
    if (rpcClosed) throw rpcError.transportClosed();
    const approvalType = approvalTypeFromStatus(data);
    const filePath = approvalFilePathFromStatus(data);
    const pending = approvalGate.wait({
      approvalType,
      ...(approvalType === 'briefs' && filePath !== undefined
        ? { onSaveDraft: () => saveBriefDraft(filePath) }
        : {}),
    });
    writer.status(withApprovalPromptStatus(data, approvalGate.pendingPrompt()));
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
        writer.error(`Invalid recovery action: ${action}`, {
          transcriptSensitive: true,
          summary: 'Recovery command rejected.',
        });
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

    while (!transportController.signal.aborted) {
      let action: string;
      try {
        action = await waitForRecoveryAction();
      } catch (err) {
        if (isWorkflowRewindAbortError(err)) {
          return { shouldRun: true, state: readCurrentState() ?? state };
        }
        throw err;
      }
      const applied = await applyAction(action);
      if (!applied) continue;
      return applied;
    }

    return { shouldRun: false, state };
  };

  const triggerAbort = (reason?: unknown) => {
    shutdownRpc(reason != null ? String(reason) : 'aborted');
  };

  let rewindFeedback: string | undefined;
  const handleCommand = createCommandHandler({
    projectDir,
    getSessionId: () => activeSessionId,
    getState: readCurrentState,
    getConfig: () => config,
    getPersistedConfig: () => persistedConfig,
    setConfig: (next) => {
      config = next;
    },
    setPersistedConfig: (next) => {
      persistedConfig = next;
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

      const turnController = new AbortController();
      activeTurnController = turnController;
      const rewindFeedbackForRun = rewindFeedback;
      rewindFeedback = undefined;
      await runWorkflowImpl({
        feature,
        plannerContext,
        projectDir,
        config,
        getApprovalEnabled: () => sessionApprovalEnabled,
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
        signal: turnController.signal,
        callbacks,
        savedState: stateForRun,
        sessionId: activeSessionId,
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

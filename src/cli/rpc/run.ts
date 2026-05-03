import type { Readable, Writable } from 'node:stream';
import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { Planner } from '../../engine/planners/types.js';
import type { Implementer } from '../../engine/implementers/types.js';
import type { QueueHandler } from '../../engine/orchestrator/types.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/run.js';
import type { CollectedReadiness } from '../../core/readiness/collect.js';
import { loadConfig } from '../../core/config/load/load.js';
import { applyCLIOverrides } from '../../core/config/runtime/overrides.js';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';
import { RecoveryActionSchema } from '../../core/schemas/enums.js';
import { loadState } from '../../core/state/persistence.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { runWorkflow } from '../../engine/orchestrator/run/run.js';
import { createEventBus } from '../../engine/events/bus.js';
import { applyRecoveryAction } from '../../engine/orchestrator/recovery/actions.js';
import { publishRecoveryPrompted } from '../../engine/orchestrator/events.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { warnStderr } from '../../lib/warn.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { cliError } from '../errors.js';
import { buildCLIOverrides } from '../build-overrides.js';
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

function loadAndApplyConfig(projectDir: string, opts: WorkflowOpts, readiness: CollectedReadiness | undefined): Config {
  const loadedResult = readiness?.config
    ? { config: readiness.config, warnings: readiness.warnings }
    : loadConfig(projectDir);
  const { config: loaded, warnings } = loadedResult;
  for (const warning of warnings) warnStderr(`⚠ ${warning}`);

  const config = applyCLIOverrides(loaded, buildCLIOverrides(opts));

  if (!config) throw cliError('Failed to load config');
  return config;
}

function currentSessionId(projectDir: string, sessionId: string | undefined): string | undefined {
  return sessionId ?? readActive(projectDir) ?? undefined;
}

function pendingQueueDepth(state: WorkflowState | null): number {
  return state?.messageQueue.filter(message => !message.drainedAt).length ?? 0;
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

export async function runRpc(
  feature: string,
  projectDir: string,
  opts: WorkflowOpts,
  savedState?: WorkflowState | undefined,
  sessionId?: string | undefined,
  readiness?: CollectedReadiness | undefined,
  planner?: Planner | undefined,
  implementer?: Implementer | undefined,
  deps: RunRpcDeps = {},
): Promise<void> {
  let config = loadAndApplyConfig(projectDir, opts, readiness);
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
  let abortTurnHandler: (() => void) | null = null;
  const queuedRecoveryActions: string[] = [];

  bus.subscribe((event) => {
    if ('phase' in event) currentPhase = event.phase;
    writer.event(event);
  });

  const readCurrentState = (): WorkflowState | null => {
    const id = activeSessionId ?? currentSessionId(projectDir, sessionId);
    return id ? loadState(projectDir, id) : null;
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

  const requestRecoveryAction = async (state: WorkflowState): Promise<{ shouldRun: boolean; state: WorkflowState }> => {
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
      const result = applyRecoveryAction({
        projectDir,
        sessionId: id,
        state: latest,
        action: parsed.data,
        bus,
        mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      });
      if (!result.ok) {
        writer.error(result.message);
        continue;
      }

      writer.ack('recovery', { action: result.action, status: result.status });
      return {
        shouldRun: result.status !== 'paused' && result.status !== 'aborted',
        state: result.state,
      };
    }

    return { shouldRun: false, state };
  };

  const handleCommand = createCommandHandler({
    projectDir,
    getSessionId: () => activeSessionId,
    getState: readCurrentState,
    getConfig: () => config,
    setConfig: (next) => { config = next; },
    getPhase: () => currentPhase,
    getQueueHandler: () => queueHandler,
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

  const reader = createCommandReader(
    deps.input ?? process.stdin,
    handleCommand,
    (message) => writer.error(message),
  );

  try {
    let stateForRun = savedState;
    while (!abortController.signal.aborted) {
      if (stateForRun?.pendingRecovery) {
        const recovery = await requestRecoveryAction(stateForRun);
        if (!recovery.shouldRun) return;
        stateForRun = recovery.state;
      }

      const callbacks = createWorkflowCallbacks({
        waitForApproval,
        waitForMessage,
        reportError: (message) => writer.error(message),
      });

      await runWorkflowImpl({
        feature,
        projectDir,
        config,
        eventBus: bus,
        sinks: {
          setAbortHandler: (handler) => {
            abortTurnHandler = handler;
          },
          setQueueHandler: (handler) => {
            queueHandler = handler;
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
      });

      if (abortController.signal.aborted) return;
      const savedSessionId = activeSessionId ?? readActive(projectDir) ?? undefined;
      const state = savedSessionId ? loadState(projectDir, savedSessionId) : null;
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

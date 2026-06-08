import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../core/config/load/io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { writeLockfile, markExited, markCrashed, markSignaled } from './lockfile.js';
import { startHeartbeat } from './heartbeat.js';
import { runWorkflow } from '../orchestrator/run/workflow.js';
import { startIpcServer, type IpcServer } from './server.js';
import { createEventBus } from '../events/bus.js';
import type { OrchestratorCallbacks } from '../orchestrator/types.js';
import { normalizeLegacyMode } from '../../core/schemas/enums.js';
import { createIpcWorkflowBridge, type IpcWorkflowBridge } from './workflow-bridge.js';
import type { IpcPromptResponse } from './protocol.js';
import { resolveEffectiveConfig } from '../../core/config/runtime/effective-config.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { error } from '../../utils/error.js';
import {
  readIpcServerArgsFileConfined,
  SERVER_ARGS_FILE,
  type IpcServerArgs,
} from './server-args.js';
import { writeActive, clearActive } from '../../core/sessions/lifecycle.js';
import { clearStaleSession } from '../../core/sessions/guards.js';
import type { Summary } from '../../core/schemas/summary.js';
import { loadState } from '../../core/state/persistence.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskId } from '../../core/schemas/task.js';
import { RecoveryActionSchema } from '../../core/schemas/enums.js';
import { DEFAULT_WORKFLOW_MODE, type Config } from '../../core/schemas/config.js';
import { applyRecoveryAction } from '../orchestrator/recovery/actions.js';
import { loadPendingRecoveryState } from '../orchestrator/recovery/driver.js';
import { publishRecoveryPrompted } from '../orchestrator/events.js';
import { buildSummary } from '../orchestrator/summary.js';
import { runPricingIdentity } from '../../core/providers/pricing-identity.js';
import type { EventBus } from '../events/types.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';

const ipcServerEntryError = {
  promptResponseKindMismatch: (expected: string, actual: string) =>
    error(
      'ipc-prompt-response-kind-mismatch',
      `IPC prompt response kind mismatch: expected ${expected}, got ${actual}`,
      { expected, actual },
    ),
} as const;

function assertPromptResponse<T extends IpcPromptResponse['kind']>(
  response: IpcPromptResponse,
  kind: T,
): Extract<IpcPromptResponse, { kind: T }> {
  if (response.kind !== kind) {
    throw ipcServerEntryError.promptResponseKindMismatch(kind, response.kind);
  }
  return response as Extract<IpcPromptResponse, { kind: T }>;
}

function exitInvalidArgs(message: string): never {
  process.stderr.write(`server-entry: ${message}\n`);
  process.exit(1);
}

function readConfinedArgsFileOrExit(argsFile: string): IpcServerArgs {
  try {
    return readIpcServerArgsFileConfined(argsFile);
  } catch (err) {
    exitInvalidArgs(toErrorMessage(err));
  }
}

function getArgv(): IpcServerArgs {
  const [, , firstArg, secondArg, feature, mode, configPath] = process.argv;
  if (firstArg && !secondArg) {
    return readConfinedArgsFileOrExit(firstArg);
  }
  if (firstArg === '--args-file' && secondArg) {
    return readConfinedArgsFileOrExit(secondArg);
  }

  const sessionId = firstArg;
  const projectDir = secondArg;
  if (!sessionId || !projectDir || !feature || !mode || !configPath) {
    exitInvalidArgs('missing required argv');
  }
  const workflowMode = normalizeLegacyMode(mode);
  if (workflowMode === null) {
    exitInvalidArgs('invalid workflow mode');
  }

  const argsFile = join(sessionDir(projectDir, sessionId), SERVER_ARGS_FILE);
  if (existsSync(argsFile)) {
    try {
      return readIpcServerArgsFileConfined(argsFile, sessionId);
    } catch {
      // Legacy argv launches can still run without persisted overrides.
    }
  }

  return { sessionId, projectDir, feature, mode: workflowMode, configPath, overrides: {} };
}

const argv = getArgv();
const dir = sessionDir(argv.projectDir, argv.sessionId);

function makeCallbacks(ipcServer: IpcServer): OrchestratorCallbacks {
  return {
    onApprovalNeeded: async (approvalType: 'spec' | 'plan' | 'briefs', filePath: string) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'approval_needed', approvalType, filePath }),
        'approval_needed',
      );
      return {
        approved: response.approved,
        ...(response.comment !== undefined && { comment: response.comment }),
        ...(response.action !== undefined && { action: response.action }),
      };
    },
    onUserEditConflict: async (conflict) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'user_edit_conflict', conflict }),
        'user_edit_conflict',
      );
      return response.selectedAction;
    },
    onQuestionAsked: async (question, num, total) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({
          kind: 'question_asked',
          question,
          num,
          total,
        }),
        'question_asked',
      );
      return response.answer;
    },
    onBudgetExceeded: async (currentCost: number, maxBudget: number) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'budget_exceeded', currentCost, maxBudget }),
        'budget_exceeded',
      );
      return response.proceed;
    },
    onBudgetPaused: async (currentCost: number, maxBudget: number) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'budget_paused', currentCost, maxBudget }),
        'budget_paused',
      );
      return response.decision;
    },
    onContinuationNeeded: async (partialResponse: string) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'continuation_needed', partialResponse }),
        'continuation_needed',
      );
      return response.text;
    },
    onTieredApproval: async (request) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'tiered_approval', request }),
        'tiered_approval',
      );
      return response.response;
    },
    onCostApprovalNeeded: async (prediction) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'cost_approval', prediction }),
        'cost_approval',
      );
      return response.approved;
    },
    onTaskReviewNeeded: async (request) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'task_review', request }),
        'task_review',
      );
      return response.response;
    },
    onComplete: () => undefined,
  };
}

function applyDetachedRecoveryAction(
  bus: EventBus,
  config: Config,
  state: WorkflowState,
  action: RecoveryAction,
): {
  shouldRun: boolean;
  state: WorkflowState;
  retryProfileOverride?: string | undefined;
  retryProfileOverrideTaskId?: TaskId | undefined;
} | null {
  const currentIssue = state.pendingRecovery;
  const selectedImplementerProfile = currentIssue?.selectedImplementerProfile;
  const retryProfileOverrideTaskId =
    currentIssue?.taskId ?? state.tasks[state.currentTaskIndex]?.id;
  const result = applyRecoveryAction({
    projectDir: argv.projectDir,
    sessionId: argv.sessionId,
    state,
    action,
    bus,
    config,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
  });
  if (!result.ok) return null;
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

async function resolveDetachedPendingRecovery(
  ipcServer: IpcServer,
  bus: EventBus,
  config: Config,
  state: WorkflowState,
): Promise<{
  shouldRun: boolean;
  state: WorkflowState;
  retryProfileOverride?: string | undefined;
  retryProfileOverrideTaskId?: TaskId | undefined;
}> {
  const pending = loadPendingRecoveryState(
    { projectDir: argv.projectDir, sessionId: argv.sessionId },
    state,
  );
  if (!pending.pending) return { shouldRun: true, state: pending.state };
  if (pending.issue.status === 'paused') {
    return { shouldRun: false, state: pending.state };
  }

  const applyAction = (action: RecoveryAction) => {
    const current =
      loadState({ projectDir: argv.projectDir, sessionId: argv.sessionId }) ?? pending.state;
    return applyDetachedRecoveryAction(bus, config, current, action);
  };

  if (pending.issue.status === 'applying') {
    const action = pending.issue.selectedAction;
    if (!action) return { shouldRun: false, state: pending.state };
    const applied = applyAction(action);
    if (!applied) return { shouldRun: false, state: pending.state };
    return applied;
  }

  publishRecoveryPrompted(bus, pending.issue);

  while (true) {
    const response = assertPromptResponse(
      await ipcServer.requestClientPrompt({
        kind: 'recovery_needed',
        issue: {
          reason: pending.issue.reason,
          message: pending.issue.message,
          availableActions: pending.issue.availableActions,
          recommendedAction: pending.issue.recommendedAction,
        },
      }),
      'recovery_needed',
    );
    const parsed = RecoveryActionSchema.safeParse(response.action);
    if (!parsed.success) continue;
    const applied = applyAction(parsed.data);
    if (!applied) continue;
    return applied;
  }
}

function buildPausedSummary(state: WorkflowState, config: Config): Summary {
  const ident = runPricingIdentity(config);
  const parsedStart = Date.parse(state.startedAt);
  const startTime = Number.isFinite(parsedStart) ? parsedStart : Date.now();
  const plannerModel = state.plannerModel ?? ident.plannerModel;
  const implementerModel = state.implementerModel ?? ident.implementerModel;
  return buildSummary({
    feature: state.feature,
    state,
    startTime,
    plannerTool: state.plannerTool ?? ident.plannerTool,
    ...(plannerModel !== undefined ? { plannerModel } : {}),
    implementerTool: state.implementerTool ?? ident.implementerTool,
    ...(implementerModel !== undefined ? { implementerModel } : {}),
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    projectDir: argv.projectDir,
    sessionId: argv.sessionId,
  });
}

async function runWorkflowLoop(
  ipcServer: IpcServer,
  ipcBridge: IpcWorkflowBridge,
  ipcBus: EventBus,
  config: Config,
): Promise<Summary> {
  const sessionRef = { projectDir: argv.projectDir, sessionId: argv.sessionId };
  let stateForRun: WorkflowState | undefined = loadState(sessionRef) ?? undefined;
  let retryProfileOverride: string | undefined;
  let retryProfileOverrideTaskId: TaskId | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (stateForRun?.pendingRecovery) {
      const recovery = await resolveDetachedPendingRecovery(ipcServer, ipcBus, config, stateForRun);
      if (!recovery.shouldRun) {
        return buildPausedSummary(recovery.state, config);
      }
      stateForRun = recovery.state;
      retryProfileOverride = recovery.retryProfileOverride;
      retryProfileOverrideTaskId = recovery.retryProfileOverrideTaskId;
    }

    const summary = await runWorkflow({
      feature: argv.feature,
      plannerContext: argv.plannerContext,
      projectDir: argv.projectDir,
      config,
      headless: true,
      allowHooks: argv.allowHooks ?? false,
      sessionId: argv.sessionId,
      eventBus: ipcBus,
      sinks: ipcBridge.sinks,
      signal: ipcBridge.signal,
      callbacks: makeCallbacks(ipcServer),
      ...(stateForRun !== undefined && { savedState: stateForRun }),
      ...(retryProfileOverride !== undefined && { retryProfileOverride }),
      ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
    });
    retryProfileOverride = undefined;
    retryProfileOverrideTaskId = undefined;

    const saved = loadState(sessionRef);
    if (saved?.pendingRecovery) {
      stateForRun = saved;
      continue;
    }
    if (saved?.rewindPending) {
      stateForRun = saved;
      continue;
    }

    const completedTasks = summary.completedByLocal + summary.escalatedToPlanner + summary.skipped;
    const isIncomplete = summary.totalTasks > 0 && completedTasks < summary.totalTasks;
    if (summary.failed === 0 && !isIncomplete) {
      return summary;
    }

    const response = assertPromptResponse(
      await ipcServer.requestClientPrompt({
        kind: 'recovery_needed',
        issue: {
          reason: 'implementation-error' as const,
          message: `Workflow exited with ${summary.failed} failures${isIncomplete ? ` and ${summary.totalTasks - completedTasks} incomplete tasks` : ''}`,
          availableActions: ['retry-same-worker' as const, 'abort-workflow' as const],
          recommendedAction: 'retry-same-worker' as const,
        },
      }),
      'recovery_needed',
    );

    if (response.action === 'abort-workflow') {
      return summary;
    }
  }
}

async function main() {
  mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const authToken = randomBytes(32).toString('hex');
  await writeLockfile(dir, {
    pid: process.pid,
    startTimeMs: now,
    lastAliveMs: now,
    sessionId: argv.sessionId,
    mode: argv.mode,
    feature: argv.feature,
    authToken,
  });

  clearStaleSession(argv.projectDir);
  writeActive({ projectDir: argv.projectDir, sessionId: argv.sessionId });

  const stopHeartbeat = startHeartbeat(dir);

  const ipcBus = createEventBus();
  const ipcBridge = createIpcWorkflowBridge(ipcBus);
  const { config: rawConfig, warnings: baseWarnings } = loadConfig(argv.projectDir);
  const { config } = resolveEffectiveConfig({
    base: rawConfig,
    overrides: argv.overrides,
    baseWarnings,
  });
  const ipcServer = await startIpcServer({
    sessionId: argv.sessionId,
    sessionDir: dir,
    startedAt: now,
    mode: argv.mode,
    feature: argv.feature,
    authToken,
    bus: ipcBus,
    onUserInput: ipcBridge.onUserInput,
    sessionJsonlPath: join(dir, SESSION_LOG_FILE),
    noClientPromptBehavior: config.approval?.headless === true ? 'fail-closed' : 'wait',
  });

  const onCleanup = async (exitCode: number) => {
    stopHeartbeat();
    ipcBridge.close();
    await ipcServer.close();
    await markExited(dir, exitCode);
    clearActive(argv.projectDir);
  };

  const handleSignal = (signal: string) => {
    void (async () => {
      try {
        await markSignaled(dir, signal);
        await onCleanup(0);
        process.exit(0);
      } catch {
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    void markCrashed(dir, 'uncaught', toErrorMessage(reason)).then(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    void markCrashed(dir, 'uncaught', toErrorMessage(err)).then(() => process.exit(1));
  });

  const summary = await runWorkflowLoop(ipcServer, ipcBridge, ipcBus, config);

  const completedTasks = summary.completedByLocal + summary.escalatedToPlanner + summary.skipped;
  const isIncomplete = summary.totalTasks > 0 && completedTasks < summary.totalTasks;
  const exitCode = summary.failed > 0 || isIncomplete ? 1 : 0;
  await onCleanup(exitCode);
}

main().catch((err) => {
  void markCrashed(dir, 'uncaught', toErrorMessage(err)).then(() => process.exit(1));
});

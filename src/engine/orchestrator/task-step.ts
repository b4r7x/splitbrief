import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage, TokenUsage } from '../../core/schemas/tokens.js';
import { formatValidationError } from './validation.js';

import type { WorkflowContext } from './types.js';
import { recordTaskUsage } from './tokens.js';
import { toErrorMessage, labelError } from '../../utils/format-errors.js';
import { createBusTextHandler, publishDriftChainDetected, publishError, publishEvent, publishTaskStart, publishTaskSkipped, publishWarning } from './events.js';
import { runPreHooks } from '../hooks/run-pre-hook.js';
import { handleRetryAndEscalation } from './escalation/escalation.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave } from './state-ops.js';
import { validateCommitAndAdvance } from './task-commit.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import { withContinuationLoop } from './continuation.js';
import {
  gateAction,
  gateChangedFiles,
  captureCurrentFileContents,
  createStagedProject,
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
  promoteStagedChanges,
  restoreDirtyFilesFromSnapshot,
  type ChangedFilesSnapshot,
  type GateChangedFilesDecision,
  type GateDecision,
} from './tiered-approval.js';
import {
  createEvidenceLedger,
  readEvidenceLedger,
  recordApprovalEvidence,
  recordLocalTaskEvidence,
  recordRejectionEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  writeEvidenceLedger,
} from './evidence.js';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';
import type { ValidationResult } from '../../core/types/summary.js';
import type { TaskCompletionMethod, TaskStatus } from '../../core/schemas/enums.js';
import type { EventBus } from '../events/types.js';
import { hashTaskBrief } from '../../core/brief-hash.js';
import {
  readDriftChainState,
  writeDriftChainState,
  initialDriftChainState,
} from './drift-chain-state.js';
import { computePerTaskOutOfBounds, analyzeDriftChain } from './drift-chain.js';

export function resolveDependsOnFiles(tasks: Task[], task: Task): string[] {
  return task.dependsOn.flatMap((id: TaskId) => {
    const dep = tasks.find((t) => t.id === id);
    return dep ? [dep.file] : [];
  });
}

async function runChainAnalysisSafe(opts: {
  wctx: WorkflowContext;
  task: Task;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
  bus: EventBus;
}): Promise<void> {
  try {
    const taskChangedFiles = await getChangedFilesSinceSnapshot(opts.projectDir, opts.taskStartSnapshot);
    const outOfBoundsFiles = computePerTaskOutOfBounds(opts.task, taskChangedFiles);

    const existing = readDriftChainState(opts.projectDir, opts.sessionId)
      ?? initialDriftChainState(opts.sessionId);

    const threshold = opts.wctx.config.workflow.driftChainThreshold ?? 0.6;
    const update = analyzeDriftChain(existing, opts.task.id, outOfBoundsFiles, threshold);

    writeDriftChainState(opts.projectDir, opts.sessionId, update.state);

    if (update.emitted) {
      publishDriftChainDetected(opts.bus, opts.state.phase, update.emitted, threshold);
    }
  } catch (err) {
    publishWarning(opts.wctx.bus, opts.state.phase, `drift chain analysis failed: ${toErrorMessage(err)}`);
  }
}

function persistTaskEvidence(
  wctx: WorkflowContext,
  state: WorkflowState,
  task: Task,
  recordKind: 'local' | 'retry' | 'skipped',
  details: {
    status: TaskStatus;
    method?: TaskCompletionMethod | undefined;
    retries?: number | undefined;
    durationMs?: number | undefined;
    validation?: ValidationResult[] | undefined;
    escalated?: boolean | undefined;
    reason?: string | undefined;
    changedFiles?: string[] | undefined;
  },
): void {
  try {
    const existing = readEvidenceLedger(wctx.projectDir, wctx.sessionId);
    const briefHash = hashTaskBrief(state.tasks);
    const ledger = existing ?? createEvidenceLedger({
      sessionId: wctx.sessionId,
      feature: state.feature,
      mode: wctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
      briefHash,
    });
    let updated = ledger;
    if (recordKind === 'local') {
      updated = recordLocalTaskEvidence({
        ledger, task,
        status: details.status,
        method: details.method,
        retries: details.retries,
        durationMs: details.durationMs,
        validation: details.validation ?? [],
        changedFiles: details.changedFiles,
        briefHash,
        validationRetryState: details.status === 'failed' ? 'failed' : undefined,
      });
    } else if (recordKind === 'retry') {
      updated = recordRetryOrEscalationEvidence({
        ledger, task,
        status: details.status,
        method: details.method,
        retries: details.retries,
        durationMs: details.durationMs,
        validation: details.validation,
        escalated: details.escalated ?? false,
        changedFiles: details.changedFiles,
        briefHash,
        validationRetryState: details.escalated ? 'escalated' : details.status === 'failed' ? 'failed' : 'initial-failure',
      });
    } else {
      updated = recordSkippedTaskEvidence({
        ledger, task, reason: details.reason ?? 'skipped', briefHash,
      });
    }
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, updated);
  } catch (err) {
    publishWarning(wctx.bus, state.phase, `failed to persist evidence ledger: ${toErrorMessage(err)}`);
  }
}

function persistRejectionEvidence(
  wctx: WorkflowContext,
  state: WorkflowState,
  reason: string,
  actionClass: import('../../core/schemas/approval-store.js').ActionClass,
  tier: 'sticky' | 'confirm',
  actionDescription: string,
  taskId?: TaskId,
): void {
  try {
    const existing = readEvidenceLedger(wctx.projectDir, wctx.sessionId);
    const briefHash = hashTaskBrief(state.tasks);
    const ledger = existing ?? createEvidenceLedger({
      sessionId: wctx.sessionId,
      feature: state.feature,
      mode: wctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
      briefHash,
    });
    const updated = recordRejectionEvidence({
      ledger,
      tier,
      actionClass,
      actionDescription,
      ...(taskId !== undefined && { taskId }),
      reason,
    });
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, updated);
  } catch {
    // non-fatal: rejection evidence loss is acceptable vs crashing
  }
}

function persistApprovalEvidence(
  wctx: WorkflowContext,
  state: WorkflowState,
  decision: GateDecision,
  taskId?: TaskId,
): void {
  if (!decision.confirmApprovals || decision.confirmApprovals.length === 0) return;
  try {
    const existing = readEvidenceLedger(wctx.projectDir, wctx.sessionId);
    const briefHash = hashTaskBrief(state.tasks);
    let ledger = existing ?? createEvidenceLedger({
      sessionId: wctx.sessionId,
      feature: state.feature,
      mode: wctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
      briefHash,
    });
    for (const approval of decision.confirmApprovals) {
      ledger = recordApprovalEvidence({
        ledger,
        tier: approval.tier,
        actionClass: approval.actionClass,
        actionDescription: approval.actionDescription,
        ...(taskId !== undefined && { taskId }),
        reason: approval.reason,
      });
    }
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, ledger);
  } catch (err) {
    publishWarning(wctx.bus, state.phase, `failed to persist approval evidence: ${toErrorMessage(err)}`);
  }
}

function recordApprovalDenial(
  wctx: WorkflowContext,
  state: WorkflowState,
  task: Task,
  decision: GateDecision,
  message: string,
): void {
  publishError(wctx.bus, state.phase, message);
  const rejectedTier = decision.tier;
  if (rejectedTier && rejectedTier !== 'auto' && decision.actionClass && decision.actionDescription) {
    persistRejectionEvidence(
      wctx,
      state,
      decision.reason ?? 'denied',
      decision.actionClass,
      rejectedTier,
      decision.actionDescription,
      task.id,
    );
  }
}

type RetryAndRecordOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  state: WorkflowState;
  taskStartTime: number;
  taskStartSnapshot?: ChangedFilesSnapshot;
  initialValidation?: ValidationResult[] | undefined;
  initialChangedFiles?: string[] | undefined;
  tokensBefore: TokenUsage;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
};

export async function retryAndRecord(opts: RetryAndRecordOptions): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState } = opts;
  let taskStartSnapshot = opts.taskStartSnapshot;
  if (!taskStartSnapshot) {
    try {
      taskStartSnapshot = await getChangedFilesSnapshot(wctx.projectDir);
    } catch (err) {
      publishError(wctx.bus, opts.state.phase, `Retry blocked by approval gate: ${toErrorMessage(err)}`);
      return { state: opts.state, completed: false };
    }
  }
  const { state, result } = await handleRetryAndEscalation({
    wctx, task, initialError, currentState: opts.state, taskStartTime,
    taskStartSnapshot,
    dependsOnFiles: resolveDependsOnFiles(opts.state.tasks, task),
  });
  setTrackedState(state);
  recordTaskUsage({ task, method: result.method, tokensBefore, currentUsage: state.tokenUsage, bus: wctx.bus, state, taskBreakdowns, retryCount: result.attempts, tool: getRunnerDisplayName(wctx.config.implementer), model: wctx.config.implementer.model });
  if (!result.completed) publishEvent(wctx.bus, { type: 'task_failed', ts: Date.now(), phase: state.phase, taskId: task.id });
  const escalated = result.completed && result.method !== 'local';
  const status: TaskStatus = result.completed ? (escalated ? 'escalated' : 'done') : 'failed';
  persistTaskEvidence(wctx, state, task, 'retry', {
    status,
    method: result.method,
    retries: result.attempts,
    durationMs: Date.now() - taskStartTime,
    escalated,
    validation: opts.initialValidation,
    changedFiles: opts.initialChangedFiles,
  });
  return { state, completed: result.completed };
}

type RunSingleTaskOptions = {
  wctx: WorkflowContext;
  task: Task;
  index: number;
  totalTasks: number;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
};

export async function runSingleTask(opts: RunSingleTaskOptions): Promise<WorkflowState> {
  const { wctx, index, totalTasks, taskBreakdowns, setTrackedState, setCurrentTask } = opts;
  const { projectDir, sessionId, config, callbacks, context } = wctx;
  let state = opts.state;

  if (wctx.signal?.aborted) return state;

  state = transitionAndSave(projectDir, sessionId, state, { type: 'START_TASK', taskId: opts.task.id });
  setTrackedState(state);

  let task: Task;
  ({ task, state } = await refreshAndPersistCode(opts.task, projectDir, sessionId, state));
  setTrackedState(state);

  setCurrentTask(task);
  const taskStartTime = Date.now();

  const gateResult = await gateAction({
    actionDescription: `${task.action} ${task.file}`,
    task,
    dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
    projectDir,
    sessionId,
    phase: state.phase,
    taskId: task.id,
    bus: wctx.bus,
    callbacks,
    config,
  });
  if (!gateResult.allow) {
    recordApprovalDenial(
      wctx,
      state,
      task,
      gateResult,
      `Task blocked by approval gate: ${gateResult.reason ?? 'denied'}`,
    );
    return state;
  }
  persistApprovalEvidence(wctx, state, gateResult, task.id);

  if (wctx.config.hooks) {
    const preTaskPayload: import('../events/types.js').EngineEvent = {
      type: 'task_started', ts: Date.now(), phase: state.phase,
      taskId: task.id, title: task.title, index, total: totalTasks,
      file: task.file, action: task.action,
    };
    const pre = await runPreHooks(wctx.config.hooks, 'pre_task', preTaskPayload, { projectDir, sessionId });
    if (!pre.allow) {
      publishWarning(wctx.bus, state.phase, `pre_task blocked: ${pre.reason ?? 'hook denied'}`);
      publishTaskSkipped(wctx.bus, state.phase, { taskId: task.id, title: task.title, reason: pre.reason ?? 'pre_task hook denied' });
      state = transitionAndSave(projectDir, sessionId, state, { type: 'SKIP_TASK', taskId: task.id });
      setTrackedState(state);
      persistTaskEvidence(wctx, state, task, 'skipped', { status: 'skipped', reason: pre.reason ?? 'pre_task hook denied' });
      return state;
    }
  }

  publishTaskStart(wctx.bus, state.phase, {
    taskId: task.id, title: task.title, index, total: totalTasks, file: task.file, action: task.action,
    tool: getRunnerDisplayName(config.implementer), model: config.implementer.model,
  });

  let taskStartSnapshot: ChangedFilesSnapshot;
  try {
    taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
  } catch (err) {
    publishError(wctx.bus, state.phase, `Task blocked by approval gate: ${toErrorMessage(err)}`);
    return state;
  }
  const tokensBefore = { ...state.tokenUsage };

  if (wctx.signal?.aborted) return state;

  const textHandler = createBusTextHandler(wctx.bus, state.phase);

  type ImplResult = Awaited<ReturnType<typeof wctx.implementer.implement>>;
  let implResult: ImplResult;
  const usesStaging = wctx.implementer.capabilities?.writesFiles === 'direct';
  const staged = usesStaging ? await createStagedProject(projectDir) : undefined;
  let preApplyApprovalDenied = false;
  let preApplyApprovedFiles: string[] = [];
  try {
    const loop = await withContinuationLoop<ImplResult>({
      ctx: { projectDir: staged?.projectDir ?? projectDir, sessionId, callbacks, signal: wctx.signal, sinks: wctx.sinks },
      state,
      onStateChange: setTrackedState,
      body: async ({ signal, continuationPrompt, recordOutput }) => {
        const result = await wctx.implementer.implement({
          task, projectDir: staged?.projectDir ?? projectDir, config, context,
          onOutput: (text) => { recordOutput(text); textHandler(text); },
          sessionId,
          signal,
          continuationPrompt,
          bus: wctx.bus,
          phase: state.phase,
          approveWrite: async (file) => {
            if (staged) return { allow: true };
            const decision = await gateChangedFiles({
              changedFiles: [file],
              task,
              dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
              projectDir,
              sessionId,
              phase: state.phase,
              taskId: task.id,
              bus: wctx.bus,
              callbacks,
              config,
            });
            if (!decision.allow) {
              preApplyApprovalDenied = true;
              const files = decision.changedFiles.join(', ');
              recordApprovalDenial(
                wctx,
                state,
                task,
                decision,
                `Task changed files blocked by approval gate: ${decision.reason ?? 'denied'} (${files})`,
              );
              return { allow: false, reason: decision.reason ?? 'write denied by approval gate' };
            }
            preApplyApprovedFiles = decision.changedFiles;
            persistApprovalEvidence(wctx, state, decision, task.id);
            return { allow: true };
          },
        });
        return { value: result, continueIfAborted: !result.success };
      },
    });
    state = loop.state;
    implResult = loop.value;
  } catch (err) {
    staged?.cleanup();
    publishError(wctx.bus, state.phase, labelError('Implementation failed', err));
    const retry = await retryAndRecord({
      wctx, task, initialError: toErrorMessage(err),
      state, taskStartTime, taskStartSnapshot, tokensBefore, taskBreakdowns, setTrackedState,
    });
    await runChainAnalysisSafe({ wctx, task, projectDir, sessionId, state: retry.state, taskStartSnapshot, bus: wctx.bus });
    return retry.state;
  }

  state = addUsageAndSave(projectDir, sessionId, state, 'implementer', implResult.usage, wctx.bus);
  setTrackedState(state);

  if (!implResult.success) {
    staged?.cleanup();
    if (preApplyApprovalDenied) {
      return state;
    }
    const retry = await retryAndRecord({
      wctx, task, initialError: implResult.error ?? 'Implementation failed to produce valid code',
      state, taskStartTime, taskStartSnapshot, tokensBefore, taskBreakdowns, setTrackedState,
    });
    await runChainAnalysisSafe({ wctx, task, projectDir, sessionId, state: retry.state, taskStartSnapshot, bus: wctx.bus });
    return retry.state;
  }

  let taskChangedFiles: string[];
  let taskChangedFilesFromStaging = Boolean(staged);
  try {
    taskChangedFiles = await getChangedFilesSinceSnapshot(staged?.projectDir ?? projectDir, taskStartSnapshot);
    if (usesStaging && taskChangedFiles.length === 0) {
      taskChangedFiles = await getChangedFilesSinceSnapshot(projectDir, taskStartSnapshot);
      taskChangedFilesFromStaging = false;
    }
  } catch (err) {
    staged?.cleanup();
    publishError(wctx.bus, state.phase, `Task changed files blocked by approval gate: ${toErrorMessage(err)}`);
    return state;
  }
  const preApprovalChangedFileContents = captureCurrentFileContents(projectDir, taskChangedFiles);
  const preApplyApprovedFileSet = new Set(preApplyApprovedFiles);
  const filesNeedingApproval = taskChangedFiles.filter((file) => !preApplyApprovedFileSet.has(file));
  let changedFilesGate: GateChangedFilesDecision = { allow: true, changedFiles: taskChangedFiles };
  if (filesNeedingApproval.length > 0) {
    changedFilesGate = await gateChangedFiles({
      changedFiles: filesNeedingApproval,
      task,
      dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
      projectDir,
      sessionId,
      phase: state.phase,
      taskId: task.id,
      bus: wctx.bus,
      callbacks,
      config,
    });
  }
  if (!changedFilesGate.allow) {
    const files = changedFilesGate.changedFiles.join(', ');
    try {
      if (!taskChangedFilesFromStaging) {
        const restoreResult = await restoreDirtyFilesFromSnapshot(
          projectDir,
          taskStartSnapshot,
          changedFilesGate.changedFiles,
          preApprovalChangedFileContents,
        );
        if (restoreResult.conflictedFiles.length > 0) {
          publishWarning(
            wctx.bus,
            state.phase,
            `denied task rollback skipped files changed during approval: ${restoreResult.conflictedFiles.join(', ')}`,
          );
        }
      }
    } catch (err) {
      publishWarning(wctx.bus, state.phase, `failed to discard denied task changes: ${toErrorMessage(err)}`);
    }
    staged?.cleanup();
    recordApprovalDenial(
      wctx,
      state,
      task,
      changedFilesGate,
      `Task changed files blocked by approval gate: ${changedFilesGate.reason ?? 'denied'} (${files})`,
    );
    return state;
  }
  if (filesNeedingApproval.length > 0) {
    persistApprovalEvidence(wctx, state, changedFilesGate, task.id);
  }

  if (staged) {
    const promoteResult = promoteStagedChanges(projectDir, staged.projectDir, taskChangedFiles, preApprovalChangedFileContents);
    staged.cleanup();
    if (promoteResult.conflictedFiles.length > 0) {
      publishError(
        wctx.bus,
        state.phase,
        `Approved task promotion blocked because files changed during approval: ${promoteResult.conflictedFiles.join(', ')}`,
      );
      return state;
    }
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'TASK_SENT' });
  setTrackedState(state);

  if (wctx.signal?.aborted) return state;

  if (wctx.config.hooks) {
    const preValidationPayload: import('../events/types.js').EngineEvent = {
      type: 'validate', ts: Date.now(), phase: state.phase,
      taskId: task.id, status: 'running', passed: false,
      stages: { tsc: false, lint: false, test: false },
    };
    const preVal = await runPreHooks(wctx.config.hooks, 'pre_validation', preValidationPayload, { projectDir, sessionId });
    if (!preVal.allow) {
      publishWarning(wctx.bus, state.phase, `pre_validation blocked: ${preVal.reason ?? 'hook denied'}`);
      return state;
    }
  }

  const validationResults = await wctx.validator.runValidation(task, projectDir, config, wctx.bus, state.phase, task.id);
  const commitResult = await validateCommitAndAdvance({
    task, projectDir, sessionId, config, bus: wctx.bus, state,
    method: 'local', transitionType: 'VALIDATION_PASS', taskStartTime,
    results: validationResults,
  });
  if (commitResult.completed) {
    state = commitResult.state;
    setTrackedState(state);
    recordTaskUsage({ task, method: 'local', tokensBefore, currentUsage: state.tokenUsage, bus: wctx.bus, state, taskBreakdowns, tool: getRunnerDisplayName(config.implementer), model: config.implementer.model });
    persistTaskEvidence(wctx, state, task, 'local', {
      status: 'done', method: 'local', retries: 0,
      durationMs: Date.now() - taskStartTime,
      validation: validationResults,
      changedFiles: taskChangedFiles,
    });
    await runChainAnalysisSafe({ wctx, task, projectDir, sessionId, state, taskStartSnapshot, bus: wctx.bus });
    return state;
  }

  const errorText = formatValidationError(validationResults);
  const retry = await retryAndRecord({
    wctx, task, initialError: errorText,
    state, taskStartTime, taskStartSnapshot, tokensBefore, taskBreakdowns, setTrackedState,
    initialValidation: validationResults,
    initialChangedFiles: taskChangedFiles,
  });
  await runChainAnalysisSafe({ wctx, task, projectDir, sessionId, state: retry.state, taskStartSnapshot, bus: wctx.bus });
  return retry.state;
}

import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { formatValidationError } from '../validation.js';
import { createStreamingFeed } from './streaming-feed.js';

import type { WorkflowContext } from '../types.js';
import { recordTaskUsage } from '../tokens.js';
import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { createBusTextHandler, publishDriftChainDetected, publishError, publishRecoveryPrompted, publishTaskStart, publishTaskSkipped, publishUserEditConflict, publishWarning } from '../events.js';
import { runPreHooks } from '../../hooks/run-pre-hook.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { validateCommitAndAdvance } from './commit.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { withContinuationLoop } from '../continuation.js';
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
} from '../approval/tiered-approval.js';
import type { EventBus, EngineEvent } from '../../events/types.js';
import {
  readDriftChainState,
  writeDriftChainState,
  initialDriftChainState,
} from '../drift/chain-state.js';
import { computePerTaskOutOfBounds, analyzeDriftChain } from '../drift/chain.js';
import { createApprovalPromotionConflict } from '../user-edit/conflicts.js';
import { isExtractedCodeApprovalRaceError } from '../../implementers/base.js';
import { buildApprovalPromotionConflictRecoveryIssue } from '../recovery/recovery.js';
import { persistTaskEvidence, persistRejectionEvidence, persistApprovalEvidence } from '../evidence/persistence.js';
import { retryAndRecord } from './retry.js';
import { buildRoutingEventFields } from './routing-fields.js';

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

async function handleApprovalTimeUserEditConflict(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  files: string[];
  taskBreakdowns?: TaskTokenUsage[] | undefined;
  setTrackedState?: ((s: WorkflowState) => void) | undefined;
}): Promise<WorkflowState> {
  const conflict = createApprovalPromotionConflict({
    files: opts.files,
    currentTaskId: opts.task.id,
  });
  publishUserEditConflict(opts.wctx.bus, opts.state.phase, conflict, 'pause');
  const issue = buildApprovalPromotionConflictRecoveryIssue({
    conflict,
    currentTask: opts.task,
    phase: opts.state.phase,
    createdAt: new Date().toISOString(),
  });
  const next = transitionAndSave(opts.wctx.projectDir, opts.wctx.sessionId, opts.state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted(opts.wctx.bus, issue);
  opts.setTrackedState?.(next);
  return next;
}

type RunSingleTaskOptions = {
  wctx: WorkflowContext;
  task: Task;
  taskCodeRefreshed?: boolean;
  index: number;
  totalTasks: number;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
  onTaskAcceptedFiles?: ((files: string[]) => void) | undefined;
};

export async function runSingleTask(opts: RunSingleTaskOptions): Promise<WorkflowState> {
  const { wctx, index, totalTasks, taskBreakdowns, setTrackedState, setCurrentTask } = opts;
  const { projectDir, sessionId, config, callbacks, context } = wctx;
  let state = opts.state;

  if (state.pendingRecovery || wctx.signal?.aborted) return state;

  state = transitionAndSave(projectDir, sessionId, state, { type: 'START_TASK', taskId: opts.task.id });
  setTrackedState(state);

  let task = opts.task;
  if (opts.taskCodeRefreshed !== true) {
    ({ task, state } = await refreshAndPersistCode(opts.task, projectDir, sessionId, state));
    setTrackedState(state);
  }

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
    const preTaskPayload: EngineEvent = {
      type: 'task_started', ts: Date.now(), phase: state.phase,
      taskId: task.id, title: task.title, index, total: totalTasks,
      file: task.file, action: task.action,
      ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
      ...buildRoutingEventFields(wctx.routingDecision),
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
    ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
    ...buildRoutingEventFields(wctx.routingDecision),
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
  const streamingFeed = createStreamingFeed(task.id, config.implementer.kind === 'api');

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
          onOutput: (text) => { recordOutput(text); textHandler(text); streamingFeed.onText(text); },
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
    streamingFeed.stop();
  } catch (err) {
    streamingFeed.stop();
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
    if (isExtractedCodeApprovalRaceError(task.file, implResult.error)) {
      state = await handleApprovalTimeUserEditConflict({
        wctx,
        state,
        task,
        files: [task.file],
        taskBreakdowns,
        setTrackedState,
      });
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
  const preApprovalChangedFileContents = await captureCurrentFileContents(projectDir, taskChangedFiles);
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
          state = await handleApprovalTimeUserEditConflict({
            wctx,
            state,
            task,
            files: restoreResult.conflictedFiles,
            taskBreakdowns,
            setTrackedState,
          });
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
    const promoteResult = await promoteStagedChanges(projectDir, staged.projectDir, taskChangedFiles, preApprovalChangedFileContents);
    staged.cleanup();
    if (promoteResult.conflictedFiles.length > 0) {
      state = await handleApprovalTimeUserEditConflict({
        wctx,
        state,
        task,
        files: promoteResult.conflictedFiles,
        taskBreakdowns,
        setTrackedState,
      });
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
    const preValidationPayload: EngineEvent = {
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
    implementerProfile: wctx.implementerProfile,
  });
  if (commitResult.completed) {
    state = commitResult.state;
    setTrackedState(state);
    opts.onTaskAcceptedFiles?.(taskChangedFiles);
    recordTaskUsage({
      task,
      method: 'local',
      tokensBefore,
      currentUsage: state.tokenUsage,
      bus: wctx.bus,
      state,
      taskBreakdowns,
      tool: getRunnerDisplayName(config.implementer),
      model: config.implementer.model,
      ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
      ...(wctx.routingDecision !== undefined && { routingDecision: wctx.routingDecision }),
    });
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

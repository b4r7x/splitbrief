import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { formatValidationError } from '../validation.js';

import type { WorkflowContext } from '../types.js';
import { recordTaskUsage } from '../tokens.js';
import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { publishError, publishWarning, publishWarningFromError, publishDriftChainDetected } from '../events.js';
import { runPreHooks } from '../../hooks/run-pre-hook.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { validateCommitAndAdvance } from './commit.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { gateAction, type GateDecision } from '../approval/tiered-approval.js';
import { getChangedFilesSinceSnapshot, type ChangedFilesSnapshot } from '../approval/file-snapshots.js';
import type { EventBus, EngineEvent } from '../../events/types.js';
import {
  readDriftChainState,
  writeDriftChainState,
  initialDriftChainState,
} from '../drift/chain-state.js';
import { computePerTaskOutOfBounds, analyzeDriftChain } from '../drift/chain.js';
import { isExtractedCodeApprovalRaceError } from '../../implementers/base.js';
import { handleApprovalTimeUserEditConflict } from '../escalation/approval-conflict.js';
import { persistTaskEvidence, persistRejectionEvidence, persistApprovalEvidence } from '../evidence/persistence.js';
import { retryAndRecord } from './retry.js';
import { runPreTaskHooksAndPublish } from './pre-task.js';
import { runImplementation } from './run-implementation.js';
import { applyChangedFiles } from './apply-changed-files.js';
import { resolveDependsOnFiles } from './resolve-deps.js';

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
      publishDriftChainDetected({ bus: opts.bus, phase: opts.state.phase }, update.emitted, threshold);
    }
  } catch (err) {
    publishWarningFromError({ bus: opts.wctx.bus, phase: opts.state.phase }, 'drift chain analysis failed', err);
  }
}

function recordApprovalDenial(
  wctx: WorkflowContext,
  state: WorkflowState,
  task: Task,
  decision: GateDecision,
  message: string,
): void {
  publishError({ bus: wctx.bus, phase: state.phase }, message);
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
  const { projectDir, sessionId, config, callbacks } = wctx;
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
    recordApprovalDenial(wctx, state, task, gateResult, `Task blocked by approval gate: ${gateResult.reason ?? 'denied'}`);
    return state;
  }
  persistApprovalEvidence(wctx, state, gateResult, task.id);

  const preTaskResult = await runPreTaskHooksAndPublish({ wctx, task, state, index, totalTasks, setTrackedState });
  if (!preTaskResult.proceed) return preTaskResult.state;
  state = preTaskResult.state;
  const taskStartSnapshot = preTaskResult.taskStartSnapshot;

  const tokensBefore = { ...state.tokenUsage };
  if (wctx.signal?.aborted) return state;

  let implState: Awaited<ReturnType<typeof runImplementation>>;
  try {
    implState = await runImplementation({
      wctx, task, state, taskStartSnapshot, setTrackedState,
      recordApprovalDenial: (decision, message) => recordApprovalDenial(wctx, state, task, decision, message),
      streamingSink: wctx.streamingSink,
    });
  } catch (err) {
    publishError({ bus: wctx.bus, phase: state.phase }, labelError('Implementation failed', err));
    const retry = await retryAndRecord({
      wctx, task, initialError: toErrorMessage(err),
      state, taskStartTime, taskStartSnapshot, tokensBefore, taskBreakdowns, setTrackedState,
    });
    await runChainAnalysisSafe({ wctx, task, projectDir, sessionId, state: retry.state, taskStartSnapshot, bus: wctx.bus });
    return retry.state;
  }

  state = addUsageAndSave(projectDir, sessionId, implState.state, 'implementer', implState.implResult.usage, wctx.bus);
  setTrackedState(state);

  if (!implState.implResult.success) {
    implState.staged?.cleanup();
    if (implState.preApplyApprovalDenied) {
      return state;
    }
    if (isExtractedCodeApprovalRaceError(task.file, implState.implResult.error)) {
      state = await handleApprovalTimeUserEditConflict({ ctx: wctx, state, task, files: [task.file], setTrackedState });
      return state;
    }
    const retry = await retryAndRecord({
      wctx, task, initialError: implState.implResult.error ?? 'Implementation failed to produce valid code',
      state, taskStartTime, taskStartSnapshot, tokensBefore, taskBreakdowns, setTrackedState,
    });
    await runChainAnalysisSafe({ wctx, task, projectDir, sessionId, state: retry.state, taskStartSnapshot, bus: wctx.bus });
    return retry.state;
  }

  const applyResult = await applyChangedFiles({
    wctx, task, state,
    staged: implState.staged,
    usesStaging: implState.usesStaging,
    preApplyApprovedFiles: implState.preApplyApprovedFiles,
    taskStartSnapshot,
    recordApprovalDenial: (s, decision, message) => recordApprovalDenial(wctx, s, task, decision, message),
    handleConflict: (s, files) => handleApprovalTimeUserEditConflict({ ctx: wctx, state: s, task, files, setTrackedState }),
  });
  if (!applyResult.proceed) return applyResult.state;
  state = applyResult.state;
  const taskChangedFiles = applyResult.taskChangedFiles;

  state = transitionAndSave(projectDir, sessionId, state, { type: 'TASK_SENT' });
  setTrackedState(state);

  if (wctx.signal?.aborted) return state;

  if (wctx.config.hooks) {
    const preValidationPayload: EngineEvent = {
      type: 'validate', ts: Date.now(), phase: state.phase,
      taskId: task.id, status: 'running', passed: false,
      stages: { typecheck: false, lint: false, test: false },
    };
    const preVal = await runPreHooks(wctx.config.hooks, 'pre_validation', preValidationPayload, { projectDir, sessionId });
    if (!preVal.allow) {
      publishWarning({ bus: wctx.bus, phase: state.phase }, `pre_validation blocked: ${preVal.reason ?? 'hook denied'}`);
      return state;
    }
  }

  const validationResults = await wctx.validator.runValidation(task, projectDir, config, wctx.bus, state.phase, task.id, state.discoveredValidation);
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

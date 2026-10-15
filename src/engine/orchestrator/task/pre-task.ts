import type { Task } from '../../../core/schemas/task.js';
import {
  lineageAttemptsOf,
  type ChangedFilesSnapshot,
  type WorkflowState,
} from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { buildSnapshotFailedRecoveryIssue } from '../recovery/builders/task.js';
import { nowIso } from '../../../utils/format-time.js';
import { publishTaskStart, publishTaskSkipped, publishWarning, publishError } from '../events.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { seatAxisWords } from '../../../core/runners/effort-channel.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { buildRoutingEventFields } from './routing-fields.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';

export type PreTaskResult =
  | { proceed: true; state: WorkflowState; taskStartSnapshot: ChangedFilesSnapshot }
  | { proceed: false; state: WorkflowState };

export async function runPreTaskHooksAndPublish(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  index: number;
  totalTasks: number;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<PreTaskResult> {
  const { wctx, task, index, totalTasks, setTrackedState } = opts;
  const { projectDir, workspaceDir, sessionId, config } = wctx;
  let state = opts.state;

  if (wctx.config.hooks) {
    const preTaskPayload: EngineEvent = {
      type: 'task_started',
      ts: Date.now(),
      phase: state.phase,
      taskId: task.id,
      title: task.title,
      index,
      total: totalTasks,
      file: task.suggestedFiles[0],
      files: [...task.suggestedFiles],
      action: task.action,
      tool: getRunnerDisplayName(config.implementer),
      model: config.implementer.model,
      axes: seatAxisWords(config.implementer),
      backendKind: config.implementer.kind,
      ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
      ...buildRoutingEventFields(wctx.routingDecision),
    };
    const pre = await runPreHooks(wctx.config.hooks, 'pre_task', preTaskPayload, {
      projectDir,
      workspaceDir,
      sessionId,
    });
    if (!pre.allow) {
      publishWarning({
        bus: wctx.bus,
        phase: state.phase,
        message: `pre_task blocked: ${pre.reason ?? 'hook denied'}`,
      });
      publishTaskSkipped(
        { bus: wctx.bus, phase: state.phase },
        { taskId: task.id, title: task.title, reason: pre.reason ?? 'pre_task hook denied' },
      );
      state = transitionAndSave({ projectDir, sessionId }, state, {
        type: 'SKIP_TASK',
        taskId: task.id,
      });
      setTrackedState(state);
      await persistTaskEvidence({
        wctx,
        state,
        task,
        recordKind: 'skipped',
        details: {
          status: 'skipped',
          reason: pre.reason ?? 'pre_task hook denied',
        },
      });
      return { proceed: false, state };
    }
  }

  const lineage = lineageAttemptsOf(state, task);
  publishTaskStart(
    { bus: wctx.bus, phase: state.phase },
    {
      taskId: task.id,
      title: task.title,
      index,
      total: totalTasks,
      lineageAttempt: lineage.used + 1,
      attemptAllowance: lineage.allowance,
      file: task.suggestedFiles[0],
      files: [...task.suggestedFiles],
      action: task.action,
      tool: getRunnerDisplayName(config.implementer),
      axes: seatAxisWords(config.implementer),
      backendKind: config.implementer.kind,
      ...(config.implementer.model !== undefined && { model: config.implementer.model }),
      ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
      ...buildRoutingEventFields(wctx.routingDecision),
    },
  );

  // A resumed attempt, and a Continue past a consult bound that replays the brief on the
  // files its last attempt left, keep the brief's first task-start snapshot.
  const activeTaskSnapshot = state.changedFilesBaseline?.activeTaskSnapshot;
  if (
    activeTaskSnapshot !== undefined &&
    (state.lineages?.[lineageIdOf(task)]?.carriedFailure !== undefined ||
      wctx.continuation?.resumesAttempt(
        { kind: 'brief', taskId: task.id, attempt: state.attempt },
        hashTaskBrief([task]),
      ) === true)
  ) {
    const taskStartSnapshot = {
      ...activeTaskSnapshot,
      restoreFiles: activeTaskSnapshot.restoreFiles ?? [],
    };
    return { proceed: true, state, taskStartSnapshot };
  }

  let taskStartSnapshot: ChangedFilesSnapshot;
  try {
    taskStartSnapshot = await captureWorkspaceSnapshot(wctx.workspaceDir, wctx, (dir) =>
      publishWarning({
        bus: wctx.bus,
        phase: state.phase,
        message: `embedded repository ${dir} ignored`,
      }),
    );
  } catch (err) {
    const detail = `Failed to capture task baseline snapshot: ${toErrorMessage(err)}`;
    publishError({ bus: wctx.bus, phase: state.phase, message: detail });
    state = raisePendingRecovery(
      wctx,
      state,
      buildSnapshotFailedRecoveryIssue({ task, phase: state.phase, detail, createdAt: nowIso() }),
      setTrackedState,
    );
    return { proceed: false, state };
  }

  return { proceed: true, state, taskStartSnapshot: { ...taskStartSnapshot, restoreFiles: [] } };
}

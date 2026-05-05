import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import type { ChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { runPreHooks } from '../../hooks/run-pre-hook.js';
import { transitionAndSave } from '../state-ops.js';
import { publishTaskStart, publishTaskSkipped, publishWarning, publishError } from '../events.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { persistTaskEvidence } from '../evidence/persistence.js';
import { buildRoutingEventFields } from './routing-fields.js';

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
  const { projectDir, sessionId, config } = wctx;
  let state = opts.state;

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
      return { proceed: false, state };
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
    return { proceed: false, state };
  }

  return { proceed: true, state, taskStartSnapshot };
}

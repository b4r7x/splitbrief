import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import type { BriefExecution } from '../../../core/schemas/brief-execution.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { buildRoutingEventFields } from '../context-routing/event-fields.js';
import type { WorkflowContext } from '../types.js';

export function recordSettledBrief(opts: {
  wctx: Pick<WorkflowContext, 'config' | 'bus' | 'implementerProfile' | 'routingDecision'>;
  state: WorkflowState;
  task: Task;
  method: BriefExecution['method'];
  taskBreakdowns: BriefExecution[];
  retryCount?: number;
  tool?: string | undefined;
  model?: string | undefined;
}): void {
  const { wctx, state, task } = opts;
  const runner = wctx.config.implementer;
  const model = opts.model ?? runner.model;
  const execution: BriefExecution = {
    taskId: task.id,
    taskTitle: task.title,
    method: opts.method,
    retryCount: opts.retryCount ?? 0,
    tool: opts.tool ?? getRunnerDisplayName(runner),
    kind: runner.kind,
    ...(model !== undefined && { model }),
    ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
    ...buildRoutingEventFields(wctx.routingDecision),
  };
  opts.taskBreakdowns.push(execution);
  wctx.bus.publish({ type: 'task_settled', ts: Date.now(), phase: state.phase, ...execution });
}

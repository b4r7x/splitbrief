import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import type { BriefExecution } from '../../../core/schemas/brief-execution.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { EventBus } from '../../events/types.js';
import { buildRoutingEventFields } from '../context-routing/event-fields.js';
import type { WorkflowContext } from '../types.js';

export type BriefExecutionRoute = Omit<
  BriefExecution,
  'taskId' | 'taskTitle' | 'method' | 'retryCount'
>;

export function recordSettledBrief(opts: {
  bus: EventBus;
  task: Task;
  method: BriefExecution['method'];
  retryCount?: number | undefined;
  route: BriefExecutionRoute;
  save: (execution: BriefExecution) => WorkflowState;
}): WorkflowState {
  const { bus, task, method, retryCount = 0, route, save } = opts;
  const execution: BriefExecution = {
    ...route,
    taskId: task.id,
    taskTitle: task.title,
    method,
    retryCount,
  };
  const state = save(execution);
  bus.publish({ type: 'task_settled', ts: Date.now(), phase: state.phase, ...execution });
  return state;
}

export function recordRoutedBrief(opts: {
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
  recordSettledBrief({
    bus: wctx.bus,
    task,
    method: opts.method,
    retryCount: opts.retryCount,
    route: {
      tool: opts.tool ?? getRunnerDisplayName(runner),
      kind: runner.kind,
      ...(model !== undefined && { model }),
      ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
      ...buildRoutingEventFields(wctx.routingDecision),
    },
    save: (execution) => {
      opts.taskBreakdowns.push(execution);
      return state;
    },
  });
}

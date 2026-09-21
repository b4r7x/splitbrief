import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { calculateTaskUsageCost, isTaskUsageCostKnown } from '../../providers/cost/task-usage.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';

/**
 * The seat fields are the run's *pricing* identity — the seat the tokens were
 * actually spent against. They are read here and never from the summary's own
 * seat fields, which name the seat the run is on now (a seat swap moves one and
 * not the other).
 */
export type BuildSummaryState = Pick<
  WorkflowState,
  | 'tasks'
  | 'tokenUsage'
  | 'plannerTool'
  | 'plannerModel'
  | 'implementerTool'
  | 'implementerModel'
  | 'reviewerTool'
  | 'reviewerModel'
>;

export function countLocalAndEscalatedTasks(
  state: BuildSummaryState,
  taskBreakdowns: TaskTokenUsage[] | undefined,
): { local: number; escalated: number } {
  const latestMethodByTask = new Map<string, TaskTokenUsage['method']>();
  for (const breakdown of taskBreakdowns ?? []) {
    latestMethodByTask.set(breakdown.taskId, breakdown.method);
  }

  let local = 0;
  let escalated = 0;
  for (const task of state.tasks) {
    if (task.status !== 'done' && task.status !== 'escalated') continue;
    const method = latestMethodByTask.get(task.id);
    if (method) {
      const completionClass = classifyTaskCompletionMethod(method);
      if (completionClass === 'local') local += 1;
      else if (completionClass === 'escalated') escalated += 1;
      continue;
    }
    if (task.status === 'done') local += 1;
    else escalated += 1;
  }
  return { local, escalated };
}

type CostBreakdownInput = {
  taskBreakdowns: TaskTokenUsage[] | undefined;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string;
  implementerModel?: string;
  pricingCache?: ModelCacheAccessor | undefined;
  callEvidence?: readonly CallUsageEvidence[] | undefined;
};

const DIRECTIONAL_COUNTERS = [
  'implementerInputTokens',
  'implementerOutputTokens',
  'implementerReasoningTokens',
  'implementerCacheReadTokens',
  'implementerCacheCreateTokens',
  'escalationInputTokens',
  'escalationOutputTokens',
  'escalationReasoningTokens',
  'escalationCacheReadTokens',
  'escalationCacheCreateTokens',
] as const satisfies readonly (keyof TaskTokenUsage)[];

// A redo can finish the same task again. Its calls price one task total, so the
// summary carries one row with all executions and the latest completion method.
function aggregateTaskExecutions(tasks: readonly TaskTokenUsage[]): TaskTokenUsage[] {
  const totals = new Map<string, TaskTokenUsage>();
  for (const task of tasks) {
    const previous = totals.get(task.taskId);
    if (previous === undefined) {
      totals.set(task.taskId, task);
      continue;
    }
    const combined: TaskTokenUsage = {
      ...task,
      implementerTokens: previous.implementerTokens + task.implementerTokens,
      escalationTokens: previous.escalationTokens + task.escalationTokens,
      retryCount: previous.retryCount + task.retryCount,
    };
    for (const key of DIRECTIONAL_COUNTERS) {
      const left = previous[key];
      const right = task[key];
      if (left === undefined || right === undefined) delete combined[key];
      else combined[key] = left + right;
    }
    totals.set(task.taskId, combined);
  }
  return [...totals.values()];
}

/**
 * A task is costed from what it was observed to spend — its own directional
 * counters, or the calls that named it — never from a share of the run's
 * totals. A record that carries neither keeps its combined count and reports no
 * cost at all.
 */
export function applyTaskBreakdownCosts(input: CostBreakdownInput): TaskTokenUsage[] | undefined {
  const {
    taskBreakdowns,
    plannerTool,
    implementerTool,
    plannerModel,
    implementerModel,
    pricingCache,
    callEvidence,
  } = input;
  const tasks =
    callEvidence === undefined || taskBreakdowns === undefined
      ? taskBreakdowns
      : aggregateTaskExecutions(taskBreakdowns);
  return tasks?.map((task) => {
    const usage = {
      task,
      implementerTool,
      plannerTool,
      implementerModel,
      plannerModel,
      cache: pricingCache,
      ...(callEvidence !== undefined && { callEvidence }),
    };
    const { cost: _cost, ...rest } = task;
    return {
      ...rest,
      ...(isTaskUsageCostKnown(usage) ? { cost: calculateTaskUsageCost(usage) } : {}),
    };
  });
}

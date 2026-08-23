import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { calculateTaskUsageCost, isTaskUsageCostKnown } from '../../providers/cost/task-usage.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'tokenUsage'>;

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

export function projectTaskBreakdownForTranscriptPolicy(task: TaskTokenUsage): TaskTokenUsage {
  const { routingReason, costPosture, ...base } = task;
  return {
    ...base,
    taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
    ...(routingReason !== undefined && { routingReason: TRANSCRIPT_OMITTED_MESSAGE }),
    ...(costPosture !== undefined && { costPosture: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

type CostBreakdownInput = {
  state: BuildSummaryState;
  taskBreakdowns: TaskTokenUsage[] | undefined;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string;
  implementerModel?: string;
  reviewerTool?: string | undefined;
  pricingCache?: ModelCacheAccessor | undefined;
};

export function applyTaskBreakdownCosts(input: CostBreakdownInput): TaskTokenUsage[] | undefined {
  const {
    state,
    taskBreakdowns,
    plannerTool,
    implementerTool,
    plannerModel,
    implementerModel,
    reviewerTool,
    pricingCache,
  } = input;
  return taskBreakdowns?.map((task) => {
    const isCostKnown = isTaskUsageCostKnown({
      task,
      tokenUsage: state.tokenUsage,
      implementerTool,
      plannerTool,
      implementerModel,
      plannerModel,
      cache: pricingCache,
      ...(reviewerTool !== undefined && { reviewerTool }),
    });
    const { cost: _cost, ...rest } = task;
    return {
      ...rest,
      ...(isCostKnown
        ? {
            cost: calculateTaskUsageCost({
              task: task,
              tokenUsage: state.tokenUsage,
              implementerTool: implementerTool,
              plannerTool: plannerTool,
              implementerModel: implementerModel,
              plannerModel: plannerModel,
              cache: pricingCache,
              ...(reviewerTool !== undefined && { reviewerTool }),
            }),
          }
        : { costPosture: task.costPosture ?? 'unknown-price' }),
    };
  });
}
